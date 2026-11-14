// What the Inbox's and Meet's lists say, as plain functions of the answer: times, labels, the unread breakdown and the notices. No React here, so the wording is checked on its own (test/client.test.tsx draws it too).
import type { PartStatus, Refused, SpacePart } from '@space/workspace'
import type { ListedPerson, ListedRow, LastBy, MailboxFilter } from '../conversations'
import { draftIdAt } from './route'

// ── Filters ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH LIST, AND WHO IN IT. The view is the inbox's own left menu (the tree under Inbox, and its sheet on a phone): Inbox (the main list), Unread, Sent, Drafts, Bulk, Closed, one
 * business mailbox, or one Client. Bulk, Closed and Sent are lists of their own; a business mailbox, Unread and a Client narrow the main list, in the inbox and before it is cut to a screen (`requestFor`);
 * Drafts is a list of its own too. The page then keeps the rows the view is about (`filterRows`). It is in the address (`/inbox?view=bulk`), so the tree and the list agree and a link keeps it.
 * `Who` is the other cut, kept as three small chips because the menu has no equivalent: everyone, outside people, or the team.
 */
export type ListView = 'all' | 'unread' | 'sent' | 'drafts' | 'bulk' | 'closed' | `mailbox:${string}` | `client:${number}`
export type Who = 'all' | 'outside' | 'team'
export type Filter = ListView | Who

/** The view an address names (`?view=`), or the main list when it names none or something that is not one. */
export function viewOf(search: string): ListView {
  const raw = new URLSearchParams(search).get('view') ?? ''
  if (raw === 'unread' || raw === 'sent' || raw === 'drafts' || raw === 'bulk' || raw === 'closed') return raw
  if (/^mailbox:[A-Za-z0-9@._+-]{1,120}$/.test(raw)) return raw as ListView
  if (/^client:[1-9][0-9]{0,9}$/.test(raw)) return raw as ListView
  return 'all'
}

/**
 * The view the address names, as the tree and the list beside a page both read it: `?view=`, and for a draft's own address (`/inbox/draft/<id>`) that names none, Drafts, which is where that
 * draft is listed (an outside tool's links and the drafting skill's carry no view).
 */
export function viewAt(pathname: string, search: string): ListView {
  return draftIdAt(pathname) !== null && !new URLSearchParams(search).has('view') ? 'drafts' : viewOf(search)
}

/**
 * What to ask the Worker for. Every view of the Inbox is asked for by name, and the inbox narrows it before it cuts the list to a screen, so each holds what its count counts: Bulk, Closed and Sent are lists of the inbox's alone (Sent is every conversation the owner sent in, any state, newest send first); Drafts is every conversation with a
 * draft, open, closed or Bulk; a Client its open conversations, Bulk included (the page then keeps the Client's people); a mailbox and Unread narrow open mail that is not Bulk, which is what the Inbox is. The Inbox asks the inbox alone (`scope=mail`), so no chat is in any of them.
 */
export function requestFor(view: Filter): string {
  if (view === 'bulk' || view === 'closed' || view === 'sent' || view === 'unread' || view === 'drafts') return `/api/conversations?scope=mail&view=${view}`
  if (view.startsWith('client:')) return `/api/conversations?scope=mail&view=client&client=${view.slice('client:'.length)}`
  if (view.startsWith('mailbox:')) return `/api/conversations?scope=mail&view=mailbox&mailbox=${encodeURIComponent(view.slice('mailbox:'.length))}`
  return '/api/conversations?scope=mail'
}

/** The list's request read further down: down to the position the page has loaded (`through`, an earlier answer's `floor`), and with `older` one more screen below it. */
export const readingFor = (request: string, reading: { through: string; older: boolean } | null): string =>
  reading === null ? request : `${request}&through=${encodeURIComponent(reading.through)}${reading.older ? '&older=1' : ''}`

// ── Meet's views ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Meet's own menu (Chat / Channels / Calls and Phone, a Meet top level nav): everything newest first, the direct messages, the channels, the past calls. The Phone is
 * a conversation of its own (`/meet/phone`), not a view of the list. It is in the address (`/meet?view=channels`), as the Inbox's views are.
 */
export type MeetView = 'all' | 'chat' | 'channels' | 'calls'

/** The view an address names (`?view=`), or everything when it names none or something that is not one. */
export function meetViewOf(search: string): MeetView {
  const raw = new URLSearchParams(search).get('view') ?? ''
  return raw === 'chat' || raw === 'channels' || raw === 'calls' ? raw : 'all'
}

/** What Meet's list asks the Worker for: meet alone, the main view. Every Meet view is cut from this one answer (the Calls view reads its own list). */
export const MEET_REQUEST = '/api/conversations?scope=chat'

/** The rows a Meet view keeps: Chat is the direct messages, Channels the channels, everything the lot (the calls with no conversation and the Phone with them). */
export function narrowMeet(rows: readonly ListedRow[], view: MeetView): ListedRow[] {
  if (view === 'chat') return rows.filter((r) => r.type === 'person')
  if (view === 'channels') return rows.filter((r) => r.type === 'channel')
  return [...rows]
}

/**
 * Rows a view or a who keeps. Outside is people outside the team; Team is everything else, channels included ("not outside"). Unread is the rows with anything
 * unread; Drafts the people with a draft waiting (a draft on no conversation is in no row: the Drafts view lists it above the rows, `looseDrafts`); a Client the people linked to it.
 */
export function filterRows(rows: readonly ListedRow[], filter: Filter): ListedRow[] {
  if (filter === 'outside') return rows.filter((r) => r.type === 'person' && r.side === 'outside')
  if (filter === 'team') return rows.filter((r) => !(r.type === 'person' && r.side === 'outside'))
  if (filter === 'unread') return rows.filter((r) => r.unread > 0)
  if (filter === 'drafts') return rows.filter((r) => r.type === 'person' && r.drafts > 0)
  if (filter.startsWith('client:')) return rows.filter((r) => r.type === 'person' && r.clients.some((c) => c.id === Number(filter.slice('client:'.length))))
  return [...rows]
}

/** The rows the list draws: the view's, then the who's. */
export const narrow = (rows: readonly ListedRow[], view: ListView, who: Who): ListedRow[] => filterRows(filterRows(rows, view), who)

export const mailboxFilter = (m: Pick<MailboxFilter, 'id'>): ListView => `mailbox:${m.id}`

// ── Times ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000

/** "now", "5m", "3h", "Yesterday", "Tue", or "Oct 3": short, because it sits beside a name. `now` is passed in so a test can pin it. */
export function ago(now: number, at: number): string {
  const d = Math.max(0, now - at)
  if (d < 45_000) return 'now'
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m`
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h`
  if (d < 2 * DAY) return 'Yesterday'
  if (d < 7 * DAY) return new Date(at).toLocaleDateString('en-US', { weekday: 'short' })
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** "just now", "18 minutes ago", "3 hours ago", "yesterday", "2 days ago", else the date: a time in words, for a line that already says what happened (Today's). */
export function agoWords(now: number, at: number): string {
  const d = Math.max(0, now - at)
  if (d < 45_000) return 'just now'
  if (d < 3_600_000) return `${plural(Math.max(1, Math.round(d / 60_000)), 'minute', 'minutes')} ago`
  if (d < DAY) return `${plural(Math.floor(d / 3_600_000), 'hour', 'hours')} ago`
  if (d < 2 * DAY) return 'yesterday'
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Unread, in two units ──────────────────────────────────────────────────────────────────────────────────────────────────

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The words behind a row's unread badge. The badge is ONE number made of two units: the inbox counts conversations (it keeps no count
 * of messages), meet counts messages. So the badge says what it is made of, in its tooltip and for a screen reader, and the list
 * says it once at its foot (`UNREAD_NOTE`).
 */
export function unreadBreakdown(row: ListedRow): string {
  if (row.type === 'channel') return plural(row.unread, 'unread chat message', 'unread chat messages')
  if (row.type === 'phone') return plural(row.unread, 'new voicemail or missed call', 'new voicemails and missed calls')
  if (row.type === 'call') return ''
  const parts: string[] = []
  // What is left of the badge when chat's messages are taken off: each unread conversation once, even where two of one person's contacts are on it.
  const mail = row.unread - (row.chat?.unread ?? 0)
  // A Telegram group's row is not an email conversation: the group has something unread in it.
  if (mail > 0) parts.push(row.telegramChat === 'group' ? 'unread messages in the group' : plural(mail, 'unread email conversation', 'unread email conversations'))
  if (row.chat && row.chat.unread > 0) parts.push(plural(row.chat.unread, 'unread chat message', 'unread chat messages'))
  return parts.join(' and ')
}

export const UNREAD_NOTE = 'The number on a row counts each unread email conversation once.'

/** The same note under Meet's list, which counts messages. */
export const MEET_UNREAD_NOTE = 'The number on a row counts the unread chat messages in it.'

// ── How a row came, who wrote last, who it is ─────────────────────────────────────────────────────────────────────────────

/** The glyph for how a row came: an email is a letter, a text a phone, a note a pen, a chat a bubble and a channel the hash. */
export function cameGlyph(row: ListedRow): 'mail' | 'phone' | 'note' | 'chat' | 'hash' | 'video' {
  if (row.type === 'channel') return 'hash'
  if (row.type === 'call') return 'video'
  if (row.type === 'phone') return 'phone'
  switch (row.came) {
    case 'sms':
      return 'phone'
    case 'manual':
      return 'note'
    case 'chat':
    case 'telegram':
      return 'chat'
    case 'email':
      return 'mail'
  }
}

export const CAME_LABEL: Record<ListedRow['came'], string> = { email: 'Email', sms: 'Text', manual: 'Note', telegram: 'Telegram', chat: 'Chat', call: 'Call' }

/** The line under a name: the business, else whether they are on the team, else the address. */
export function whoLine(row: ListedRow): string {
  if (row.type === 'call') return 'A call with no conversation'
  if (row.type === 'phone') return 'Voicemails and missed calls, with Call back'
  if (row.type === 'channel') return `${row.privacy === 'private' ? 'Private channel' : 'Channel'}, ${plural(row.memberCount, 'person', 'people')}`
  // A Client's name is a pill under the row (the inbox's own rows have it there), so this line is who they are: their address.
  if (row.side === 'team') return 'Teammate'
  if (row.telegramChat !== null) return row.telegramChat === 'group' ? 'Telegram group' : 'Telegram channel'
  return row.addresses[0] ?? 'Outside'
}

/** "You: " where the signed-in person wrote last, "Name: " in a channel, and nothing for the other person in a direct message or an email. */
export function lastByPrefix(by: LastBy): string {
  if (by === 'you') return 'You: '
  if (by === 'them' || by === 'nobody') return ''
  return `${by.name}: `
}

/** The subject of the email that is the row's newest item, or null when the newest item is not an email. */
export function newestSubject(row: ListedPerson): string | null {
  if (row.came !== 'email') return null
  return row.mail.find((m) => m.newest.at === row.at && m.newest.kind === 'email')?.newest.subject || null
}

/** The initials in a row's circle: the first and last word that starts with a letter, or "" for a name with none (a phone number). */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w))
  const first = words[0]?.[0]
  if (!first) return ''
  return (first + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase()
}

/**
 * What a row's circle holds. A channel is the "#" and nothing else is: a person is their initials, a phone glyph when they are only a
 * number (a text), the first letter of their address when they have a name that is no letters, and "?" as the last resort.
 */
export type Mark = { kind: 'channel' } | { kind: 'phone' } | { kind: 'call' } | { kind: 'text'; text: string }

export function markFor(row: ListedRow): Mark {
  if (row.type === 'channel') return { kind: 'channel' }
  if (row.type === 'call') return { kind: 'call' }
  if (row.type === 'phone') return { kind: 'phone' }
  const letters = initials(row.name)
  if (letters) return { kind: 'text', text: letters }
  if (/\d/.test(row.name)) return { kind: 'phone' }
  const fromAddress = row.addresses[0]?.[0]
  return { kind: 'text', text: (fromAddress ?? '?').toUpperCase() }
}

// ── Notices: what could not be reached, and what said no ──────────────────────────────────────────────────────────────────

/** What a person calls each part of the space, the one list the Inbox, Meet and Today all say it from. */
export const PART_NAME: Record<SpacePart, string> = { mail: 'Email', chat: 'Chat', documents: 'Forms' }
const OTHER = { mail: 'chat', chat: 'email' } as const

export interface Notice {
  /** `unreachable`: it did not answer (a fault, shown as a warning). `refused`: it answered no (a decision, shown quietly). */
  kind: 'unreachable' | 'refused'
  part: SpacePart
  text: string
}

/** Why a part did not answer, in the words of a person. */
export function troubleWords(part: SpacePart, reason: string): string {
  const name = PART_NAME[part]
  switch (reason) {
    case 'timed-out':
      return `${name} took too long to answer`
    case 'not-understood':
      return `${name} answered in a way the space could not read`
    case 'broken':
      return `${name} had a problem and could not answer`
    default:
      return `${name} could not be reached`
  }
}

/** Why a part said no, in the words of a person: a decision, not a fault. `what` is what it would not show ("its conversations"). */
export function refusalWords(part: SpacePart, refusal: Refused, what: string): string {
  const name = PART_NAME[part]
  if (refusal.reason === 'not-signed-in') return `${name} could not check your sign-in`
  if (refusal.reason === 'not-admitted') return `${name} is not open to you`
  return `${name} would not show ${what}: ${refusal.message}`
}

/**
 * One line for each part that is not ok, saying what the list is missing. The other part's rows are on screen; the line says whose they
 * are. A refusal reads differently from a part that could not be reached: nothing is down, the app does not open its part to you.
 */
export function noticesFor(parts: readonly PartStatus[]): Notice[] {
  const notices: Notice[] = []
  for (const p of parts) {
    if (p.state === 'ok') continue
    if (p.state === 'could-not-be-reached') {
      const other = parts.find((q) => q.part !== p.part)
      const rest = other && other.state === 'ok' ? ` Showing ${OTHER[p.part]} only.` : ''
      notices.push({ kind: 'unreachable', part: p.part, text: `${troubleWords(p.part, p.reason)} just now, so it is missing from this list.${rest} It will be tried again.` })
    } else {
      const why = `${refusalWords(p.part, p.refusal, 'its conversations')}.`
      notices.push({ kind: 'refused', part: p.part, text: why })
    }
  }
  return notices
}
