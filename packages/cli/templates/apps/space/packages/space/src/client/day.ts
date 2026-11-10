// What Today says, as plain functions of its answer: the times in the company's day, the summary line, the notices for a part that did
// not answer, and where each row goes. No React here, so the wording and the links are checked on their own (test/today-view.test.tsx draws them).
import type { SpacePart } from '@space/workspace'
import type { DraftAuthor } from '../conversation'
import { type DocumentRow, type Draft, SOURCES, type SourceId, type SourceStatus, type TodayAnswer } from '../today-shape'
import { type Notice, PART_NAME, agoWords, plural, refusalWords, troubleWords } from './format'

// ── Where a row goes ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A call's link: meet's own public address, never the space's. Behind the space's sign-in a link on the space's address would lead nowhere for
 * a guest, and meet builds and recognises its call links on its own address for the same reason. `meetUrl` is where `Me` says meet
 * is (the space's own address, `Me.origin`); the link is made on that address's origin.
 */
export const callHref = (meetUrl: string, name: string): string => `${new URL(meetUrl).origin}/r/${name}`

/**
 * A document in Forms: it opens in the Forms tab, at the envelope's own screen (a path of the tab: ADR 0007), from Today, from a person's page and from the
 * card in the conversation it was sent from. They open it with a full page load, not a move inside the page: that is what renews the Forms application's day-long sign-in.
 */
export const documentPath = (id: string): string => `/forms/envelopes/${encodeURIComponent(id)}`

/**
 * Where "Send for signature" in a conversation goes: Forms' Send screen, with the conversation's key, which it reads the person and the conversation from.
 * A full page load, like every way into Forms, so the Forms sign-in is renewed.
 */
export const sendFromPath = (conversationKey: string): string => `/forms/send?from=${encodeURIComponent(conversationKey)}`

// ── Times ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A meeting's time on the company's clock: "2:30 PM PDT". The zone is named, because the person's own clock may be elsewhere. */
export const clockIn = (zone: string, at: number): string => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at)

// ── The words of a row ────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Dana Reyes", "Dana Reyes and Marcus Chen", "Dana Reyes, Marcus Chen and 2 others": who a mail conversation is with. */
export function peopleWords(people: readonly string[]): string {
  if (people.length <= 1) return people[0] ?? ''
  if (people.length === 2) return `${people[0]} and ${people[1]}`
  const rest = people.length - 2
  return `${people[0]}, ${people[1]} and ${rest} other${rest === 1 ? '' : 's'}`
}

const AUTHOR_WORDS: Record<DraftAuthor, string> = {
  claude: 'Suggested by Claude',
  assistant: 'Written with the assistant',
  owner: 'Your draft',
  outbox: 'Gmail never confirmed this was sent. Check Sent before sending again',
}

export const draftAuthorWords = (author: DraftAuthor): string => AUTHOR_WORDS[author]

/** The line under a document out for signature: who has not signed, and since when. */
export function outLine(d: DocumentRow, now: number): string {
  const since = `sent ${agoWords(now, d.at)}`
  if (d.state === 'sealing') return `Everyone has signed. The finished copy is being made, ${since}`
  if (d.notSigned.length === 0) return `Waiting on the others, ${since}`
  return `${peopleWords(d.notSigned)} ${d.notSigned.length === 1 ? 'has' : 'have'} not signed, ${since}`
}

/** The line under a document not yet sent: who it is for. */
export const draftDocumentLine = (d: Pick<DocumentRow, 'notSigned'>): string => (d.notSigned.length === 0 ? 'Not sent. No one is named to sign it yet' : `For ${peopleWords(d.notSigned)}, not sent`)

/** The line under a document that came back: signed by everyone, and when. */
export const backLine = (d: Pick<DocumentRow, 'at' | 'signers'>, now: number): string =>
  `${d.signers > 1 ? 'Signed by all ' + d.signers : 'Signed'}, back ${agoWords(now, d.at)}`

/** A draft's title: a reply to a person, or a new email to them. */
export const draftTitle = (d: Extract<Draft, { kind: 'email' }>): string => `${d.reply ? 'Reply to' : 'New email to'} ${d.to}`

// ── The summary line ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether any part did not answer: then Today cannot say that nothing needs the person. A part that said no (the inbox admits its owner only) is not
 * trouble: it was asked, it decided, and what it holds is not this person's to see, so nothing of theirs is missing.
 */
export const hasTrouble = (sources: readonly SourceStatus[]): boolean => sources.some((s) => s.state === 'could-not-be-reached')

/**
 * The line under the title: how much there is, or that there is nothing. "Nothing needs you right now" is a claim, so it is made only when
 * every part answered; a part that did not leaves the line saying the rest is what Today could see.
 */
export function summaryLine(a: TodayAnswer): string {
  const bits: string[] = []
  if (a.happeningNow.length > 0) bits.push(plural(a.happeningNow.length, 'call in progress', 'calls in progress'))
  if (a.waitingOnYou.total > 0) bits.push(`${a.waitingOnYou.total} waiting on you`)
  if (a.drafts.total > 0) bits.push(plural(a.drafts.total, 'draft not sent', 'drafts not sent'))
  if (a.waitingOnOthers.total > 0) bits.push(`${a.waitingOnOthers.total} waiting on others`)
  const trouble = hasTrouble(a.sources)
  if (bits.length === 0) return trouble ? 'Nothing to show from the parts that answered.' : 'Nothing needs you right now.'
  return `${bits.join(', ')}.${trouble ? ' Some of it could not be reached.' : ''}`
}

// ── Notices: what could not be reached, and what said no ──────────────────────────────────────────────────────────────────

/** What Today is missing when this source does not answer. */
const MISSING: Record<SourceId, string> = {
  waiting: 'mail waiting on you',
  drafts: 'email drafts',
  messages: 'direct messages waiting on you',
  calls: 'calls in progress',
  meetings: 'meetings with a time',
  unsent: 'documents not yet sent',
  out: 'documents waiting on others',
  back: 'documents signed today',
}

/** The same, when every source of the part is missing: the part's own name for what it gives Today, not a list of its seven bits. */
const MISSING_ALL: Record<SpacePart, string> = {
  mail: 'mail waiting on you and email drafts',
  chat: 'direct messages waiting on you and calls in progress',
  documents: 'documents',
}

/**
 * One line for each part that did not answer, saying what Today is missing without it. The other parts' rows are on screen; the line says whose
 * they are not. A refusal reads differently from a part that could not be reached: nothing is down, the app does not open its part to this person.
 */
export function noticesFor(sources: readonly SourceStatus[]): Notice[] {
  const notices: Notice[] = []
  for (const part of Object.keys(PART_NAME) as SpacePart[]) {
    for (const state of ['could-not-be-reached', 'not-open-to-you'] as const) {
      const failing = sources.filter((s) => s.part === part && s.state === state)
      if (failing.length === 0) continue
      const all = (Object.keys(SOURCES) as SourceId[]).filter((id) => SOURCES[id].part === part)
      const missing = failing.length === all.length ? MISSING_ALL[part] : failing.map((s) => MISSING[s.source]).join(' and ')
      const first = failing[0] as SourceStatus
      if (first.state === 'could-not-be-reached') {
        notices.push({ kind: 'unreachable', part, text: `${troubleWords(part, first.reason)} just now, so Today is missing ${missing}. It will be tried again.` })
      } else if (first.state === 'not-open-to-you') {
        const why = refusalWords(part, first.refusal, missing)
        notices.push({ kind: 'refused', part, text: first.refusal.reason === 'not-admitted' ? `${why}, so ${missing} are not on Today.` : `${why}.` })
      }
    }
  }
  return notices
}
