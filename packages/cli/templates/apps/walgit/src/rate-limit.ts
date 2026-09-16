/**
 * Per-source rate limits: bound what one visitor can spend, in a window.
 *
 * The size caps beside this file (`src/limits.ts`) bound how big a push may be.
 * They say nothing about how OFTEN one may arrive, and the two are different
 * failures: a hundred 1 MiB pushes are each individually fine, and a hundred
 * new names are each individually free. One container serves every repository
 * (`wrangler.jsonc`, `max_instances: 1`), so a bored visitor filling the bucket
 * during a traffic spike is not merely storage — it is the queue everyone else
 * is behind.
 *
 * ── where the verdict is reached, and where it is spoken ────────────────────
 *
 * Reached in `src/http.ts`, because that is the only place that sees BOTH the
 * source the edge attributed the request to and the repository it names: the
 * hooks are processes git spawns, three down, and a header does not reach them.
 * Spoken by `pre-receive`, because a refusal at the HTTP layer is a status code
 * git reports as `RPC failed; HTTP …` — a transport fault, which a client
 * retries. The handler therefore hands the backend a refusal and the hook
 * prints it, so an over-limit push reads exactly the way an oversized one does:
 * a `remote:` reject line naming the limit and what to do next.
 *
 * ── what a "source" is ──────────────────────────────────────────────────────
 *
 * Whatever the Worker can see, which is the client IP (`cf-connecting-ip`, set
 * by Cloudflare at the edge and not forgeable by a client, since the container
 * is reachable only through the Worker). A request carrying no such header is
 * unattributable — a direct request to the container, a local deployment — and
 * is NOT limited: pooling everything walgit cannot name into one bucket would
 * make the first unattributable request throttle every other one.
 *
 * ── the counters are in memory, deliberately ────────────────────────────────
 *
 * A window that a container restart forgets. The alternative is a round trip to
 * the object store on every push to enforce a limit whose entire purpose is to
 * make a spike cheap, and the failure direction of forgetting is a visitor
 * getting one more window than it should — against a Durable Object write per
 * push, forever, on every deployment that turned this on. The table is capped
 * so a spike of distinct addresses cannot grow it without bound.
 *
 * Every limit is UNSET by default, and an unset one is not enforced and not
 * advertised — `capabilitiesFrom` (`shared/capabilities.ts`) is the one reading
 * both this file and the three documents take their numbers from.
 */

import type { Capabilities } from '../shared/capabilities'
import { describeBytes, describeWindow } from '../shared/policy'

export interface RateLimits {
  /** The window every count below is taken over, in milliseconds. */
  windowMs: number
  /** New repository names one source may create per window. `null` is unlimited. */
  maxNewRepos: number | null
  /** Pushes one source may make per window. `null` is unlimited. */
  maxPushes: number | null
  /** Bytes one source may push per window. `null` is unlimited. */
  maxPushBytes: number | null
}

/**
 * The limits this instance enforces, as the four of the capabilities this file
 * cares about — a projection, exactly as `limitsOf` is, so the number a page
 * prints and the number a push is refused on cannot be arrived at two ways.
 */
export function rateLimitsOf(caps: Capabilities): RateLimits {
  return {
    windowMs: caps.rateWindowSeconds * 1000,
    maxNewRepos: caps.maxNewReposPerSource,
    maxPushes: caps.maxPushesPerSource,
    maxPushBytes: caps.maxPushBytesPerSource,
  }
}

/** Is there anything to count? Nothing is tracked when there isn't. */
export function rateLimitsEnforced(limits: RateLimits): boolean {
  return limits.maxNewRepos !== null || limits.maxPushes !== null || limits.maxPushBytes !== null
}

/** Does any configured limit need to know whether the name is a new one? */
export function countsNewRepos(limits: RateLimits): boolean {
  return limits.maxNewRepos !== null
}

export type RateKind = 'new-repos' | 'pushes' | 'push-bytes'

export type RateVerdict = { ok: true } | { ok: false; kind: RateKind; message: string }

export interface RateCharge {
  /** The client the edge attributed this request to. */
  source: string
  /** The repository this push names. */
  repoId: string
  /** Does this push bring a name into existence? */
  creating: boolean
  /** Bytes this push declared, or 0 when it declared none. */
  bytes: number
}

/**
 * How many sources one instance remembers at once.
 *
 * A bound rather than a tuning knob: this table is fed by whoever shows up, so
 * an unbounded one is a memory leak an attacker chooses the size of. When it is
 * full the least recently seen source is dropped — which forgives it, the same
 * direction a restart forgives in, and the one that cannot refuse an innocent
 * client because somebody else arrived.
 */
const MAX_SOURCES = 10_000

type Spend = { at: number; bytes: number; creating: boolean }

export interface SourceLimiter {
  /** Judge one push and, when it is allowed, charge it to its source. */
  admit(charge: RateCharge): RateVerdict
}

/**
 * The window, as a table of what each source spent in it.
 *
 * Charged only for pushes it ALLOWS. A refused push costs the client nothing
 * further, so a client that keeps retrying is refused on the same spend rather
 * than digging a deeper hole it cannot see the bottom of — and the window
 * therefore always describes traffic walgit actually served.
 */
export function createSourceLimiter(
  limits: RateLimits,
  now: () => number = Date.now,
): SourceLimiter {
  const spends = new Map<string, Spend[]>()

  return {
    admit(charge) {
      const at = now()
      const since = at - limits.windowMs

      // Re-inserted on every touch, so Map iteration order is least-recently
      // seen first and the eviction below drops the right one.
      const previous = spends.get(charge.source)
      spends.delete(charge.source)
      const window = (previous ?? []).filter((spend) => spend.at > since)

      const verdict = judge(limits, window, charge)
      if (verdict.ok) window.push({ at, bytes: charge.bytes, creating: charge.creating })

      if (window.length > 0) {
        spends.set(charge.source, window)
        if (spends.size > MAX_SOURCES) {
          const oldest = spends.keys().next()
          if (!oldest.done) spends.delete(oldest.value)
        }
      }
      return verdict
    },
  }
}

/**
 * Judge one push against a source's window.
 *
 * Creation is judged FIRST, and the reason is the same one that puts the
 * per-push size cap ahead of the per-repository one: when a push trips both, the
 * actionable message is the one about the thing the client chose to do. "You
 * have created enough new names" tells it to push to a name it already has;
 * "you have pushed enough" would send it away from the host entirely for a
 * push that would have been fine under a name it already owns.
 */
function judge(limits: RateLimits, window: Spend[], charge: RateCharge): RateVerdict {
  const window_ = describeWindow(limits.windowMs / 1000)

  if (charge.creating && limits.maxNewRepos !== null) {
    const created = window.filter((spend) => spend.creating).length
    if (created >= limits.maxNewRepos) {
      return {
        ok: false,
        kind: 'new-repos',
        message: tooManyNewRepos(charge.repoId, limits.maxNewRepos, window_),
      }
    }
  }

  if (limits.maxPushes !== null && window.length >= limits.maxPushes) {
    return { ok: false, kind: 'pushes', message: tooManyPushes(limits.maxPushes, window_) }
  }

  if (limits.maxPushBytes !== null) {
    const spent = window.reduce((total, spend) => total + spend.bytes, 0)
    if (spent + charge.bytes > limits.maxPushBytes) {
      return {
        ok: false,
        kind: 'push-bytes',
        message: tooManyBytes(spent, charge.bytes, limits.maxPushBytes, window_),
      }
    }
  }

  return { ok: true }
}

/**
 * Product copy, and the same discipline the size caps are written with: say
 * which limit, say the number, and say the one thing to do next. A rate limit
 * is the refusal most likely to be read by something that will simply try
 * again, so each message states that waiting is the remedy and roughly what
 * for.
 */
function tooManyNewRepos(repoId: string, cap: number, window: string): string {
  return [
    `walgit: refused — ${repoId} would be your ${cap + 1}${ordinal(cap + 1)} new repository this ${window}.`,
    '',
    `This host lets one client create ${cap} ${plural(cap, 'repository', 'repositories')} per ${window}.`,
    'This is a walgit limit, not a network failure. Retrying now will be refused',
    'again in the same way.',
    '',
    'What you can do instead:',
    `  - push to a name you already created — the limit is on NEW names, not on pushes`,
    `  - or wait out the ${window} and push again`,
    '',
    'Nothing was uploaded; no repository was created.',
  ].join('\n')
}

function tooManyPushes(cap: number, window: string): string {
  return [
    `walgit: refused — you have already made ${cap} ${plural(cap, 'push', 'pushes')} this ${window}.`,
    '',
    `This host lets one client push ${cap} ${plural(cap, 'time', 'times')} per ${window}.`,
    'This is a walgit limit, not a network failure. Retrying now will be refused',
    'again in the same way.',
    '',
    'What you can do instead:',
    '  - combine your work into fewer pushes: commit locally, then push once',
    `  - or wait out the ${window} and push again`,
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

function tooManyBytes(spent: number, bytes: number, cap: number, window: string): string {
  return [
    `walgit: refused — this push would take you past ${describeBytes(cap)} pushed this ${window}.`,
    '',
    `You have pushed ${describeBytes(spent)} in the last ${window} and this push adds`,
    `${describeBytes(bytes)}.`,
    'This is a walgit limit, not a network failure. Retrying now will be refused',
    'again in the same way.',
    '',
    'What you can do instead:',
    '  - push less at once, or leave large files out of the repository entirely',
    `  - or wait out the ${window} and push again`,
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** `1st`, `2nd`, `3rd`, `4th` — the suffix only, so the number reads naturally. */
function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th'
  if (n % 10 === 1) return 'st'
  if (n % 10 === 2) return 'nd'
  if (n % 10 === 3) return 'rd'
  return 'th'
}
