// A stand-in for the Clients part (packages/clients): what `bun test` asks instead of the real one for the screens, and what a local page shows with fixture data (`SPACE_FIXTURES`, src/app.ts) so Settings › Clients and
// People's Link to a Client can be seen and photographed with no Durable Object. It keeps the contract's shapes (packages/workspace/src/clients.ts) and the rules the screens lean on: a number from 1001 while a source is on,
// a name and legal name cut to their limits, an edit that names the revision it was shown (`conflict` when it has moved), archive and put back, and nothing deleted. The rules themselves are the real store's, proven over a
// real SQLite in packages/clients/test and again, through the Worker, in test/clients-settings.test.ts; this holds only enough of them to draw the page.
//
// Every call is recorded, and a script can make the next one fail, so a test can see what was and was not sent.

import {
  answered,
  CLIENT_LEGAL_NAME_MAX,
  CLIENT_LOCAL_NUMBER_FROM,
  CLIENT_NAME_MAX,
  type Client,
  type ClientList,
  type ClientsCounts,
  type ClientsForSpace,
  type ClientSourceStatus,
  failed,
  refused,
  type SpaceReply,
} from '@space/workspace'

export interface StandInClientsState {
  clients: Client[]
  /** The source's status, or null for an install with none. */
  source: ClientSourceStatus | null
}

export interface StandInClients {
  /** Every call, by method and its arguments after the asker. */
  calls: { method: string; args: unknown[] }[]
  state: StandInClientsState
  /** What the next call does instead of the normal thing: `throw` (the part cannot be reached), `hang` (never answers), `broken` (a fault). */
  script: ('throw' | 'hang' | 'broken')[]
  methods: ClientsForSpace
}

const MIN = 60_000
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** A Client brought in by a source: its fields, as `Client` holds them. */
export function sourced(over: Partial<Client> & { number: number; name: string }, source: Partial<NonNullable<Client['source']>> & { said?: { name: string; legalName: string | null } } = {}, now = Date.now()): Client {
  return {
    legalName: null,
    createdAt: now - 5 * 24 * 60 * MIN,
    createdBy: 'source:northfield.example',
    updatedAt: now - 2 * 24 * 60 * MIN,
    updatedBy: 'source:northfield.example',
    archivedAt: null,
    archivedBy: null,
    revision: 1,
    ...over,
    source: {
      source: 'northfield.example',
      externalId: String(over.number),
      url: `https://admin.example.test/clients#client-${over.number}`,
      said: { name: over.name, legalName: over.legalName ?? null },
      extra: {},
      goneSince: null,
      ...source,
    },
  }
}

/** The Clients every local page and screenshot starts with: five that northfield.example brought in (one renamed here, one it no longer lists, one archived) and one made here. */
export function fixtureClients(now: number): StandInClientsState {
  const day = 24 * 60 * MIN
  return {
    source: { name: 'northfield.example', lastPushAt: now - 12 * MIN, lastSyncAt: now - 9 * 60 * MIN, syncedCount: 5 },
    clients: [
      sourced(
        { number: 3, name: 'Tamarack Print Supply', legalName: 'Tamarack Print Supply Co.', revision: 2, updatedAt: now - 3 * day, updatedBy: 'tessa@northfield.example' },
        { said: { name: 'Tamarack Print Supply Co', legalName: 'Tamarack Print Supply Co.' }, extra: { signInAddress: 'nils@tamarackprint.example', subscriptionStatus: 'incomplete_expired', subscriptionAt: new Date(now - 6 * day).toISOString() } },
        now,
      ),
      sourced({ number: 6, name: 'Greenleaf Landscaping' }, { goneSince: now - 3 * day, extra: { signInAddress: 'hello@greenleaf.example', subscriptionStatus: 'canceled', subscriptionAt: new Date(now - 20 * day).toISOString() } }, now),
      sourced(
        { number: 7, name: 'Harbor Dental', legalName: 'Harbor Dental Group, Inc.' },
        { extra: { signInAddress: 'dana@harbordental.example', subscriptionStatus: 'active', subscriptionAt: new Date(now - 2 * day).toISOString() } },
        now,
      ),
      sourced({ number: 9, name: 'Lakeside Print Supply' }, { extra: { subscriptionStatus: 'active', subscriptionAt: new Date(now - 4 * day).toISOString() } }, now),
      sourced({ number: 5, name: 'Old Harbor Marine', archivedAt: now - 8 * day, archivedBy: 'tessa@northfield.example', revision: 3, updatedAt: now - 8 * day, updatedBy: 'tessa@northfield.example' }, { extra: { subscriptionStatus: 'canceled', subscriptionAt: new Date(now - 40 * day).toISOString() } }, now),
      {
        number: 1001,
        name: 'Fischer Bakery',
        legalName: null,
        createdAt: now - 2 * day,
        createdBy: 'tessa@northfield.example',
        updatedAt: now - 2 * day,
        updatedBy: 'tessa@northfield.example',
        archivedAt: null,
        archivedBy: null,
        revision: 1,
        source: null,
      },
    ],
  }
}

export function standInClients(initial: StandInClientsState, options: { now?: () => number } = {}): StandInClients {
  const state: StandInClientsState = { clients: initial.clients.map((c) => structuredClone(c)), source: initial.source }
  const calls: StandInClients['calls'] = []
  const script: StandInClients['script'] = []
  const now = options.now ?? Date.now

  async function enter<T>(method: string, args: unknown[]): Promise<SpaceReply<T> | null> {
    calls.push({ method, args })
    const step = script.shift()
    if (step === 'throw') throw new Error('stand-in Clients part lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    if (step === 'broken') return failed('The Clients could not answer that. Nothing was changed.')
    return null
  }

  const find = (number: number): Client | undefined => state.clients.find((c) => c.number === number)
  const nameChecked = (raw: string): { ok: true; value: string } | { ok: false; error: string } => {
    const name = oneLine(raw)
    if (name === '') return { ok: false, error: 'A Client needs a name.' }
    if (Array.from(name).length > CLIENT_NAME_MAX) return { ok: false, error: `A name is at most ${CLIENT_NAME_MAX} characters.` }
    return { ok: true, value: name }
  }
  const legalChecked = (raw: string | null | undefined): { ok: true; value: string | null } | { ok: false; error: string } => {
    const legal = raw === undefined || raw === null ? '' : oneLine(raw)
    if (legal === '') return { ok: true, value: null }
    if (Array.from(legal).length > CLIENT_LEGAL_NAME_MAX) return { ok: false, error: `A legal name is at most ${CLIENT_LEGAL_NAME_MAX} characters.` }
    return { ok: true, value: legal }
  }
  const localBase = state.source ? CLIENT_LOCAL_NUMBER_FROM : 1
  const lowestFree = (): number => {
    let n = localBase
    while (find(n)) n += 1
    return n
  }
  const keep = (c: Client): Client => structuredClone(c)

  const methods: ClientsForSpace = {
    async clients(_asker) {
      const early = await enter<ClientList>('clients', [])
      if (early) return early
      const all = [...state.clients].sort((x, y) => x.number - y.number)
      return answered({ active: all.filter((c) => c.archivedAt === null).map(keep), archived: all.filter((c) => c.archivedAt !== null).map(keep), source: state.source })
    },
    async client(_asker, number) {
      const early = await enter<Client>('client', [number])
      if (early) return early
      const found = find(number)
      return found ? answered(keep(found)) : refused('not-found', 'No such Client.')
    },
    async makeClient(_asker, make) {
      const early = await enter<Client>('makeClient', [make])
      if (early) return early
      const name = nameChecked(make.name)
      if (!name.ok) return refused('bad-request', name.error)
      const legal = legalChecked(make.legalName)
      if (!legal.ok) return refused('bad-request', legal.error)
      const at = now()
      const made: Client = { number: lowestFree(), name: name.value, legalName: legal.value, createdAt: at, createdBy: 'tessa@northfield.example', updatedAt: at, updatedBy: 'tessa@northfield.example', archivedAt: null, archivedBy: null, revision: 1, source: null }
      state.clients.push(made)
      return answered(keep(made))
    },
    async editClient(_asker, number, revision, edit) {
      const early = await enter<Client>('editClient', [number, revision, edit])
      if (early) return early
      const found = find(number)
      if (!found) return refused('not-found', 'No such Client.')
      if (found.revision !== revision) return refused('conflict', 'This Client was changed after it was shown, so nothing was changed. It is shown as it is now.')
      if (edit.name === undefined && edit.legalName === undefined) return refused('bad-request', 'Say what to change: the name, the legal name, or both.')
      let name = found.name
      let legalName = found.legalName
      if (edit.name !== undefined) {
        const n = nameChecked(edit.name)
        if (!n.ok) return refused('bad-request', n.error)
        name = n.value
      }
      if (edit.legalName !== undefined) {
        const l = legalChecked(edit.legalName)
        if (!l.ok) return refused('bad-request', l.error)
        legalName = l.value
      }
      if (name === found.name && legalName === found.legalName) return answered(keep(found))
      Object.assign(found, { name, legalName, updatedAt: now(), updatedBy: 'tessa@northfield.example', revision: found.revision + 1 })
      return answered(keep(found))
    },
    async archiveClient(_asker, number) {
      const early = await enter<Client>('archiveClient', [number])
      if (early) return early
      const found = find(number)
      if (!found) return refused('not-found', 'No such Client.')
      if (found.archivedAt === null) Object.assign(found, { archivedAt: now(), archivedBy: 'tessa@northfield.example', updatedAt: now(), updatedBy: 'tessa@northfield.example', revision: found.revision + 1 })
      return answered(keep(found))
    },
    async putBackClient(_asker, number) {
      const early = await enter<Client>('putBackClient', [number])
      if (early) return early
      const found = find(number)
      if (!found) return refused('not-found', 'No such Client.')
      if (found.archivedAt !== null) Object.assign(found, { archivedAt: null, archivedBy: null, updatedAt: now(), updatedBy: 'tessa@northfield.example', revision: found.revision + 1 })
      return answered(keep(found))
    },
    async storeBookmark(_asker) {
      return (await enter<{ bookmark: string }>('storeBookmark', [])) ?? answered({ bookmark: '00000000-00000006-00005118-0123456789abcdef0123456789abcdef' })
    },
    async restartStore(_asker) {
      return (await enter<{ restarted: true }>('restartStore', [])) ?? answered({ restarted: true as const })
    },
    async storeCounts(_asker) {
      const early = await enter<ClientsCounts>('storeCounts', [])
      if (early) return early
      const sourceKept = state.clients.filter((c) => c.source !== null)
      return answered({
        clients: state.clients.length,
        active: state.clients.filter((c) => c.archivedAt === null).length,
        archived: state.clients.filter((c) => c.archivedAt !== null).length,
        fromSource: sourceKept.length,
        madeHere: state.clients.length - sourceKept.length,
        gone: sourceKept.filter((c) => c.source?.goneSince != null).length,
        highest: Math.max(0, ...state.clients.map((c) => c.number)),
        source: state.source,
        schema: 1,
      })
    },
  }

  return { calls, state, script, methods }
}
