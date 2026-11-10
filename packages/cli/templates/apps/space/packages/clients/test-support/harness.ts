import { createInstall, type ExternalFields, type Install, signedIn, sourceActor } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { migrate } from '../src/schema'
import { ClientsStore, localApi, type StoreApi } from '../src/store'
import { memoryDatabase } from './sql-over-sqlite'

/** The clock tests start at, and what the assertions are good until. */
export const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)

export const OWNER = 'tessa@northfield.example'
export const SOURCE = 'northfield.example'
export const SOURCE_ACTOR = sourceActor(SOURCE)

/** Northfield's install: an owner, and the Clients door naming `northfield.example` as the source. */
export const NORTHFIELD = createInstall(declaration)

/** Northfield's declaration with a teammate who is not an owner, for the faces. */
export const WITH_TEAMMATE: Install = createInstall({
  ...declaration,
  people: [...declaration.people, { address: 'dana@northfield.example', name: 'Dana', role: 'member' }],
})

export const owner = () => signedIn(WITH_TEAMMATE.person(OWNER)!, Math.floor(T0 / 1000) + 3600)
export const teammate = () => signedIn(WITH_TEAMMATE.person('dana@northfield.example')!, Math.floor(T0 / 1000) + 3600)

/** What a source says of a Client, with the fields a test does not care about filled in. */
export const says = (name: string, over: Partial<ExternalFields> = {}): ExternalFields => ({
  preferredNumber: null,
  name,
  legalName: null,
  url: null,
  extra: {},
  ...over,
})

/** A store over a real SQLite with the real migrations and a clock that moves only when told. `sources` is the declared source (default: Northfield's), or none for an install that has no source. */
export function harness(opts: { owners?: readonly string[]; sources?: readonly string[] } = {}) {
  const mem = memoryDatabase()
  migrate(mem.sql)
  let at = T0
  const store = new ClientsStore({
    sql: mem.sql,
    transaction: mem.transaction,
    now: () => new Date(at),
    owners: opts.owners ?? [OWNER],
    ownerName: 'Tessa',
    sources: opts.sources ?? [SOURCE],
  })
  const api: StoreApi = localApi(store)
  return {
    ...mem,
    store,
    api,
    tick: (ms = 60_000) => {
      at += ms
    },
    now: () => at,
    rows: <T>(sql: string): T[] => mem.db.query(sql).all() as T[],
    /** The source's push of one Client, as the door's face would make it. */
    push: (id: string, fields: ExternalFields) => store.upsertExternal(SOURCE, id, fields, SOURCE_ACTOR),
    gone: (id: string) => store.markGone(SOURCE, id, SOURCE_ACTOR),
    sync: (clients: unknown) => store.syncExternal(SOURCE, clients, SOURCE_ACTOR),
    make: (name: string, legalName: string | null = null) => store.make(name, legalName, OWNER),
  }
}

export type Harness = ReturnType<typeof harness>

/** The value of a result that must have succeeded. */
export function must<T>(r: { ok: true; value: T } | { ok: false; reason: string; error: string }): T {
  if (!r.ok) throw new Error(`expected success, got ${r.reason}: ${r.error}`)
  return r.value
}
