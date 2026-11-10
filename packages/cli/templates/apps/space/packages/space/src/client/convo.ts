// What a conversation says, as plain functions of the Worker's answer: the headings over the emails, who a reply goes to and in what way, the
// words for a draft and a part that did not answer. No React here, so the rules (a teammate gets a direct message, an outside person an email,
// a shared thread goes to all) are checked on their own; test/conversation-view.test.tsx draws the same functions on screen.
import type { MeetCall, PartStatus } from '@space/workspace'
import type { ShownDocument } from '../documents'
import type { ConversationAnswer, DraftAuthor, DraftView, Profile, ThreadView } from '../conversation'
import type { ReplyTarget, Way } from './compose'
import { type Entry, groupOf } from '../history'
import type { Me } from '../me'

// ── Names and times ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Dana Reyes <dana@x.example>" is "Dana Reyes"; a bare address stays as it is. */
export function senderName(from: string): string {
  const named = from.replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '').trim()
  return named === '' ? from.trim() : named
}

/** "Dana Reyes <dana@x.example>" is "dana@x.example", and a bare address is itself; a sender with no address in the header gives none. */
export function senderAddress(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from.trim()) ?? /^([^<>\s"]+@[^<>\s"]+)$/.exec(from.trim())
  return m ? (m[1] as string) : null
}

const DAY = 86_400_000

/** "3:42 PM" today, "Oct 3, 3:42 PM" before, with the year when it is not this one. `timeZone` is for a test; a person's own is the default. */
export function stamp(now: number, at: number, timeZone?: string): string {
  const zone = timeZone ? { timeZone } : {}
  const when = new Date(at)
  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...zone })
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA', zone)
  if (day(at) === day(now)) return time
  const year = new Date(at).toLocaleDateString('en-US', { year: 'numeric', ...zone }) !== new Date(now).toLocaleDateString('en-US', { year: 'numeric', ...zone })
  const date = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year && { year: 'numeric' as const }), ...zone })
  return `${date}, ${time}`
}

/** "A", "A and B", "A, B and C". */
export function joined(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ── The headings over the emails ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a block holds: a message, a draft waiting on the thread it belongs to (at the time it was made), a call's card, or a document sent from the conversation (at the time it
 * last moved). A huddle's card stands where the message that announced it was, in the direct message or channel; a call link's or a meeting's card at the time it was made.
 */
export type Item = { kind: 'entry'; entry: Entry } | { kind: 'draft'; draft: DraftView } | { kind: 'call'; call: MeetCall; at: number } | { kind: 'document'; doc: ShownDocument }

/** A run of items from one place, with the heading that labels it: an email by its subject, and "with" the others on a shared thread. */
export interface Block {
  id: string
  /** Null for a channel, which is one place and needs no label. */
  heading: string | null
  kind: 'email' | 'chat' | 'document'
  items: Item[]
}

/** The heading over a Telegram chat's messages: one place, named for what it is. A group and a channel say so. */
export const TELEGRAM_HEADING = 'Telegram'
export const TELEGRAM_GROUP_HEADING = 'Telegram group'
export const TELEGRAM_CHANNEL_HEADING = 'Telegram channel'

function threadHeading(answer: ConversationAnswer, conversationId: string, fallbackSubject: string): string {
  const thread = answer.threads.find((t) => t.conversationId === conversationId)
  if (thread?.kind === 'sms') return 'Text messages'
  if (thread?.kind === 'manual') return 'Note'
  if (thread?.kind === 'telegram') return thread.telegramChat === 'group' ? TELEGRAM_GROUP_HEADING : thread.telegramChat === 'channel' ? TELEGRAM_CHANNEL_HEADING : TELEGRAM_HEADING
  const subject = (thread?.subject ?? fallbackSubject).trim() || '(no subject)'
  const others = thread ? thread.alsoOn.map((p) => p.name) : []
  return `Email: ${subject}${others.length > 0 ? `, with ${joined(others)}` : ''}`
}

function headingOf(answer: ConversationAnswer, item: Item): string | null {
  if (item.kind === 'document') return null
  if (item.kind === 'call') return item.call.kind === 'huddle' && answer.row.type !== 'channel' ? 'Direct message' : null
  if (item.kind === 'draft') return item.draft.conversationId === null ? `Draft to ${item.draft.toName}` : threadHeading(answer, item.draft.conversationId, item.draft.subject)
  const { entry } = item
  if (entry.kind === 'chat') return answer.row.type === 'channel' ? null : 'Direct message'
  return threadHeading(answer, entry.message.conversationId, entry.message.subject)
}

const groupOfItem = (item: Item): string =>
  item.kind === 'entry'
    ? groupOf(item.entry)
    : item.kind === 'call'
      ? item.call.kind === 'huddle' && item.call.conversationId !== null
        ? `chat:${item.call.conversationId}`
        : `call:${item.call.name}`
      : item.kind === 'document'
        ? `document:${item.doc.id}`
        : item.draft.conversationId === null
          ? `draft:${item.draft.id}`
          : `email:${item.draft.conversationId}`
const atOf = (item: Item): number => (item.kind === 'entry' ? item.entry.at : item.kind === 'call' ? item.at : item.kind === 'document' ? item.doc.at : item.draft.at)
/** The one tie order, for items at the same moment: a message, then a call's card, then a draft, then a document's card. */
const rank = (item: Item): number => (item.kind === 'entry' ? 0 : item.kind === 'call' ? 1 : item.kind === 'draft' ? 2 : 3)

/**
 * The entries and the drafts waiting as runs under their headings, in the order they happened. A draft is in its own thread at the time it was made
 * (Claude's reply to a thread comes after the message it answers), not after the whole history; a heading is repeated where the conversation goes
 * back to a place it left. A draft is never held back by the cutoff: a draft waiting on the person is always on screen.
 *
 * A document sent from the conversation is a card of its own at the time it last moved: when it went out, and again, further down, when the signed
 * copy came back. It follows the history's cutoff as a message does, so a card never sits above "Earlier messages" with the messages it came after still
 * unread behind that button. Forms that did not answer leaves the history as it is (`answer.documents` says so).
 */
export function blocksOf(answer: ConversationAnswer, entries: readonly Entry[], cutoff: number | null = null): Block[] {
  // A huddle's message is drawn as its card where the answer carries the card; with no card (an older huddle, or one the person may not see) it is the message as it was.
  const cards = new Map((answer.calls ?? []).map((c) => [c.name, c]))
  const announced = new Set<string>()
  const items: Item[] = []
  for (const entry of entries) {
    const card = entry.kind === 'chat' && entry.message.huddle !== undefined ? cards.get(entry.message.huddle) : undefined
    if (card) {
      announced.add(card.name)
      items.push({ kind: 'call', call: card, at: entry.at })
    } else items.push({ kind: 'entry', entry })
  }
  // The call links and meetings made from this conversation, and meetings booked in a direct message or channel, have no message: they stand at the time they were made.
  for (const call of answer.calls ?? []) if (!announced.has(call.name) && call.kind !== 'huddle') items.push({ kind: 'call', call, at: call.madeAt })
  items.push(...answer.drafts.map((draft): Item => ({ kind: 'draft', draft })))
  // A document sent from the conversation follows the history's cutoff as a message does (see above).
  if (answer.documents.state === 'ok') items.push(...answer.documents.documents.filter((doc) => cutoff === null || doc.at >= cutoff).map((doc): Item => ({ kind: 'document', doc })))
  // Stable: at the same moment a message comes before a call's card, a card before a draft, and a draft before a document's card.
  items.sort((a, b) => atOf(a) - atOf(b) || rank(a) - rank(b))
  const out: Block[] = []
  for (const item of items) {
    const id = groupOfItem(item)
    const last = out[out.length - 1]
    if (last && last.id === id) {
      last.items.push(item)
      continue
    }
    out.push({ id, heading: headingOf(answer, item), kind: item.kind === 'document' ? 'document' : item.kind === 'draft' || (item.kind === 'entry' && item.entry.kind === 'email') ? 'email' : 'chat', items: [item] })
  }
  return out
}

/**
 * The key of the chat entry the "New" line goes before: the first one DRAWN (a huddle's announcement drawn as its card is not an entry here) that is at or after the message where unread
 * began (`newFrom`, the answer's) and is from someone else. Null when there is none to put it before.
 */
export function newLineKey(blocks: readonly Block[], newFrom: number): string | null {
  for (const block of blocks) {
    for (const item of block.items) {
      if (item.kind === 'entry' && item.entry.kind === 'chat' && item.entry.message.id >= newFrom && !item.entry.message.mine) return item.entry.key
    }
  }
  return null
}

/** The line over the timeline when forms did not give the documents sent from this conversation: the history is shown as it is. */
export function documentsNotice(part: Exclude<ConversationAnswer['documents'], { state: 'ok' }>): string {
  return part.state === 'not-open-to-you' ? 'Documents are not open to you, so the ones sent from here are not shown.' : part.message
}

// ── The reply ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Ways {
  /** The email threads a reply can go in: open ones first, the newest first within each; none that cannot be answered (a text, a note) or is Bulk. */
  email: ThreadView[]
  /**
   * The direct message or channel a post can go to, or null where there is none. `personId` is for someone meet lists who has no message with the
   * person asking yet: meet opens the direct message as it posts.
   */
  chat: ({ conversationId: number } | { personId: string }) & { to: string } | null
  /**
   * The way the reply opens in. A channel: a post. A teammate: a direct message, and an email only where they have no direct message (they email, we
   * answer by email). An outside person: an email, and a direct message only where there is no thread to reply in (a channel guest who only chats).
   */
  preferred: Way | null
  /** Why there is nothing to write to, when `preferred` is null. */
  none: string | null
}

/** Newest first; a thread with no message in the history (older than the page) comes after those that have one, in the order the inbox gave. */
const byNewest = (a: ThreadView, b: ThreadView): number => (b.at ?? -1) - (a.at ?? -1)

export function replyWays(answer: ConversationAnswer): Ways {
  const { row } = answer
  const chatId = row.type === 'channel' ? row.conversationId : (row.chat?.conversationId ?? null)
  const chat: Ways['chat'] = chatId !== null ? { conversationId: chatId, to: row.name } : answer.chatPerson ? { personId: answer.chatPerson.personId, to: answer.chatPerson.name } : null
  // Open before closed, and the newest first within each: the default thread is the one most recently written in.
  const email = row.type === 'person' ? answer.threads.filter((t) => t.canReply && !t.bulk).sort((a, b) => Number(b.open) - Number(a.open) || byNewest(a, b)) : []
  let preferred: Ways['preferred']
  if (row.type === 'channel') preferred = chat ? 'chat' : null
  else if (row.side === 'team') preferred = chat ? 'chat' : email.length > 0 ? 'email' : null
  else preferred = email.length > 0 ? 'email' : chat ? 'chat' : null
  const telegram = answer.threads.some((t) => t.kind === 'telegram')
  const channelOnly = telegram && answer.threads.every((t) => t.kind !== 'telegram' || t.telegramChat === 'channel')
  const none =
    preferred !== null
      ? null
      : channelOnly
        ? 'A Telegram channel is one you follow: there is nothing to reply to.'
        : telegram
          ? 'This Telegram chat is a bot’s, filed in Bulk, which the space does not answer. Claude can draft a reply: it waits on this page for you to send in Telegram yourself and mark sent.'
        : answer.threads.length > 0
          ? 'Texts, notes and newsletters cannot be answered from the space. Claude can draft a text: it waits on this page for you to send yourself and mark sent.'
          : 'There is nothing here to reply to yet.'
  return { email, chat, preferred, none }
}

/** The way a reply goes when the person asked for `way`: the other one where there is nothing to send that way. The one place this fallback is written. */
export function chosenWay(ways: Ways, way: Way): Way {
  if (way === 'email' && ways.email.length === 0) return 'chat'
  if (way === 'chat' && ways.chat === null) return 'email'
  return way
}

/**
 * Where a reply goes, from the way the person is writing it and the thread they chose (the newest that can be answered when they chose none).
 * An email in a thread with other people on it goes to all of them (`copyEveryone`). Null where there is nothing to send to.
 */
export function replyTarget(answer: ConversationAnswer, way: Way, threadId: string | null): { target: ReplyTarget; way: Way } | null {
  const ways = replyWays(answer)
  if (chosenWay(ways, way) === 'chat') {
    const chat = ways.chat
    if (!chat) return null
    return { target: 'personId' in chat ? { via: 'chat', personId: chat.personId } : { via: 'chat', conversationId: chat.conversationId }, way: 'chat' }
  }
  const thread = ways.email.find((t) => t.conversationId === threadId) ?? ways.email[0]
  // A Telegram message copies no one: a group's one participant is the group itself, and a chat has the person alone.
  return thread ? { target: { via: 'email', conversationId: thread.conversationId, through: thread.through, copyEveryone: thread.kind !== 'telegram' && thread.alsoOn.length > 0 }, way: 'email' } : null
}

/**
 * Who an email reply goes to: the person, and everyone else on the thread when it is shared. The reply is sent to all, so the
 * line over the box says so with their names.
 */
export function replyLine(person: string, thread: ThreadView): { all: boolean; text: string } {
  if (thread.kind === 'telegram') return { all: false, text: thread.telegramChat === 'group' ? `Telegram message to the group ${person}` : `Telegram message to ${person}` }
  const others = thread.alsoOn.map((p) => p.name)
  if (others.length === 0) return { all: false, text: `Email to ${person}` }
  return { all: true, text: `Reply all to ${joined([person, ...others])}` }
}

// ── Drafts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DRAFT_BY: Record<DraftAuthor, string> = { claude: 'Draft from Claude', assistant: 'Draft from the assistant', owner: 'Your draft', outbox: 'Not confirmed as sent' }

// ── What could not be reached ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PartNotice {
  kind: 'unreachable' | 'refused'
  part: 'mail' | 'chat'
  text: string
}

const NAME = { mail: 'Email', chat: 'Chat' } as const

/** One line for each source of this conversation that did not answer, saying what is missing from it. Nothing for one that did. */
export function partNotices(parts: readonly PartStatus[]): PartNotice[] {
  const out: PartNotice[] = []
  for (const p of parts) {
    if (p.state === 'ok') continue
    const name = NAME[p.part]
    if (p.state === 'could-not-be-reached') {
      const why = p.reason === 'timed-out' ? 'took too long to answer' : p.reason === 'not-understood' ? 'answered in a way the space could not read' : p.reason === 'broken' ? 'had a problem and could not answer' : 'could not be reached'
      out.push({ kind: 'unreachable', part: p.part, text: `${name} ${why} just now, so its messages are missing here. It will be tried again.` })
    } else {
      out.push({ kind: 'refused', part: p.part, text: p.refusal.reason === 'not-signed-in' ? `${name} could not check your sign-in.` : p.refusal.reason === 'not-admitted' ? `${name} is not open to you.` : `${name} would not show this conversation: ${p.refusal.message}` })
    }
  }
  return out
}

// ── The profile ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The facts beside the conversation, label and value. An outsider's business, role and notes are People's: they are the editable boxes under these (People.tsx `ProfileFields`). */
export function profileFacts(profile: Profile): [string, string][] {
  switch (profile.kind) {
    case 'outside':
      // A Telegram group or channel is a place and not a person: it has no Client, no address and no chat of its own to say.
      if (profile.telegramChat !== undefined) return [['Kind', profile.telegramChat === 'group' ? 'Telegram group' : 'Telegram channel']]
      return [
        ['Client', profile.client ? profile.client.name : 'Not linked to a Client'],
        ['Email', profile.addresses.length > 0 ? profile.addresses.join(', ') : 'No email address on file'],
        ...(profile.chat ? ([['Chat', 'A direct message is open']] as [string, string][]) : []),
      ]
    case 'team':
      return [
        ['Role', profile.role === 'owner' ? 'Owner' : profile.role === 'member' ? 'Member' : 'Teammate'],
        ['Email', profile.address ?? 'No email address on file'],
        ...(profile.signIn && profile.signIn !== profile.address ? ([['Signs in with', profile.signIn]] as [string, string][]) : []),
      ]
    case 'channel':
      return [
        ['Kind', profile.privacy === 'private' ? 'Private channel' : 'Open channel'],
        ['Members', `${profile.memberCount} ${profile.memberCount === 1 ? 'person' : 'people'}`],
      ]
  }
}
