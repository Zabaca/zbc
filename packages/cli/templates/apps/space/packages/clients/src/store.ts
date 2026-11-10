/**
 * The Clients: the one list of businesses an install serves, each with a number that every link and address names. Made, edited and archived by the install's owner in the space, and, where the install has an
 * outside system that keeps Clients of its own, brought in by that system's pushes. The rules are the knowledge store's way of working (packages/knowledge/src/store.ts): this class has never seen `env`, `ctx`,
 * `cloudflare:workers` or a Durable Object. It takes PORTS (a `sql`, a `transaction`, a clock, the owners and the declared source) and the Durable Object in durable.ts is a shell that builds one of these and forwards
 * to it, so every rule here runs under plain `bun` against a REAL SQLite with the REAL migrations.
 *
 * ── RESULTS, NOT THROWS ──────────────────────────────────────────────────
 * A refusal is a value: `{ ok: false, reason, error }`, the reason one of the contract's (`RefusalReason`). An error thrown inside a Durable Object reaches the Worker through RPC as a bare Error with its type and
 * fields stripped.
 *
 * ── WHO MAY WRITE ────────────────────────────────────────────────────────
 * The owner makes, edits, archives and puts back: each refuses any other actor here (a default-deny on the actor), as well as at the face that admitted them. The one declared SOURCE writes its own Clients, by an
 * actor that is exactly `source:<its name>`, and nothing else; a push in any other source's name is refused. Nothing deletes a Client, whoever asks.
 *
 * ── THE SOURCE'S COPY AND THE SPACE'S ────────────────────────────────────
 * A Client a source brought in keeps, beside its own name and legal name, what the source last SAID of them (`said`, whole). Its name follows the source's only while it still equals what the source last said,
 * so a name edited in the space stands against every later push, and a name never touched follows a rename at the source. Everything else the source says (its address of the Client, its other fields) is the
 * source's, replaced whole on every push and never edited here. Archived is the space's alone. A Client the source says is gone is marked, with the time, and kept; sending it again clears the mark.
 *
 * ── NUMBERS ──────────────────────────────────────────────────────────────
 * A number is a whole number from 1, the row's own id, so it is never reused. A Client made in the space takes the lowest free number from `CLIENT_LOCAL_NUMBER_FROM` while the install has a source (so the
 * source's own numbers stay free), and from 1 with none. A Client brought in keeps the number the source asks for when it is free, and otherwise takes the lowest free local number.
 */

import {
  CLIENT_EXTERNAL_ID,
  CLIENT_EXTRA_KEY,
  CLIENT_EXTRA_MOST,
  CLIENT_EXTRA_VALUE_MAX,
  CLIENT_LEGAL_NAME_MAX,
  CLIENT_LOCAL_NUMBER_FROM,
  CLIENT_NAME_MAX,
  CLIENT_SAID_MAX,
  CLIENT_SYNC_MAX,
  CLIENT_URL_MAX,
  type Client,
  type ClientGone,
  type ClientListing,
  type ClientSourcePart,
  type ClientSourceStatus,
  type ClientsCounts,
  type ClientsSynced,
  type ClientUpserted,
  type ExternalClient,
  type ExternalFields,
  type RefusalReason,
  sourceActor,
} from '@space/workspace'
import { isRecord } from './reply'
import { CLIENTS_VERSION, type ClientsSql } from './schema'

export interface ClientsPorts {
  sql: ClientsSql
  /** Commit if `fn` returns, roll back if it throws. A Durable Object's `transactionSync`. */
  transaction: <T>(fn: () => T) => T
  /** Injected so nothing here reads the wall clock, and so tests can fix it. */
  now: () => Date
  /** The addresses of the install's owners: the only actors that make, edit, archive and put back. */
  owners: readonly string[]
  /** The owner's name as the sentences a person is shown say it (the install's first owner: "Tessa"). */
  ownerName: string
  /** The sources the declaration names (none, or the Clients door's one): the only names a push is accepted in. With one, a Client made in the space is numbered from `CLIENT_LOCAL_NUMBER_FROM`. */
  sources: readonly string[]
}

export type Refusal = { ok: false; reason: RefusalReason; error: string }
export type Result<T> = { ok: true; value: T } | Refusal

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (reason: RefusalReason, error: string): Refusal => ({ ok: false, reason, error })

/** The sentences a refusal shows, with the owner named by the install and not written in here. */
export const onlyTheOwner = (owner: string): string => `Only ${owner} changes the Clients.`
export const ONLY_THE_SOURCE = 'Only the source changes its own Clients, and only in its own name.'
export const NO_SUCH_CLIENT = 'No such Client.'
/** Why an edit that named a revision was refused: the Client is not the one its author was shown. */
export const CLIENT_CHANGED = 'This Client was changed after it was shown, so nothing was changed. It is shown as it is now.'

/** A name, one line: runs of white space are one space. The ONE cleaning, for what a write checks and stores and for what a source says. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const length = (s: string): number => Array.from(s).length
const cut = (s: string, max: number): string => Array.from(s).slice(0, max).join('').trim()

/** What a Client's name is while it follows the source: what the source said, cut to the longest name. */
export const followName = (said: string): string => cut(said, CLIENT_NAME_MAX)
/** What a Client's legal name is while it follows the source: what the source said, cut, or none. */
export const followLegal = (said: string | null): string | null => (said === null ? null : cut(said, CLIENT_LEGAL_NAME_MAX) || null)

const text = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const ms = (iso: unknown): number => {
  const t = Date.parse(text(iso))
  return Number.isNaN(t) ? 0 : t
}
const msOrNull = (iso: unknown): number | null => (iso === null || iso === undefined ? null : ms(iso))

/** What a source says of a Client, checked and cleaned: the name and legal name one line each, the address https, the extra fields plain text under plain keys. */
export interface CleanFields {
  preferredNumber: number | null
  name: string
  legalName: string | null
  url: string | null
  extra: Record<string, string>
}

const FIELD_KEYS = ['preferredNumber', 'name', 'legalName', 'url', 'extra']

/** A source's fields as they arrive from outside, untrusted: refused whole with a sentence if any part is not the shape. An unknown field is refused, so a sender's typo shows. */
export function readFields(raw: unknown): Result<CleanFields> {
  if (!isRecord(raw)) return fail('bad-request', 'A Client is an object.')
  for (const k of Object.keys(raw)) if (!FIELD_KEYS.includes(k)) return fail('bad-request', `A Client has no field "${k}".`)
  if (typeof raw.name !== 'string') return fail('bad-request', 'A Client needs a name.')
  const name = oneLine(raw.name)
  if (name === '') return fail('bad-request', 'A Client needs a name.')
  if (length(name) > CLIENT_SAID_MAX) return fail('bad-request', `A name is at most ${CLIENT_SAID_MAX} characters.`)
  let legalName: string | null = null
  if (raw.legalName !== undefined && raw.legalName !== null) {
    if (typeof raw.legalName !== 'string') return fail('bad-request', 'A legal name is text, or null.')
    legalName = oneLine(raw.legalName) || null
    if (legalName !== null && length(legalName) > CLIENT_SAID_MAX) return fail('bad-request', `A legal name is at most ${CLIENT_SAID_MAX} characters.`)
  }
  let preferredNumber: number | null = null
  if (raw.preferredNumber !== undefined && raw.preferredNumber !== null) {
    if (typeof raw.preferredNumber !== 'number' || !Number.isSafeInteger(raw.preferredNumber) || raw.preferredNumber < 1 || raw.preferredNumber > 2_000_000_000) {
      return fail('bad-request', 'A preferred number is a whole number from 1, or null.')
    }
    preferredNumber = raw.preferredNumber
  }
  let url: string | null = null
  if (raw.url !== undefined && raw.url !== null) {
    if (typeof raw.url !== 'string' || raw.url.length > CLIENT_URL_MAX) return fail('bad-request', 'An address is an https address, or null.')
    try {
      if (new URL(raw.url).protocol !== 'https:') return fail('bad-request', 'An address is an https address, or null.')
    } catch {
      return fail('bad-request', 'An address is an https address, or null.')
    }
    url = raw.url
  }
  const extra: Record<string, string> = {}
  if (raw.extra !== undefined) {
    if (!isRecord(raw.extra)) return fail('bad-request', 'The extra fields are an object of text.')
    const keys = Object.keys(raw.extra)
    if (keys.length > CLIENT_EXTRA_MOST) return fail('bad-request', `A Client has at most ${CLIENT_EXTRA_MOST} extra fields.`)
    for (const k of keys.sort()) {
      const v = raw.extra[k]
      if (!CLIENT_EXTRA_KEY.test(k)) return fail('bad-request', `"${k}" is not a name an extra field may have.`)
      if (typeof v !== 'string' || length(v) > CLIENT_EXTRA_VALUE_MAX) return fail('bad-request', `The extra field "${k}" is text of at most ${CLIENT_EXTRA_VALUE_MAX} characters.`)
      extra[k] = v
    }
  }
  return ok({ preferredNumber, name, legalName, url, extra })
}

/** A source's id for a Client, checked. */
export function readExternalId(raw: unknown): Result<string> {
  if (typeof raw !== 'string' || !CLIENT_EXTERNAL_ID.test(raw)) return fail('bad-request', 'A Client is named by its id at the source: letters, digits and . _ : -, up to 100.')
  return ok(raw)
}

interface Row {
  [column: string]: unknown
}

/** What `applyOne` did to one Client. */
interface Applied {
  number: number
  created: boolean
  renamed: boolean
  sourceChanged: boolean
  returned: boolean
}

const canonical = (f: { url: string | null; said: { name: string; legalName: string | null }; extra: Record<string, string> }): string =>
  JSON.stringify([f.url, f.said.name, f.said.legalName, Object.keys(f.extra).sort().map((k) => [k, f.extra[k]])])

export class ClientsStore {
  /** How many changes have been stored since this store was made. The object tells the live object when it moves (src/durable.ts); a call that changed nothing leaves it where it was. */
  private changes = 0

  constructor(private readonly ports: ClientsPorts) {}

  get changeCount(): number {
    return this.changes
  }

  private get sql(): ClientsSql {
    return this.ports.sql
  }

  private now(): string {
    return this.ports.now().toISOString()
  }

  private audit(actor: string, action: string, subject: string, before: unknown, after: unknown): void {
    this.changes += 1
    this.sql.exec(
      `INSERT INTO audit (at, actor, action, subject, before, after) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      this.now(),
      actor,
      action,
      subject,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
    )
  }

  private isOwner = (actor: string): boolean => this.ports.owners.includes(actor)

  /** The owner, or the sentence that says only they do. */
  private owner(actor: string): Refusal | null {
    return this.isOwner(actor) ? null : fail('not-admitted', onlyTheOwner(this.ports.ownerName))
  }

  /** The declared source a push is in the name of, and only in its own name. */
  private asSource(source: unknown, actor: string): Result<string> {
    if (typeof source !== 'string' || !this.ports.sources.includes(source) || actor !== sourceActor(source)) return fail('not-admitted', ONLY_THE_SOURCE)
    return ok(source)
  }

  // ─── numbers ─────────────────────────────────────────────────────────

  /** The lowest number from `base` that no Client holds and that is not `reserved`. */
  private lowestFree(base: number, reserved: ReadonlySet<number>): number {
    const held = new Set(this.sql.exec(`SELECT number FROM client WHERE number >= ?1`, base).toArray().map((r) => Number(r.number)))
    let n = base
    while (held.has(n) || reserved.has(n)) n += 1
    return n
  }

  private localBase = (): number => (this.ports.sources.length > 0 ? CLIENT_LOCAL_NUMBER_FROM : 1)

  private isTaken(number: number): boolean {
    return this.sql.exec(`SELECT 1 FROM client WHERE number = ?1`, number).toArray().length > 0
  }

  // ─── reading ─────────────────────────────────────────────────────────

  private static readonly SELECT = `SELECT c.number, c.name, c.legal_name, c.created_at, c.created_by, c.updated_at, c.updated_by, c.archived_at, c.archived_by, c.revision,
      s.source, s.external_id, s.url, s.said, s.extra, s.gone_since
    FROM client c LEFT JOIN client_source s ON s.client_number = c.number`

  private clientFrom(r: Row): Client {
    let source: ClientSourcePart | null = null
    if (r.source !== null && r.source !== undefined) {
      const said = JSON.parse(text(r.said)) as { name: string; legalName: string | null }
      source = {
        source: text(r.source),
        externalId: text(r.external_id),
        url: textOrNull(r.url),
        said: { name: said.name, legalName: said.legalName ?? null },
        extra: JSON.parse(text(r.extra)) as Record<string, string>,
        goneSince: msOrNull(r.gone_since),
      }
    }
    return {
      number: Number(r.number),
      name: text(r.name),
      legalName: textOrNull(r.legal_name),
      createdAt: ms(r.created_at),
      createdBy: text(r.created_by),
      updatedAt: ms(r.updated_at),
      updatedBy: text(r.updated_by),
      archivedAt: msOrNull(r.archived_at),
      archivedBy: textOrNull(r.archived_by),
      revision: Number(r.revision),
      source,
    }
  }

  private find(number: number): Client | null {
    const r = this.sql.exec(`${ClientsStore.SELECT} WHERE c.number = ?1`, number).toArray()[0]
    return r ? this.clientFrom(r) : null
  }

  /** Every Client, archived ones included, lowest number first. */
  list(): Result<Client[]> {
    return ok(this.sql.exec(`${ClientsStore.SELECT} ORDER BY c.number`).toArray().map((r) => this.clientFrom(r)))
  }

  /** One Client by its number. */
  get(number: unknown): Result<Client> {
    const found = typeof number === 'number' && Number.isSafeInteger(number) ? this.find(number) : null
    return found ? ok(found) : fail('not-found', NO_SUCH_CLIENT)
  }

  /** When the declared source was last heard from; null where the install has none. */
  sourceStatus(): Result<ClientSourceStatus | null> {
    const name = this.ports.sources[0]
    if (name === undefined) return ok(null)
    const r = this.sql.exec(`SELECT last_push_at, last_sync_at, synced_count FROM client_source_state WHERE source = ?1`, name).toArray()[0]
    return ok({
      name,
      lastPushAt: r ? msOrNull(r.last_push_at) : null,
      lastSyncAt: r ? msOrNull(r.last_sync_at) : null,
      syncedCount: r && r.synced_count !== null && r.synced_count !== undefined ? Number(r.synced_count) : null,
    })
  }

  /** The counts of the store, for the operator's comparison with the source's own list. Not part of the face: the object answers it as its own method. */
  counts(): ClientsCounts {
    const n = (query: string): number => Number(this.sql.exec(query).toArray()[0]?.n ?? 0)
    const status = this.sourceStatus()
    return {
      clients: n(`SELECT count(*) AS n FROM client`),
      active: n(`SELECT count(*) AS n FROM client WHERE archived_at IS NULL`),
      archived: n(`SELECT count(*) AS n FROM client WHERE archived_at IS NOT NULL`),
      fromSource: n(`SELECT count(*) AS n FROM client_source`),
      madeHere: n(`SELECT count(*) AS n FROM client c WHERE NOT EXISTS (SELECT 1 FROM client_source s WHERE s.client_number = c.number)`),
      gone: n(`SELECT count(*) AS n FROM client_source WHERE gone_since IS NOT NULL`),
      highest: n(`SELECT coalesce(max(number), 0) AS n FROM client`),
      source: status.ok ? status.value : null,
      schema: CLIENTS_VERSION,
    }
  }

  // ─── the owner's changes ─────────────────────────────────────────────

  private nameChecked(raw: unknown): Result<string> {
    if (typeof raw !== 'string') return fail('bad-request', 'A Client needs a name.')
    const name = oneLine(raw)
    if (name === '') return fail('bad-request', 'A Client needs a name.')
    if (length(name) > CLIENT_NAME_MAX) return fail('bad-request', `A name is at most ${CLIENT_NAME_MAX} characters.`)
    return ok(name)
  }

  private legalChecked(raw: unknown): Result<string | null> {
    if (raw === undefined || raw === null) return ok(null)
    if (typeof raw !== 'string') return fail('bad-request', 'A legal name is text, or empty.')
    const legal = oneLine(raw)
    if (legal === '') return ok(null)
    if (length(legal) > CLIENT_LEGAL_NAME_MAX) return fail('bad-request', `A legal name is at most ${CLIENT_LEGAL_NAME_MAX} characters.`)
    return ok(legal)
  }

  /** Make a Client in the space. It takes the lowest free number from the local base. */
  make(name: unknown, legalName: unknown, actor: string): Result<Client> {
    const refused = this.owner(actor)
    if (refused) return refused
    const n = this.nameChecked(name)
    if (!n.ok) return n
    const l = this.legalChecked(legalName)
    if (!l.ok) return l
    return this.ports.transaction(() => {
      const number = this.lowestFree(this.localBase(), new Set())
      const at = this.now()
      this.sql.exec(
        `INSERT INTO client (number, name, legal_name, created_at, created_by, updated_at, updated_by, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?5, 1)`,
        number,
        n.value,
        l.value,
        at,
        actor,
      )
      this.audit(actor, 'client.make', `client:${number}`, null, { name: n.value, legalName: l.value })
      return ok(this.find(number) as Client)
    })
  }

  /**
   * Change a Client's name or legal name, naming the revision the author was shown. A field left out is kept; a legal name given empty or null is cleared. Over a Client that has moved on since: `conflict`, and
   * nothing is changed. An edit that changes nothing is answered as it is, with no new revision.
   */
  edit(number: unknown, revision: unknown, changes: unknown, actor: string): Result<Client> {
    const refused = this.owner(actor)
    if (refused) return refused
    if (!isRecord(changes) || (changes.name === undefined && changes.legalName === undefined)) return fail('bad-request', 'Say what to change: the name, the legal name, or both.')
    return this.ports.transaction(() => {
      const found = this.shown(number, revision)
      if (!found.ok) return found
      const was = found.value
      let name = was.name
      let legalName = was.legalName
      if (changes.name !== undefined) {
        const n = this.nameChecked(changes.name)
        if (!n.ok) return n
        name = n.value
      }
      if (changes.legalName !== undefined) {
        const l = this.legalChecked(changes.legalName)
        if (!l.ok) return l
        legalName = l.value
      }
      if (name === was.name && legalName === was.legalName) return ok(was)
      this.sql.exec(
        `UPDATE client SET name = ?2, legal_name = ?3, updated_at = ?4, updated_by = ?5, revision = revision + 1 WHERE number = ?1`,
        was.number,
        name,
        legalName,
        this.now(),
        actor,
      )
      this.audit(actor, 'client.edit', `client:${was.number}`, { name: was.name, legalName: was.legalName }, { name, legalName })
      return ok(this.find(was.number) as Client)
    })
  }

  /** The Client a number names, when it is the revision its author was shown. */
  private shown(number: unknown, revision: unknown): Result<Client> {
    const found = this.get(number)
    if (!found.ok) return found
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return fail('bad-request', 'Say which revision of the Client you were shown.')
    if (found.value.revision !== revision) return fail('conflict', CLIENT_CHANGED)
    return found
  }

  /** Take a Client out of the lists and pickers. Archived already: answered as it is. Nothing is deleted and no person is unlinked. */
  archive(number: unknown, actor: string): Result<Client> {
    return this.setArchived(number, true, actor)
  }

  /** Put an archived Client back. Active already: answered as it is. */
  putBack(number: unknown, actor: string): Result<Client> {
    return this.setArchived(number, false, actor)
  }

  private setArchived(number: unknown, archived: boolean, actor: string): Result<Client> {
    const refused = this.owner(actor)
    if (refused) return refused
    return this.ports.transaction(() => {
      const found = this.get(number)
      if (!found.ok) return found
      const was = found.value
      if ((was.archivedAt !== null) === archived) return ok(was)
      const at = this.now()
      this.sql.exec(
        `UPDATE client SET archived_at = ?2, archived_by = ?3, updated_at = ?4, updated_by = ?5, revision = revision + 1 WHERE number = ?1`,
        was.number,
        archived ? at : null,
        archived ? actor : null,
        at,
        actor,
      )
      this.audit(actor, archived ? 'client.archive' : 'client.put-back', `client:${was.number}`, { archived: !archived }, { archived })
      return ok(this.find(was.number) as Client)
    })
  }

  // ─── the source's pushes ─────────────────────────────────────────────

  private sourceRow(source: string, externalId: string): Row | undefined {
    return this.sql.exec(`SELECT client_number, url, said, extra, gone_since FROM client_source WHERE source = ?1 AND external_id = ?2`, source, externalId).toArray()[0]
  }

  private touchSource(source: string, sync: number | null): void {
    const at = this.now()
    if (sync === null) {
      this.sql.exec(
        `INSERT INTO client_source_state (source, last_push_at) VALUES (?1, ?2) ON CONFLICT(source) DO UPDATE SET last_push_at = excluded.last_push_at`,
        source,
        at,
      )
    } else {
      this.sql.exec(
        `INSERT INTO client_source_state (source, last_push_at, last_sync_at, synced_count) VALUES (?1, ?2, ?2, ?3)
           ON CONFLICT(source) DO UPDATE SET last_push_at = excluded.last_push_at, last_sync_at = excluded.last_sync_at, synced_count = excluded.synced_count`,
        source,
        at,
        sync,
      )
    }
  }

  /**
   * Make or bring up to date the Client the source knows as `externalId`. Called inside a transaction. `reserved` holds numbers a full send asks for, which a Client needing a free number must not take.
   */
  private applyOne(source: string, externalId: string, f: CleanFields, actor: string, reserved: ReadonlySet<number>): Applied {
    const said = { name: f.name, legalName: f.legalName }
    const row = this.sourceRow(source, externalId)
    if (row === undefined) {
      const wanted = f.preferredNumber
      const number = wanted !== null && !this.isTaken(wanted) ? wanted : this.lowestFree(this.localBase(), reserved)
      const at = this.now()
      const name = followName(f.name)
      const legalName = followLegal(f.legalName)
      this.sql.exec(
        `INSERT INTO client (number, name, legal_name, created_at, created_by, updated_at, updated_by, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?5, 1)`,
        number,
        name,
        legalName,
        at,
        actor,
      )
      this.sql.exec(
        `INSERT INTO client_source (source, external_id, client_number, url, said, extra) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        source,
        externalId,
        number,
        f.url,
        JSON.stringify(said),
        JSON.stringify(f.extra),
      )
      this.audit(actor, 'client.source.add', `client:${number}`, null, { name, legalName, source, externalId, said, url: f.url, extra: f.extra })
      return { number, created: true, renamed: false, sourceChanged: true, returned: false }
    }

    const number = Number(row.client_number)
    const was = this.find(number) as Client
    const before = was.source as ClientSourcePart
    // The name follows the source's only while it still equals what the source last said (a name edited in the space stands).
    const name = was.name === followName(before.said.name) ? followName(f.name) : was.name
    const legalName = was.legalName === followLegal(before.said.legalName) ? followLegal(f.legalName) : was.legalName
    const renamed = name !== was.name || legalName !== was.legalName
    const returned = before.goneSince !== null
    const sourceChanged = canonical({ url: before.url, said: before.said, extra: before.extra }) !== canonical({ url: f.url, said: said, extra: f.extra }) || returned
    if (!renamed && !sourceChanged) return { number, created: false, renamed: false, sourceChanged: false, returned: false }
    if (renamed) {
      this.sql.exec(`UPDATE client SET name = ?2, legal_name = ?3, updated_at = ?4, updated_by = ?5, revision = revision + 1 WHERE number = ?1`, number, name, legalName, this.now(), actor)
    }
    if (sourceChanged) {
      this.sql.exec(
        `UPDATE client_source SET url = ?3, said = ?4, extra = ?5, gone_since = NULL WHERE source = ?1 AND external_id = ?2`,
        source,
        externalId,
        f.url,
        JSON.stringify(said),
        JSON.stringify(f.extra),
      )
    }
    this.audit(
      actor,
      'client.source.update',
      `client:${number}`,
      { name: was.name, legalName: was.legalName, said: before.said, url: before.url, extra: before.extra, goneSince: before.goneSince },
      { name, legalName, said, url: f.url, extra: f.extra, goneSince: null },
    )
    return { number, created: false, renamed, sourceChanged, returned }
  }

  /** Make or bring up to date one Client of the source. The same push twice changes nothing the second time. */
  upsertExternal(source: unknown, externalId: unknown, fields: unknown, actor: string): Result<ClientUpserted> {
    const named = this.asSource(source, actor)
    if (!named.ok) return named
    const id = readExternalId(externalId)
    if (!id.ok) return id
    const f = readFields(fields)
    if (!f.ok) return f
    return this.ports.transaction(() => {
      this.touchSource(named.value, null)
      const done = this.applyOne(named.value, id.value, f.value, actor, new Set())
      return ok({ number: done.number, created: done.created, changed: done.created || done.renamed || done.sourceChanged })
    })
  }

  /** The source says the Client is gone: it is marked with the time and kept, never archived or deleted. */
  markGone(source: unknown, externalId: unknown, actor: string): Result<ClientGone> {
    const named = this.asSource(source, actor)
    if (!named.ok) return named
    const id = readExternalId(externalId)
    if (!id.ok) return id
    return this.ports.transaction(() => {
      const row = this.sourceRow(named.value, id.value)
      if (row === undefined) return fail('not-found', NO_SUCH_CLIENT)
      this.touchSource(named.value, null)
      const number = Number(row.client_number)
      if (row.gone_since !== null) return ok({ number, changed: false })
      const at = this.now()
      this.sql.exec(`UPDATE client_source SET gone_since = ?3 WHERE source = ?1 AND external_id = ?2`, named.value, id.value, at)
      this.audit(actor, 'client.source.gone', `client:${number}`, { goneSince: null }, { goneSince: at })
      return ok({ number, changed: true })
    })
  }

  /** Every Client of the source, by its id at the source, so the sender can reconcile its own list against the space's. */
  listing(source: unknown, actor: string): Result<ClientListing[]> {
    const named = this.asSource(source, actor)
    if (!named.ok) return named
    return ok(
      this.sql
        .exec(`SELECT s.external_id, s.gone_since, c.number, c.name, c.legal_name, c.archived_at FROM client_source s JOIN client c ON c.number = s.client_number WHERE s.source = ?1 ORDER BY c.number`, named.value)
        .toArray()
        .map((r) => ({
          externalId: text(r.external_id),
          number: Number(r.number),
          name: text(r.name),
          legalName: textOrNull(r.legal_name),
          archived: r.archived_at !== null,
          goneSince: msOrNull(r.gone_since),
        })),
    )
  }

  /**
   * The source's full set. Every Client sent is made or brought up to date, and every Client of this source that is not in it is marked gone. All or nothing: a send with a fault in it (a name missing, an id twice, too
   * many) changes nothing. Idempotent: the same set twice changes nothing the second time.
   */
  syncExternal(source: unknown, clients: unknown, actor: string): Result<ClientsSynced> {
    const named = this.asSource(source, actor)
    if (!named.ok) return named
    if (!Array.isArray(clients)) return fail('bad-request', 'A full send is a list of Clients.')
    if (clients.length > CLIENT_SYNC_MAX) return fail('bad-request', `A full send holds at most ${CLIENT_SYNC_MAX} Clients.`)
    const sent: { id: string; f: CleanFields }[] = []
    const ids = new Set<string>()
    const wanted = new Set<number>()
    for (const [i, raw] of clients.entries()) {
      if (!isRecord(raw)) return fail('bad-request', `Client ${i + 1} of the send is not an object.`)
      const id = readExternalId(raw.id)
      if (!id.ok) return fail('bad-request', `Client ${i + 1} of the send: ${id.error}`)
      if (ids.has(id.value)) return fail('bad-request', `The id "${id.value}" is in the send twice.`)
      const { id: _id, ...fields } = raw
      const f = readFields(fields)
      if (!f.ok) return fail('bad-request', `Client "${id.value}" of the send: ${f.error}`)
      ids.add(id.value)
      if (f.value.preferredNumber !== null) wanted.add(f.value.preferredNumber)
      sent.push({ id: id.value, f: f.value })
    }
    // The ones that ask for a number first, lowest first, so the numbers they ask for are theirs before a Client that needs a free one looks.
    const order = [...sent].sort((a, b) => (a.f.preferredNumber ?? Infinity) - (b.f.preferredNumber ?? Infinity))
    return this.ports.transaction(() => {
      const report = { sent: sent.length, added: 0, updated: 0, markedGone: 0, returned: 0 }
      for (const { id, f } of order) {
        const done = this.applyOne(named.value, id, f, actor, wanted)
        if (done.created) report.added += 1
        else if (done.renamed || done.sourceChanged) report.updated += 1
        if (done.returned) report.returned += 1
      }
      const at = this.now()
      for (const r of this.sql.exec(`SELECT external_id, client_number FROM client_source WHERE source = ?1 AND gone_since IS NULL`, named.value).toArray()) {
        if (ids.has(text(r.external_id))) continue
        this.sql.exec(`UPDATE client_source SET gone_since = ?3 WHERE source = ?1 AND external_id = ?2`, named.value, text(r.external_id), at)
        this.audit(actor, 'client.source.gone', `client:${Number(r.client_number)}`, { goneSince: null }, { goneSince: at })
        report.markedGone += 1
      }
      this.touchSource(named.value, sent.length)
      return ok({ ...report, changed: report.added + report.updated + report.markedGone + report.returned > 0, matches: this.holds(named.value, sent) })
    })
  }

  /** Whether the space holds exactly what was sent: each Client stored, not gone, with what the source said, and every other of the source's marked gone. */
  private holds(source: string, sent: { id: string; f: CleanFields }[]): boolean {
    const rows = new Map(
      this.sql
        .exec(`SELECT external_id, url, said, extra, gone_since FROM client_source WHERE source = ?1`, source)
        .toArray()
        .map((r) => [text(r.external_id), r] as const),
    )
    const ids = new Set(sent.map((s) => s.id))
    for (const { id, f } of sent) {
      const r = rows.get(id)
      if (r === undefined || r.gone_since !== null) return false
      const said = JSON.parse(text(r.said)) as { name: string; legalName: string | null }
      const extra = JSON.parse(text(r.extra)) as Record<string, string>
      if (canonical({ url: textOrNull(r.url), said, extra }) !== canonical({ url: f.url, said: { name: f.name, legalName: f.legalName }, extra: f.extra })) return false
    }
    for (const [id, r] of rows) if (!ids.has(id) && r.gone_since === null) return false
    return true
  }
}

/** What the Durable Object may be asked to do: every method of the store that is part of its face, by name. */
export const STORE_METHODS = [
  'list',
  'get',
  'sourceStatus',
  'make',
  'edit',
  'archive',
  'putBack',
  'upsertExternal',
  'markGone',
  'listing',
  'syncExternal',
] as const satisfies readonly (keyof ClientsStore)[]
export type StoreMethod = (typeof STORE_METHODS)[number]

/**
 * The typed face of the Durable Object's untyped `call`, and of a store in the same process: the faces' logic (space.ts, inbox.ts, source.ts) is written against this, so it runs under plain `bun` over a real store,
 * and in the Worker over the object.
 */
export type StoreApi = {
  call<M extends StoreMethod>(method: M, ...args: Parameters<ClientsStore[M]>): Promise<ReturnType<ClientsStore[M]>>
}

/** A store in this process as a `StoreApi`: what the tests ask through, and what the object itself would answer. */
export const localApi = (store: ClientsStore): StoreApi => ({
  call: async (method, ...args) => (store[method] as (...a: unknown[]) => never).apply(store, args),
})
