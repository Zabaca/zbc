/**
 * Ceilings for scenario 7, keyed by WAL entry count.
 *
 * These gate the COMPACTED restore — the number that must stay flat, because a
 * compacted repository replays exactly one WAL entry however many pushes it has
 * ever taken. The raw number is measured and reported but not gated: it grows
 * with push count by design, and gating it would gate the size of the test
 * fixture rather than the behaviour of the code.
 *
 * They are deliberately loose. A shared CI runner's variance is large and a
 * gate that goes red on a noisy neighbour is a gate people learn to ignore;
 * these are set to catch a change of KIND — a restore that started downloading
 * every entry again, or one that lost its parallelism — not a change of ten
 * percent. Measured on a GitHub `ubuntu-latest` runner against a local
 * `FileStore`; a real bucket adds a network round trip per entry, so a run
 * against R2 should point `WALGIT_E2E_LATENCY_BASELINE` at its own file rather
 * than raise these.
 *
 * Raising a number here is a deliberate act with a reason attached. Doing it to
 * make a red build green is how a latency gate stops being one.
 */

export interface LatencyCeiling {
  /** Milliseconds. Compacted cold materialize, median. */
  p50: number
  /** Milliseconds. Compacted cold materialize, 99th percentile. */
  p99: number
}

export const LATENCY_BASELINE: Record<string, LatencyCeiling> = {
  '1': { p50: 400, p99: 1200 },
  '10': { p50: 400, p99: 1200 },
  '50': { p50: 500, p99: 1500 },
}
