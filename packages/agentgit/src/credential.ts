/**
 * The credential helper: what git runs when a walgit repository is Private.
 *
 * A Private repository (docs/adr/0013 in Zabaca/zbc) refuses every read unless
 * the reader proves, by signature, a key on its Reader List or its Signer
 * List. Over smart-HTTP there is no transport that signs a fetch — `git push
 * --signed` has no counterpart on `upload-pack` — so the only place a key can
 * be presented is the `Authorization` header a credential helper fills in.
 *
 * That is all this is: fetch the host's nonce, sign it with the key this
 * machine already signs pushes with, and hand git a username and a password.
 * There is nothing to store, so `store` and `erase` do nothing.
 *
 * Three details are not negotiable, because walgit's reader is on the other
 * side of them:
 *
 *  - the username is the key's `SHA256:` fingerprint, and the password is the
 *    signature — walgit splits the Basic userid at the LAST colon, which works
 *    precisely because a fingerprint has one and an armoured signature has
 *    none;
 *  - the password is the armour **base64-encoded once more**. git's credential
 *    protocol ends a value at a newline and armour has several, and
 *    `ssh-keygen` rejects armour with its newlines stripped, so the doubly
 *    encoded form is the only one that survives both;
 *  - the nonce is FETCHED from the host, never taken from `wwwauth[]`: only
 *    git ≥ 2.42 forwards that to a helper, and a version cut-off an agent
 *    cannot see is a footgun.
 *
 * Everything the outside world does — the network, git's config, `ssh-keygen`
 * — arrives as `CredentialDeps`, so the whole behaviour above is testable with
 * no host, no key and no subprocess.
 */

import { spawnSync } from 'node:child_process'

import type { CredentialOperation } from './args'
import { git } from './git'

/** The nonce endpoint, frozen by the ADR above; never derived from the server. */
const CHALLENGE_PATH = '/_walgit/challenge'

/**
 * The signature namespace. `walgit-read`, never `git`: `ssh-keygen` binds the
 * namespace into the signed bytes, so a Read Challenge signature cannot be
 * replayed as a Push Certificate nor as an SSH authentication.
 */
const READ_CHALLENGE_NAMESPACE = 'walgit-read'

export interface CredentialDeps {
  /** This host's current nonce, or `null` if it publishes none (most hosts). */
  challenge(origin: string): Promise<string | null>
  /** The key git would sign a push with — `user.signingkey` — or `null`. */
  signingKey(): string | null
  /** `SHA256:…` for that key, or `null` when it cannot be read. */
  fingerprint(key: string): string | null
  /** The armoured signature over `nonce`, or `null` when signing failed. */
  sign(key: string, nonce: string): string | null
}

export interface CredentialResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * git's credential protocol: `key=value` lines, ended by a blank line.
 *
 * Repeated keys (`wwwauth[]`) keep the FIRST occurrence and are then ignored
 * anyway; a line with no `=` is skipped rather than fatal, because a future
 * git that adds a field must not break a helper that predates it.
 */
export function parseCredentialInput(stdin: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const raw of stdin.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (key in fields) continue
    fields[key] = line.slice(eq + 1)
  }
  return fields
}

/** The answer, in the same grammar it was asked in. */
export function formatCredentialOutput(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('')
}

/**
 * Answer one invocation of the helper.
 *
 * Answering NOTHING is a first-class outcome and not a failure: git treats
 * empty output as "this helper knows nothing" and moves on to the next one, so
 * a host that is not walgit, or a request that is not over HTTP, costs a
 * process and no behaviour. The only exits that are non-zero are the two an
 * agent has to act on — no key, and a key that will not sign — because they
 * are misconfiguration, and failing them silently would surface as a password
 * prompt on a machine with no human at it.
 */
export async function runCredential(
  operation: CredentialOperation,
  stdin: string,
  deps: CredentialDeps,
): Promise<CredentialResult> {
  // Read even for store/erase: git writes the request either way, and a helper
  // that never drains the pipe can leave git writing into a closed one.
  const request = parseCredentialInput(stdin)
  if (operation !== 'get') return { stdout: '', stderr: '', code: 0 }

  const protocol = request.protocol ?? ''
  const host = request.host ?? ''
  if ((protocol !== 'https' && protocol !== 'http') || host === '') {
    return { stdout: '', stderr: '', code: 0 }
  }

  const origin = `${protocol}://${host}`
  let nonce: string | null
  try {
    nonce = await deps.challenge(origin)
  } catch {
    // A host that could not be reached for a nonce is a host this helper has
    // nothing to say about. git's own request is about to fail with a network
    // error of its own, which is the better message.
    nonce = null
  }
  if (nonce === null) return { stdout: '', stderr: '', code: 0 }

  const key = deps.signingKey()
  if (key === null) {
    return {
      stdout: '',
      stderr:
        `agentgit: ${origin} is walgit with Private repositories, and this machine has no ` +
        'key to prove.\n' +
        'Set the key git signs pushes with, and this helper signs reads with the same one:\n\n' +
        '  git config --global gpg.format ssh\n' +
        '  git config --global user.signingkey ~/.ssh/id_ed25519\n',
      code: 1,
    }
  }

  const fingerprint = deps.fingerprint(key)
  if (fingerprint === null) {
    return {
      stdout: '',
      stderr: `agentgit: could not read a fingerprint for ${key} (ssh-keygen -lf)\n`,
      code: 1,
    }
  }

  const armour = deps.sign(key, nonce)
  if (armour === null) {
    return {
      stdout: '',
      stderr: `agentgit: ${key} could not sign the challenge from ${origin} (ssh-keygen -Y sign)\n`,
      code: 1,
    }
  }

  return {
    stdout: formatCredentialOutput({
      username: fingerprint,
      password: Buffer.from(armour, 'utf8').toString('base64'),
    }),
    stderr: '',
    code: 0,
  }
}

// ── The real world ──────────────────────────────────────────────────────────

/** `ssh-keygen`, run for its output. Never throws; a failure is `null`. */
function sshKeygen(args: string[], input?: string): string | null {
  const run = spawnSync('ssh-keygen', args, { encoding: 'utf8', input })
  if (run.error || run.status !== 0) return null
  return run.stdout ?? ''
}

/**
 * The deps as they are on a real machine.
 *
 * `cwd` is where git config is read from, so a repository-local
 * `user.signingkey` wins over the global one exactly as it does for a push.
 * git invokes a helper in the working tree of the operation, so in practice
 * that is the clone being fetched.
 */
export function realCredentialDeps(cwd: string = process.cwd()): CredentialDeps {
  return {
    async challenge(origin) {
      const res = await fetch(`${origin}${CHALLENGE_PATH}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { nonce?: unknown }
      return typeof body.nonce === 'string' && body.nonce !== '' ? body.nonce : null
    },
    signingKey() {
      const configured =
        process.env.AGENTGIT_SIGNING_KEY ??
        git(cwd, ['config', '--get', 'user.signingkey']).stdout.trim()
      if (!configured) return null
      // `~` is not expanded by anything below this line: git stores the value
      // as it was typed, and `ssh-keygen` is not a shell.
      return configured.startsWith('~/')
        ? `${process.env.HOME ?? ''}${configured.slice(1)}`
        : configured
    },
    fingerprint(key) {
      // `-lf` takes either half of a pair and prints the public key's
      // fingerprint either way, which is what walgit records and compares.
      const printed = sshKeygen(['-lf', key])
      return printed?.split(/\s+/).find((word) => word.startsWith('SHA256:')) ?? null
    },
    sign(key, nonce) {
      // `-` reads the message from stdin; the signature comes back on stdout.
      const armour = sshKeygen(
        ['-Y', 'sign', '-n', READ_CHALLENGE_NAMESPACE, '-f', key, '-'],
        nonce,
      )
      return armour && armour.includes('BEGIN SSH SIGNATURE') ? armour : null
    },
  }
}

/**
 * The `Authorization` header value this machine would present to `origin`, or
 * `null` when it has nothing to present.
 *
 * Used by `agentgit watch`, which subscribes to an event stream rather than
 * fetching over git — the same credential, because an event is a strict subset
 * of what a fetch hands over and walgit gates both on one verdict.
 */
export async function readAuthorization(
  origin: string,
  deps: CredentialDeps,
): Promise<string | null> {
  const url = new URL(origin)
  const answered = await runCredential(
    'get',
    `protocol=${url.protocol.replace(':', '')}\nhost=${url.host}\n\n`,
    deps,
  )
  const { username, password } = parseCredentialInput(answered.stdout)
  if (!username || !password) return null
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}
