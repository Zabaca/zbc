/**
 * The load run's arithmetic and its verdict — everything `load.ts` decides
 * that does not need the network.
 *
 * It lives apart from the driver because the driver is the part that must not
 * be doubled: pointing it at a stub would measure the stub. What CAN be
 * checked without a deployment is whether the numbers coming back are read
 * correctly — a percentile that counts a 9-second failure as a 9-second
 * latency, or a verdict that names the slowest workload rather than the one
 * that broke, is a wrong answer written down with a date on it.
 */

/** What one operation did. `ms` is wall time; only an `ok` one is a latency. */
export interface Sample {
  ms: number
  outcome: 'ok' | 'error' | 'limited'
  /** The remote's own words, for a refusal or a failure. */
  detail?: string
}

export interface OpSummary {
  /** Every attempt, whatever it did. */
  n: number
  ok: number
  errors: number
  /** Refused by the deployment's per-source rate limit (`src/rate-limit.ts`). */
  limited: number
  /** Milliseconds, over the successful attempts alone. Null when there were none. */
  min: number | null
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}

/**
 * Nearest rank: the pth percentile is the ceil(p/100 × n)-th smallest sample.
 *
 * Chosen over interpolation because every number this produces is a latency
 * something actually experienced, which is what a report gets read for.
 */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null
}

/**
 * The percentiles are over SUCCESSES only.
 *
 * A connection that died after nine seconds did not serve anything in nine
 * seconds, and a rate-limit refusal answered in 40 ms is not the service being
 * fast. Blending either into the latency distribution makes a degrading run
 * look better the more it fails, so both are counted instead.
 */
export function summarize(samples: readonly Sample[]): OpSummary {
  const durations = samples
    .filter((sample) => sample.outcome === 'ok')
    .map((sample) => sample.ms)
    .toSorted((a, b) => a - b)

  return {
    n: samples.length,
    ok: durations.length,
    errors: samples.filter((sample) => sample.outcome === 'error').length,
    limited: samples.filter((sample) => sample.outcome === 'limited').length,
    min: durations[0] ?? null,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] ?? null,
  }
}

export interface Bottleneck {
  /** The workload that degraded first, or null when none of them ran. */
  op: string | null
  /** p99 ÷ p50 for that workload, when it is a slowness verdict. */
  ratio: number | null
  reason: string
}

/**
 * Which workload degraded first.
 *
 * Two rules, in order. A workload that FAILED or was REFUSED outranks every
 * merely slow one however fast it was — a broken thing is not a fast thing.
 * Among the rest the verdict is p99 ÷ p50 rather than absolute p99, because a
 * clone is honestly slower than a websocket handshake and comparing them
 * absolutely would name the heaviest workload every time. A tail that is a
 * multiple of its own median is the shape of a queue, which is what one
 * container serving every repository produces when it saturates.
 */
export function nameBottleneck(summaries: Readonly<Record<string, OpSummary>>): Bottleneck {
  const ran = Object.entries(summaries).filter(([, summary]) => summary.n > 0)
  if (ran.length === 0) return { op: null, ratio: null, reason: 'nothing ran' }

  const broken = ran
    .filter(([, summary]) => summary.errors > 0 || summary.limited > 0)
    .toSorted((a, b) => b[1].errors + b[1].limited - (a[1].errors + a[1].limited))
  if (broken.length > 0) {
    const [op, summary] = broken[0] as [string, OpSummary]
    const parts = [
      summary.errors > 0 ? `${summary.errors}/${summary.n} failed` : '',
      summary.limited > 0 ? `${summary.limited}/${summary.n} rate-limited` : '',
    ].filter(Boolean)
    return { op, ratio: null, reason: parts.join(', ') }
  }

  const ratios = ran
    .filter(([, summary]) => summary.p50 !== null && summary.p50 > 0 && summary.p99 !== null)
    .map(([op, summary]) => ({ op, ratio: (summary.p99 as number) / (summary.p50 as number) }))
    .toSorted((a, b) => b.ratio - a.ratio)
  const worst = ratios[0]
  if (!worst) return { op: null, ratio: null, reason: 'nothing completed' }

  return {
    op: worst.op,
    ratio: worst.ratio,
    reason: `p99 is ${worst.ratio.toFixed(1)}x its own p50`,
  }
}

export interface LoadOptions {
  origin: string
  /** Concurrent clones of the seeded repositories. */
  clones: number
  /** Concurrent pushes, one per seeded repository at a time. */
  pushes: number
  /** Concurrent websocket subscribers on the ref-event stream. */
  watchers: number
  /** How many scratch repositories to seed — each one is a NEW NAME. */
  repos: number
  /** Where to write the machine-readable record, if anywhere. */
  json: string | null
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * What one source may spend against agentgit production in an hour
 * (`packages/infra/environments/production/walgit-public.ts`).
 *
 * The run refuses to plan past a fraction of it. Not politeness: a run that
 * spends the budget measures `src/rate-limit.ts` rather than the service, and
 * it burns the rest of the hour for whoever measures next — from the same IP,
 * which on a NAT is more people than the operator.
 */
const BUDGET = {
  newRepos: 20,
  pushes: 300,
  /** Of each, what one run may take. */
  share: 0.5,
} as const

export function parseLoadArgs(argv: readonly string[]): Parsed<LoadOptions> {
  const value: LoadOptions = {
    origin: '',
    clones: 8,
    pushes: 8,
    watchers: 8,
    // One per concurrent push, per the rule below: the default plan has to be
    // a legal one, or the bare `--origin` invocation is refused.
    repos: 8,
    json: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    const next = argv[index + 1]
    const takes = (): string | null => {
      if (next === undefined || next.startsWith('--')) return null
      index += 1
      return next
    }

    switch (flag) {
      case '--origin': {
        const origin = takes()
        if (origin === null) return { ok: false, error: '--origin needs a URL' }
        value.origin = origin.replace(/\/+$/, '')
        break
      }
      case '--json': {
        const path = takes()
        if (path === null) return { ok: false, error: '--json needs a path' }
        value.json = path
        break
      }
      case '--clones':
      case '--pushes':
      case '--watchers':
      case '--repos': {
        const raw = takes()
        const count = Number(raw)
        if (raw === null || !Number.isInteger(count) || count < 0) {
          return { ok: false, error: `${flag} needs a non-negative integer` }
        }
        value[flag.slice(2) as 'clones' | 'pushes' | 'watchers' | 'repos'] = count
        break
      }
      default:
        return { ok: false, error: `unknown argument: ${flag}` }
    }
  }

  if (value.origin === '') return { ok: false, error: '--origin is required' }

  const repoCap = Math.floor(BUDGET.newRepos * BUDGET.share)
  if (value.repos > repoCap) {
    return {
      ok: false,
      error: `--repos ${value.repos} would spend more than half the deployment's per-source budget of ${BUDGET.newRepos} new names an hour; at most ${repoCap}`,
    }
  }
  const pushCap = Math.floor(BUDGET.pushes * BUDGET.share)
  // Seeding is a push too, and so is the one that wakes the watchers.
  const plannedPushes = value.repos + value.pushes + (value.watchers > 0 ? 1 : 0)
  if (plannedPushes > pushCap) {
    return {
      ok: false,
      error: `${plannedPushes} pushes would spend more than half the deployment's per-source budget of ${BUDGET.pushes} an hour; at most ${pushCap}`,
    }
  }
  // One repository per concurrent pusher. Two pushes racing for the same ref
  // means one of them loses the compare-and-swap and is refused as a
  // non-fast-forward — git being right, recorded as the host giving way, which
  // would make a report understate capacity and name the wrong bottleneck.
  if (value.pushes > value.repos) {
    return {
      ok: false,
      error: `--pushes ${value.pushes} with --repos ${value.repos} would race two pushes for the same ref; give at least one repository per concurrent push`,
    }
  }
  if (value.repos === 0 && (value.clones > 0 || value.pushes > 0)) {
    return { ok: false, error: 'nothing to clone or push: --repos is 0' }
  }

  return { ok: true, value }
}
