import { describe, expect, it } from 'bun:test'
import { type Sample, nameBottleneck, parseLoadArgs, summarize } from './load-report'

/**
 * The load run's arithmetic and its verdict, away from the network.
 *
 * Everything here is a known-good literal or the nearest-rank definition
 * worked by hand — never the implementation's own arithmetic restated, which
 * would agree with a wrong percentile as readily as a right one.
 */

const ok = (ms: number): Sample => ({ ms, outcome: 'ok' })

describe('summarize', () => {
  it('reports nearest-rank percentiles', () => {
    // 1..10 ms, shuffled. Nearest rank: p50 -> ceil(0.50*10) = 5th smallest = 5,
    // p95 -> ceil(0.95*10) = 10th = 10, p99 -> 10th = 10.
    const samples = [7, 2, 9, 4, 1, 10, 5, 3, 8, 6].map(ok)

    expect(summarize(samples)).toEqual({
      n: 10,
      ok: 10,
      errors: 0,
      limited: 0,
      min: 1,
      p50: 5,
      p95: 10,
      p99: 10,
      max: 10,
    })
  })

  it('counts a rate-limit refusal apart from a transport error, and times neither', () => {
    const samples: Sample[] = [
      ok(100),
      ok(300),
      { ms: 40, outcome: 'limited', detail: 'too many new repositories' },
      { ms: 9000, outcome: 'error', detail: 'connection reset' },
    ]

    const summary = summarize(samples)

    expect(summary.n).toBe(4)
    expect(summary.ok).toBe(2)
    expect(summary.limited).toBe(1)
    expect(summary.errors).toBe(1)
    // The 9000 ms failure and the 40 ms refusal are outcomes, not latencies:
    // a run that died at 9 s did not serve anything in 9 s.
    expect(summary.p50).toBe(100)
    expect(summary.max).toBe(300)
  })

  it('has no percentiles when nothing succeeded', () => {
    const summary = summarize([{ ms: 5, outcome: 'error', detail: 'refused' }])

    expect(summary.ok).toBe(0)
    expect(summary.p50).toBeNull()
    expect(summary.p99).toBeNull()
  })

  it('is empty rather than absent for a workload that did not run', () => {
    expect(summarize([])).toEqual({
      n: 0,
      ok: 0,
      errors: 0,
      limited: 0,
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    })
  })
})

describe('nameBottleneck', () => {
  it('names the workload whose p99 degrades furthest from its own p50', () => {
    const verdict = nameBottleneck({
      clone: { ...summarize([ok(100), ok(120)]), n: 2 },
      push: { ...summarize([ok(500), ok(520)]), n: 2 },
      // p99 5x its p50: the shape of a queue, not of a slow operation.
      watch: { ...summarize([ok(40), ok(200)]), n: 2 },
    })

    expect(verdict.op).toBe('watch')
    expect(verdict.ratio).toBe(5)
  })

  it('names a workload that failed over one that was merely slow', () => {
    const verdict = nameBottleneck({
      clone: summarize([ok(50), ok(4000)]),
      push: summarize([ok(100), { ms: 10, outcome: 'error', detail: 'reset' }]),
    })

    expect(verdict.op).toBe('push')
    expect(verdict.reason).toContain('failed')
  })

  it('names nothing when nothing ran', () => {
    expect(nameBottleneck({}).op).toBeNull()
  })
})

describe('parseLoadArgs', () => {
  it('requires an origin', () => {
    const parsed = parseLoadArgs([])
    expect(parsed.ok).toBe(false)
  })

  it('reads the three concurrencies', () => {
    const parsed = parseLoadArgs([
      '--origin',
      'https://agentgit.zabaca.com',
      '--clones',
      '8',
      '--pushes',
      '6',
      '--watchers',
      '12',
      '--repos',
      '6',
    ])

    expect(parsed).toEqual({
      ok: true,
      value: {
        origin: 'https://agentgit.zabaca.com',
        clones: 8,
        pushes: 6,
        watchers: 12,
        repos: 6,
        json: null,
      },
    })
  })

  it('refuses a run that would exceed the deployment budget it is measuring', () => {
    // agentgit production allows 20 new names and 300 pushes per source per
    // hour; a run that spends the whole budget measures the limiter.
    const parsed = parseLoadArgs(['--origin', 'https://x', '--repos', '40'])

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('budget')
  })

  it('refuses more concurrent pushes than there are repositories to push to', () => {
    // Two concurrent pushes to one ref: one of them loses the compare-and-swap
    // and is refused as a non-fast-forward. That is git being correct, and
    // counting it as a load failure overstates how early the host gives way.
    const parsed = parseLoadArgs(['--origin', 'https://x', '--repos', '4', '--pushes', '8'])

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('same ref')
  })

  it('refuses a trailing origin flag rather than reading the next flag as its value', () => {
    expect(parseLoadArgs(['--origin']).ok).toBe(false)
  })
})
