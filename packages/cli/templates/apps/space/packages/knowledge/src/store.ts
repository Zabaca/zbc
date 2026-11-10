/**
 * The knowledge base: what the assistants of an install's businesses may tell people, as entries marked with the businesses they are
 * for, with every version kept, the owner's changes and Claude's proposals. The rules are the inbox's knowledge store's
 * (packages/inbox/src/store/knowledge.ts), moved onto this app's own base: keyed by
 * business and not by mailbox, with its own audit, clock and ids, no mail, and no carry.
 *
 * This class has never seen `env`, `ctx`, `cloudflare:workers` or a Durable Object. It takes PORTS (a `sql`, a `transaction`, a
 * clock, an id source, the declared businesses and the owners), and the Durable Object in worker.ts is a shell that builds one of
 * these and forwards to it. So every rule here runs under plain `bun` against a REAL SQLite with the REAL migrations.
 *
 * ── RESULTS, NOT THROWS ──────────────────────────────────────────────────
 * A refusal is a value: `{ ok: false, reason, error }`, the reason one of the contract's (`RefusalReason`). An error thrown inside a
 * Durable Object reaches the Worker through RPC as a bare Error with its type and fields stripped.
 *
 * ── WHO MAY WRITE ────────────────────────────────────────────────────────
 * The owner adds, edits, removes, puts back, approves and rejects: each refuses any other actor here (a default-deny on the actor),
 * as well as at the entrypoint that admitted them. Claude PROPOSES: a proposal is an entry that nothing reads until the owner
 * approves it, so Claude can never change what an assistant tells a customer. The assistants read active entries only and write
 * none: they have no method here that writes.
 *
 * ── A VERSION IS NEVER EDITED ────────────────────────────────────────────
 * `knowledge_version` is appended to and never updated or deleted: the entry as it was made, then each edit (a change of
 * businesses alone is one: it decides which customers are told the entry), each approval (the owner approving a proposal is a
 * version by them) and each put-back. A removal changes the entry's status and keeps every version. An edit, a removal, an approval
 * or a rejection names the `version` count its author was shown, and is `conflict` over an entry that has moved on, so nobody saves
 * over a change they have not seen.
 *
 * ── BUSINESSES ───────────────────────────────────────────────────────────
 * An entry is for at least one business, each one the declaration lists (`ports.businesses`, ids in the declaration's order, which
 * is the order an entry's list is kept in). "Every business" is the tab ticking them all; what is stored is that list, so a business
 * added later starts with no entries.
 */

import {
  KNOWLEDGE_AGENT_PREFIX,
  KNOWLEDGE_MAX_BODY,
  KNOWLEDGE_MAX_TITLE,
  KNOWLEDGE_MOST_PROPOSALS,
  type KnowledgeEntry,
  type KnowledgeEntryStatus,
  type KnowledgeProposal,
  type KnowledgeText,
  type KnowledgeVersion,
  type RefusalReason,
} from '@space/workspace'
import type { KnowledgeSql } from './schema'

export interface KnowledgePorts {
  sql: KnowledgeSql
  /** Commit if `fn` returns, roll back if it throws. A Durable Object's `transactionSync`. */
  transaction: <T>(fn: () => T) => T
  /** Injected so nothing here reads the wall clock, and so tests can fix it. */
  now: () => Date
  newId: () => string
  /** The declaration's business ids, in its order. */
  businesses: readonly string[]
  /** The addresses of the install's owners: the only actors that change the base. */
  owners: readonly string[]
  /** The owner's name as the sentences a person is shown say it (the install's first owner: "Tessa"). */
  ownerName: string
}

export type Refusal = { ok: false; reason: RefusalReason; error: string }
export type Result<T> = { ok: true; value: T } | Refusal

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (reason: RefusalReason, error: string): Refusal => ({ ok: false, reason, error })

/** The sentences a refusal shows, with the owner named by the install and not written in here. */
export const onlyTheOwner = (owner: string): string => `Only ${owner} changes the knowledge base. Claude proposes an entry and ${owner} approves it.`
export const onlyClaudeProposes = (owner: string): string => `Only Claude proposes an entry; ${owner} adds one directly.`
export const proposalsWaiting = (owner: string, n: number): string =>
  `There are ${n} proposals waiting for ${owner}. They wait for ${owner} before any more is added.`

/** A business the declaration does not list. The one sentence, for the store and for the entrypoints in front of it. */
export const NO_SUCH_BUSINESS = 'No such business.'

/**
 * Why approving a proposed change is refused once the entry it would change has moved on. A proposal copies the entry's words and
 * businesses as they stood when Claude wrote it, so approving it later would write that old copy back over a later edit (a price
 * corrected, a business taken off the entry).
 */
export const PROPOSAL_OUT_OF_DATE =
  'The entry this would change was changed after it was proposed, so approving it would undo that change, and nothing was changed. Reject it, and ask Claude to propose it again against the entry as it is now.'

/** Why an edit, removal or approval that named a version was refused: the entry is not the one its author was shown. */
export const KNOWLEDGE_CHANGED = 'This entry was changed after it was shown, so nothing was changed. It is shown as it is now.'

/** Why adding an entry an active one already says is refused: the fix is the entry's businesses, not a second copy. */
export const SAME_AS_AN_ENTRY =
  'An active entry already says the same, so nothing was added. To tell another business the same thing, add that business to that entry.'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** An entry's words as they are held: the title on one line, the body trimmed. The ONE cleaning, for what a write checks and stores and for the duplicate check. */
export const cleaned = (title: string, body: string): { title: string; body: string } => ({
  title: oneLine(title),
  body: body.trim(),
})

/** An entry's words, checked: a one-line title and a body, each within its cap. */
function words(title: string, body: string): Result<{ title: string; body: string }> {
  const { title: t, body: b } = cleaned(title, body)
  if (t === '') return fail('bad-request', 'An entry needs a title.')
  if (t.length > KNOWLEDGE_MAX_TITLE) return fail('bad-request', `A title is one line of at most ${KNOWLEDGE_MAX_TITLE} characters.`)
  if (b === '') return fail('bad-request', 'An entry needs a body.')
  if (b.length > KNOWLEDGE_MAX_BODY) {
    return fail('bad-request', `A body is at most ${KNOWLEDGE_MAX_BODY} characters: the assistants read every active one on every email.`)
  }
  return ok({ title: t, body: b })
}

const text = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const ms = (iso: unknown): number => {
  const t = Date.parse(text(iso))
  return Number.isNaN(t) ? 0 : t
}

export class KnowledgeStore {
  constructor(private readonly ports: KnowledgePorts) {}

  private get sql(): KnowledgeSql {
    return this.ports.sql
  }

  private now(): string {
    return this.ports.now().toISOString()
  }

  private audit(actor: string, action: string, subject: string, before: unknown, after: unknown): void {
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
  private isAgent = (actor: string): boolean => actor.startsWith(KNOWLEDGE_AGENT_PREFIX) && actor.length > KNOWLEDGE_AGENT_PREFIX.length

  // ─── businesses ──────────────────────────────────────────────────────

  /** A list of businesses, checked: at least one, each declared, once each, in the declaration's order. */
  private businessesOf(raw: unknown): Result<string[]> {
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail('bad-request', 'An entry needs at least one business, so that some assistant reads it.')
    }
    const named = new Set<string>()
    for (const b of raw) {
      if (typeof b !== 'string' || !this.ports.businesses.includes(b.trim())) {
        return fail('bad-request', `"${String(b)}" is not one of the businesses (${this.ports.businesses.join(', ')}).`)
      }
      named.add(b.trim())
    }
    return ok(this.ports.businesses.filter((id) => named.has(id)))
  }

  /** A business named in a read: one the declaration lists, or null for all. */
  private businessNamed(business: string | null): Result<string | null> {
    if (business === null) return ok(null)
    if (!this.ports.businesses.includes(business)) return fail('not-found', NO_SUCH_BUSINESS)
    return ok(business)
  }

  // ─── reading ─────────────────────────────────────────────────────────

  /**
   * What an assistant is given: a business's ACTIVE entries, oldest first. Empty is a state, not an error. The only thing the
   * assistants read, and no entry of another business is in it.
   */
  activeFor(business: string): Result<KnowledgeText[]> {
    const named = this.businessNamed(business)
    if (!named.ok) return named
    return ok(
      this.sql
        .exec(
          `SELECT e.title, e.body FROM knowledge_entry e
             JOIN knowledge_entry_business b ON b.entry_id = e.id
            WHERE e.status = 'active' AND b.business_id = ?1 ORDER BY e.created_at, e.rowid`,
          business,
        )
        .toArray()
        .map((r) => ({ title: text(r.title), body: text(r.body) })),
    )
  }

  /** The base, every status, each entry with its history, in the order the tab shows them; with a business named, only the entries marked for it. */
  entries(business: string | null): Result<KnowledgeEntry[]> {
    const named = this.businessNamed(business)
    if (!named.ok) return named
    const all = this.everything()
    return ok(named.value === null ? all : all.filter((e) => e.businesses.includes(named.value as string)))
  }

  private everything(): KnowledgeEntry[] {
    const versions = new Map<string, KnowledgeVersion[]>()
    for (const r of this.sql.exec(`SELECT seq, entry_id, by, at, title, body, businesses FROM knowledge_version ORDER BY seq`).toArray()) {
      const list = versions.get(text(r.entry_id)) ?? []
      list.push({
        seq: Number(r.seq),
        by: text(r.by),
        at: ms(r.at),
        title: text(r.title),
        body: text(r.body),
        businesses: this.inOrder(JSON.parse(text(r.businesses)) as string[]),
      })
      versions.set(text(r.entry_id), list)
    }
    const businesses = new Map<string, string[]>()
    for (const r of this.sql.exec(`SELECT entry_id, business_id FROM knowledge_entry_business`).toArray()) {
      const list = businesses.get(text(r.entry_id)) ?? []
      list.push(text(r.business_id))
      businesses.set(text(r.entry_id), list)
    }
    return this.sql
      .exec(
        `SELECT * FROM knowledge_entry
          ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, created_at, rowid`,
      )
      .toArray()
      .map((r) => {
        const list = versions.get(text(r.id)) ?? []
        return {
          id: text(r.id),
          title: text(r.title),
          body: text(r.body),
          businesses: this.inOrder(businesses.get(text(r.id)) ?? []),
          status: text(r.status) as KnowledgeEntryStatus,
          proposedBy: textOrNull(r.proposed_by),
          replaces: textOrNull(r.replaces),
          replacesVersion: r.replaces_version === null || r.replaces_version === undefined ? null : Number(r.replaces_version),
          createdAt: ms(r.created_at),
          createdBy: text(r.created_by),
          updatedAt: ms(r.updated_at),
          updatedBy: text(r.updated_by),
          version: list.length,
          versions: list,
        }
      })
  }

  /** Ids in the declaration's order; an id the declaration no longer lists is kept, after the others. */
  private inOrder(ids: readonly string[]): string[] {
    const declared = this.ports.businesses
    const known = declared.filter((id) => ids.includes(id))
    return [...known, ...ids.filter((id) => !declared.includes(id)).sort()]
  }

  private entry(id: string): KnowledgeEntry | null {
    return this.everything().find((e) => e.id === id) ?? null
  }

  /** The entry, for a write that names the version its author was shown: not found, or moved on, is a refusal. */
  private shown(id: string, version: unknown): Result<KnowledgeEntry> {
    const found = this.entry(id)
    if (!found) return fail('not-found', 'No such entry.')
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      return fail('bad-request', 'Say which version of the entry you were shown (version).')
    }
    if (version !== found.version) return fail('conflict', KNOWLEDGE_CHANGED)
    return ok(found)
  }

  // ─── writing rows ────────────────────────────────────────────────────

  private appendVersion(entryId: string, by: string, title: string, body: string, businesses: readonly string[]): void {
    this.sql.exec(
      `INSERT INTO knowledge_version (entry_id, by, at, title, body, businesses) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      entryId,
      by,
      this.now(),
      title,
      body,
      JSON.stringify(businesses),
    )
  }

  private setBusinesses(entryId: string, businesses: readonly string[]): void {
    this.sql.exec(`DELETE FROM knowledge_entry_business WHERE entry_id = ?1`, entryId)
    for (const b of businesses) {
      this.sql.exec(`INSERT INTO knowledge_entry_business (entry_id, business_id) VALUES (?1, ?2)`, entryId, b)
    }
  }

  private setStatus(id: string, status: KnowledgeEntryStatus, actor: string): void {
    this.sql.exec(`UPDATE knowledge_entry SET status = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1`, id, status, this.now(), actor)
  }

  private setWords(id: string, title: string, body: string, actor: string): void {
    this.sql.exec(`UPDATE knowledge_entry SET title = ?2, body = ?3, updated_at = ?4, updated_by = ?5 WHERE id = ?1`, id, title, body, this.now(), actor)
  }

  // ─── the owner's writes ──────────────────────────────────────────────

  /** The owner adds an entry, active at once. Refused as `conflict` when an active entry already has the same title and body, whatever its businesses. */
  add(title: string, body: string, businesses: unknown, actor: string): Result<KnowledgeEntry> {
    if (!this.isOwner(actor)) return fail('not-admitted', onlyTheOwner(this.ports.ownerName))
    const said = words(title, body)
    if (!said.ok) return said
    const marked = this.businessesOf(businesses)
    if (!marked.ok) return marked
    return this.ports.transaction(() => {
      const same = this.sql
        .exec(`SELECT 1 FROM knowledge_entry WHERE status = 'active' AND title = ?1 AND body = ?2 LIMIT 1`, said.value.title, said.value.body)
        .toArray()
      if (same.length > 0) return fail('conflict', SAME_AS_AN_ENTRY)
      const id = this.ports.newId()
      const at = this.now()
      this.sql.exec(
        `INSERT INTO knowledge_entry (id, title, body, status, proposed_by, created_at, created_by, updated_at, updated_by)
         VALUES (?1, ?2, ?3, 'active', NULL, ?4, ?5, ?4, ?5)`,
        id,
        said.value.title,
        said.value.body,
        at,
        actor,
      )
      this.setBusinesses(id, marked.value)
      this.appendVersion(id, actor, said.value.title, said.value.body, marked.value)
      this.audit(actor, 'knowledge.add', `knowledge:${id}`, null, { ...said.value, businesses: marked.value })
      return ok(this.entry(id) as KnowledgeEntry)
    })
  }

  /**
   * The owner edits an entry's title, body or businesses: a new version, every earlier one kept. A change of businesses alone is a
   * version. The same words and businesses are no change and add nothing.
   */
  edit(id: string, change: { title?: string; body?: string; businesses?: unknown; version: unknown }, actor: string): Result<KnowledgeEntry> {
    if (!this.isOwner(actor)) return fail('not-admitted', onlyTheOwner(this.ports.ownerName))
    return this.ports.transaction(() => {
      const found = this.shown(id, change.version)
      if (!found.ok) return found
      const before = found.value
      if (before.status === 'removed') return fail('conflict', 'A removed entry cannot be edited. Put it back first.')
      const said = words(change.title ?? before.title, change.body ?? before.body)
      if (!said.ok) return said
      let businesses = before.businesses
      if (change.businesses !== undefined) {
        const marked = this.businessesOf(change.businesses)
        if (!marked.ok) return marked
        businesses = marked.value
      }
      const sameBusinesses = businesses.length === before.businesses.length && businesses.every((b, i) => b === before.businesses[i])
      if (said.value.title === before.title && said.value.body === before.body && sameBusinesses) return ok(before)
      this.setWords(id, said.value.title, said.value.body, actor)
      if (!sameBusinesses) this.setBusinesses(id, businesses)
      this.appendVersion(id, actor, said.value.title, said.value.body, businesses)
      this.audit(
        actor,
        'knowledge.edit',
        `knowledge:${id}`,
        { title: before.title, body: before.body, businesses: before.businesses },
        { title: said.value.title, body: said.value.body, businesses },
      )
      return ok(this.entry(id) as KnowledgeEntry)
    })
  }

  /** The owner removes an entry: the assistants stop reading it, and its history and its row are kept. */
  remove(id: string, version: unknown, actor: string): Result<KnowledgeEntry> {
    if (!this.isOwner(actor)) return fail('not-admitted', onlyTheOwner(this.ports.ownerName))
    return this.ports.transaction(() => {
      const found = this.shown(id, version)
      if (!found.ok) return found
      if (found.value.status === 'removed') return fail('conflict', 'This entry is already removed.')
      this.setStatus(id, 'removed', actor)
      this.audit(actor, 'knowledge.remove', `knowledge:${id}`, { status: found.value.status }, { status: 'removed' })
      return ok(this.entry(id) as KnowledgeEntry)
    })
  }

  /** The owner puts a removed entry back, active, as a new version by them (so the history shows it came back). */
  restore(id: string, version: unknown, actor: string): Result<KnowledgeEntry> {
    if (!this.isOwner(actor)) return fail('not-admitted', onlyTheOwner(this.ports.ownerName))
    return this.ports.transaction(() => {
      const found = this.shown(id, version)
      if (!found.ok) return found
      if (found.value.status !== 'removed') return fail('conflict', 'Only a removed entry is put back.')
      // A proposed change that was approved or rejected is not an entry of its own: put back, it would be a second live entry
      // beside the one it changed. Ask Claude to propose it again instead.
      if (found.value.replaces !== null) {
        return fail('conflict', 'This was a proposed change to another entry, so it cannot be put back as an entry. Ask Claude to propose it again.')
      }
      this.setStatus(id, 'active', actor)
      this.appendVersion(id, actor, found.value.title, found.value.body, found.value.businesses)
      this.audit(actor, 'knowledge.restore', `knowledge:${id}`, { status: 'removed' }, { status: 'active' })
      return ok(this.entry(id) as KnowledgeEntry)
    })
  }

  // ─── Claude's proposals ──────────────────────────────────────────────

  /**
   * Claude proposes an entry, or a change to one (`replaces`: its id). A new entry needs a title, a body and businesses. A change may
   * change the words, the businesses or both, and what it leaves out is the entry's. Nothing reads a proposal until the owner
   * approves it, so this cannot change what an assistant says. At most `KNOWLEDGE_MOST_PROPOSALS` wait at once, across the base.
   */
  propose(proposal: KnowledgeProposal, actor: string): Result<KnowledgeEntry> {
    if (!this.isAgent(actor)) return fail('not-admitted', onlyClaudeProposes(this.ports.ownerName))
    return this.ports.transaction(() => {
      let target: KnowledgeEntry | null = null
      if (proposal.replaces) {
        target = this.entry(proposal.replaces)
        if (!target || target.status !== 'active') {
          return fail('bad-request', 'The entry to change is not an active entry (it is not there, is removed, or is itself a proposal). Propose a new entry instead.')
        }
        if (proposal.title === undefined && proposal.body === undefined && proposal.businesses === undefined) {
          return fail('bad-request', 'A change to an entry says what it changes: the title, the body or the businesses.')
        }
      } else if (proposal.title === undefined || proposal.body === undefined) {
        return fail('bad-request', 'A new entry needs a title, a body and the businesses it is for.')
      }
      const said = words(proposal.title ?? target?.title ?? '', proposal.body ?? target?.body ?? '')
      if (!said.ok) return said
      let businesses: string[]
      if (proposal.businesses !== undefined || target === null) {
        const marked = this.businessesOf(proposal.businesses)
        if (!marked.ok) return marked
        businesses = marked.value
      } else businesses = target.businesses
      const pending = Number(this.sql.exec(`SELECT count(*) AS n FROM knowledge_entry WHERE status = 'proposed'`).one().n)
      if (pending >= KNOWLEDGE_MOST_PROPOSALS) {
        return fail('limit', proposalsWaiting(this.ports.ownerName, pending))
      }
      const id = this.ports.newId()
      const at = this.now()
      this.sql.exec(
        `INSERT INTO knowledge_entry (id, title, body, status, proposed_by, replaces, replaces_version, created_at, created_by, updated_at, updated_by)
         VALUES (?1, ?2, ?3, 'proposed', ?4, ?5, ?6, ?7, ?4, ?7, ?4)`,
        id,
        said.value.title,
        said.value.body,
        actor,
        target?.id ?? null,
        target?.version ?? null,
        at,
      )
      this.setBusinesses(id, businesses)
      this.appendVersion(id, actor, said.value.title, said.value.body, businesses)
      this.audit(actor, 'knowledge.propose', `knowledge:${id}`, null, { ...said.value, businesses, replaces: target?.id ?? null })
      return ok(this.entry(id) as KnowledgeEntry)
    })
  }

  /**
   * The owner approves a proposal. A new entry becomes active (a version by them). A proposed change is applied to the entry it
   * would change as an edit by them (its words and its businesses), and the proposal is removed (its row and history kept).
   * Answers the entry that now holds the words.
   */
  approve(id: string, version: unknown, actor: string): Result<KnowledgeEntry> {
    if (!this.isOwner(actor)) return fail('not-admitted', onlyTheOwner(this.ports.ownerName))
    return this.ports.transaction(() => {
      const found = this.shown(id, version)
      if (!found.ok) return found
      const proposal = found.value
      if (proposal.status !== 'proposed') return fail('conflict', 'Only a proposal is approved.')
      if (proposal.replaces === null) {
        this.setStatus(id, 'active', actor)
        this.appendVersion(id, actor, proposal.title, proposal.body, proposal.businesses)
        this.audit(actor, 'knowledge.approve', `knowledge:${id}`, { status: 'proposed' }, { status: 'active' })
        return ok(this.entry(id) as KnowledgeEntry)
      }
      const target = this.entry(proposal.replaces)
      if (!target || target.status !== 'active') {
        return fail('conflict', 'The entry this would change is gone. Reject it, or ask Claude to propose it as a new entry.')
      }
      // The proposal is a copy of the entry as it stood: if the entry has been edited since (its words, or the businesses it is for),
      // applying the copy would undo that edit, here or for another business.
      if (target.version !== proposal.replacesVersion) return fail('conflict', PROPOSAL_OUT_OF_DATE)
      this.setWords(target.id, proposal.title, proposal.body, actor)
      this.setBusinesses(target.id, proposal.businesses)
      this.appendVersion(target.id, actor, proposal.title, proposal.body, proposal.businesses)
      this.setStatus(id, 'removed', actor)
      this.audit(
        actor,
        'knowledge.approve',
        `knowledge:${target.id}`,
        { title: target.title, body: target.body, businesses: target.businesses },
        { title: proposal.title, body: proposal.body, businesses: proposal.businesses, proposal: id },
      )
      return ok(this.entry(target.id) as KnowledgeEntry)
    })
  }

  /** The owner rejects a proposal: removed, with its history, and nothing reads it. */
  reject(id: string, version: unknown, actor: string): Result<KnowledgeEntry> {
    if (!this.isOwner(actor)) return fail('not-admitted', onlyTheOwner(this.ports.ownerName))
    return this.ports.transaction(() => {
      const found = this.shown(id, version)
      if (!found.ok) return found
      if (found.value.status !== 'proposed') return fail('conflict', 'Only a proposal is rejected.')
      this.setStatus(id, 'removed', actor)
      this.audit(actor, 'knowledge.reject', `knowledge:${id}`, { status: 'proposed' }, { status: 'removed' })
      return ok(this.entry(id) as KnowledgeEntry)
    })
  }
}

/** What the Durable Object may be asked to do: every method of the store that is part of its face, by name. */
export const STORE_METHODS = ['activeFor', 'entries', 'add', 'edit', 'remove', 'restore', 'propose', 'approve', 'reject'] as const satisfies readonly (keyof KnowledgeStore)[]
export type StoreMethod = (typeof STORE_METHODS)[number]

/**
 * The methods that change what the knowledge base shows (a new entry, an edit, a removal, a restore, a proposal, an approval or a rejection): after one of these has been stored the live object is told
 * (src/durable.ts). The other two only read. test/durable.test.ts holds the two lists to every method of the face, so a new method is put in one on purpose.
 */
export const CHANGING_METHODS = ['add', 'edit', 'remove', 'restore', 'propose', 'approve', 'reject'] as const satisfies readonly StoreMethod[]

/**
 * The typed face of the Durable Object's untyped `call`, and of a store in the same process: the entrypoints' logic
 * (space.ts, inbox.ts) is written against this, so it runs under plain `bun` over a real store, and in the Worker over the object.
 */
export type StoreApi = {
  call<M extends StoreMethod>(method: M, ...args: Parameters<KnowledgeStore[M]>): Promise<ReturnType<KnowledgeStore[M]>>
}

/** A store in this process as a `StoreApi`: what the tests ask through, and what the object itself would answer. */
export const localApi = (store: KnowledgeStore): StoreApi => ({
  call: async (method, ...args) => (store[method] as (...a: unknown[]) => never).apply(store, args),
})
