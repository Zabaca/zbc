// A person's history: their emails (from the inbox) and their direct messages (from meet) as one run of entries by time, and the paging back
// through it. Pure: no I/O and no clock, so the Worker, the page and `bun test` all use the same functions on literal data.
//
// The two apps page their own history, each by the id of the oldest message the caller holds (`InboxHistoryQuery.before`, meet's `history`).
// A page of mail and a page of chat reach back different distances in time, so showing both as they came would put old mail beside a chat that
// stops yesterday, with the chat between missing. The merge therefore shows only as far back as every source that has more has been read
// (`cutoff`): what is older stays held, and appears when the source that stopped first is paged. The rule is one line to say and one test.

import type { InboxAttachment, InboxCalendar, InboxDeliveryNote, InboxRead } from '@space/workspace'

/**
 * An email's calendar summary as the page draws it: the inbox's (`InboxCalendar`, read once when the mail arrived) and, for the OWNER where the Calendar tab exists, the Calendar tab's copy of the event it is about
 * (`eventId`, the card's address in the tab), which has also lent a title or a time the part itself left out (a bare "accepted"). A teammate's never has `eventId`, and nothing of the owner's calendar is in it.
 */
export interface MailCalendar extends InboxCalendar {
  eventId?: string
}

/** One email, or a text or note the inbox logged, as the page draws it: the contract's `InboxMessage` without what the page does not use. */
export interface MailMessage {
  id: string
  conversationId: string
  subject: string
  direction: 'in' | 'out'
  at: number
  from: string
  text: string
  textCut: boolean
  /** How the inbox's own page reads it: what the sender wrote now and the quoted rest it folds. Absent from an inbox that predates it: draw `text` whole. */
  read?: InboxRead
  /** Who an outgoing message went to, as its header wrote it. Absent on mail received and from an older inbox. */
  to?: string
  /** The files on it. Absent when there are none and from an inbox that predates them: draw no files. */
  attachments?: InboxAttachment[]
  /** What the email's calendar part says, drawn as a card in place of the empty bubble when the email has no words. Absent on an email with none and from an inbox that predates it: no card. */
  calendar?: MailCalendar
  /** How Cloudflare says a message sent as a business mailbox went, one note per recipient reported. Absent when nothing was reported and from an inbox that predates it: say nothing. */
  delivery?: InboxDeliveryNote[]
  /** A text or a direct message the owner marked sent by hand: the page offers "Not sent after all" on it. Absent from an inbox that predates it: no way back is offered. */
  sentByHand?: boolean
  /** A Telegram message its sender edited (the text is the new one): the page says so. Absent otherwise and from an inbox that predates it. */
  edited?: boolean
  /** A Telegram message its sender deleted for everyone: no words are held, and the page draws a line saying one was deleted. Absent otherwise. */
  deleted?: boolean
}

/** One direct message or channel post. */
export interface ChatMessage {
  id: number
  conversationId: number
  authorName: string
  mine: boolean
  at: number
  text: string
  edited: boolean
  /** What the person may do with it, by meet's rules. Absent from a meet that predates it: the message is drawn without buttons. */
  may?: { edit: boolean; delete: boolean }
  /** The call this message announces, when it is a huddle started here: the page draws its card in place of the words. */
  huddle?: string
}

/**
 * A run of messages from one place, oldest first, and whether there are older ones. Mail is read per inbox CONTACT (a person may be two
 * contacts, one for each of their addresses); chat per conversation.
 */
export type HistorySource =
  | { kind: 'mail'; contactId: string; messages: MailMessage[]; more: boolean }
  | { kind: 'chat'; conversationId: number; messages: ChatMessage[]; more: boolean }

export type Entry = { kind: 'email'; key: string; at: number; message: MailMessage } | { kind: 'chat'; key: string; at: number; message: ChatMessage }

export const sourceId = (s: HistorySource): string => (s.kind === 'mail' ? `mail:${s.contactId}` : `chat:${s.conversationId}`)

const oldestAt = (s: HistorySource): number | null => s.messages[0]?.at ?? null

/** The id a page back from this source starts after: the oldest message held. Null for a source with nothing in it. */
export function oldestId(s: HistorySource): string | null {
  const first = s.messages[0]
  return first === undefined ? null : String(first.id)
}

/**
 * How far back the merged history may be shown: the latest of the oldest times of the sources that have more. Nothing older than this is
 * shown until those sources are paged, because a source that has more may still hold something between. Null when no source has more.
 */
export function cutoffOf(sources: readonly HistorySource[]): number | null {
  let cutoff: number | null = null
  for (const s of sources) {
    const at = s.more ? oldestAt(s) : null
    if (at !== null && (cutoff === null || at > cutoff)) cutoff = at
  }
  return cutoff
}

/** The sources to page when the person asks for earlier messages: those that have more and stop at the cutoff (the others already reach further back). */
export function sourcesToPage(sources: readonly HistorySource[]): HistorySource[] {
  const cutoff = cutoffOf(sources)
  if (cutoff === null) return []
  return sources.filter((s) => s.more && oldestId(s) !== null && (oldestAt(s) as number) >= cutoff)
}

const byTime = (a: Entry, b: Entry): number => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'email' ? -1 : 1) || compareIds(a.message.id, b.message.id)

function compareIds(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

export interface MergedHistory {
  /** Oldest first, none twice, none older than `cutoff`. */
  entries: Entry[]
  /** There are older messages somewhere than the first entry. */
  hasEarlier: boolean
  cutoff: number | null
}

/** The sources as one history. An email that two of a person's contacts are both on is one entry, whichever read brought it. */
export function mergeHistory(sources: readonly HistorySource[]): MergedHistory {
  const cutoff = cutoffOf(sources)
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const s of sources) {
    if (s.kind === 'mail') {
      for (const m of s.messages) {
        const key = `email:${m.id}`
        if (seen.has(key) || (cutoff !== null && m.at < cutoff)) continue
        seen.add(key)
        entries.push({ kind: 'email', key, at: m.at, message: m })
      }
    } else {
      for (const m of s.messages) {
        const key = `chat:${m.conversationId}:${m.id}`
        if (seen.has(key) || (cutoff !== null && m.at < cutoff)) continue
        seen.add(key)
        entries.push({ kind: 'chat', key, at: m.at, message: m })
      }
    }
  }
  entries.sort(byTime)
  return { entries, hasEarlier: sources.some((s) => s.more), cutoff }
}

/** `older` placed before `held`, none that is held twice. */
function placeBefore<M extends { id: string | number }>(held: readonly M[], older: readonly M[]): M[] {
  const have = new Set(held.map((m) => m.id))
  return [...older.filter((m) => !have.has(m.id)), ...held]
}

/** A page of older messages comes in before what is held. The page is of the same kind as the source: the caller asked for it for this source. */
export function withEarlier(source: HistorySource, page: { messages: readonly (MailMessage | ChatMessage)[]; more: boolean }): HistorySource {
  return source.kind === 'mail'
    ? { ...source, messages: placeBefore(source.messages, page.messages as readonly MailMessage[]), more: page.more }
    : { ...source, messages: placeBefore(source.messages, page.messages as readonly ChatMessage[]), more: page.more }
}

/**
 * A page of older messages that was asked for while the conversation stayed open, put on the source it was asked of, if that source still stops where it did
 * when the page was asked for (`before`, the id of the oldest message it held). A refresh in between may have replaced what was held (more than a page
 * arrived at once), and an old page placed on that would leave a gap: it is dropped, and "Earlier messages" asks again from where the source now stops.
 */
export function withEarlierPage(sources: readonly HistorySource[], id: string, before: string | null, page: { messages: readonly (MailMessage | ChatMessage)[]; more: boolean }): HistorySource[] {
  return sources.map((held) => (sourceId(held) === id && oldestId(held) === before ? withEarlier(held, page) : held))
}

/** The older messages a source holds that come before the first of a fresh page, or null when the fresh page reaches back to nothing held. */
function heldBefore<M extends { id: string | number }>(held: readonly M[], fresh: readonly M[]): M[] | null {
  const first = fresh[0]
  if (first === undefined) return null
  const at = held.findIndex((m) => m.id === first.id)
  return at < 0 ? null : held.slice(0, at)
}

/**
 * The newest page read again while the person has the conversation open: new messages arrive, the older pages the person has paged back
 * through stay. If the fresh page does not reach back to anything held (more than a page arrived at once), what was held is dropped, so
 * there is never a gap, and the older ones are paged again.
 */
export function refreshSources(held: readonly HistorySource[], fresh: readonly HistorySource[]): HistorySource[] {
  return fresh.map((f): HistorySource => {
    const old = held.find((h) => sourceId(h) === sourceId(f))
    if (!old || old.kind !== f.kind) return f
    if (f.kind === 'mail') {
      const before = heldBefore((old as typeof f).messages, f.messages)
      return before === null ? f : { ...f, messages: [...before, ...f.messages], more: before.length > 0 ? old.more : f.more }
    }
    const before = heldBefore((old as typeof f).messages, f.messages)
    return before === null ? f : { ...f, messages: [...before, ...f.messages], more: before.length > 0 ? old.more : f.more }
  })
}

/**
 * A chat message changed or gone in the sources held (an edit or a delete the person just made): `change` answers the message as it now stands, or null where it is gone. The message
 * may be older than the newest page, which a read of the conversation does not bring back, so the held copy is changed here rather than waiting for one.
 */
export function changeChat(sources: readonly HistorySource[], messageId: number, change: (m: ChatMessage) => ChatMessage | null): HistorySource[] {
  return sources.map((s): HistorySource => {
    if (s.kind !== 'chat' || !s.messages.some((m) => m.id === messageId)) return s
    return {
      ...s,
      messages: s.messages.flatMap((m) => {
        if (m.id !== messageId) return [m]
        const changed = change(m)
        return changed === null ? [] : [changed]
      }),
    }
  })
}

/** Which email threads (by conversation id) an entry belongs to, for the heading above a run of them. */
export const groupOf = (e: Entry): string => (e.kind === 'email' ? `email:${e.message.conversationId}` : `chat:${e.message.conversationId}`)
