/**
 * Private repositories: the flag, and the one misconfiguration that is fatal.
 *
 * A claimed repository may carry a **Reader List** — fingerprints in a file
 * called `readers`, beside `signers` on the same `refs/walgit/signers` commit
 * (docs/adr/0013). This module owns only the deployment question: *is this
 * host doing that at all*. Reading the file is `src/signers.ts`'s, and gating a
 * read on it is a later slice — nothing here refuses anything to anyone.
 *
 * It is a SEED rather than a boolean, and that is not decoration: the Read
 * Challenge's nonce is `HMAC(seed, window)`, so the same value that turns the
 * capability on is the value it is built from — ADR-0011's "the seed IS the
 * capability", in the other direction. Blank collapses to unset here as it does
 * for the push-certificate seed, because a variable cleared to nothing is a
 * capability turned off.
 */

import { createHmac } from 'node:crypto'

import { flagEnabled, seedValue } from '../shared/policy'
import { CHALLENGE_PATH, READ_CHALLENGE_NAMESPACE } from '../shared/protocol'
import type { Claim } from './wal-index'

/**
 * The variables this module reads, named so a literal fixture is checked: a
 * misspelled one in a literal annotated with this is a compile error.
 */
export type PrivateEnv = {
  WALGIT_PRIVATE_REPOS?: string | undefined
  WALGIT_SIGNER_LISTS?: string | undefined
}

/**
 * What these functions accept, and the second half is what lets the container
 * hand over `process.env` — an all-optional type is "weak" to TypeScript, which
 * refuses a source declaring no property in common with it, and
 * `NodeJS.ProcessEnv` declares only `NODE_ENV` and `TZ`. The same widening
 * `capabilitiesFrom` makes, for the same reason and with the same limit: a
 * property access on a union has to exist on both halves, so nothing outside
 * `PrivateEnv` can be read in here.
 */
type EnvSource = PrivateEnv | Record<string, string | undefined>

/**
 * The configured seed, or `null` for "this deployment has no Private
 * repositories". Read through the same helper as `WALGIT_PUSH_CERT_SEED`, so
 * the two seeds cannot acquire two readings of "unset".
 */
export function privateReposSeed(env: EnvSource): string | null {
  return seedValue(env.WALGIT_PRIVATE_REPOS)
}

/**
 * Is this deployment maintaining Reader Lists?
 *
 * Both variables, because a Reader List is ownership spent: it lives in the
 * tree the Signer List lives in, is written by a push the Signer List judged,
 * and on a name anyone may write to it protects nothing — the next stranger's
 * push adds themselves to it. `privateReposConfigError` refuses to boot on this
 * combination, so reaching it here means an operator got past that; reading it
 * as off is the fail-closed half of the same answer.
 */
export function privateReposEnabled(env: EnvSource): boolean {
  return privateReposSeed(env) !== null && flagEnabled(env.WALGIT_SIGNER_LISTS)
}

/**
 * What is wrong with this deployment's Private configuration, or `null`.
 *
 * There is exactly one wrong shape and it is worth the container's life: the
 * seed set with no Signer List flag. That deployment would advertise Private
 * repositories it cannot have — every name on it is unclaimed as far as
 * `pre-receive` is concerned, so no `readers` file would ever be recorded and
 * no read would ever be gated — and it would do it silently, because both
 * variables are optional and an unset one simply means unenforced. A refusal
 * at boot is loud, immediate and recoverable; the silent version is a promise
 * of privacy nothing keeps.
 */
export function privateReposConfigError(env: EnvSource): string | null {
  if (privateReposSeed(env) === null) return null
  if (flagEnabled(env.WALGIT_SIGNER_LISTS)) return null
  return (
    'walgit: WALGIT_PRIVATE_REPOS is set without WALGIT_SIGNER_LISTS. A Reader List ' +
    'lives beside the Signer List and is written by a push that list judged, so ' +
    'private repositories need ownership turned on: set WALGIT_SIGNER_LISTS=1 (and a ' +
    'WALGIT_PUSH_CERT_SEED, so a claim can be signed), or unset WALGIT_PRIVATE_REPOS.'
  )
}

// ── The Read Challenge ──────────────────────────────────────────────────────

/**
 * How long one nonce stands, in seconds.
 *
 * Five minutes, and the same number `PUSH_CERT_NONCE_SLOP_SECONDS` is, for the
 * same reason: it is the replay window for a captured signature. Two windows
 * are accepted at once, so the true ceiling is ten minutes — a reader that
 * fetched a challenge just before a boundary must still be able to spend it.
 */
export const READ_NONCE_WINDOW_SECONDS = 300

/**
 * The nonce for the window `now` falls in: `HMAC(seed, floor(now / 300 s))`.
 *
 * No state anywhere, which is the whole design: the container sleeps, restarts
 * and scales, and a nonce it had to remember would be a nonce it forgets. The
 * window number is the message rather than the raw timestamp so that every
 * request inside one window is handed the same string to sign — a reader signs
 * once and spends it on as many repositories as it likes.
 */
export function readChallengeNonce(seed: string, nowMs: number = Date.now()): string {
  const window = Math.floor(nowMs / 1000 / READ_NONCE_WINDOW_SECONDS)
  return createHmac('sha256', seed).update(String(window)).digest('hex')
}

/**
 * The nonces a signature may have been made over: this window, then the one
 * before it, newest first.
 *
 * Two and not three. One alone refuses a reader whose round trip crossed a
 * boundary — the same intermittent failure `receive.certNonceSlop` exists to
 * prevent on the push side — and each extra window doubles the replay window
 * for a captured signature while buying nothing a client would notice.
 */
export function acceptedNonces(seed: string, nowMs: number = Date.now()): string[] {
  const previous = nowMs - READ_NONCE_WINDOW_SECONDS * 1000
  return [readChallengeNonce(seed, nowMs), readChallengeNonce(seed, previous)]
}

/** What the read verdict is asked about. */
export type ReadRequest = {
  /** Is this deployment gating reads at all — the seed, read as a yes/no. */
  enabled: boolean
  /** What the Index records about this repository, if anything. */
  claim?: Pick<Claim, 'signers' | 'readers'> | undefined
  /** The fingerprint the reader PROVED, never one it merely asserted. */
  presented: string | null
}

/**
 * May this reader read this repository?
 *
 * One pure function over three facts, and it is the same function for the
 * clone, the fetch and the Provenance Read — ADR-0011 put the provenance read
 * behind exactly the credential a clone needs, and a second verdict function
 * would be the second authorization model that sentence refuses.
 *
 * Absence is the switch, in both directions. No seed: nothing is gated, so a
 * deployment that has not turned Private on cannot acquire a refusal by
 * accident. No `readers` field: world-readable, which is every repository until
 * someone writes the file — a claimed one with no Reader List included.
 *
 * A Signer reads without being listed, so `readers: []` is the spelling of
 * "private, and only I read it" rather than of a repository nobody can read.
 * The caller must have VERIFIED the fingerprint before passing it: this
 * function cannot tell a proof from a claim, and a fingerprint is public.
 */
export function readAllowed({ enabled, claim, presented }: ReadRequest): boolean {
  if (!enabled) return true
  const readers = claim?.readers
  if (!readers) return true
  if (presented === null) return false
  return readers.includes(presented) || (claim?.signers ?? []).includes(presented)
}

/**
 * What a refused reader is told, in walgit's own words.
 *
 * Rendered rather than written as prose in `src/http.ts` for the reason every
 * other agent-facing document in this package is: the 401 is where discovery
 * actually lands — the moment it is relevant, on our server — so it names the
 * helper, the one config line, and the by-hand exchange for a reader who would
 * rather see the mechanism than install anything.
 *
 * `origin` is the host the agent TYPED (behind the Worker the request URL
 * carries an internal address), so the config line is copy-pasteable.
 */
export function renderReadChallenge(origin: string): string {
  return [
    'walgit: this repository is Private (docs/adr/0013).',
    '',
    'It carries a Reader List — the keys it lets read it — so every clone, fetch',
    'and provenance read is refused until one of those keys, or one of its',
    'Signers, signs the current challenge. There is no account and no token.',
    '',
    'Once per machine, and then git needs nothing typed:',
    '',
    `  git config --global credential.${origin}.helper '!agentgit credential'`,
    '',
    'By hand, if you would rather see the exchange:',
    '',
    `  nonce=$(curl -fsS ${origin}${CHALLENGE_PATH} | sed 's/.*"nonce":"\\([^"]*\\)".*/\\1/')`,
    `  sig=$(printf %s "$nonce" | ssh-keygen -Y sign -n ${READ_CHALLENGE_NAMESPACE} -f ~/.ssh/id_ed25519 -)`,
    "  fp=$(ssh-keygen -lf ~/.ssh/id_ed25519.pub | awk '{print $2}')",
    `  git -c http.extraHeader="Authorization: Basic $(printf %s "$fp:$sig" | base64 -w0)" clone ${origin}/<name>.git`,
    '',
    'The credential is Basic, with the fingerprint as the user and the signature',
    'as the password. A helper must send the signature base64-encoded once more:',
    "git's credential protocol ends a value at a newline, and armour has several.",
    '',
    'The challenge is an HMAC of this host and the clock: it stands for five',
    'minutes, the one before it is still accepted, and nothing is stored.',
    '',
  ].join('\n')
}
