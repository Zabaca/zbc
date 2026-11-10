/**
 * The store's half of what the inbox answers the space (src/space.ts): the reads it needs that no page of the inbox asks for (who
 * is on each conversation, which way the newest message went, a person's messages a page at a time) and the compose keys that
 * make a send go out at most once. Synchronous SQL over the same ports as the rest, so every rule here runs under plain `bun`
 * against a real SQLite; the waiting (Gmail) is the Mailroom's.
 *
 * ── A SUBCLASS ONLY TO SHARE HELPERS ─────────────────────────────────────
 * `SpaceStore extends AssistStore`, as `AssistStore` sits under `MailStore`: it uses the base's `queueFacts`,
 * `listConversations`, `message` and `newestPosition` without making them public. The Durable Object builds one of these. Nothing
 * in the Gmail half knows it exists. It adds no table: see the compose keys below. (People's three fields and their revision are columns of `contact`, migration 12.)
 *
 * ── WHAT THE READS LEAVE OUT ─────────────────────────────────────────────
 * They hand over facts and judge nothing about who may see them: the asker is the owner or this is never reached
 * (src/space.ts verifies the assertion first), and the main list is the queue's own rule (`isBulk`, the one place Bulk is
 * decided), so a Bulk or closed conversation is in an answer only when it was asked for.
 *
 * ── THE COMPOSE KEYS ARE SETTINGS, NOT A TABLE ───────────────────────────
 * A key is one row of `setting` named `compose:<key>`. A table of their own would be a migration, and a store migrated by a
 * newer deploy is refused by an older one (`migrate`, src/store/schema.ts), which would take away the rollback the inbox's
 * deploys have: put the old Worker back and the data is as it was. A row of `setting` is read by name only, so an older Worker
 * ignores it.
 */

import { type InboxSent, profileLimitMessage, WRITE_WITHIN_MS } from '@space/workspace'
import { repairMojibake } from '../charset'
import { isBulk, type MailScope } from '../queue'
import { isRecord } from '../space-gate'
import {
  type ContactListItem,
  type ContactRow,
  type ConversationSummary,
  type DraftInput,
  type IdentityKind,
  type MailboxMark,
  type MessageRow,
  type MessageStatus,
  QUEUE_PAGE,
  type SendsFrom,
} from '../types'
import { AssistStore } from './assist'
import { isInside, type Placed, type PlacementCandidate, placeConversation } from './placement'
import { type RowCounts, rowCounts } from './row-counts'
import { scopeWhere } from './scope'
import { type ContactProfile, fail, messageRow, ok, PENDING, type Result, text, textOrNull } from './store'

/** How a record of a compose key is named in `setting`. */
export const COMPOSE_PREFIX = 'compose:'

/** Who wrote a compose key's record: the space, which is the only caller that makes one. */
const COMPOSE_ACTOR = 'space'

/** How long a compose key's record is kept before it is dropped on the next claim: well past the day the contract asks for. */
export const COMPOSE_KEPT_DAYS = 30

/** What a claim of a key found. `held` is a key whose first use may have sent something. */
export type ComposeClaim =
  | { kind: 'claimed' }
  | { kind: 'held'; earlier: { state: 'done'; sent: InboxSent } | { state: 'in-progress' } }

interface ComposeRecord {
  state: 'in-progress' | 'done'
  /** Milliseconds since the epoch, on the store's clock. */
  startedAt: number
  draftId: string | null
  conversationId: string | null
  sent: InboxSent | null
  /** The contact this compose's draft made for an address the inbox had never heard of, so a send that is refused does not leave one behind. Dropped once the message is sent (the contact then has mail). */
  madeContact?: string
}

/** A person on a conversation, as the space needs them: the contact, their Client, and their email addresses. */
export interface SpaceParty {
  contactId: string
  name: string
  clientId: number | null
  /** Every email address the contact has, as stored. */
  emails: string[]
  /** The email address they have on THIS conversation, if the identity they are on it under is one. */
  here: string | null
}

/** One conversation with the facts a page of it needs beyond the queue's summary. */
export interface SpaceConversation {
  id: string
  subject: string
  snippet: string
  kind: IdentityKind
  /** ISO time of the newest message that is not a draft; the conversation's own last activity when it has none. */
  newestAt: string
  direction: 'in' | 'out'
  unread: boolean
  open: boolean
  bulk: boolean
  drafts: number
  mailbox: MailboxMark | null
  /** Which kind of mailbox `mailbox` is (files go only from a Cloudflare one); null when `mailbox` is. */
  mailboxKind: 'gmail' | 'cloudflare' | 'telegram' | 'jmap' | null
  /** `newestPosition`: how far into the conversation this answer reaches. */
  through: number
  /** It is in a mailbox the inbox can send on, so a reply can be sent on it. False for a Telegram channel, which has no reply box. */
  canReply: boolean
  /** Which kind of Telegram chat this is when it is a group or a channel; null for everything else, a one-to-one Telegram chat included. */
  telegramChat: 'group' | 'channel' | null
  /**
   * For a Telegram GROUP only: whether it needs a reply, which is that a message addressed to the owner (a mention of them, or a reply to one of theirs) came in after their last message there
   * (a message its sender deleted does not count). Null for everything else, where the newest message's direction says it.
   */
  needsReply: boolean | null
  parties: SpaceParty[]
  /** Where the lists put this conversation (src/store/placement.ts): the contact every list but a Client's uses, and the contact each Client's list uses. A person's page still shows it for every party. */
  placed: Placed
}

export interface SpaceScope {
  /** What the person asking may see (`canSee`, src/queue.ts): the mailboxes they are on. REQUIRED, so a read of conversations cannot be written without saying whose. */
  mail: MailScope
  bulk?: boolean
  closed?: boolean
  /** The Sent view: only the conversations the owner sent a message in, in any state, newest send first, each as of that message (`sentConversations`). `bulk` and `closed` are then ignored. */
  sent?: boolean
  /** The Drafts view: only the conversations that hold a draft waiting, in any state, newest first, cut at the same screen (`bulk` and `closed` are then ignored). The menu's Drafts counts exactly these. */
  drafts?: boolean
  /** Only the conversations these contacts are on. Left out: every conversation in scope; `[]`: none. */
  contactIds?: string[]
  /** Every conversation in scope, past the screen the lists stop at: a person's history, whose messages must not be cut by it. */
  all?: boolean
  /** Every address of the team (each teammate's company and sign-in address, lowercase): with the owner's own, they are INSIDE and never own a thread's row while an outsider is on it (src/store/placement.ts). */
  team: readonly string[]
}

/** A group's row says who wrote the newest message before its words ("Ana: Lunch?"); the owner's own, a channel's post and every other conversation's snippet are as they were. */
function groupSnippet(
  snippet: string,
  newest: { telegramChat: string | null; direction: string; from: string } | undefined,
): string {
  if (newest?.telegramChat !== 'group' || newest.direction !== 'in' || snippet === '') return snippet
  const first = newest.from.trim().split(/\s+/)[0] ?? ''
  return first === '' ? snippet : `${first}: ${snippet}`
}

const parseCompose = (value: unknown): ComposeRecord | null => {
  try {
    const r = JSON.parse(text(value)) as Partial<ComposeRecord>
    if ((r.state !== 'in-progress' && r.state !== 'done') || typeof r.startedAt !== 'number') return null
    return {
      state: r.state,
      startedAt: r.startedAt,
      draftId: typeof r.draftId === 'string' ? r.draftId : null,
      conversationId: typeof r.conversationId === 'string' ? r.conversationId : null,
      sent: r.sent && typeof r.sent.messageId === 'string' ? r.sent : null,
      ...(typeof r.madeContact === 'string' && { madeContact: r.madeContact }),
    }
  } catch {
    return null
  }
}

/** A Telegram group a person writes in. */
export interface SpaceGroupRef {
  /** The contact that stands for the group: what the space opens the group's row by. */
  contactId: string
  name: string
  /** When the person last wrote there (ISO). */
  lastWroteAt: string
}

/** A contact with the profile fields People adds, as the directory reads it: the inbox's own list item and the three facts of migration 12 (the note only on `spaceContactProfile`). */
export interface SpaceContactFacts {
  contact: ContactListItem
  /** The Telegram groups this person writes in, newest first: the group's own contact, which opens its row, its name, and when they last wrote there. Empty for nearly everyone. */
  groups: SpaceGroupRef[]
  business: string
  role: string
  rev: number
  /** Where a new email to them goes out from when none is chosen (store.ts `sendsFromOf`): null for a contact with no email address, or while no Gmail account is connected. */
  sendsFrom: SendsFrom | null
}

/** A merge as its audit entry keeps it (`mergeContacts`), read back by `undoMerge`. */
interface MergeRecord {
  survivor: ContactRow
  absorbed: ContactRow
  profiles: { survivor: ContactProfile; absorbed: ContactProfile }
  made: { at: string; by: string }
  /** The survivor as the merge left it: its Client, and its profile. */
  merged: ContactRow
  mergedProfile: ContactProfile
}

/** A merge's audit entry, or null when it is not one this build wrote (an entry from before migration 12 has no profiles: it cannot be undone from here). */
function parseMerge(before: unknown, after: unknown): MergeRecord | null {
  try {
    const b = JSON.parse(text(before)) as Record<string, unknown>
    const a = JSON.parse(text(after)) as Record<string, unknown>
    if (
      !isRecord(b.survivor) ||
      !isRecord(b.absorbed) ||
      !isRecord(b.profiles) ||
      !isRecord(b.absorbedMade) ||
      !isRecord(a.survivor) ||
      !isRecord(a.profile)
    )
      return null
    const p = b.profiles
    if (!isRecord(p.survivor) || !isRecord(p.absorbed)) return null
    const absorbed = b.absorbed as unknown as ContactRow
    if (typeof absorbed.id !== 'string' || !Array.isArray(absorbed.identities)) return null
    return {
      survivor: b.survivor as unknown as ContactRow,
      absorbed,
      profiles: {
        survivor: p.survivor as unknown as ContactProfile,
        absorbed: p.absorbed as unknown as ContactProfile,
      },
      made: { at: text(b.absorbedMade.at), by: text(b.absorbedMade.by) },
      merged: a.survivor as unknown as ContactRow,
      mergedProfile: a.profile as unknown as ContactProfile,
    }
  } catch {
    return null
  }
}

export class SpaceStore extends AssistStore {
  // ─── the compose keys ─────────────────────────────────────────────────

  private composeRecord(key: string): ComposeRecord | null {
    const row = this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, `${COMPOSE_PREFIX}${key}`).toArray()[0]
    return row ? parseCompose(row.value) : null
  }

  private writeCompose(key: string, record: ComposeRecord): void {
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      `${COMPOSE_PREFIX}${key}`,
      JSON.stringify(record),
      this.now(),
      COMPOSE_ACTOR,
    )
  }

  /**
   * Take a compose key for its first use, or say how it was used. ONE call, in one transaction, so two presses that arrive
   * together cannot both be the first: the second finds the first's record. A key is HELD while its first use may have sent
   * something (in progress, done), and a held key is never claimed again; a key whose first use was refused or failed was
   * RELEASED (`releaseCompose`) and is claimed anew.
   *
   * A record still in progress after `WRITE_WITHIN_MS` is ENDED here for the repeat that finds it: the first use may be lost (the
   * Worker died between the claim and the answer), so the repeat is told done with the inbox's own "sending" status, the draft
   * it had made (if it had made one) named, and "check Gmail Sent". That answer is PROVISIONAL, not a verdict: the first use may
   * only be slow (queued behind another send or a sync, then up to 25 seconds for Gmail), and when it settles it is the authority
   * (`finishCompose` writes what it came to, `releaseCompose` frees the key for a definite refusal, whatever state the record is
   * in by then). Only a first use that never settles leaves the key as "sending" for good.
   */
  claimCompose(key: string): ComposeClaim {
    return this.ports.transaction((): ComposeClaim => {
      const now = this.ports.now().getTime()
      const held = this.composeRecord(key)
      if (held === null) {
        this.sql.exec(
          `DELETE FROM setting WHERE key LIKE ?1 AND updated_at < ?2`,
          `${COMPOSE_PREFIX}%`,
          new Date(now - COMPOSE_KEPT_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        )
        this.writeCompose(key, {
          state: 'in-progress',
          startedAt: now,
          draftId: null,
          conversationId: null,
          sent: null,
        })
        return { kind: 'claimed' }
      }
      if (held.state === 'done' && held.sent) return { kind: 'held', earlier: { state: 'done', sent: held.sent } }
      if (held.state === 'in-progress' && now - held.startedAt <= WRITE_WITHIN_MS) {
        return { kind: 'held', earlier: { state: 'in-progress' } }
      }
      const sent: InboxSent = held.sent ?? {
        messageId: held.draftId ?? '',
        conversationId: held.conversationId ?? '',
        status: 'sending',
      }
      this.writeCompose(key, { ...held, state: 'done', sent })
      return { kind: 'held', earlier: { state: 'done', sent } }
    })
  }

  /** The draft this key's send made, so a first use that is lost can still name it. A key that is not in progress is left alone. */
  noteCompose(key: string, draftId: string, conversationId: string | null): void {
    this.ports.transaction(() => {
      const held = this.composeRecord(key)
      if (held?.state === 'in-progress') this.writeCompose(key, { ...held, draftId, conversationId })
    })
  }

  /** The first use ended with a message that is out, or that may be (`sending`): the key stays held for good. */
  finishCompose(key: string, sent: InboxSent): void {
    this.ports.transaction(() => {
      const held = this.composeRecord(key)
      this.writeCompose(key, {
        state: 'done',
        startedAt: held?.startedAt ?? this.ports.now().getTime(),
        draftId: held?.draftId ?? sent.messageId,
        conversationId: sent.conversationId,
        sent,
      })
    })
  }

  /**
   * The first use ended with nothing sent (refused, or failed with the inbox knowing nothing went out): the key is free again,
   * in whatever state the record is. Only the first use calls this, once, after it claimed the key, and a record that was ended
   * as "sending" in the meantime (`claimCompose`) was only a provisional answer to a repeat; nothing went out, so it goes too.
   */
  releaseCompose(key: string): void {
    this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${COMPOSE_PREFIX}${key}`)
  }

  /**
   * Make the draft of a send and note it on the key in ONE transaction, so a Worker that dies after the draft exists cannot leave
   * an orphan draft (which the owner could send from Drafts) beside a key that never heard of it: either both are there or neither.
   * Refused (409, nothing made) for a key nobody claimed. The draft is `createDraft`'s, rules and audit and all.
   */
  createComposeDraft(
    key: string,
    input: DraftInput,
    actor: string,
    /** The press carries a picture: the draft may have no words (the picture speaks for itself), and the send decides whether a picture can go where it is going. */
    options: { empty?: boolean } = {},
  ): Result<MessageRow> {
    return this.ports.transaction(() => {
      const held = this.composeRecord(key)
      if (held === null) return fail(409, 'This message is not being sent, so no draft was made.')
      // A new email to an address the inbox has not heard of makes its contact: noted on the key, so a refused send can take it away again.
      const known = input.address ? this.addressIdentity(input.address) !== null : true
      const made = this.createDraft(input, actor, options)
      if (made.ok) {
        const madeContact = known || !input.address ? undefined : this.addressIdentity(input.address)?.contactId
        this.writeCompose(key, {
          ...held,
          draftId: made.value.id,
          conversationId: made.value.conversationId,
          ...(madeContact !== undefined && { madeContact }),
        })
      }
      return made
    })
  }

  /** Where a message stands after a send did not come back ok: its status and conversation, or null when it is gone. */
  composeOutcome(draftId: string): { status: MessageStatus; conversationId: string | null } | null {
    const msg = this.message(draftId)
    return msg ? { status: msg.status, conversationId: msg.conversationId } : null
  }

  /**
   * Remove a draft the space made for a send that was refused, so the compose that comes back with the same key makes one draft
   * and not two, and nothing is left in Drafts that could be sent a second time. Only a draft, only at the revision it has now:
   * a message that is `sending` or sent is never touched.
   */
  discardComposed(draftId: string, actor: string, key?: string): boolean {
    const msg = this.message(draftId)
    if (msg?.status !== 'draft') return false
    const gone = this.deleteDraft(draftId, actor, msg.rev).ok
    // The contact the draft made for a stranger goes with it, when nothing else came to hold it.
    const madeContact = key === undefined ? undefined : this.composeRecord(key)?.madeContact
    if (gone && madeContact !== undefined) this.removeUnusedContact(madeContact, actor)
    return gone
  }

  /** The identity (and so the contact) an email address is held under, or null. */
  private addressIdentity(address: string): { id: string; contactId: string } | null {
    const r = this.sql
      .exec(`SELECT id, contact_id FROM identity WHERE kind = 'email' AND address = ?1`, address)
      .toArray()[0]
    return r ? { id: text(r.id), contactId: text(r.contact_id) } : null
  }

  /**
   * Take away a contact only if it is exactly what a refused send's draft made: one email identity, no message and no conversation on it, no Client, nothing written about it. Anything else
   * (mail arrived from that address meanwhile, someone linked or described them) and it stays. Audited.
   */
  private removeUnusedContact(contactId: string, actor: string): void {
    this.ports.transaction(() => {
      const contact = this.sql
        .exec(`SELECT name, client_id, business, role, notes FROM contact WHERE id = ?1`, contactId)
        .toArray()[0]
      const identities = this.sql
        .exec(`SELECT id, kind, address FROM identity WHERE contact_id = ?1`, contactId)
        .toArray()
      if (!contact || identities.length !== 1 || contact.client_id !== null) return
      if (text(contact.business) !== '' || text(contact.role) !== '' || text(contact.notes) !== '') return
      const identity = text((identities[0] as { id: unknown }).id)
      const used = this.sql
        .exec(
          `SELECT (SELECT count(*) FROM message WHERE identity_id = ?1) + (SELECT count(*) FROM participant WHERE identity_id = ?1) AS n`,
          identity,
        )
        .one().n
      if (Number(used) > 0) return
      this.sql.exec(`DELETE FROM identity WHERE id = ?1`, identity)
      this.sql.exec(`DELETE FROM contact WHERE id = ?1`, contactId)
      this.audit(actor, 'contact.remove-unused', `contact:${contactId}`, { name: text(contact.name), identities }, null)
    })
  }

  // ─── People: the contacts as a directory (migration 12) ───────────────

  /**
   * The Telegram groups each person has written in, by contact (or one contact's), newest first. A group message is filed under its SENDER's identity, so this is the one read that
   * finds them by it: the person's own history (their conversations) never holds a group message, because the group's conversation has the group's contact as its only participant.
   */
  private groupsWritten(contactId: string | null, scope: MailScope): Map<string, SpaceGroupRef[]> {
    const out = new Map<string, SpaceGroupRef[]>()
    const on = scopeWhere(scope, 'c.mailbox_id', 2)
    for (const r of this.sql
      .exec(
        `SELECT si.contact_id AS member, gc.id AS group_contact, gc.name AS name,
                max(coalesce(m.sent_at, m.created_at)) AS last_wrote_at
           FROM message m
           JOIN identity si ON si.id = m.identity_id
           JOIN conversation c ON c.id = m.conversation_id AND c.telegram_kind = 'group'
           JOIN participant p ON p.conversation_id = c.id
           JOIN identity gi ON gi.id = p.identity_id
           JOIN contact gc ON gc.id = gi.contact_id
          WHERE m.direction = 'in' AND si.contact_id != gc.id AND (?1 IS NULL OR si.contact_id = ?1) AND ${on.sql}
          GROUP BY si.contact_id, gc.id
          ORDER BY last_wrote_at DESC, gc.rowid`,
        contactId,
        ...on.bindings,
      )
      .toArray()) {
      const held = out.get(text(r.member)) ?? []
      held.push({ contactId: text(r.group_contact), name: text(r.name), lastWroteAt: text(r.last_wrote_at) })
      out.set(text(r.member), held)
    }
    return out
  }

  /**
   * Every contact that is a person, with the profile fields and revision that are People's, and how many automated senders (the inbox's own judgment,
   * `judgeSender`) there are: left out unless `includeAutomated`, when each comes with the others, marked. Names, addresses, the Client's id and the counts
   * only: no message or draft.
   */
  spaceContacts(includeAutomated = false, mail: MailScope): { contacts: SpaceContactFacts[]; automated: number } {
    const profiles = new Map(
      this.sql
        .exec(`SELECT id, business, role, profile_rev FROM contact`)
        .toArray()
        .map(
          (r) => [text(r.id), { business: text(r.business), role: text(r.role), rev: Number(r.profile_rev) }] as const,
        ),
    )
    const groups = this.groupsWritten(null, mail)
    let automated = 0
    const contacts: SpaceContactFacts[] = []
    for (const c of this.listContacts(mail)) {
      // A Telegram group's or channel's own contact stands for a conversation and is not a person: People leaves it out (and does not count it among the automated senders).
      if (c.identities.some((i) => i.chat !== undefined)) continue
      if (c.sender.automated) {
        automated += 1
        if (!includeAutomated) continue
      }
      const p = profiles.get(c.id) ?? { business: '', role: '', rev: 0 }
      contacts.push({ contact: c, groups: groups.get(c.id) ?? [], ...p, sendsFrom: this.sendsFromOfContact(c, mail) })
    }
    return { contacts, automated }
  }

  /** One contact with its note, or 404. An automated sender is readable by its id (a link to one still opens); only the directory leaves them out. */
  spaceContactProfile(contactId: string, mail: MailScope): Result<SpaceContactFacts & { notes: string }> {
    const found = this.listContacts(mail).find((c) => c.id === contactId)
    const profile = this.profileRow(contactId)
    if (!found || !profile) return fail(404, 'No such contact.')
    return ok({
      contact: found,
      groups: this.groupsWritten(contactId, mail).get(contactId) ?? [],
      business: profile.business,
      role: profile.role,
      rev: profile.rev,
      sendsFrom: this.sendsFromOfContact(found, mail),
      notes: profile.notes,
    })
  }

  /** `sendsFrom` for a contact of the directory: only one with an email address is written to by email. */
  private sendsFromOfContact(c: ContactListItem, scope: MailScope): SendsFrom | null {
    return c.identities.some((i) => i.kind === 'email') ? (this.sendsFromOf(c.id, scope).sendsFrom ?? null) : null
  }

  /**
   * Save the three fields at the revision the caller was shown. 409 (nothing changed) when the contact has moved on; 422 for a field past its limit.
   * The values are trimmed. A save that changes nothing writes nothing and leaves the revision, but the revision is checked first, so a stale screen
   * is told so even when it would have written what is there. Audited with the fields before and after.
   */
  saveContactProfile(
    edit: { contactId: string; rev: number; business: string; role: string; notes: string },
    actor: string,
  ): Result<ContactProfile> {
    // The limit and its words are the contract's, once (`profileLimitMessage`); this is the check that counts, since it is the one nothing can get past.
    const tooLong = profileLimitMessage(edit)
    if (tooLong !== null) return fail(422, tooLong)
    const business = edit.business.trim()
    const role = edit.role.trim()
    const notes = edit.notes.trim()
    return this.ports.transaction(() => {
      const before = this.profileRow(edit.contactId)
      if (!before) return fail(404, 'No such contact.')
      if (before.rev !== edit.rev) {
        return fail(
          409,
          'This person changed since you opened them, so nothing was saved. They are shown as they are now.',
        )
      }
      if (before.business === business && before.role === role && before.notes === notes) return ok(before)
      this.setProfile(edit.contactId, { business, role, notes })
      const after = this.profileRow(edit.contactId) as ContactProfile
      this.audit(actor, 'contact.profile', `contact:${edit.contactId}`, before, after)
      return ok(after)
    })
  }

  /**
   * Put a merge back from its audit entry (`mergeContacts` writes it): the absorbed contact is made again under its own id with its name, its Client, its fields and when
   * it was made; the addresses it had that are STILL on the survivor move back to it (one split off since stays where it went); and the survivor's Client and fields go
   * back to what they were before the merge, but only if nobody has changed them since (its Client's stamp is the merge's own, and its three fields are still what the merge left: a rename or a split raises the revision without touching them, so a revision that moved does not by itself mean they changed). Both revisions go up,
   * never back. 404 for an entry that is not a merge; 409 when the absorbed contact exists (undone already), when a later merge of the same contact exists, when the survivor
   * is gone, or when none of the addresses is on the survivor any more. Conversations and drafts follow the addresses, as they did when merging.
   */
  undoMerge(mergeId: number, actor: string): Result<{ survivor: ContactRow; restored: ContactRow }> {
    return this.ports.transaction(() => {
      const entry = this.sql.exec(`SELECT action, before, after FROM audit WHERE id = ?1`, mergeId).toArray()[0]
      if (entry?.action !== 'contact.merge') return fail(404, 'There is no such merge.')
      const was = parseMerge(entry.before, entry.after)
      if (!was) return fail(404, 'There is no such merge.')
      if (this.contactRow(was.absorbed.id)) return fail(409, 'That merge was undone already.')
      // The same person merged again since (undone once, then merged a second time): this entry is the older one, and undoing it would put the contact back from a state
      // the later merge has moved on from. The later merge is the one to undo.
      const later = this.sql
        .exec(
          `SELECT id FROM audit WHERE action = 'contact.merge' AND id > ?1 AND json_extract(before, '$.absorbed.id') = ?2 LIMIT 1`,
          mergeId,
          was.absorbed.id,
        )
        .toArray()[0]
      if (later) {
        return fail(409, `${was.absorbed.name} was merged again since, so that later merge is the one to undo.`)
      }
      const survivor = this.contactRow(was.survivor.id)
      if (!survivor) {
        return fail(
          409,
          `${was.survivor.name} is not a contact any more (they were merged into someone else), so this merge cannot be undone from here.`,
        )
      }
      const here = new Set(survivor.identities.map((i) => i.id))
      const back = was.absorbed.identities.filter((i) => here.has(i.id))
      if (back.length === 0) {
        return fail(
          409,
          `None of ${was.absorbed.name}’s addresses is on ${survivor.name} any more, so there is nothing to undo.`,
        )
      }
      this.sql.exec(
        `INSERT INTO contact (id, name, created_at, created_by, client_id, client_set_by, client_set_at, business, role, notes, profile_rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        was.absorbed.id,
        was.absorbed.name,
        was.made.at,
        was.made.by,
        was.absorbed.clientId,
        was.absorbed.clientSetBy,
        was.absorbed.clientSetAt,
        was.profiles.absorbed.business,
        was.profiles.absorbed.role,
        was.profiles.absorbed.notes,
        was.profiles.absorbed.rev + 1,
      )
      for (const i of back) {
        this.sql.exec(
          `UPDATE identity SET contact_id = ?1 WHERE id = ?2 AND contact_id = ?3`,
          was.absorbed.id,
          i.id,
          survivor.id,
        )
      }
      // The survivor goes back to what it was before the merge only where it is still what the merge left it.
      const profileNow = this.profileRow(survivor.id) as ContactProfile
      // A rename or a split raises the revision without touching the three fields, so "nobody has changed them" is the fields still being what the merge left, as well as the revision being the merge's own.
      const unchanged =
        profileNow.rev === was.mergedProfile.rev ||
        (profileNow.business === was.mergedProfile.business &&
          profileNow.role === was.mergedProfile.role &&
          profileNow.notes === was.mergedProfile.notes)
      const fields = unchanged ? was.profiles.survivor : profileNow
      this.setProfile(survivor.id, fields)
      const clientUntouched =
        survivor.clientId === was.merged.clientId &&
        survivor.clientSetAt === was.merged.clientSetAt &&
        survivor.clientSetBy === was.merged.clientSetBy
      if (clientUntouched) {
        this.sql.exec(
          `UPDATE contact SET client_id = ?2, client_set_by = ?3, client_set_at = ?4 WHERE id = ?1`,
          survivor.id,
          was.survivor.clientId,
          was.survivor.clientSetBy,
          was.survivor.clientSetAt,
        )
      }
      const after = {
        survivor: this.contactRow(survivor.id) as ContactRow,
        restored: this.contactRow(was.absorbed.id) as ContactRow,
      }
      this.audit(
        actor,
        'contact.unmerge',
        `contact:${survivor.id}`,
        { mergeId },
        { ...after, moved: back.map((i) => i.address) },
      )
      return ok(after)
    })
  }

  // ─── what the space reads ─────────────────────────────────────────────

  /**
   * The contact a person is named by: an id the space holds, or an email address (as stored, so the caller has normalised it).
   * Null when there is none.
   */
  spaceContact(who: { contactId: string } | { address: string }, mail: MailScope): { id: string; name: string } | null {
    const row =
      'contactId' in who
        ? this.sql.exec(`SELECT id, name FROM contact WHERE id = ?1`, who.contactId).toArray()[0]
        : this.sql
            .exec(
              `SELECT c.id, c.name FROM identity i JOIN contact c ON c.id = i.contact_id
                WHERE i.kind = 'email' AND i.address = ?1 ORDER BY i.rowid LIMIT 1`,
              who.address,
            )
            .toArray()[0]
    // A contact whose mail is not the person's is not theirs to find, by an id or by an address.
    return row && (this.visibleContactIds(mail)?.has(text(row.id)) ?? true)
      ? { id: text(row.id), name: text(row.name) }
      : null
  }

  /** The contacts that have any of these email addresses (as stored), each once. */
  spaceContactsWith(addresses: string[]): string[] {
    if (addresses.length === 0) return []
    return this.sql
      .exec(
        `SELECT DISTINCT contact_id FROM identity
          WHERE kind = 'email' AND address IN (SELECT value FROM json_each(?1)) ORDER BY contact_id`,
        JSON.stringify(addresses),
      )
      .toArray()
      .map((r) => text(r.contact_id))
  }

  /**
   * The conversations in scope, newest first, at most a screen of them (`QUEUE_PAGE`, with `more` when there were others). The
   * main list is the queue's own Inbox: open and not Bulk, of every mailbox. `bulk` adds the open Bulk ones and `closed` the
   * closed ones, and nothing else is in the answer. `drafts` replaces all of that with the conversations that hold a draft, in any state (the Drafts count's own set).
   */
  spaceConversations(scope: SpaceScope): { conversations: SpaceConversation[]; more: boolean } {
    const on =
      scope.contactIds === undefined
        ? null
        : new Set(
            scope.contactIds.length === 0
              ? []
              : this.sql
                  .exec(
                    `SELECT DISTINCT p.conversation_id AS id FROM participant p JOIN identity i ON i.id = p.identity_id
                      WHERE i.contact_id IN (SELECT value FROM json_each(?1))`,
                    JSON.stringify(scope.contactIds),
                  )
                  .toArray()
                  .map((r) => text(r.id)),
          )
    const visible = this.queueFacts(null, scope.mail)
    if (scope.sent === true) return this.sentConversations(on, new Set(visible.map((f) => f.id)), scope.team)
    const kept = visible.filter((f) => {
      if (on !== null && !on.has(f.id)) return false
      if (scope.drafts === true) return f.drafts > 0
      if (!f.open) return scope.closed === true
      return isBulk(f) ? scope.bulk === true : true
    })
    if (scope.all === true) {
      const everything = kept.map((f) => f.id)
      return {
        conversations: this.shape(
          everything.length === 0
            ? []
            : this.conversationsWhere(
                'c.id IN (SELECT value FROM json_each(?1))',
                [JSON.stringify(everything)],
                everything.length,
              ),
          scope.team,
        ),
        more: false,
      }
    }
    const ids = kept.slice(0, QUEUE_PAGE).map((f) => f.id)
    return { conversations: this.shape(this.listConversations(ids), scope.team), more: kept.length > QUEUE_PAGE }
  }

  /**
   * The Sent view: the conversations the owner sent a message in (a message going out that is sent, or marked sent by hand: a draft, a send in doubt and a failed one are not), open or
   * closed, Bulk or not, newest send first, cut at the same screen as the other lists (`more` when there were others). Each comes as of the owner's newest sent message: its time, its words
   * and `out`, so a row reads "You: ..." and the lists order by the owner's send and not by what arrived after it. Which person the row is under is the lists' rule (`placed`), unchanged.
   */
  private sentConversations(
    on: Set<string> | null,
    visible: ReadonlySet<string>,
    team: readonly string[],
  ): { conversations: SpaceConversation[]; more: boolean } {
    const sentBy = (alias: string) => `${alias}.direction = 'out' AND ${alias}.status IN ('sent', 'manual-sent')`
    const latest = this.sql
      .exec(
        `SELECT m.conversation_id AS id, coalesce(m.sent_at, m.created_at) AS at, substr(m.body, 1, 2000) AS body
           FROM message m
          WHERE m.conversation_id IS NOT NULL AND ${sentBy('m')}
            AND m.rowid = (SELECT l.rowid FROM message l
                            WHERE l.conversation_id = m.conversation_id AND ${sentBy('l')}
                            ORDER BY coalesce(l.sent_at, l.created_at) DESC, l.rowid DESC LIMIT 1)
          ORDER BY at DESC, m.rowid DESC`,
      )
      .toArray()
      .filter((r) => visible.has(text(r.id)) && (on === null || on.has(text(r.id))))
    const shown = latest.slice(0, QUEUE_PAGE)
    const sent = new Map(shown.map((r, n) => [text(r.id), { n, at: text(r.at), body: text(r.body) }]))
    const conversations = this.shape(this.listConversations([...sent.keys()]), team)
      .map((c): SpaceConversation => {
        const mine = sent.get(c.id) as { n: number; at: string; body: string }
        // Repaired and cut as a list line's snippet is (conversationsWhere), so the row reads as the others do.
        const snippet = repairMojibake(mine.body).replace(/\s+/g, ' ').trim().slice(0, 160)
        return { ...c, newestAt: mine.at, snippet, direction: 'out' }
      })
      .sort((a, b) => (sent.get(a.id) as { n: number }).n - (sent.get(b.id) as { n: number }).n)
    return { conversations, more: latest.length > QUEUE_PAGE }
  }

  /**
   * The menu's counts as rows, every conversation counted and none cut to a screen (see `rowCounts`, src/store/row-counts.ts). `team` is each teammate's addresses (the company
   * address and the sign-in address), because the space puts a teammate known by both in one row. One read of the queue's facts, two of the people on them and the placement of every conversation (`placements`: the newest message from each contact on each conversation, grouped in SQL; no message body is read).
   */
  spaceRowCounts(team: string[][], mail: MailScope): RowCounts {
    const addresses = new Map<string, string[]>()
    for (const r of this.sql.exec(`SELECT contact_id, address FROM identity WHERE kind = 'email'`).toArray()) {
      const held = addresses.get(text(r.contact_id)) ?? []
      held.push(text(r.address).trim().toLowerCase())
      addresses.set(text(r.contact_id), held)
    }
    const facts = this.queueFacts(null, mail)
    const visible = new Set(facts.map((f) => f.id))
    const placed = this.placements(null, team.flat())
    const parties = this.sql
      .exec(
        `SELECT DISTINCT p.conversation_id AS conversation_id, ct.id AS contact_id, ct.client_id AS client_id
           FROM participant p
           JOIN identity i ON i.id = p.identity_id
           JOIN contact ct ON ct.id = i.contact_id`,
      )
      .toArray()
      .filter((r) => visible.has(text(r.conversation_id)))
      .map((r) => ({
        conversationId: text(r.conversation_id),
        contactId: text(r.contact_id),
        clientId: r.client_id === null ? null : Number(r.client_id),
        addresses: addresses.get(text(r.contact_id)) ?? [],
        placed: placed.get(text(r.conversation_id))?.everyone === text(r.contact_id),
        placedInClient:
          r.client_id !== null &&
          placed.get(text(r.conversation_id))?.byClient.get(Number(r.client_id)) === text(r.contact_id),
      }))
    return rowCounts(facts, parties, team)
  }

  /** The conversations the inbox's search finds for these words (src/search.ts), with the line that matched, open or closed, Bulk or not. */
  spaceSearch(
    terms: string[],
    team: readonly string[],
    mail: MailScope,
  ): { hits: { conversation: SpaceConversation; match: string | null }[]; more: boolean } {
    const found = this.searchConversations(terms, mail)
    const shaped = this.shape(
      found.hits.map((h) => h.conversation),
      team,
    )
    return {
      hits: shaped.map((conversation, n) => ({ conversation, match: found.hits[n]?.match ?? null })),
      more: found.more,
    }
  }

  /**
   * A page of the messages on these conversations that are not drafts, newest `limit` before `before` (a message id the caller
   * holds the oldest of), answered oldest first, with `more` when there are older ones still. The store's order: time, then the
   * order they were stored. Null when `before` is not a message on one of these conversations.
   *
   * `older` is the text of the messages on the conversations of this page that come BEFORE it, oldest first: a quote is proved
   * against the earlier messages of its conversation (quote.ts), and a page back in time must not lose them. Empty when the page
   * reaches the start of everything asked for.
   *
   * `own` is every address that is the owner's (each Gmail account and mailbox: `ownAddresses`), lower case, for the one thing the page says "you" by: an invitation whose organizer is one of them reads "From you" to the owner.
   */
  spaceMessages(
    conversationIds: string[],
    before: string | null,
    limit: number,
  ): {
    messages: MessageRow[]
    more: boolean
    older: { conversationId: string; body: string }[]
    own: string[]
  } | null {
    if (conversationIds.length === 0) return before === null ? { messages: [], more: false, older: [], own: [] } : null
    const ids = JSON.stringify(conversationIds)
    if (before !== null) {
      const held = this.sql
        .exec(
          `SELECT 1 FROM message WHERE id = ?1 AND status NOT IN ${PENDING}
              AND conversation_id IN (SELECT value FROM json_each(?2))`,
          before,
          ids,
        )
        .toArray()[0]
      if (!held) return null
    }
    const rows = this.sql
      .exec(
        `${this.messageSelect()}
          WHERE m.conversation_id IN (SELECT value FROM json_each(?1)) AND m.status NOT IN ${PENDING}
            AND (?2 IS NULL OR (coalesce(m.sent_at, m.created_at), m.rowid) <
                 (SELECT coalesce(b.sent_at, b.created_at), b.rowid FROM message b WHERE b.id = ?2))
          ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.rowid DESC
          LIMIT ${Math.trunc(limit) + 1}`,
        ids,
        before,
      )
      .toArray()
      .map(messageRow)
    const messages = this.withDelivery(rows.slice(0, limit).reverse())
    const first = messages[0]
    const more = rows.length > limit
    let older: { conversationId: string; body: string }[] = []
    if (first !== undefined && (more || before !== null)) {
      const onPage = JSON.stringify([...new Set(messages.map((m) => m.conversationId))])
      older = this.sql
        .exec(
          `SELECT m.conversation_id AS conversation_id, m.body AS body FROM message m
            WHERE m.conversation_id IN (SELECT value FROM json_each(?1)) AND m.status NOT IN ${PENDING}
              AND (coalesce(m.sent_at, m.created_at), m.rowid) <
                  (SELECT coalesce(b.sent_at, b.created_at), b.rowid FROM message b WHERE b.id = ?2)
            ORDER BY coalesce(m.sent_at, m.created_at), m.rowid`,
          onPage,
          first.id,
        )
        .toArray()
        .map((r) => ({ conversationId: text(r.conversation_id), body: text(r.body) }))
    }
    return { messages, more, older, own: [...this.ownAddresses()].map((a) => a.toLowerCase()) }
  }

  /**
   * The summaries with what the queue's summary lacks: who is on each (and under which address), which way the newest message
   * went and when, how far into it this answer reaches, and whether a reply can go on it. Three reads for all of them.
   */
  private shape(summaries: ConversationSummary[], team: readonly string[]): SpaceConversation[] {
    if (summaries.length === 0) return []
    const ids = JSON.stringify(summaries.map((s) => s.id))
    const newest = new Map<
      string,
      {
        direction: 'in' | 'out'
        at: string | null
        through: number
        canReply: boolean
        telegramChat: 'group' | 'channel' | null
        needsReply: boolean | null
        /** Who wrote the newest message, as it names them: a group's row says it before the words. */
        from: string
      }
    >()
    for (const r of this.sql
      .exec(
        `SELECT c.id AS id, c.mailbox_id IS NOT NULL AS has_mailbox, c.telegram_kind AS telegram_kind,
                CASE WHEN c.telegram_kind = 'group' THEN EXISTS (
                  SELECT 1 FROM message a
                   WHERE a.conversation_id = c.id AND a.direction = 'in' AND a.telegram_to_me = 1 AND a.deleted_at IS NULL AND a.status NOT IN ${PENDING}
                     AND coalesce(a.sent_at, a.created_at) > coalesce(
                       (SELECT max(coalesce(o.sent_at, o.created_at)) FROM message o
                         WHERE o.conversation_id = c.id AND o.direction = 'out' AND o.status NOT IN ${PENDING}), '')) END AS needs_reply,
                (SELECT mb.kind FROM mailbox mb WHERE mb.id = c.mailbox_id) AS mailbox_kind,
                (SELECT l.direction FROM message l WHERE l.conversation_id = c.id AND l.status NOT IN ${PENDING}
                  ORDER BY coalesce(l.sent_at, l.created_at) DESC, l.rowid DESC LIMIT 1) AS direction,
                (SELECT coalesce(l.sent_at, l.created_at) FROM message l WHERE l.conversation_id = c.id AND l.status NOT IN ${PENDING}
                  ORDER BY coalesce(l.sent_at, l.created_at) DESC, l.rowid DESC LIMIT 1) AS at,
                (SELECT l.from_header FROM message l WHERE l.conversation_id = c.id AND l.status NOT IN ${PENDING}
                  ORDER BY coalesce(l.sent_at, l.created_at) DESC, l.rowid DESC LIMIT 1) AS newest_from,
                (SELECT coalesce(max(rowid), 0) FROM message WHERE conversation_id = c.id AND status NOT IN ${PENDING}) AS through
           FROM conversation c WHERE c.id IN (SELECT value FROM json_each(?1))`,
        ids,
      )
      .toArray()) {
      newest.set(text(r.id), {
        direction: r.direction === 'in' ? 'in' : 'out',
        at: textOrNull(r.at),
        through: Number(r.through),
        // A Telegram chat is answered through the bridge, one-to-one or in a group; a channel is one the owner follows and has no reply box, so a draft on it is a hand draft.
        canReply: Number(r.has_mailbox) === 1 && !(r.mailbox_kind === 'telegram' && r.telegram_kind === 'channel'),
        telegramChat: r.telegram_kind === 'group' || r.telegram_kind === 'channel' ? r.telegram_kind : null,
        needsReply: r.needs_reply === null || r.needs_reply === undefined ? null : Number(r.needs_reply) === 1,
        from: textOrNull(r.newest_from) ?? '',
      })
    }

    const placed = this.placements(
      summaries.map((x) => x.id),
      team,
    )
    const emails = new Map<string, string[]>()
    const partyRows = this.sql
      .exec(
        `SELECT p.conversation_id AS conversation_id, ct.id AS contact_id, ct.name AS name, ct.client_id AS client_id,
                i.kind AS kind, i.address AS address
           FROM participant p
           JOIN identity i ON i.id = p.identity_id
           JOIN contact ct ON ct.id = i.contact_id
          WHERE p.conversation_id IN (SELECT value FROM json_each(?1))
          ORDER BY ct.rowid, i.rowid`,
        ids,
      )
      .toArray()
    const contactIds = [...new Set(partyRows.map((r) => text(r.contact_id)))]
    if (contactIds.length > 0) {
      for (const r of this.sql
        .exec(
          `SELECT contact_id, address FROM identity
            WHERE kind = 'email' AND contact_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid`,
          JSON.stringify(contactIds),
        )
        .toArray()) {
        const held = emails.get(text(r.contact_id)) ?? []
        held.push(text(r.address))
        emails.set(text(r.contact_id), held)
      }
    }
    const partiesOf = new Map<string, Map<string, SpaceParty>>()
    for (const r of partyRows) {
      const conversation = text(r.conversation_id)
      const contact = text(r.contact_id)
      const held = partiesOf.get(conversation) ?? new Map<string, SpaceParty>()
      const party = held.get(contact) ?? {
        contactId: contact,
        name: text(r.name),
        clientId: r.client_id === null ? null : Number(r.client_id),
        emails: emails.get(contact) ?? [],
        here: null,
      }
      if (party.here === null && r.kind === 'email') party.here = text(r.address)
      held.set(contact, party)
      partiesOf.set(conversation, held)
    }

    return summaries.map((s) => {
      const facts = newest.get(s.id)
      return {
        id: s.id,
        subject: repairMojibake(s.subject),
        snippet: groupSnippet(s.snippet, facts),
        kind: s.kind,
        newestAt: facts?.at ?? s.lastActivityAt,
        direction: facts?.direction ?? 'out',
        unread: s.unread,
        open: s.open,
        bulk: isBulk(s),
        drafts: s.drafts,
        mailbox: s.mailbox ?? null,
        mailboxKind: s.mailboxKind ?? null,
        through: facts?.through ?? 0,
        canReply: facts?.canReply ?? false,
        telegramChat: facts?.telegramChat ?? null,
        needsReply: facts?.needsReply ?? null,
        parties: [...(partiesOf.get(s.id)?.values() ?? [])],
        placed: placed.get(s.id) ?? { everyone: null, byClient: new Map() },
      }
    })
  }

  /**
   * Where each conversation is listed (see src/store/placement.ts, the rule): for these conversations, or for every one when `ids` is null (the menu's counts). The lists
   * and the counts both read it, so they place a thread alike. Two reads: who is on each conversation, and the newest message of each of them from each contact.
   */
  private placements(ids: string[] | null, team: readonly string[]): Map<string, Placed> {
    const inside = new Set([...this.ownAddresses(), ...team.map((a) => a.trim().toLowerCase())])
    const only = ids === null ? '' : 'AND conversation_id IN (SELECT value FROM json_each(?1))'
    const args = ids === null ? [] : [JSON.stringify(ids)]
    const emails = new Map<string, string[]>()
    for (const r of this.sql.exec(`SELECT contact_id, address FROM identity WHERE kind = 'email'`).toArray()) {
      const held = emails.get(text(r.contact_id)) ?? []
      held.push(text(r.address))
      emails.set(text(r.contact_id), held)
    }
    const times = new Map<string, { wroteAt: string | null; touchedAt: string | null }>()
    for (const r of this.sql
      .exec(
        `SELECT m.conversation_id AS conversation_id, i.contact_id AS contact_id,
                max(CASE WHEN m.direction = 'in' THEN coalesce(m.sent_at, m.created_at) END) AS wrote_at,
                max(coalesce(m.sent_at, m.created_at)) AS touched_at
           FROM message m JOIN identity i ON i.id = m.identity_id
          WHERE m.conversation_id IS NOT NULL AND m.status NOT IN ${PENDING} ${only.replace('conversation_id', 'm.conversation_id')}
          GROUP BY m.conversation_id, i.contact_id`,
        ...args,
      )
      .toArray()) {
      times.set(`${text(r.conversation_id)}\u0000${text(r.contact_id)}`, {
        wroteAt: textOrNull(r.wrote_at),
        touchedAt: textOrNull(r.touched_at),
      })
    }
    const candidates = new Map<string, (PlacementCandidate & { clientId: number | null })[]>()
    for (const r of this.sql
      .exec(
        `SELECT DISTINCT p.conversation_id AS conversation_id, ct.id AS contact_id, ct.name AS name, ct.client_id AS client_id
           FROM participant p
           JOIN identity i ON i.id = p.identity_id
           JOIN contact ct ON ct.id = i.contact_id
          WHERE 1 = 1 ${only.replace('conversation_id', 'p.conversation_id')}`,
        ...args,
      )
      .toArray()) {
      const conversation = text(r.conversation_id)
      const contactId = text(r.contact_id)
      const held = times.get(`${conversation}\u0000${contactId}`)
      const list = candidates.get(conversation) ?? []
      list.push({
        contactId,
        name: text(r.name),
        clientId: r.client_id === null ? null : Number(r.client_id),
        addresses: emails.get(contactId) ?? [],
        inside: isInside(emails.get(contactId) ?? [], inside),
        wroteAt: held?.wroteAt ?? null,
        touchedAt: held?.touchedAt ?? null,
      })
      candidates.set(conversation, list)
    }
    const out = new Map<string, Placed>()
    for (const [conversation, list] of candidates) out.set(conversation, placeConversation(list))
    return out
  }
}
