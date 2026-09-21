/**
 * `agentgit setup` — turning the helper on, which is one line of git config.
 *
 * It exists because that line is easy to get subtly wrong: the config key
 * carries the whole ORIGIN (`credential.https://host.helper`), not the
 * hostname, and a key that is off by a scheme is a helper git silently never
 * calls. The symptom of getting it wrong is a password prompt, which on a
 * machine with no human at it is a hang.
 */

import { type CloneDiscovery, discoverClone } from './clone'
import { git } from './git'

/** What the helper is invoked as. `!` is git's "run this as a command". */
export const HELPER_COMMAND = '!agentgit credential'

export interface SetupDeps {
  /** Which clone this is (`src/clone.ts`) — the same answer `watch` and `accept` get. */
  discover(): CloneDiscovery
  /** `git config …`. A non-zero code with git's own message is a failure. */
  writeConfig(args: readonly string[]): { code: number; stderr: string }
}

export interface SetupRequest {
  host: string | null
  global: boolean
}

export interface SetupResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * The origin a `setup` argument names.
 *
 * A bare hostname means https, because that is every deployment; a
 * self-hosted node on plain http is named in full (`http://127.0.0.1:8787`),
 * which is also what the remote of a clone of it says.
 */
export function originFromArgument(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** The config key git looks the helper up under, for one origin. */
export function helperConfigKey(origin: string): string {
  return `credential.${origin}.helper`
}

export async function runSetup(request: SetupRequest, deps: SetupDeps): Promise<SetupResult> {
  const origin =
    request.host === null ? originOfClone(deps.discover()) : originFromArgument(request.host)
  if (typeof origin !== 'string') return origin

  const key = helperConfigKey(origin)
  const scope = request.global ? '--global' : '--local'
  const written = deps.writeConfig(['config', scope, key, HELPER_COMMAND])
  if (written.code !== 0) {
    return {
      stdout: '',
      stderr: `agentgit: git config ${scope} ${key} failed (${written.code}): ${written.stderr.trim()}\n`,
      code: 1,
    }
  }

  return {
    stdout:
      `${scope === '--global' ? 'git config --global' : 'git config'} ${key} '${HELPER_COMMAND}'\n` +
      `agentgit now answers ${origin} for git — clone, fetch and push need nothing typed.\n`,
    stderr: '',
    code: 0,
  }
}

/** Every refusal here ends the same way, because every one of them has the same fix. */
const refuse = (message: string): SetupResult => ({
  stdout: '',
  stderr: `agentgit: ${message}\nName the host instead: agentgit setup agentgit.co\n`,
  code: 2,
})

/**
 * The origin to write a helper for, or the refusal to return instead.
 *
 * Three arms, three sentences. "Not in a checkout" and "in a checkout whose
 * remotes we cannot address" are different problems with different fixes, and
 * a clone full of GitHub remotes told "no walgit remote here to take a host
 * from" reads as though it has no remotes at all.
 */
function originOfClone(found: CloneDiscovery): string | SetupResult {
  if (found.kind === 'clone') return found.origin
  if (found.kind === 'no-repository')
    return refuse('not inside a git repository, so there is no remote to take a host from.')
  const seen = found.remotes.map((remote) => `${remote.name} → ${remote.url}`)
  return refuse(
    seen.length === 0
      ? `${found.root} has no remotes, so there is no host to take.`
      : `none of the remotes in ${found.root} is a walgit host we can address: ${seen.join(', ')}.`,
  )
}

/** The deps as they are on a real machine. */
export function realSetupDeps(cwd: string = process.cwd()): SetupDeps {
  return {
    discover: () => discoverClone(cwd),
    writeConfig(args) {
      const run = git(cwd, args)
      return { code: run.code, stderr: run.stderr }
    },
  }
}
