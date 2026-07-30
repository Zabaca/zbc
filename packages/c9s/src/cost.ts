// Money. Cloudflare publishes usage everywhere and dollars nowhere: there is no
// billing field on the GraphQL account node, and `/accounts/{id}/billing/*`
// rejects API tokens outright, so a price only ever appears in the dashboard.
// c9s therefore carries its own rate card and multiplies. Every number this file
// produces is an estimate, which makes REVISED the most important line in it.
import { type Cf, graphql } from './cf'

/** When the rate card below was last read off Cloudflare's pricing pages. */
export const REVISED = '2026-07-30'

const M = 1_000_000

/**
 * One billable meter on the Workers Paid plan.
 *
 * `included` is monthly and *account-wide*, never per resource, which is the
 * whole difficulty of this view: Cloudflare bills an account, c9s reports
 * projects. `estimate` decides how the allowance is shared out.
 */
export type Rate = {
  key: string
  /** Resource kind the usage belongs to, so a sample can be attributed to a row. */
  kind: string
  label: string
  unit: string
  included: number
  /** Dollars per unit above `included`; for gauges, dollars per unit-month. */
  price: number
  /** Storage: a level rather than a flow, charged monthly at its current size. */
  gauge?: boolean
}

/** Positional so the rate card reads as a table: key, kind, label, unit, included, price. */
const meter = (
  key: string,
  kind: string,
  label: string,
  unit: string,
  included: number,
  price: number,
  gauge = false,
): Rate => ({ key, kind, label, unit, included, price, gauge })

export const RATES: Rate[] = [
  meter('workers.requests', 'workers', 'requests', 'req', 10 * M, 0.3 / M),
  meter('workers.cpu', 'workers', 'CPU', 'CPU-ms', 30 * M, 0.02 / M),

  // Containers bill provisioned memory and disk but *actual* CPU, which is why a
  // container can cost real money while its CPU column rounds to nothing.
  meter('containers.memory', 'containers', 'memory', 'GiB-s', 90_000, 0.0000025),
  meter('containers.cpu', 'containers', 'CPU', 'vCPU-s', 22_500, 0.00002),
  meter('containers.disk', 'containers', 'disk', 'GB-s', 720_000, 0.00000007),
  // Egress is priced by region (0.025 in NA/EU, up to 0.05 elsewhere). c9s bills it
  // all at the NA/EU rate rather than fanning every query out over `region`.
  meter('containers.egress', 'containers', 'egress', 'GB', 1000, 0.025),

  meter('do.requests', 'do', 'requests', 'req', 1 * M, 0.15 / M),
  meter('do.duration', 'do', 'duration', 'GB-s', 400_000, 12.5 / M),
  meter('do.rowsRead', 'do', 'rows read', 'rows', 25_000 * M, 0.001 / M),
  meter('do.rowsWritten', 'do', 'rows written', 'rows', 50 * M, 1.0 / M),
  meter('do.storage', 'do', 'storage', 'GB', 5, 0.2, true),

  meter('d1.rowsRead', 'd1', 'rows read', 'rows', 25_000 * M, 0.001 / M),
  meter('d1.rowsWritten', 'd1', 'rows written', 'rows', 50 * M, 1.0 / M),
  meter('d1.storage', 'd1', 'storage', 'GB', 5, 0.75, true),

  meter('r2.classA', 'r2', 'class A ops', 'ops', 1 * M, 4.5 / M),
  meter('r2.classB', 'r2', 'class B ops', 'ops', 10 * M, 0.36 / M),
  meter('r2.storage', 'r2', 'storage', 'GB', 10, 0.015, true),

  meter('kv.reads', 'kv', 'reads', 'ops', 10 * M, 0.5 / M),
  meter('kv.writes', 'kv', 'writes', 'ops', 1 * M, 5.0 / M),
  meter('kv.deletes', 'kv', 'deletes', 'ops', 1 * M, 5.0 / M),
  meter('kv.lists', 'kv', 'lists', 'ops', 1 * M, 5.0 / M),
  meter('kv.storage', 'kv', 'storage', 'GB', 1, 0.5, true),

  meter('queues.ops', 'queues', 'operations', 'ops', 1 * M, 0.4 / M),
]

const RATE = new Map(RATES.map((r) => [r.key, r]))

/** Usage of one meter by one resource, over the window that was queried. */
export type Sample = { rate: string; id: string; amount: number }

/** Where a resource id came from, so a sample can be given a name and a project. */
export type Resource = { kind: string; id: string; name: string; project: string }

export type Line = {
  rate: Rate
  name: string
  amount: number
  mtd: number
  projected: number
}

export type ProjectCost = {
  project: string
  mtd: number
  projected: number
  /** Projected dollars per resource kind, for the table's product columns. */
  byKind: Record<string, number>
  lines: Line[]
}

/** Usage that survived a resource being deleted, or that Cloudflare never named. */
export const UNATTRIBUTED = '(unknown)'

const GB = 1e9
const GIB = 1024 ** 3

/**
 * Class A costs 12.5× Class B, so the mapping matters more than its length
 * suggests. The named sets are Cloudflare's own lists.
 */
const CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
])
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
])

/** The meter an R2 operation bills against, or undefined when it is free. */
export function r2Class(action: string): string | undefined {
  if (CLASS_A.has(action)) return 'r2.classA'
  if (CLASS_B.has(action)) return 'r2.classB'
  // Deletes and aborts are free, and Cloudflare ships operations faster than it
  // updates the pricing page — `GetBucketSippyConfiguration` is live and listed
  // nowhere. Fall back to the verb, and bill an unfamiliar one as Class A: an
  // estimate that reads high sends you to look, one that reads low sends you a bill.
  if (/^(Delete|Abort)/.test(action)) return undefined
  if (/^(Get|Head)/.test(action)) return 'r2.classB'
  return 'r2.classA'
}

/** KV prices reads 10× below everything else, so only reads may be assumed. */
export function kvClass(action: string): string {
  const a = action.toLowerCase()
  if (a.startsWith('read')) return 'kv.reads'
  if (a.startsWith('delete')) return 'kv.deletes'
  if (a.startsWith('list')) return 'kv.lists'
  return 'kv.writes'
}

/**
 * How much of the current UTC month has elapsed, as a fraction.
 *
 * Floored at a day: on the 1st a linear projection off two hours of usage is a
 * 300× multiplier, and a cost view that screams on the first of the month is a
 * cost view people learn to ignore.
 */
export function elapsedMonth(now = new Date()): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  return Math.max((now.getTime() - start) / (end - start), 1 / 31)
}

/** First day of the current UTC month, as the `Date` scalar the API wants. */
export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

/** Yesterday: storage is read as a level, and today's row may not exist yet. */
export function recent(now = new Date()): string {
  return new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * Dollars per project, from raw usage.
 *
 * The one real decision here is what to do with an included allowance. It is
 * account-wide, so it cannot be given to any single project without lying about
 * the others; instead each meter's *billable* remainder (usage above the
 * allowance) is shared out in proportion to usage. An account inside its free
 * tier therefore shows zero everywhere, which is the common case and the honest
 * answer, and an account over it shows each project paying its share of the
 * overage rather than an invented per-project free tier.
 */
export function estimate(
  samples: Sample[],
  resources: Resource[],
  elapsed = elapsedMonth(),
): ProjectCost[] {
  const byId = new Map(resources.map((r) => [`${r.kind}:${r.id}`, r]))

  // One meter per resource. R2 and KV arrive split by operation name — a dozen
  // `class B ops` lines for one bucket — and a breakdown you have to add up
  // yourself is not a breakdown.
  const merged = new Map<string, Sample>()
  for (const s of samples) {
    const key = `${s.rate} ${s.id}`
    const prev = merged.get(key)
    if (prev) prev.amount += s.amount
    else merged.set(key, { ...s })
  }

  const totals = new Map<string, number>()
  for (const s of merged.values()) totals.set(s.rate, (totals.get(s.rate) ?? 0) + s.amount)

  const projects = new Map<string, ProjectCost>()
  for (const s of merged.values()) {
    const rate = RATE.get(s.rate)
    const total = totals.get(s.rate) ?? 0
    if (!rate || total <= 0 || s.amount <= 0) continue

    const share = s.amount / total
    const billable = (used: number) => rate.price * Math.max(used - rate.included, 0) * share
    // A gauge is already a monthly figure; a flow has to be extrapolated to one.
    const projected = rate.gauge ? billable(total) : billable(total / elapsed)
    const mtd = rate.gauge ? billable(total) * elapsed : billable(total)

    const res = byId.get(`${rate.kind}:${s.id}`)
    const name = res?.name ?? s.id
    const project = res?.project ?? UNATTRIBUTED

    const p = projects.get(project) ?? {
      project,
      mtd: 0,
      projected: 0,
      byKind: {},
      lines: [] as Line[],
    }
    p.mtd += mtd
    p.projected += projected
    p.byKind[rate.kind] = (p.byKind[rate.kind] ?? 0) + projected
    p.lines.push({ rate, name, amount: s.amount, mtd, projected })
    projects.set(project, p)
  }

  for (const p of projects.values()) {
    p.lines.sort((a, b) => b.projected - a.projected || a.name.localeCompare(b.name))
  }
  return [...projects.values()].toSorted(
    (a, b) => b.projected - a.projected || a.project.localeCompare(b.project),
  )
}

/** `~$17.51`, or `-` for a line that costs nothing. The `~` is the point. */
export function usd(n: number): string {
  if (n <= 0) return '-'
  if (n < 0.01) return '<$0.01'
  return `~$${n.toFixed(2)}`
}

/** Compact usage: 6.2M, 953k, 41. */
export function qty(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}G`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return abs >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1)
}

/** The describe pane for a cost row: every meter that charged this project. */
export function breakdown(p: ProjectCost): string {
  // Ink gives an empty <Text> no height at all, so spacer lines have to be a space.
  const gap = ' '
  const out = [
    `${p.project}: ~$${p.projected.toFixed(2)}/mo projected, ~$${p.mtd.toFixed(2)} month to date`,
    gap,
  ]
  const kinds = [...new Set(p.lines.map((l) => l.rate.kind))].toSorted(
    (a, b) => (p.byKind[b] ?? 0) - (p.byKind[a] ?? 0),
  )
  for (const kind of kinds) {
    const total = p.byKind[kind] ?? 0
    // `-/mo` would read as missing data rather than as the answer, which for most
    // products on most accounts is that the usage never left the free tier.
    out.push(`${kind.toUpperCase()} — ${total > 0 ? `${usd(total)}/mo` : 'within the free tier'}`)
    for (const l of p.lines.filter((x) => x.rate.kind === kind)) {
      const used = `${qty(l.amount)} ${l.rate.unit}`
      out.push(
        `  ${l.name.padEnd(30)} ${l.rate.label.padEnd(13)} ${used.padEnd(16)} ${usd(l.projected)}`,
      )
    }
    out.push(gap)
  }
  out.push(
    'Estimated from Cloudflare usage analytics against the Workers Paid rate card',
    `(rates read ${REVISED}). Account-wide included allowances are shared out in`,
    'proportion to usage; storage is charged at its latest observed size; the $5',
    'plan fee and any non-compute products are not counted. This is not an invoice.',
  )
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

type Block = Record<
  string,
  {
    dimensions: Record<string, string>
    sum?: Record<string, number>
    max?: Record<string, number>
  }[]
>

/**
 * Every product is queried separately rather than in one document, so a token
 * missing one scope (or a beta gate on one product) costs that product's numbers
 * instead of the whole view — the same rule the All view follows.
 */
type Collector = { body: string; read(b: Block): Sample[] }

const rows = (b: Block, k: string) => b[k] ?? []

const COLLECTORS: Collector[] = [
  {
    body: `workersInvocationsAdaptive(limit: 1000, filter: { date_geq: $since }) {
      dimensions { scriptName } sum { requests cpuTimeUs } }`,
    read: (b) =>
      rows(b, 'workersInvocationsAdaptive').flatMap((r) => {
        const id = r.dimensions.scriptName ?? ''
        return [
          { rate: 'workers.requests', id, amount: r.sum?.requests ?? 0 },
          // Microseconds on the wire, milliseconds on the invoice.
          { rate: 'workers.cpu', id, amount: (r.sum?.cpuTimeUs ?? 0) / 1000 },
        ]
      }),
  },
  {
    body: `containersUsageAdaptiveGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { applicationId } sum { cpuTimeSec allocatedMemory allocatedDisk txBytes } }`,
    read: (b) =>
      rows(b, 'containersUsageAdaptiveGroups').flatMap((r) => {
        const id = r.dimensions.applicationId ?? ''
        // allocatedMemory and allocatedDisk arrive as byte-seconds.
        return [
          { rate: 'containers.memory', id, amount: (r.sum?.allocatedMemory ?? 0) / GIB },
          { rate: 'containers.cpu', id, amount: r.sum?.cpuTimeSec ?? 0 },
          { rate: 'containers.disk', id, amount: (r.sum?.allocatedDisk ?? 0) / GB },
          { rate: 'containers.egress', id, amount: (r.sum?.txBytes ?? 0) / GB },
        ]
      }),
  },
  {
    body: `durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { namespaceId } sum { requests } }
    durableObjectsPeriodicGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { namespaceId } sum { duration rowsRead rowsWritten } }
    durableObjectsSqlStorageGroups(limit: 1000, filter: { date_geq: $recent }) {
      dimensions { namespaceId } max { storedBytes } }`,
    read: (b) => [
      ...rows(b, 'durableObjectsInvocationsAdaptiveGroups').map((r) => ({
        rate: 'do.requests',
        id: r.dimensions.namespaceId ?? '',
        amount: r.sum?.requests ?? 0,
      })),
      ...rows(b, 'durableObjectsPeriodicGroups').flatMap((r) => {
        const id = r.dimensions.namespaceId ?? ''
        return [
          // `duration` is already GB-s: Cloudflare has applied the 128 MB per
          // object itself. `activeTime` next to it is raw microseconds — using
          // that one would overstate duration by about 7.8 million.
          { rate: 'do.duration', id, amount: r.sum?.duration ?? 0 },
          { rate: 'do.rowsRead', id, amount: r.sum?.rowsRead ?? 0 },
          { rate: 'do.rowsWritten', id, amount: r.sum?.rowsWritten ?? 0 },
        ]
      }),
      // Only SQLite-backed storage is attributable: the KV-backed dataset
      // (durableObjectsStorageGroups) carries no namespace dimension at all.
      ...rows(b, 'durableObjectsSqlStorageGroups').map((r) => ({
        rate: 'do.storage',
        id: r.dimensions.namespaceId ?? '',
        amount: (r.max?.storedBytes ?? 0) / GB,
      })),
    ],
  },
  {
    body: `d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { databaseId } sum { rowsRead rowsWritten } }
    d1StorageAdaptiveGroups(limit: 1000, filter: { date_geq: $recent }) {
      dimensions { databaseId } max { databaseSizeBytes } }`,
    read: (b) => [
      ...rows(b, 'd1AnalyticsAdaptiveGroups').flatMap((r) => {
        const id = r.dimensions.databaseId ?? ''
        return [
          { rate: 'd1.rowsRead', id, amount: r.sum?.rowsRead ?? 0 },
          { rate: 'd1.rowsWritten', id, amount: r.sum?.rowsWritten ?? 0 },
        ]
      }),
      ...rows(b, 'd1StorageAdaptiveGroups').map((r) => ({
        rate: 'd1.storage',
        id: r.dimensions.databaseId ?? '',
        amount: (r.max?.databaseSizeBytes ?? 0) / GB,
      })),
    ],
  },
  {
    body: `r2OperationsAdaptiveGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { bucketName actionType } sum { requests } }
    r2StorageAdaptiveGroups(limit: 1000, filter: { date_geq: $recent }) {
      dimensions { bucketName } max { payloadSize metadataSize } }`,
    read: (b) => [
      ...rows(b, 'r2OperationsAdaptiveGroups').flatMap((r) => {
        const rate = r2Class(r.dimensions.actionType ?? '')
        return rate
          ? [{ rate, id: r.dimensions.bucketName ?? '', amount: r.sum?.requests ?? 0 }]
          : []
      }),
      ...rows(b, 'r2StorageAdaptiveGroups').map((r) => ({
        rate: 'r2.storage',
        id: r.dimensions.bucketName ?? '',
        amount: ((r.max?.payloadSize ?? 0) + (r.max?.metadataSize ?? 0)) / GB,
      })),
    ],
  },
  {
    body: `kvOperationsAdaptiveGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { namespaceId actionType } sum { requests } }
    kvStorageAdaptiveGroups(limit: 1000, filter: { date_geq: $recent }) {
      dimensions { namespaceId } max { byteCount } }`,
    read: (b) => [
      ...rows(b, 'kvOperationsAdaptiveGroups').map((r) => ({
        rate: kvClass(r.dimensions.actionType ?? ''),
        id: r.dimensions.namespaceId ?? '',
        amount: r.sum?.requests ?? 0,
      })),
      ...rows(b, 'kvStorageAdaptiveGroups').map((r) => ({
        rate: 'kv.storage',
        id: r.dimensions.namespaceId ?? '',
        amount: (r.max?.byteCount ?? 0) / GB,
      })),
    ],
  },
  {
    body: `queueMessageOperationsAdaptiveGroups(limit: 1000, filter: { date_geq: $since }) {
      dimensions { queueId } sum { billableOperations } }`,
    read: (b) =>
      rows(b, 'queueMessageOperationsAdaptiveGroups').map((r) => ({
        rate: 'queues.ops',
        id: r.dimensions.queueId ?? '',
        amount: r.sum?.billableOperations ?? 0,
      })),
  },
]

type Response = { viewer: { accounts: Block[] } }

/**
 * Month-to-date usage for every billable meter. Like `workerMetrics`, a failure
 * is a hole in the numbers rather than an error: a token without analytics scope
 * still gets a table, it just reads `-`.
 */
export async function usage(cf: Cf, now = new Date()): Promise<Sample[]> {
  const variables = { account: cf.accountId, since: monthStart(now), recent: recent(now) }
  const results = await Promise.all(
    COLLECTORS.map(async (c) => {
      const query = `query($account: string!, $since: Date!, $recent: Date!) {
        viewer { accounts(filter: { accountTag: $account }) { ${c.body} } } }`
      try {
        const data = await graphql<Response>(cf, query, variables)
        const block = data.viewer.accounts[0]
        return block ? c.read(block) : []
      } catch (e) {
        if (process.env.C9S_DEBUG) throw e
        return []
      }
    }),
  )
  return results.flat().filter((s) => s.amount > 0)
}
