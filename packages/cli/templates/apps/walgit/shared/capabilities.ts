/**
 * What this deployment advertises, derived once.
 *
 * Three agent-facing documents describe the same host — the plain-text `GET /`
 * (`src/instructions.ts`), the landing page (`shared/landing.ts`) and
 * `/llms.txt` (`shared/llms.ts`) — and the push path enforces what they
 * describe. Each of them used to read the environment for itself, from three
 * types that disagreed about how to spell "unset" and about which variables a
 * capability was made of. The rule that kept them honest was a paragraph
 * repeated in three doc comments and enforced nowhere; of the nine commits that
 * touched the landing page since July, eight had to touch one of the others.
 *
 * So the derivation lives here, once, and everything that states a capability
 * or enforces one reads the same value. A capability added here is a required
 * field, so every construction site fails to compile until it says what it
 * offers — which is the property a hand-maintained "everything on" test fixture
 * cannot have.
 *
 * ── one predicate per capability, and the renderers combine nothing ─────────
 *
 * A renderer that wrote `signedPushes && signerLists` for itself is a fourth
 * place the rule lives. Both readings of the Signer List flag are fields here
 * (`namesCanRefuse`, `namesCanBeClaimed`), named for what a sentence using them
 * is doing, so a document asks for the reading it needs rather than assembling
 * it.
 *
 * ── the host is not a capability ────────────────────────────────────────────
 *
 * Every document also prints the host it was reached on, and it is deliberately
 * not in here: `GET /` needs a full origin including the scheme (a local test
 * reaches it over plain http and the example has to work verbatim), while the
 * two edge documents take a bare hostname and supply `https://`/`wss://`
 * themselves. One field could not serve both, and the two are passed as
 * arguments beside these facts rather than folded into them.
 */

import type { ContainerEnvName } from './container-env'
import { flagEnabled, positiveNumber } from './policy'
import { signedPushEnabled } from './provenance'

/**
 * The variables a capability may be read from — and only those the container is
 * actually told about.
 *
 * `Extract` rather than a plain union of string literals, deliberately: a
 * capability derived from a variable missing from `CONTAINER_ENV`
 * (`shared/container-env.ts`) would be one the edge advertises and the push
 * path never sees, silently, because every one of these is optional and an
 * unset one just means unenforced. Narrowing through `ContainerEnvName` makes
 * that a compile error instead. If a name here ever stops type-checking, the
 * forward list is the bug — not this type.
 */
type CapabilityVar = Extract<
  ContainerEnvName,
  | 'WALGIT_PUBLIC'
  | 'WALGIT_APPEND_ONLY'
  | 'WALGIT_RETENTION_HOURS'
  | 'WALGIT_MAX_PUSH_BYTES'
  | 'WALGIT_MAX_REPO_BYTES'
  | 'WALGIT_EVENTS_URL'
  | 'WALGIT_EVENTS_TOKEN'
  | 'WALGIT_PUSH_CERT_SEED'
  | 'WALGIT_SIGNER_LISTS'
>

/**
 * An environment named exactly by the variables a capability is read from.
 *
 * `capabilitiesFrom` accepts something wider (see below), so this is what a
 * caller writing a LITERAL should annotate it with: a misspelled variable in a
 * literal typed as this is a compile error, whereas the same literal handed
 * straight to `capabilitiesFrom` would be accepted and quietly read as unset.
 * That is what every test fixture in this package is typed as.
 */
export type CapabilityEnv = Partial<Record<CapabilityVar, string>>

/**
 * What this deployment offers, as the documents and the push path both read it.
 *
 * Every field is REQUIRED and absence is `null`, never an omitted key. Optional
 * fields would let a new capability be forgotten at a construction site and
 * default to "off" there, which is precisely the drift this module exists to
 * end — and `null` is the spelling `positiveNumber` already returns, so the
 * numbers arrive here without a conversion that could invent a second meaning
 * for a missing limit.
 */
export type Capabilities = {
  /** Reads and writes take no credential. */
  publicAccess: boolean
  /** Refs only move forward; a rewrite or a deletion is refused. */
  appendOnly: boolean
  /**
   * The ref-event stream is served, and something can publish to it.
   *
   * BOTH halves, because either alone is a stream that never delivers: the
   * token is what claims the socket path at the edge, and the URL is where the
   * container's `post-receive` announces. With only the token, the handshake
   * answers with current refs and then nothing ever arrives, because the push
   * path has nowhere to announce to — which is worse than no stream at all,
   * since an agent writes the client before finding out.
   */
  events: boolean
  /**
   * A signed push is accepted, and who made it is recorded.
   *
   * From the nonce seed, which IS the capability: with none,
   * `git-receive-pack` never advertises `push-cert` and a client asking to
   * sign is refused by its OWN git, before a byte leaves the machine. A
   * document offering it there would hand an agent a flag that cannot work.
   */
  signedPushes: boolean
  /**
   * The gate is on: a claimed name refuses a stranger. Corrects
   * "world-writable".
   *
   * The raw `WALGIT_SIGNER_LISTS` flag, and it is the right strength for any
   * sentence that only states what `pre-receive` refuses — because the hook
   * refuses on this flag by itself (`signerListsEnabled`, `src/signers.ts`).
   * On a deployment that sets it with no nonce seed, a claimed name refuses
   * EVERY push, which makes unconditional writability more wrong rather than
   * less.
   */
  namesCanRefuse: boolean
  /**
   * Safe to send somebody to claim a name: the gate is on AND signing is
   * possible.
   *
   * The strength every sentence that TEACHES claiming needs. With the flag and
   * no seed nothing can sign, so an agent following those instructions would
   * claim the name with an unsigned push and then be refused on every push to
   * it, its own included, with no way to sign out of it.
   */
  namesCanBeClaimed: boolean
  /** A repository is collected this many hours after its last push. */
  retentionHours: number | null
  /** Largest single push, in bytes. */
  maxPushBytes: number | null
  /** Largest total size of one repository, in bytes. */
  maxRepoBytes: number | null
}

/**
 * Read an environment into what it advertises.
 *
 * Takes the environment as an argument rather than reaching for one, because
 * the two halves do not have the same one to hand: the container has
 * `process.env`, read once at boot, and the Worker has a binding object it
 * reads per request. That asymmetry is correct and is why `reconcileEnv`
 * (`worker/index.ts`) exists — what they must share is the reading, and this is
 * it.
 *
 * Every predicate is the one that enforces the thing: `flagEnabled` and
 * `positiveNumber` from `shared/policy.ts`, `signedPushEnabled` from
 * `shared/provenance.ts`. Nothing is parsed a second way here.
 *
 * The second half of the parameter type is what lets the container hand over
 * `process.env` — an all-optional type is "weak" to TypeScript, which refuses a
 * source that declares no property in common with it, and `NodeJS.ProcessEnv`
 * declares only `NODE_ENV` and `TZ`.
 *
 * It does not widen what may be READ here: a property access on a union has to
 * exist on BOTH halves, so a variable outside `CapabilityVar` is a compile
 * error inside this function. It DOES widen what a caller may pass — a literal
 * with a misspelled variable is accepted and read as unset — so a caller
 * writing one annotates it `CapabilityEnv`, which is checked.
 */
export function capabilitiesFrom(
  env: CapabilityEnv | Record<string, string | undefined>,
): Capabilities {
  const namesCanRefuse = flagEnabled(env.WALGIT_SIGNER_LISTS)
  const signedPushes = signedPushEnabled(env.WALGIT_PUSH_CERT_SEED)

  return {
    publicAccess: flagEnabled(env.WALGIT_PUBLIC),
    appendOnly: flagEnabled(env.WALGIT_APPEND_ONLY),
    // Blank collapses to unset, the same reading `announceConfigFromEnv`
    // (`src/announce.ts`) makes of the same two variables — the config the push
    // path announces with and this advertisement cannot be allowed to disagree.
    events: nonBlank(env.WALGIT_EVENTS_URL) && nonBlank(env.WALGIT_EVENTS_TOKEN),
    signedPushes,
    namesCanRefuse,
    namesCanBeClaimed: namesCanRefuse && signedPushes,
    retentionHours: positiveNumber(env.WALGIT_RETENTION_HOURS),
    maxPushBytes: positiveNumber(env.WALGIT_MAX_PUSH_BYTES),
    maxRepoBytes: positiveNumber(env.WALGIT_MAX_REPO_BYTES),
  }
}

const nonBlank = (raw: string | undefined): boolean => typeof raw === 'string' && raw.trim() !== ''
