/**
 * Reading a limit, and saying what it is.
 *
 * Both halves state walgit's limits and only one of them enforces them: the
 * container refuses an oversized push in `pre-receive` (`src/limits.ts`), while
 * `GET /` (`src/instructions.ts`) and the landing page (`shared/landing.ts`)
 * describe the caps to whoever is about to push. A page that promised a number
 * the hook does not hold would be a lie told at the top of the funnel, and the
 * only reliable way not to tell it is for the statement and the enforcement to
 * read the same variable through the same function.
 *
 * That is why these two live here rather than in either half. `positiveNumber`
 * existed three times with two different return types, and `describeBytes`
 * twice with a comment promising they were kept identical.
 */

/**
 * A configured limit, or `null` for "this deployment enforces nothing here".
 *
 * Unset, blank, unparseable and non-positive all read as unset. Zero would
 * refuse every push, and a typo in a deployment variable must not silently
 * become "this host accepts nothing" — nor, on the page, a stated cap of `NaN`.
 */
export function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Both a unit and the raw byte count, so an agent comparing its own pack size
 * against this number never has to guess our rounding.
 *
 * `GET /`, the landing page and the refusal message all print a cap through
 * this one function: an agent reads the limit in one place and the refusal in
 * another, and two roundings would look like two different limits.
 */
export function describeBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  const mib = bytes / 1024 ** 2
  if (gib >= 1) return `${round(gib)} GiB (${bytes} bytes)`
  if (mib >= 1) return `${round(mib)} MiB (${bytes} bytes)`
  return `${bytes} bytes`
}

const round = (n: number) => String(Math.round(n * 100) / 100)

/**
 * A cap without its exact byte count.
 *
 * `describeBytes` renders `99 MiB (103809024 bytes)` because the refusal it was
 * written for is read by a client comparing a number to its own, and a
 * parenthetical there is the difference between a machine acting on the message
 * and a machine guessing at a rounded figure. On a page somebody is reading —
 * the landing page's fine print, a row in the repository list — the same nine
 * digits are noise in the middle of a sentence.
 *
 * DERIVED from `describeBytes` rather than formatted again, which is the whole
 * care here: the invariant is that the cap a document prints and the cap
 * `pre-receive` refuses on cannot look like two different numbers, and a second
 * formatter is exactly how they would. Stripping a suffix off the one rendering
 * cannot change the figure in front of it, so a document still cannot disagree
 * with the hook — it only says less.
 */
export function shortBytes(bytes: number): string {
  return describeBytes(bytes).replace(/ \(\d+ bytes\)$/, '')
}

/**
 * Is a boolean-ish walgit variable on?
 *
 * `1` or `true`, and nothing else. It lives here because BOTH halves have to
 * agree on it exactly: the container enforces append-only from this answer and
 * the Worker tells agents about it from the same one, and a Worker that read
 * only `1` would quietly stop mentioning a rule the push path was still
 * enforcing for `true` (docs/adr/0010).
 */
export function flagEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true'
}

/**
 * A configured secret seed, or `null` for "this deployment does not offer the
 * capability that seed IS".
 *
 * walgit has two of them — the push-certificate nonce seed (docs/adr/0011) and
 * the Private one the Read Challenge's nonce is derived from (docs/adr/0013) —
 * and they must not acquire two readings of "unset". Blank collapses to unset
 * for the reason a limit's blank does: a variable cleared to an empty string is
 * a capability turned off, not one seeded with nothing. git would take `""` as
 * a seed and derive perfectly usable nonces from it, so the collapse has to
 * happen here rather than at whatever writes the config.
 */
export function seedValue(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const seed = raw.trim()
  return seed === '' ? null : seed
}

/**
 * A window in the words both halves state it in.
 *
 * Here for the reason `describeBytes` is: the refusal a push reads
 * (`src/rate-limit.ts`) and the limit the two documents print are the same
 * window, and two spellings of "per hour" would look like two different rules.
 *
 * Whole hours and whole minutes are named as such, because that is how an
 * operator configured it and how a client waits it out. Anything else is stated
 * in seconds rather than rounded into a number somebody would then wait the
 * wrong amount of time on.
 */
export function describeWindow(seconds: number): string {
  const whole = Math.round(seconds)
  if (whole % 3600 === 0) {
    const hours = whole / 3600
    return hours === 1 ? 'hour' : `${hours} hours`
  }
  if (whole % 60 === 0) {
    const minutes = whole / 60
    return minutes === 1 ? 'minute' : `${minutes} minutes`
  }
  return `${whole} seconds`
}
