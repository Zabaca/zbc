/**
 * How a message's text is READ: what its sender wrote now and the earlier email they quoted under it, each as the screen shows
 * it. One function for both places that draw a message, so they cannot fold differently: the conversation page (client/Conversation.tsx)
 * and the answer the space gets (`messagesWith`, src/space.ts). The quote rules are quote.ts's and the line-wrap rules reflow.ts's;
 * this only puts them in the order the page has always used them (the quote is found in the text as it arrived, then each half is
 * reflowed, and only when the message came in through Gmail).
 */
import type { InboxRead } from '@space/workspace'
import { splitQuoted } from './quote'
import { reflow } from './reflow'
import { GMAIL_ACTOR, type MessageRow } from './types'

/** The text was written in a mail client and came in through Gmail, so its hard line wraps are put back. */
export const viaGmail = (m: Pick<MessageRow, 'gmailId' | 'sentBy'>): boolean =>
  m.gmailId !== null && m.sentBy === GMAIL_ACTOR

/** `earlier` is the text of the messages before this one in the same conversation, which a quote is proved against. */
export function readText(
  body: string,
  context: { earlier: readonly string[]; subject: string; viaGmail: boolean },
): InboxRead {
  const shown = context.viaGmail ? reflow : (text: string) => text
  const { visible, quoted } = splitQuoted(body, context)
  return quoted === '' ? { visible: shown(body), quoted: '' } : { visible: shown(visible), quoted: shown(quoted) }
}
