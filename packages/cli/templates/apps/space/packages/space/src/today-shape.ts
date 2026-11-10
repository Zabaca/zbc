// What Today's answer is made of: the shapes the Worker (today.ts) builds and the page (client/Today.tsx) draws, so the two cannot drift. Types and
// one list, nothing that runs, as me.ts is for /api/me.
import type { CalendarAccountMark, CalendarResponse, DocumentSummary, InboxDraft, SpacePart } from '@space/workspace'
import type { Outcome } from './list'

// ── What Today is made of ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The tab a conversation key opens in: the Inbox for a person's email, Meet for a channel, a direct message, a call or the Phone (the Conversations tab was split in two). */
export type ConversationTab = 'inbox' | 'meet'

/** A call with someone in it: its name (what its link is made from on meet's own address), when it was made, how many are in it, and why it is shown to this person. */
export interface LiveCallRow {
  name: string
  startedAt: number
  present: number
  /** They made it (`started`), are invited to its meeting (`invited`), or it is a huddle in a conversation of theirs (`conversation`); anything else meet may say is `other`. */
  why: 'started' | 'invited' | 'conversation' | 'other'
}

/** A meeting with a time, booked from a conversation: what Later today and Tomorrow are drawn from. */
export interface Meeting {
  id: string
  title: string
  /** When it starts, milliseconds. */
  startsAt: number
  /** The conversation key it belongs to, when it was made in one. */
  conversation?: string
  /** The tab that conversation is in: the Inbox for one made from an email conversation, Meet for a direct message or channel. Absent with `conversation`: the Inbox. */
  conversationTab?: ConversationTab
  /** The call's link, made by meet on its public address: what Copy link copies and Join opens. Absent in a test's literal. */
  link?: string
  /** Who is invited, by name. */
  with?: string[]
}

/**
 * An event from the calendar app (Google's calendars, kept in the calendar's own store), as Later today and Tomorrow draw it beside Meet's meetings. Only what a row shows: the card (its guests and its words) is the
 * Calendar tab's, opened by `id`.
 */
export interface TodayEvent {
  /** The event's key in the calendar's store: what `/calendar/event/<id>` opens. */
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  /** For an all-day event, its last day (inclusive). */
  endDate: string | null
  location: string | null
  videoLink: string | null
  /** How the account answered the invitation; `needsAction` is "not answered". Null for an event with no invitation. */
  response: CalendarResponse | null
  status: 'confirmed' | 'tentative'
  /** The accounts that hold it, the first being the one drawn. */
  accounts: CalendarAccountMark[]
  /** The last picture of an account Google has stopped answering for. */
  stale: boolean
}

/** A mail conversation waiting on the person: the newest message came in, or it is unread. */
export interface MailWaiting {
  kind: 'mail'
  /** The inbox's conversation id: what makes the row, so a thread that several contacts are on is one row. */
  id: string
  /** The conversation it opens (a row key of the Inbox's list; the Phone's and a direct message's are Meet's). */
  key: string
  /** The people on it, by name, the first being whose conversation opens. */
  people: string[]
  /** The business the first person is under, when the inbox has them under one. */
  client: string | null
  subject: string
  snippet: string
  at: number
  /** The newest message came in: it is waiting on a reply. */
  needsReply: boolean
  unread: boolean
  /** The business mailbox it came to (a shared mailbox's), or null for the owner's own. */
  mailbox: string | null
}

/** Unread direct messages from one person. */
export interface ChatWaiting {
  kind: 'chat'
  key: string
  person: string
  /** The newest message, on one line. */
  snippet: string
  at: number
  /** How many messages meet counts unread. */
  unread: number
}

/** Voicemails and missed calls waiting in the Phone conversation (meet gives it to the people on the phone list). One row for all of them. */
export interface PhoneWaiting {
  kind: 'phone'
  /** The Phone's row key, `phone`. */
  key: string
  /** The newest, on one line. */
  snippet: string
  at: number
  /** How many items meet counts unread. */
  unread: number
}

export type Waiting = MailWaiting | ChatWaiting | PhoneWaiting

/** An email draft waiting to be sent: Claude's, the assistant's, the person's own, or a send Gmail never confirmed. */
export interface EmailDraft {
  kind: 'email'
  id: string
  /** The conversation that holds the person it is to (a row key). */
  key: string
  /** Who it is to. */
  to: string
  subject: string
  /** On a conversation, so a reply; otherwise a new email. */
  reply: boolean
  author: InboxDraft['author']
  /** A send Gmail never confirmed. */
  stuck: boolean
  at: number
}

/** A document, by title and state. Nothing it holds. */
export interface DocumentRow {
  id: string
  title: string
  state: DocumentSummary['state']
  /** When it was sent, or finished for a signed one, or made for a draft. */
  at: number
  signers: number
  signed: number
  /** The names of the signers who have not signed. */
  notSigned: string[]
  /**
   * Signed and back only: the conversation the document was sent from, as the key of its Conversations row, so the row opens it there. Absent for a document sent from Forms,
   * from a forms that predates conversations, and when the row cannot be found (the conversation is closed or in Bulk, or its contact was merged away): the row then opens it in Forms.
   */
  conversationKey?: string
  /** The tab that row is in: the Inbox for a document sent from an email conversation, Meet for one sent from a direct message or channel. Absent with `conversationKey`: the Inbox. */
  conversationTab?: ConversationTab
}

/** A document not yet sent: forms' draft envelope. */
export interface DocumentDraft extends DocumentRow {
  kind: 'document'
}

export type Draft = EmailDraft | DocumentDraft

/** The rows a section shows, and how many there are in all (a section shows its newest few). */
export interface Section<T> {
  rows: T[]
  total: number
}

/** What Today asked for, each by what the person is told is missing without it. */
export const SOURCES = {
  waiting: { part: 'mail' },
  drafts: { part: 'mail' },
  messages: { part: 'chat' },
  calls: { part: 'chat' },
  meetings: { part: 'chat' },
  unsent: { part: 'documents' },
  out: { part: 'documents' },
  back: { part: 'documents' },
} as const satisfies Record<string, { part: SpacePart }>

export type SourceId = keyof typeof SOURCES

export type SourceStatus = { source: SourceId; part: SpacePart } & Outcome

export interface TodayAnswer {
  /** The moment it was made. */
  now: number
  /** The company's time zone: the day Today is about, and the clock its times are read in. */
  zone: string
  sources: SourceStatus[]
  happeningNow: LiveCallRow[]
  laterToday: Meeting[]
  tomorrow: Meeting[]
  /** Google's events for the same two days, from the calendar app. */
  events: {
    /** The calendar app is part of this space at all. False in an install without it: the page says nothing about events. */
    connected: boolean
    /** False where it did not answer or said no: the page then says Google's events are not listed, rather than that there are none. */
    listed: boolean
    laterToday: TodayEvent[]
    tomorrow: TodayEvent[]
  }
  /** Whether meet listed its meetings. False where it did not answer or said no: the page then says meetings are not listed, rather than that there are none. */
  meetingsListed: boolean
  waitingOnYou: Section<Waiting>
  /** What Waiting on you does not show, counted by the tab it is in: email is the Inbox's, direct messages and the Phone are Meet's. They add up to `waitingOnYou.total` less the rows shown. */
  waitingOnYouLeft: { inbox: number; meet: number }
  drafts: Section<Draft>
  waitingOnOthers: Section<DocumentRow>
  signedAndBack: Section<DocumentRow>
  /** An app had more than one screen of what it was asked for, so what is shown is the newest. */
  more: boolean
}

/** How many rows a section shows. A list that grows past this is the Conversations list's or Forms' job, and Today links there. */
export const SECTION_ROWS = 12
