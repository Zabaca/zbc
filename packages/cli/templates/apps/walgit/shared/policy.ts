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
