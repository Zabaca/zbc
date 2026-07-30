import { expect, test } from 'bun:test'
import { UNATTRIBUTED, elapsedMonth, estimate, kvClass, r2Class } from './cost'

const worker = (id: string, project: string) => ({ kind: 'workers', id, name: id, project })

test('usage inside the account allowance costs nothing', () => {
  // 4M requests against the 10M included per month: the projects exist, but there
  // is nothing to charge them for, so the view has nothing to say.
  const rows = estimate(
    [
      { rate: 'workers.requests', id: 'a', amount: 3_000_000 },
      { rate: 'workers.requests', id: 'b', amount: 1_000_000 },
    ],
    [worker('a', 'alpha'), worker('b', 'beta')],
    1,
  )
  expect(rows.map((r) => [r.project, r.projected])).toEqual([
    ['alpha', 0],
    ['beta', 0],
  ])
})

test('an overage is shared out in proportion to usage', () => {
  // 16M requests, 10M of them free. The 6M billable cost $1.80, and `a` burned
  // three quarters of the traffic, so it wears three quarters of the bill —
  // rather than each project being handed its own imaginary 10M allowance.
  const rows = estimate(
    [
      { rate: 'workers.requests', id: 'a', amount: 12_000_000 },
      { rate: 'workers.requests', id: 'b', amount: 4_000_000 },
    ],
    [worker('a', 'alpha'), worker('b', 'beta')],
    1,
  )
  expect(rows.map((r) => [r.project, Number(r.projected.toFixed(4))])).toEqual([
    ['alpha', 1.35],
    ['beta', 0.45],
  ])
})

test('flows are projected to month end, levels are not', () => {
  // Half a month in. 8M requests so far is 16M by month end, which clears the
  // allowance even though today it does not — so month-to-date is 0 and the
  // projection is $1.80. Storage is already a monthly figure: 30GB less the 10GB
  // included is $0.30/mo however much of the month has run, of which half has
  // accrued so far.
  const [row] = estimate(
    [
      { rate: 'workers.requests', id: 'a', amount: 8_000_000 },
      { rate: 'r2.storage', id: 'bucket', amount: 30 },
    ],
    [worker('a', 'alpha'), { kind: 'r2', id: 'bucket', name: 'bucket', project: 'alpha' }],
    0.5,
  )
  expect(row?.byKind.workers).toBeCloseTo(1.8, 10)
  expect(row?.byKind.r2).toBeCloseTo(0.3, 10)
  expect(row?.mtd).toBeCloseTo(0.15, 10)
})

test('usage outlives its resource rather than vanishing from the total', () => {
  // A worker deleted mid-month still billed for what it ran. Dropping the sample
  // would quietly make the account's rows add up to less than its invoice.
  const rows = estimate(
    [{ rate: 'workers.requests', id: 'deleted-last-week', amount: 20_000_000 }],
    [],
    1,
  )
  expect(rows[0]?.project).toBe(UNATTRIBUTED)
  expect(rows[0]?.lines[0]?.name).toBe('deleted-last-week')
})

test('one meter per resource, however many operations fed it', () => {
  // R2 reports per operation name, so GetObject and HeadObject arrive as separate
  // Class B samples for the same bucket. They are one line on the bill.
  const [row] = estimate(
    [
      { rate: 'r2.classB', id: 'assets', amount: 6_000_000 },
      { rate: 'r2.classB', id: 'assets', amount: 8_000_000 },
    ],
    [{ kind: 'r2', id: 'assets', name: 'assets', project: 'alpha' }],
    1,
  )
  expect(row?.lines).toHaveLength(1)
  expect(row?.lines[0]?.amount).toBe(14_000_000)
  // 14M ops, 10M included, 4M billable at $0.36/million.
  expect(row?.projected).toBeCloseTo(1.44, 10)
})

test('R2 operations are classed by name, then by verb', () => {
  expect(r2Class('PutObject')).toBe('r2.classA')
  expect(r2Class('GetObject')).toBe('r2.classB')
  // Free, and 1.4% of this account's operations.
  expect(r2Class('DeleteObject')).toBeUndefined()
  expect(r2Class('AbortMultipartUpload')).toBeUndefined()
  // Live on the API, absent from the pricing page: read as the cheap class it
  // plainly is, not billed at 12.5× on a technicality.
  expect(r2Class('GetBucketSippyConfiguration')).toBe('r2.classB')
  // Unrecognisable, so estimate high: a number that reads wrong sends you looking.
  expect(r2Class('RewriteEverything')).toBe('r2.classA')
})

test('KV assumes the expensive class for anything but a read', () => {
  expect(kvClass('read')).toBe('kv.reads')
  expect(kvClass('list')).toBe('kv.lists')
  expect(kvClass('something-new')).toBe('kv.writes')
})

test('the projection multiplier is floored at a day', () => {
  // Two hours into the month, a linear projection off usage so far is a 360×
  // multiplier and every row screams. Cap it at a day's worth.
  const twoHoursIn = new Date('2026-07-01T02:00:00Z')
  expect(elapsedMonth(twoHoursIn)).toBeCloseTo(1 / 31, 10)
  const midMonth = new Date('2026-07-16T12:00:00Z')
  expect(elapsedMonth(midMonth)).toBeCloseTo(0.5, 10)
})
