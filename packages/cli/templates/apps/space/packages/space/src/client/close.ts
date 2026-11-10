// Close and Reopen on a person's conversation: what the page says about how they ended, which thread Reopen acts on, and when the key `c` means Close.
// Pure, so the words and the rules are checked on their own.
//
// CLOSE is the inbox's own Close, once for each open email thread on screen, each at the position the page read to. The inbox refuses a thread that
// has newer mail than that (`conflict`) and changes nothing of it, so the page says which thread, and shows it as it now stands. REOPEN is the inbox's
// own Reopen, which changes ONE conversation: from the Closed view it acts on one thread (the one chosen in the reply picker, else the newest closed
// one), and right after a Close it undoes exactly the threads that Close closed. Both are idempotent and the page never retries on its own, so a lost
// answer is not an "outcome unknown" that must be guarded: the conversation is read again, and shows.

import type { ConversationAnswer, CloseOutcome, ReopenOutcome } from '../conversation'
import { isRecord } from '../guards'
import type { Notice } from './compose'

/** What the Worker answered a write, as `write()` gives it back. */
export type WriteResponse = { status: number; type?: string; body: unknown } | 'network'

export interface Changed {
  notice: Notice
  /** The conversations that were closed (or reopened). */
  done: string[]
  /** The conversations the inbox DEFINITELY did not change (it answered and refused them). Absent when none, and for an outcome that is not known (no answer, a dropped connection): that may have gone through. */
  refused?: string[]
}

/** What the page names a thread by when it says something about it. */
export type Subject = (conversationId: string) => string

const isNotChanged = (list: unknown): boolean =>
  Array.isArray(list) && list.every((n) => isRecord(n) && typeof n.conversationId === 'string' && typeof n.reason === 'string' && typeof n.message === 'string')
const isIds = (v: unknown): boolean => Array.isArray(v) && v.every((d) => typeof d === 'string')

const isCloseOutcome = (v: unknown): v is CloseOutcome =>
  isRecord(v) && ((v.state === 'unanswered' && typeof v.message === 'string') || (v.state === 'ok' && isIds(v.closed) && isNotChanged(v.notClosed)))
const isReopenOutcome = (v: unknown): v is ReopenOutcome =>
  isRecord(v) && ((v.state === 'unanswered' && typeof v.message === 'string') || (v.state === 'ok' && isIds(v.reopened) && isNotChanged(v.notReopened)))

/** The answer, or the notice for one that is not an answer at all (the connection, the sign-in, a refusal by the Worker itself). */
function answered<T>(res: WriteResponse, did: 'closed' | 'reopened', valid: (v: unknown) => v is T): T | Notice {
  if (res === 'network') return { tone: 'error', text: `The connection to the space dropped. Whether it ${did} is not known: the conversation is shown as it stands.` }
  if (res.type === 'opaqueredirect' || res.status === 401) return { tone: 'error', text: 'Your sign-in may have ended. Reload the page to sign in again.' }
  if (res.status >= 400 && res.status < 500) return { tone: 'error', text: isRecord(res.body) && typeof res.body.error === 'string' ? res.body.error : 'The space would not take that.' }
  if (res.status === 200 && valid(res.body)) return res.body
  return { tone: 'error', text: `The space did not answer clearly. Whether it ${did} is not known: the conversation is shown as it stands.` }
}

const isNotice = (v: object): v is Notice => 'tone' in v

/**
 * What to tell the person after Close. `notShown` is how many open email threads were left alone because they are not on screen. `sent` is a Close that
 * follows a send ("Send and close"): the email went, so a failure to close says so first.
 */
export function describeClose(res: WriteResponse, ctx: { subject: Subject; notShown: number; sent: boolean }): Changed {
  const got = answered(res, 'closed', isCloseOutcome)
  const lead = ctx.sent ? 'Sent, but not closed. ' : ''
  if (isNotice(got)) return { notice: { tone: got.tone, text: `${lead}${got.text}` }, done: [] }
  if (got.state === 'unanswered') return { notice: { tone: 'error', text: `${lead}${got.message} Whether it closed is not known: the conversation is shown as it stands.` }, done: [] }
  const why = got.notClosed.map((n) => (n.reason === 'conflict' ? `A new message arrived in "${ctx.subject(n.conversationId)}", so it was not closed. It is shown now.` : `"${ctx.subject(n.conversationId)}" was not closed. ${n.message}`))
  const left = ctx.notShown > 0 ? ` ${ctx.notShown} older email conversation${ctx.notShown === 1 ? ' is' : 's are'} not on screen, so ${ctx.notShown === 1 ? 'it was' : 'they were'} left open.` : ''
  if (why.length === 0) return { notice: { tone: 'ok', text: `${ctx.sent ? 'Sent and closed.' : 'Closed.'}${left}` }, done: got.closed }
  const refused = got.notClosed.map((n) => n.conversationId)
  if (got.closed.length === 0) return { notice: { tone: 'warn', text: `${lead}${why.join(' ')}${left}` }, done: [], refused }
  return { notice: { tone: 'warn', text: `${ctx.sent ? 'Sent. ' : ''}Closed ${got.closed.length} of ${got.closed.length + why.length}. ${why.join(' ')}${left}` }, done: got.closed, refused }
}

/** What to tell the person after Reopen. */
export function describeReopen(res: WriteResponse, ctx: { subject: Subject }): Changed {
  const got = answered(res, 'reopened', isReopenOutcome)
  if (isNotice(got)) return { notice: got, done: [] }
  if (got.state === 'unanswered') return { notice: { tone: 'error', text: `${got.message} Whether it reopened is not known: the conversation is shown as it stands.` }, done: [] }
  const why = got.notReopened.map((n) => `"${ctx.subject(n.conversationId)}" was not reopened. ${n.message}`)
  if (why.length === 0) return { notice: { tone: 'ok', text: 'Reopened.' }, done: got.reopened }
  return { notice: { tone: 'warn', text: why.join(' ') }, done: got.reopened, refused: got.notReopened.map((n) => n.conversationId) }
}

/** Why a Send and close sent but closed nothing: the reply went in a direct message (chat has no close), or in an email thread that is already closed or not on screen. */
export function whyNotClosed(answer: ConversationAnswer, threadId: string | null): string {
  if (threadId === null) return 'A direct message has no Close.'
  const thread = answer.threads.find((t) => t.conversationId === threadId)
  return thread && !thread.open ? 'That email thread is already closed.' : 'That email thread is not on screen, so it was left open.'
}

// ── What is shown while a change is out ───────────────────────────────────────────────────────────────────────────────────

/**
 * The conversation as it will stand once the changes still out have gone through (changes.ts): each thread named in `pending` is open or closed as the person
 * asked, and the marks Close and Reopen act on follow. A Reopen's thread goes back into Close at the position the page read it to. The same object comes
 * back when nothing here is named, so a screen that keeps it does not redraw.
 */
export function withPending(answer: ConversationAnswer, pending: ReadonlyMap<string, boolean>): ConversationAnswer {
  if (pending.size === 0 || !answer.threads.some((t) => pending.has(t.conversationId) && pending.get(t.conversationId) !== t.open)) return answer
  const threads = answer.threads.map((t) => (pending.has(t.conversationId) ? { ...t, open: pending.get(t.conversationId) as boolean } : t))
  const wasOpen = new Map(answer.threads.map((t) => [t.conversationId, t.open]))
  const stays = (id: string, open: boolean) => (pending.has(id) ? pending.get(id) === open : wasOpen.get(id) === open)
  const throughOf = new Map(answer.threads.map((t) => [t.conversationId, t.through]))
  const reopening = answer.change.reopen.filter((id) => pending.get(id) === true)
  const close = [...answer.change.close.filter((m) => stays(m.conversationId, true)), ...reopening.map((id) => ({ conversationId: id, through: throughOf.get(id) as number }))]
  const reopen = [...answer.change.reopen.filter((id) => stays(id, false)), ...answer.change.close.filter((m) => pending.get(m.conversationId) === false).map((m) => m.conversationId)]
  return { ...answer, threads, change: { ...answer.change, close, reopen } }
}

// ── Which thread Reopen acts on ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The threads Reopen would bring back, and what the button says.
 *
 * - RIGHT AFTER A CLOSE: exactly the threads that Close closed (`lastClosed`), so a mistaken Close is undone whole and nothing else is touched.
 * - FROM THE CLOSED VIEW: ONE thread, as the inbox's own Reopen changes one conversation: the closed thread chosen in the reply picker, else the newest
 *   closed one. A person with six closed threads on screen gets one back, not all six.
 * - Otherwise nothing, and no button.
 *
 * Only threads that are closed and on screen (`answer.change.reopen`) are ever named.
 */
export function reopenOffer(
  answer: ConversationAnswer,
  from: { fromClosed: boolean; lastClosed: readonly string[]; threadId: string | null },
): { ids: string[]; label: string; title: string } | null {
  const subject = (id: string) => answer.threads.find((t) => t.conversationId === id)?.subject.trim() || '(no subject)'
  const undo = answer.change.reopen.filter((id) => from.lastClosed.includes(id))
  if (undo.length > 0) {
    return undo.length === 1
      ? { ids: undo, label: 'Reopen', title: `Reopen "${subject(undo[0] as string)}", which was just closed` }
      : { ids: undo, label: `Reopen ${undo.length}`, title: `Reopen the ${undo.length} email conversations just closed` }
  }
  if (!from.fromClosed) return null
  const closed = answer.threads.filter((t) => answer.change.reopen.includes(t.conversationId))
  // Newest first; a thread with no message in the history (older than the page) after those that have one.
  const newest = [...closed].sort((a, b) => (b.at ?? -1) - (a.at ?? -1))[0]
  const chosen = closed.find((t) => t.conversationId === from.threadId) ?? newest
  if (!chosen) return null
  const name = chosen.subject.trim() || '(no subject)'
  return { ids: [chosen.conversationId], label: `Reopen "${name}"`, title: `Reopen "${name}"` }
}

// ── The key ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KeyPress {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  /** The browser's auto-repeat of a key held down. */
  repeat?: boolean
}

/** Whether focus is somewhere a letter is a letter: a text box, a menu of choices, or anything editable. */
export function typingIn(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false
  return target.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName ?? '')
}

/** Whether a modal is open anywhere on the page (the phone's Views sheet): a key behind it is not for the page behind. */
export const modalOpen = (doc: { querySelector(selector: string): unknown }): boolean => doc.querySelector('[aria-modal="true"], [data-no-shortcuts]') !== null

/**
 * Whether a key press is the person asking to close (as the inbox's `c` is): a plain lowercase c, not held down, and never while typing or behind a
 * modal, so a word with a c in the reply box is a word. A capital (Caps Lock, Shift) and any command key are not it.
 */
export function isCloseKey(press: KeyPress, off: boolean): boolean {
  if (off || press.repeat) return false
  if (press.metaKey || press.ctrlKey || press.altKey || press.shiftKey) return false
  return press.key === 'c'
}
