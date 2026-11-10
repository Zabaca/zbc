// Today: what the apps behind the space say needs the person, gathered into one answer for the page.
//
// Seven READS, in parallel, each given `ANSWER_WITHIN_MS` and each allowed to fail on its own, as the Conversations list's two are:
//   the inbox's `people` and `drafts`; meet's `conversations` and `liveCalls`; forms' `documents`, three times (not yet sent, out for
//   signature, signed today). A read that does not answer leaves the others on the page, and the answer says which one it was
//   (`sources`), so the page can say what is missing instead of claiming there is nothing.
//
// TODAY HOLDS NOTHING TO ACT ON. A row is a fact and a handle: the key of the conversation it opens, a call's name, a document's id. The page
// makes the link (a conversation's from its key, a call's on meet's own address, a document's in Forms), so no address is built here.
//
// "TODAY" IS THE COMPANY'S DAY, in its declared time zone (`company.timeZone`), not the Worker's (UTC) and not the browser's. Signed
// and back is "completed since this day began there", and Later today and Tomorrow are the two days after the moment it is asked.
//
// The merge that gives the Conversations list its rows is used here for one thing: the key of the conversation a contact is in, so a row
// opens exactly the conversation the list would (conversations.ts).

import { ANSWER_WITHIN_MS, type CalendarEvent, type ConversationRef, type DocumentSummary, type InboxPeople, momentAt, wallAt } from '@space/workspace'
import { MAIN, type ListedConversation, type ListedPerson, isConversationRow, mergeConversations } from './conversations'
import { type Asking, outcomeOf } from './list'
import { isCalendarAgenda } from './calendar'
import { isDocuments, isInboxDrafts, isInboxPeople, isMeetCalls, isMeetLiveCalls, isMeetOverview, notConnected, reach } from './reach'
import {
  type ChatWaiting,
  type ConversationTab,
  type Draft,
  type DocumentRow,
  type MailWaiting,
  type Meeting,
  SECTION_ROWS,
  SOURCES,
  type Section,
  type TodayEvent,
  type SourceId,
  type SourceStatus,
  type TodayAnswer,
  type Waiting,
} from './today-shape'

// ── The company's day ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Day {
  /** When the company's day that holds the moment began. */
  start: number
  /** When the next day begins: the end of today and the start of tomorrow. */
  next: number
  /** When the day after tomorrow begins: the end of tomorrow. */
  after: number
}

/** The company's day around a moment: today, as `[start, next)`, and tomorrow, as `[next, after)`. A day is 23 or 25 hours long where the clocks change. */
export function dayAround(ms: number, zone: string): Day {
  const w = wallAt(ms, zone)
  return { start: momentAt(w.y, w.m, w.d, 0, 0, zone), next: momentAt(w.y, w.m, w.d + 1, 0, 0, zone), after: momentAt(w.y, w.m, w.d + 2, 0, 0, zone) }
}

const DOCUMENTS_ASKED = 40

// ── Building it ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Meetings sorted into the two days they are drawn under. One that has started is not "later". */
export function bucketMeetings(meetings: readonly Meeting[], now: number, zone: string): { laterToday: Meeting[]; tomorrow: Meeting[] } {
  const day = dayAround(now, zone)
  const byTime = (a: Meeting, b: Meeting) => a.startsAt - b.startsAt || a.id.localeCompare(b.id)
  return {
    laterToday: meetings.filter((m) => m.startsAt > now && m.startsAt < day.next).sort(byTime),
    tomorrow: meetings.filter((m) => m.startsAt >= day.next && m.startsAt < day.after).sort(byTime),
  }
}

/**
 * Google's events sorted into the two days they are drawn under, all-day ones first. A timed event that has started is not "later"; an all-day one is drawn under each day it covers (it began at midnight, and it is the day's news
 * all day). An invitation the person declined is left out: it is not on their day.
 */
export function bucketEvents(events: readonly CalendarEvent[], now: number, zone: string): { laterToday: TodayEvent[]; tomorrow: TodayEvent[] } {
  const day = dayAround(now, zone)
  const row = (e: CalendarEvent): TodayEvent => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    startDate: e.startDate,
    endDate: e.endDate,
    location: e.location,
    videoLink: e.videoLink,
    response: e.response,
    status: e.status,
    accounts: e.accounts,
    stale: e.stale,
  })
  const order = (a: TodayEvent, b: TodayEvent) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.id.localeCompare(b.id)
  const kept = events.filter((e) => e.response !== 'declined')
  const timed = (e: CalendarEvent, from: number, to: number) => !e.allDay && e.start >= from && e.start < to
  const covers = (e: CalendarEvent, from: number, to: number) => e.allDay && e.start < to && e.end > from
  return {
    laterToday: kept.filter((e) => timed(e, now + 1, day.next) || covers(e, now, day.next)).map(row).sort(order),
    tomorrow: kept.filter((e) => timed(e, day.next, day.after) || covers(e, day.next, day.after)).map(row).sort(order),
  }
}

const section = <T>(all: T[]): Section<T> => ({ rows: all.slice(0, SECTION_ROWS), total: all.length })

/** The list's row each inbox contact is on, so a Today row opens the conversation the list would. */
function rowsByContact(rows: readonly ListedPerson[]): Map<string, ListedPerson> {
  const by = new Map<string, ListedPerson>()
  for (const row of rows) for (const side of row.mail) by.set(side.contactId, row)
  return by
}

/** The key that opens a contact's conversation: its row's, else the contact's own (the key a contact with no row is opened by). */
const keyFor = (by: Map<string, ListedPerson>, contactId: string): string => by.get(contactId)?.key ?? `mail:${contactId}`

function mailWaiting(inbox: InboxPeople, by: Map<string, ListedPerson>): MailWaiting[] {
  const found = new Map<string, MailWaiting>()
  for (const person of inbox.people) {
    for (const line of person.conversations) {
      // The main list's rule: open, outside Bulk. What is waiting on the person is what came in last, and anything unread.
      if (!line.open || line.bulk) continue
      // A Telegram group is waiting on the person only when a message mentions them or replies to one of theirs, and chatter alone is not Today's business.
      const needsReply = line.needsReply ?? line.direction === 'in'
      if (line.telegramChat === 'group' ? !needsReply : !needsReply && !line.unread) continue
      const name = by.get(person.contactId)?.name ?? person.name
      const held = found.get(line.conversationId)
      const client = by.get(person.contactId)?.client?.name ?? person.client?.name ?? null
      if (held) {
        // A thread several of the contacts are on is one row. It leads with, and opens, the person the lists put it under, whatever order the inbox listed them in.
        if (line.listed) {
          held.key = keyFor(by, person.contactId)
          held.client = client
          held.people = [name, ...held.people.filter((n) => n !== name)]
        } else if (!held.people.includes(name)) held.people.push(name)
        continue
      }
      found.set(line.conversationId, {
        kind: 'mail',
        id: line.conversationId,
        key: keyFor(by, person.contactId),
        people: [name],
        client,
        subject: line.subject,
        snippet: line.snippet,
        at: line.at,
        needsReply,
        unread: line.unread,
        mailbox: line.mailbox?.name ?? null,
      })
    }
  }
  return [...found.values()]
}

function chatWaiting(rows: readonly ListedPerson[]): ChatWaiting[] {
  return rows.flatMap((row) => (row.chat && row.chat.unread > 0 ? [{ kind: 'chat' as const, key: row.key, person: row.name, snippet: row.chat.newest.text, at: row.chat.newest.at, unread: row.chat.unread }] : []))
}

const documentRow = (d: DocumentSummary, at: number): DocumentRow => ({ id: d.id, title: d.title, state: d.state, at, signers: d.signers, signed: d.signed, notSigned: d.notSigned })

/** The documents out for signature: sent, and not finished. Newest first, as forms answers. */
const outRows = (docs: readonly DocumentSummary[]): DocumentRow[] => docs.map((d) => documentRow(d, d.sentAt ?? d.createdAt))

/**
 * The key of the Conversations row a conversation ref names, or null when this list has none: the row is found by the ref's stored id (the inbox's contact, meet's conversation),
 * never by an address, so it is the conversation the document was sent from and not another of the person's. A conversation that is closed or in Bulk is not in the main list, so
 * its document opens in Forms instead.
 */
function keyOfRef(rows: readonly ListedConversation[], ref: ConversationRef): string | null {
  const row = rows.find((r) => (ref.app === 'inbox' ? r.type === 'person' && r.mail.some((m) => m.contactId === ref.id) : String(r.type === 'channel' ? r.conversationId : (r.chat?.conversationId ?? -1)) === ref.id))
  return row?.key ?? null
}

/** The tab a ref's conversation is in: the inbox's contact is an Inbox conversation, meet's direct message or channel is Meet's. */
const tabOfRef = (ref: ConversationRef): ConversationTab => (ref.app === 'inbox' ? 'inbox' : 'meet')

/** Signed and back: completed since the company's day began. Forms' `since` also lets in a document made today, so the finish is checked here. Each opens the conversation it was sent from, when it has one and the list has its row. */
const backRows = (docs: readonly DocumentSummary[], since: number, rows: readonly ListedConversation[]): DocumentRow[] =>
  docs
    .filter((d) => d.state === 'completed' && d.completedAt !== null && d.completedAt >= since)
    .map((d) => {
      const key = d.conversation ? keyOfRef(rows, d.conversation) : null
      return { ...documentRow(d, d.completedAt as number), ...(key !== null && d.conversation && { conversationKey: key, conversationTab: tabOfRef(d.conversation) }) }
    })
    .sort((a, b) => b.at - a.at)

export async function today(ask: Asking): Promise<TodayAnswer> {
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const now = (ask.now ?? Date.now)()
  const zone = ask.install.company.timeZone
  const day = dayAround(now, zone)
  const { inbox, meet, forms } = ask.apps
  // The calendar is a Google account's: an install without the Gmail switch has none, and Today says nothing about events.
  const calendar = ask.install.has('gmail') ? ask.apps.calendar : undefined
  const documents = (states: readonly DocumentSummary['state'][], since?: number) =>
    forms ? reach('Forms', () => forms.documents(ask.signedIn, { states, ...(since !== undefined && { since }), limit: DOCUMENTS_ASKED }), isDocuments, ms) : notConnected('Forms')

  // In parallel: the slowest part is the wait, not the sum. Meetings are asked from now to the end of tomorrow.
  const [people, drafts, chat, calls, meetingsRead, unsent, out, back, eventsRead] = await Promise.all([
    inbox ? reach('Email', () => inbox.people(ask.signedIn), isInboxPeople, ms) : notConnected('Email'),
    inbox ? reach('Email', () => inbox.drafts(ask.signedIn), isInboxDrafts, ms) : notConnected('Email'),
    meet ? reach('Chat', () => meet.conversations(ask.signedIn), isMeetOverview, ms) : notConnected('Chat'),
    meet ? reach('Chat', () => meet.liveCalls(ask.signedIn), isMeetLiveCalls, ms) : notConnected('Chat'),
    meet ? reach('Chat', () => meet.meetings(ask.signedIn, now, day.after), isMeetCalls, ms) : notConnected('Chat'),
    documents(['draft']),
    documents(['sent', 'prepared', 'sealing']),
    documents(['completed'], day.start),
    calendar ? reach('Calendar', () => calendar.agenda(ask.signedIn, now, day.after), isCalendarAgenda, ms) : notConnected('Calendar'),
  ])

  const answers = { waiting: people, drafts, messages: chat, calls, meetings: meetingsRead, unsent, out, back }
  const sources = (Object.keys(SOURCES) as SourceId[]).map((source): SourceStatus => ({ source, part: SOURCES[source].part, ...outcomeOf(SOURCES[source].part, answers[source]) }))

  const merged = mergeConversations({ install: ask.install, self: ask.self, view: MAIN, inbox: people.ok ? people.value : null, meet: chat.ok ? chat.value : null })
  const personRows = merged.rows.filter((r): r is ListedPerson => r.type === 'person')
  const by = rowsByContact(personRows)

  // A meeting opens the conversation it was made in: an email conversation by the row key it was made from, a direct message or channel by the row that holds it.
  const chatKeys = new Map<number, string>()
  for (const row of merged.rows) {
    if (row.type === 'channel') chatKeys.set(row.conversationId, row.key)
    else if (row.type === 'person' && row.chat) chatKeys.set(row.chat.conversationId, row.key)
  }
  const meetings: Meeting[] = meetingsRead.ok
    ? meetingsRead.value.flatMap((c) =>
        c.startsAt === null
          ? []
          : [
              {
                id: c.name,
                title: c.title ?? 'Meeting',
                startsAt: c.startsAt,
                link: c.link,
                with: c.invitees.map((i) => i.name),
                ...((c.home ?? (c.conversationId === null ? undefined : chatKeys.get(c.conversationId))) !== undefined && {
                  conversation: (c.home ?? chatKeys.get(c.conversationId as number)) as string,
                  conversationTab: c.home ? ('inbox' as const) : ('meet' as const),
                }),
              },
            ],
      )
    : []

  // Voicemails and missed calls: the Phone conversation's unread, from the overview meet already answered (it has one only for a person on the phone list).
  const phone = chat.ok ? chat.value.phone : null
  const phoneWaiting: Waiting[] = phone && phone.unread > 0 && phone.newest ? [{ kind: 'phone', key: 'phone', snippet: phone.newest.text, at: phone.newest.at, unread: phone.unread }] : []
  const waiting: Waiting[] = [...(people.ok ? mailWaiting(people.value, by) : []), ...(chat.ok ? chatWaiting(personRows) : []), ...phoneWaiting].sort((a, b) => b.at - a.at)
  const emailDrafts: Draft[] = drafts.ok
    ? drafts.value.map((d): Draft => ({ kind: 'email', id: d.id, key: keyFor(by, d.contactId), to: d.toName, subject: d.subject, reply: d.conversationId !== null, author: d.author, stuck: d.stuck, at: d.at }))
    : []
  const documentDrafts: Draft[] = unsent.ok ? unsent.value.documents.map((d): Draft => ({ kind: 'document', ...documentRow(d, d.createdAt) })) : []

  return {
    now,
    zone,
    sources,
    happeningNow: calls.ok ? calls.value.map((c) => ({ name: c.name, startedAt: c.startedAt, present: c.present, why: c.why === 'started' || c.why === 'invited' || c.why === 'conversation' ? c.why : 'other' })) : [],
    ...bucketMeetings(meetings, now, zone),
    events: { connected: calendar !== undefined, listed: eventsRead.ok, ...(eventsRead.ok ? bucketEvents(eventsRead.value.events, now, zone) : { laterToday: [], tomorrow: [] }) },
    meetingsListed: meetingsRead.ok,
    waitingOnYou: section(waiting),
    waitingOnYouLeft: { inbox: waiting.slice(SECTION_ROWS).filter((w) => w.kind === 'mail').length, meet: waiting.slice(SECTION_ROWS).filter((w) => w.kind !== 'mail').length },
    drafts: section([...emailDrafts, ...documentDrafts].sort((a, b) => b.at - a.at)),
    waitingOnOthers: section(out.ok ? outRows(out.value.documents) : []),
    signedAndBack: section(back.ok ? backRows(back.value.documents, day.start, merged.rows.filter(isConversationRow)) : []),
    more: (people.ok && people.value.more) || (unsent.ok && unsent.value.more) || (out.ok && out.value.more) || (back.ok && back.value.more),
  }
}
