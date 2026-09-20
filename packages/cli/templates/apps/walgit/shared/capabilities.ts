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
import { flagEnabled, positiveNumber, seedValue } from './policy'
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
  | 'WALGIT_PRIVATE_REPOS'
  | 'WALGIT_PROPOSALS'
  | 'WALGIT_WEB'
  | 'WALGIT_RATE_WINDOW_SECONDS'
  | 'WALGIT_MAX_NEW_REPOS_PER_SOURCE'
  | 'WALGIT_MAX_PUSHES_PER_SOURCE'
  | 'WALGIT_MAX_PUSH_BYTES_PER_SOURCE'
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
  /**
   * A name can refuse a stranger READING it: the Private seed is set, the name
   * can be claimed at all, and a reader could actually prove a key
   * (docs/adr/0013).
   *
   * Everything `namesCanBeClaimed` needs, plus its own seed — because a Reader
   * List lives in the Signer List's tree and is written by a push that list
   * judged, so on a name anyone may write to it protects nothing. The seed is
   * its own variable for the reason ownership's flag is not the certificate
   * seed: a deployment that turned on ownership must not acquire read gating as
   * a side effect.
   *
   * And `publicAccess`, which is the same defect `namesCanBeClaimed` guards
   * against one rung down: a Read Challenge is presented as Basic auth, in the
   * one `authorization` header a credentialed deployment's token already
   * occupies, and the token gate is answered FIRST (`src/http.ts`). So on a
   * deployment that asks for a token, a reader cannot present a signature at
   * all — a Private repository there is unreadable by everyone, its owner
   * included, and a document teaching the exchange would be handing an agent
   * commands that cannot work. Absence of a per-repository read gate is what
   * the `Credentialed` term already says: one credential reads every name.
   */
  namesCanBePrivate: boolean
  /**
   * A claimed name takes a signed push to `refs/walgit/proposals/<target>/<id>`
   * from whoever may READ it, while every other ref stays under the Signer List
   * (docs/adr/0018).
   *
   * Everything `namesCanBeClaimed` needs, plus its own flag. Not the flag
   * alone, for the reason Private is not its seed alone: a Proposal is a SIGNED
   * push to a name that holds a Signer List, so with no nonce seed nothing can
   * sign one, and on a deployment with no gate there is no refusal to widen —
   * `refs/walgit/proposals/…` is already a ref namespace anyone may write to.
   * A document rendered from the flag by itself would describe a handoff no
   * push could make.
   *
   * `publicAccess` is deliberately NOT in it, where Private needs it: a
   * Proposal is a push, and a push proves its key with the certificate inside
   * the pack rather than with the one `authorization` header a deployment token
   * occupies. A credentialed deployment can take Proposals from everyone it
   * gave a token to.
   */
  proposals: boolean
  /**
   * This deployment serves a browse of the repositories it holds — the list at
   * `/repos` (`shared/repo-list.ts`), and the repository pages under it
   * (`shared/browse.ts`).
   *
   * A plain flag, read on BOTH sides: at the edge to claim the routes, and in
   * the container to decide whether `/_walgit/browse` exists — the list is
   * answered off the log and never wakes the container, but a tree is git
   * objects and only the Cache holds those. Default off, because a
   * deployment's repository names are the one
   * thing a credentialed instance has not already been asked to publish — the
   * credential still gates the route, but enumerating names is a surface an
   * operator opts into rather than acquires on upgrade.
   */
  web: boolean
  /** A repository is collected this many hours after its last push. */
  retentionHours: number | null
  /** Largest single push, in bytes. */
  maxPushBytes: number | null
  /** Largest total size of one repository, in bytes. */
  maxRepoBytes: number | null
  /**
   * Anything at all is bounded PER SOURCE — what one client may spend in a
   * window (`src/rate-limit.ts`).
   *
   * A predicate rather than three `!== null` tests at each renderer, for the
   * reason `namesCanRefuse` and `namesCanBeClaimed` are both fields: a document
   * that combined them for itself would be a fourth place the rule lives.
   */
  sourceLimited: boolean
  /**
   * The window the three limits below are counted in, in seconds.
   *
   * The one number here that is never `null`: it is not a limit, it is the unit
   * the limits are stated in, and a deployment that sets a count without a
   * window means the default one rather than no window at all. Unset,
   * unparseable and non-positive all read as the default, for the reason
   * `positiveNumber` collapses them everywhere else — a typo must not become a
   * zero-length window, which would refuse nothing, or an infinite one, which
   * would refuse a client forever.
   */
  rateWindowSeconds: number
  /** New repository names one source may create per window. */
  maxNewReposPerSource: number | null
  /** Pushes one source may make per window. */
  maxPushesPerSource: number | null
  /** Bytes one source may push per window. */
  maxPushBytesPerSource: number | null
}

/**
 * The window a deployment gets when it bounds a count and says nothing about
 * over what. An hour: long enough that an ordinary working session is one
 * window, short enough that a client refused inside it does not give up on the
 * host.
 */
export const DEFAULT_RATE_WINDOW_SECONDS = 3600

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
  const publicAccess = flagEnabled(env.WALGIT_PUBLIC)

  const maxNewReposPerSource = positiveNumber(env.WALGIT_MAX_NEW_REPOS_PER_SOURCE)
  const maxPushesPerSource = positiveNumber(env.WALGIT_MAX_PUSHES_PER_SOURCE)
  const maxPushBytesPerSource = positiveNumber(env.WALGIT_MAX_PUSH_BYTES_PER_SOURCE)

  return {
    publicAccess,
    appendOnly: flagEnabled(env.WALGIT_APPEND_ONLY),
    // Blank collapses to unset, the same reading `announceConfigFromEnv`
    // (`src/announce.ts`) makes of the same two variables — the config the push
    // path announces with and this advertisement cannot be allowed to disagree.
    events: nonBlank(env.WALGIT_EVENTS_URL) && nonBlank(env.WALGIT_EVENTS_TOKEN),
    signedPushes,
    namesCanRefuse,
    namesCanBeClaimed: namesCanRefuse && signedPushes,
    namesCanBePrivate:
      namesCanRefuse &&
      signedPushes &&
      publicAccess &&
      seedValue(env.WALGIT_PRIVATE_REPOS) !== null,
    proposals: namesCanRefuse && signedPushes && flagEnabled(env.WALGIT_PROPOSALS),
    web: flagEnabled(env.WALGIT_WEB),
    retentionHours: positiveNumber(env.WALGIT_RETENTION_HOURS),
    maxPushBytes: positiveNumber(env.WALGIT_MAX_PUSH_BYTES),
    maxRepoBytes: positiveNumber(env.WALGIT_MAX_REPO_BYTES),
    sourceLimited:
      maxNewReposPerSource !== null ||
      maxPushesPerSource !== null ||
      maxPushBytesPerSource !== null,
    rateWindowSeconds:
      positiveNumber(env.WALGIT_RATE_WINDOW_SECONDS) ?? DEFAULT_RATE_WINDOW_SECONDS,
    maxNewReposPerSource,
    maxPushesPerSource,
    maxPushBytesPerSource,
  }
}

const nonBlank = (raw: string | undefined): boolean => typeof raw === 'string' && raw.trim() !== ''
