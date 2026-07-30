// The resource table. Adding a Cloudflare product to c9s is one entry here and
// nothing else: the number key, the `:` completion, and the table all derive from
// this list.
//
// Keys beginning with `_` are metadata, not columns: `_raw` carries the API object
// through to the describe pane, `_id` the handle wrangler needs.
import { type Cf, age, bytes, get } from './cf'
import { micros, workerMetrics } from './metrics'
import { projectOf, taggedService } from './project'

export type Row = Record<string, string>
export type Kind = {
  key: string
  /** Typed at the `:` prompt. k9s-style short forms, so `:co` reaches containers. */
  aliases: string[]
  title: string
  columns: string[]
  /** `load` lets derived kinds (all, projects) run over injected rows instead of the network. */
  list(cf: Cf, load?: (kind: Kind) => Promise<Row[]>): Promise<Row[]>
  /** Set when rows can be tailed (`l`) or shelled into (`s`). */
  actions?: { tail?: boolean; ssh?: boolean }
}

export const isMeta = (k: string) => k.startsWith('_')

const workers: Kind = {
  key: 'workers',
  aliases: ['wk', 'w'],
  title: 'Workers',
  columns: ['NAME', 'REQ', 'ERR', 'P50', 'DEPLOYED', 'LOGS'],
  actions: { tail: true },
  async list(cf) {
    type W = {
      id: string
      created_on: string
      modified_on: string
      tags?: string[] | null
      observability?: { enabled?: boolean }
    }
    // Metrics never block the table: workerMetrics swallows its own failures.
    const [ws, metrics] = await Promise.all([
      get<W[]>(cf, `/accounts/${cf.accountId}/workers/scripts`),
      workerMetrics(cf),
    ])
    return ws.map((w) => {
      const m = metrics.get(w.id)
      return {
        NAME: w.id,
        REQ: m ? String(m.requests) : '-',
        ERR: m ? String(m.errors) : '-',
        P50: micros(m?.p50),
        DEPLOYED: age(w.modified_on),
        LOGS: w.observability?.enabled ? 'on' : 'off',
        _id: w.id,
        _project: taggedService(w.tags) ?? '',
        _raw: JSON.stringify(w, null, 2),
      }
    })
  },
}

const containers: Kind = {
  key: 'containers',
  aliases: ['co', 'ct', 'c'],
  title: 'Containers',
  columns: ['NAME', 'DESIRED', 'VCPU', 'MEMORY', 'VER', 'AGE'],
  actions: { ssh: true },
  async list(cf) {
    type A = {
      id: string
      name: string
      instances: number
      version: number
      created_at: string
      configuration: { vcpu: number; memory: string }
    }
    const apps = await get<A[]>(cf, `/accounts/${cf.accountId}/containers/applications`)
    return apps.map((a) => ({
      NAME: a.name,
      DESIRED: String(a.instances),
      VCPU: String(a.configuration.vcpu),
      MEMORY: a.configuration.memory,
      VER: String(a.version),
      AGE: age(a.created_at),
      _id: a.id,
      _raw: JSON.stringify(a, null, 2),
    }))
  },
}

const durableObjects: Kind = {
  key: 'do',
  aliases: ['durable', 'dobj'],
  title: 'Durable Objects',
  columns: ['NAME', 'SCRIPT', 'CLASS', 'SQLITE', 'CONTAINER'],
  async list(cf) {
    type D = {
      id: string
      name: string
      script: string
      class: string
      use_sqlite?: boolean
      use_containers?: boolean
    }
    const ns = await get<D[]>(cf, `/accounts/${cf.accountId}/workers/durable_objects/namespaces`)
    return ns.map((d) => ({
      NAME: d.name,
      SCRIPT: d.script,
      CLASS: d.class,
      SQLITE: d.use_sqlite ? 'yes' : 'no',
      CONTAINER: d.use_containers ? 'yes' : 'no',
      _id: d.id,
      // A DO namespace belongs to its script, which is stronger than any name guess.
      _project: d.script,
      _raw: JSON.stringify(d, null, 2),
    }))
  },
}

const d1: Kind = {
  key: 'd1',
  aliases: ['db', 'sql'],
  title: 'D1',
  columns: ['NAME', 'SIZE', 'AGE'],
  async list(cf) {
    type D = { uuid: string; name: string; file_size?: number; created_at: string }
    const dbs = await get<D[]>(cf, `/accounts/${cf.accountId}/d1/database`)
    return dbs.map((d) => ({
      NAME: d.name,
      SIZE: bytes(d.file_size),
      AGE: age(d.created_at),
      _id: d.uuid,
      _raw: JSON.stringify(d, null, 2),
    }))
  },
}

const r2: Kind = {
  key: 'r2',
  aliases: ['bucket', 'buckets'],
  title: 'R2',
  columns: ['NAME', 'AGE'],
  async list(cf) {
    // R2 is the one product that nests its list under a named key.
    const { buckets } = await get<{ buckets: { name: string; creation_date: string }[] }>(
      cf,
      `/accounts/${cf.accountId}/r2/buckets`,
    )
    return buckets.map((b) => ({
      NAME: b.name,
      AGE: age(b.creation_date),
      _id: b.name,
      _raw: JSON.stringify(b, null, 2),
    }))
  },
}

const kv: Kind = {
  key: 'kv',
  aliases: ['ns'],
  title: 'KV',
  columns: ['NAME', 'ID'],
  async list(cf) {
    type K = { title: string; id: string }
    const ns = await get<K[]>(cf, `/accounts/${cf.accountId}/storage/kv/namespaces`)
    return ns.map((k) => ({ NAME: k.title, ID: k.id, _id: k.id, _raw: JSON.stringify(k, null, 2) }))
  },
}

const queues: Kind = {
  key: 'queues',
  // No 'q' alias: `:q` is quit, per every vi-descended TUI including k9s.
  aliases: ['queue'],
  title: 'Queues',
  columns: ['NAME', 'PRODUCERS', 'CONSUMERS', 'AGE'],
  async list(cf) {
    type Q = {
      queue_id: string
      queue_name: string
      created_on: string
      producers_total_count?: number
      consumers_total_count?: number
    }
    const qs = await get<Q[]>(cf, `/accounts/${cf.accountId}/queues`)
    return qs.map((q) => ({
      NAME: q.queue_name,
      PRODUCERS: String(q.producers_total_count ?? 0),
      CONSUMERS: String(q.consumers_total_count ?? 0),
      AGE: age(q.created_on),
      _id: q.queue_id,
      _raw: JSON.stringify(q, null, 2),
    }))
  },
}

const PRODUCTS: Kind[] = [workers, containers, durableObjects, d1, r2, kv, queues]

/** Everything, attributed to a project. The view the Cloudflare dashboard cannot give you. */
const all: Kind = {
  key: 'all',
  aliases: ['a', 'everything'],
  title: 'All',
  columns: ['PROJECT', 'KIND', 'NAME', 'DETAIL'],
  async list(cf, load) {
    const fetchKind = load ?? ((k: Kind) => k.list(cf))
    const perKind = await Promise.all(
      PRODUCTS.map(async (k) => {
        try {
          return { kind: k, rows: await fetchKind(k) }
        } catch {
          // One product failing (scope, beta gate) must not blank the whole view.
          return { kind: k, rows: [] as Row[] }
        }
      }),
    )
    const anchors = (perKind.find((p) => p.kind.key === 'workers')?.rows ?? []).map(
      (r) => r.NAME ?? '',
    )
    return perKind.flatMap(({ kind, rows }) =>
      rows.map((row) => ({
        PROJECT: row._project || projectOf(row.NAME ?? '', anchors),
        KIND: kind.title,
        NAME: row.NAME ?? '',
        // Second column of each product's table, whatever it happens to be.
        DETAIL: `${kind.columns[1] ?? ''}=${row[kind.columns[1] ?? ''] ?? '-'}`,
        _id: row._id ?? '',
        _kind: kind.key,
        _raw: row._raw ?? '',
      })),
    )
  },
}

/** Rollup of `all`: one line per project, counts per product. */
const projects: Kind = {
  key: 'projects',
  aliases: ['proj', 'p'],
  title: 'Projects',
  columns: ['PROJECT', 'TOTAL', ...PRODUCTS.map((k) => k.key.toUpperCase())],
  async list(cf, load) {
    const rows = await all.list(cf, load)
    const byProject = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const p = r.PROJECT ?? '-'
      const counts = byProject.get(p) ?? new Map<string, number>()
      counts.set(r._kind ?? '', (counts.get(r._kind ?? '') ?? 0) + 1)
      byProject.set(p, counts)
    }
    return [...byProject.entries()]
      .map(([project, counts]) => {
        const total = [...counts.values()].reduce((a, b) => a + b, 0)
        const cells = Object.fromEntries(
          PRODUCTS.map((k) => [k.key.toUpperCase(), String(counts.get(k.key) ?? 0)]),
        )
        return { PROJECT: project, TOTAL: String(total), ...cells, _id: project }
      })
      .toSorted((a, b) => Number(b.TOTAL) - Number(a.TOTAL) || a.PROJECT.localeCompare(b.PROJECT))
  },
}

export const KINDS: Kind[] = [...PRODUCTS, all, projects]

/** Kinds whose key or any alias starts with `input`, keys before aliases. */
export function matchKinds(input: string): Kind[] {
  const q = input.trim().toLowerCase()
  if (!q) return KINDS
  const byKey = KINDS.filter((k) => k.key.startsWith(q))
  const byAlias = KINDS.filter((k) => !byKey.includes(k) && k.aliases.some((a) => a.startsWith(q)))
  return [...byKey, ...byAlias]
}

/** The ghost text shown after the cursor: the rest of the best match's key. */
export function completion(input: string): string {
  const q = input.trim().toLowerCase()
  if (!q) return ''
  const best = matchKinds(q)[0]
  return best?.key.startsWith(q) ? best.key.slice(q.length) : ''
}

/** `:proj <name>` / `:project <name>` / `:p <name>` — the one command that takes an argument. */
const PROJ_ARG = /^(?:proj|project|p)\s+(\S*)$/

/** How many project names fit on the prompt's single candidate line. */
const PROJ_CANDIDATES = 8

/**
 * What the prompt should show for `input`: ghost text plus the candidate line.
 *
 * The command prompt has two halves. At the head you are naming a resource kind,
 * which `matchKinds`/`completion` already cover. After `:proj ` you are naming a
 * *project*, and c9s is the only thing that knows what those are — the account is
 * a flat bag, so the list is inferred, never queryable. `known` is that inferred
 * list, passed in rather than fetched, so this stays pure.
 */
export function suggest(
  input: string,
  known: string[],
): { completion: string; candidates: string[] } {
  const arg = PROJ_ARG.exec(input.trimStart().toLowerCase())
  if (!arg)
    return { completion: completion(input), candidates: matchKinds(input).map((k) => k.key) }

  const q = arg[1] ?? ''
  // `all` clears the scope, so it is a real value of this input, not a project.
  const hits = [...known, 'all'].filter((p) => p.toLowerCase().startsWith(q))
  const shown = hits.slice(0, PROJ_CANDIDATES)
  return {
    completion: hits[0] ? hits[0].slice(q.length) : '',
    // The prompt box is fixed-height: a wrapped candidate line would push the
    // table past the terminal, so elide the tail instead of rendering all of it.
    candidates:
      hits.length > shown.length ? [...shown, `+${hits.length - shown.length} more`] : shown,
  }
}
