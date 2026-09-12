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

import { flagEnabled, seedValue } from '../shared/policy'

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
