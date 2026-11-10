// Marking an email thread as spam, or not: the inbox's own "Mark as spam" and "Move to the Inbox", in the space. Pure rules, so each is checked on its own.
//
// What it moves: the thread goes to Bulk (or back to the Inbox). Nothing is deleted either way, and for Gmail nothing is changed in Gmail: it is the inbox's view. The call sticks: nothing is asked
// of the spam check again, and a later message in the thread does not undo it. A Client's people are never Bulk, so the inbox draws no button for a thread that is not Bulk yet and belongs to
// one (it would move nothing the screen could show), and a call on one that is says so in its answer.
import type { InboxSpamResult } from '@space/workspace'
import type { ThreadView } from '../conversation'
import type { Notice } from './compose'

export interface SpamControl {
  /** The words on the button: the inbox's own. */
  label: 'Mark as spam' | 'Move to the Inbox'
  /** What pressing it calls the thread. */
  spam: boolean
  title: string
}

/**
 * The button over a thread, or none: exactly where the inbox's own page draws one, which the inbox says (`canMarkSpam`: the conversation is in a mailbox, and is in Bulk or has no contact
 * on it linked to a Client). An inbox that does not say gets no button.
 */
export function spamControl(thread: Pick<ThreadView, 'canMarkSpam' | 'bulk'>): SpamControl | null {
  if (!thread.canMarkSpam) return null
  if (thread.bulk) return { label: 'Move to the Inbox', spam: false, title: 'Move this email thread back to the Inbox. Nothing is changed in Gmail.' }
  return { label: 'Mark as spam', spam: true, title: 'Move this email thread to Bulk: kept apart from people, never deleted. It stays there, and nothing is changed in Gmail.' }
}

/** What to say once the inbox has answered: where the thread stands now, and why when that is not where the call put it. */
export function spamNotice(result: InboxSpamResult, subject: string): Notice {
  const what = subject.trim() === '' ? 'The thread' : `“${subject.trim()}”`
  if (result.spam && result.bulk) return { tone: 'ok', text: `${what} is in Bulk now: kept apart from people, never deleted.` }
  if (!result.spam && !result.bulk) return { tone: 'ok', text: `${what} is back in the Inbox.` }
  const why = result.reasons.length > 0 ? ` ${result.reasons.join(' ')}` : ''
  return result.spam ? { tone: 'warn', text: `${what} was called spam, but it stays in the Inbox.${why}` } : { tone: 'warn', text: `${what} was moved back, but it is still in Bulk.${why}` }
}
