// What a card of a conversation does by hand, the three things the inbox's own page does too: say how a send Gmail never confirmed went, mark a text or a
// direct message sent by hand, and take that mark back. Each is one call to the inbox (src/views.ts, `resolve-send`, `draft-sent`, `draft-unsent`); none sends mail.
//
// THE WORDS ARE THE INBOX PAGE'S OWN, and so is the order: a stuck send is never offered again (sending it a second time could deliver it twice), the person looks in Gmail Sent (or asks the recipient,
// for a business mailbox, which has no Sent folder) and says which it was, and each answer asks once more IN THE PAGE and says what it will do, because the wrong answer costs a lost email or a second copy.
// A text or a direct message has no send here at all: it is sent by hand and Mark sent files it. Whatever the answer, the conversation is read again, so a refusal (it was settled already, or the draft
// changed) shows the card as it now is.
import { useState } from 'react'
import type { InboxHandSent, InboxSendResolved } from '@space/workspace'
import type { DraftView } from '../conversation'
import { Glyph } from './icons'
import { Say, useAction } from './settings-parts'
import { postView } from './views'

/** The inbox page's own words over a send that never finished: which mailbox it went out of decides whether Gmail Sent can settle it. */
export const stuckWords = (draft: Pick<DraftView, 'sentFrom' | 'to'> & { kind?: DraftView['kind'] }): string =>
  draft.kind === 'telegram'
    ? 'Sending on Telegram, or the send never finished. The bridge has not said whether this went out, so it has not been sent again. Check Telegram, then say which it was.'
    : fromMailbox(draft)
    ? `Sending, or the send never finished. Cloudflare did not say whether this went out from ${draft.sentFrom}, so it has not been sent again. There is no Sent folder for it: ask ${draft.to}, then say which it was.`
    : 'Sending, or the send never finished. Gmail did not say whether this went out, so it has not been sent again. Check Gmail Sent, then say which it was.'

/** What each answer will do, said before it is given: the inbox page's own sentences. */
export const askingWords = (draft: Pick<DraftView, 'sentFrom'> & { kind?: DraftView['kind'] }, asking: 'out' | 'not'): string =>
  draft.kind === 'telegram'
    ? asking === 'out'
      ? 'The message is in the Telegram chat. This removes the stuck draft; the message in the chat is the record.'
      : 'The message is not in the Telegram chat. This makes it a draft again. If it did go out, sending it again delivers it twice.'
    : fromMailbox(draft)
    ? asking === 'out'
      ? 'It went out. This records it as sent, on your word: the inbox has the only record of it.'
      : 'It did not go out. This makes it a draft again. If it did go out, sending it again delivers it twice.'
    : asking === 'out'
      ? 'Gmail Sent shows this message. This removes the stuck draft; Gmail’s own copy is the record.'
      : 'Gmail Sent does not show this message. This makes it a draft again. If it did go out, sending it again delivers it twice.'

/** Whether a stuck send went out of a business mailbox (no Sent folder to look in), decided once: every word and button below follows it. */
export const fromMailbox = (draft: Pick<DraftView, 'sentFrom'>): boolean => Boolean(draft.sentFrom)

export function StuckSend({ draft, onChanged, initialAsking = null }: { draft: DraftView; onChanged(): void; initialAsking?: 'out' | 'not' | null }) {
  const [asking, setAsking] = useState<'out' | 'not' | null>(initialAsking)
  const action = useAction()
  const mailbox = fromMailbox(draft)

  const resolve = async (sent: boolean) => {
    await action.run(() => postView<InboxSendResolved>('resolve-send', { draftId: draft.id, sent }), 'Done.')
    setAsking(null)
    // Settled or refused, the conversation is read again: a settled send is gone from it, and a refusal shows what it is now.
    onChanged()
  }

  return (
    <div className="stuck-send" data-testid="stuck-send">
      <p className="cnotice error" role="alert" data-testid="draft-notice">
        <Glyph name="warn" size={13} />
        <span>{stuckWords(draft)}</span>
      </p>
      {asking === null ? (
        <div className="stuck-bar">
          <button type="button" className="btn" disabled={action.busy} onClick={() => setAsking('out')} data-testid="stuck-out">
            {mailbox ? 'It went out: record it as sent' : 'It went out: remove this'}
          </button>
          <button type="button" className="btn" disabled={action.busy} onClick={() => setAsking('not')} data-testid="stuck-not">
            It did not go out: make it a draft again
          </button>
        </div>
      ) : (
        <div className="stuck-ask" data-testid="stuck-ask" data-asking={asking}>
          <p>{askingWords(draft, asking)}</p>
          <div className="stuck-bar">
            <button type="button" className="btn primary" disabled={action.busy} onClick={() => void resolve(asking === 'out')} data-testid="stuck-yes">
              {asking === 'out' ? (mailbox ? 'Yes, it went out: record it as sent' : 'Yes, it went out: remove it') : 'Yes, it did not go out: make it a draft'}
            </button>
            <button type="button" className="btn" disabled={action.busy} onClick={() => setAsking(null)} data-testid="stuck-cancel">
              Cancel
            </button>
          </div>
        </div>
      )}
      {action.say && <Say say={action.say} />}
    </div>
  )
}

/** Mark sent, on a text or a direct message draft: the inbox cannot send on that channel, so the person sends it themselves and files it here. */
export function MarkSent({ draft, onChanged }: { draft: DraftView; onChanged(): void }) {
  const action = useAction()
  const press = async () => {
    await action.run(() => postView<InboxHandSent>('draft-sent', { draftId: draft.id }), 'Marked sent.')
    onChanged()
  }
  return (
    <>
      <button type="button" className="btn primary" disabled={action.busy} onClick={() => void press()} title="Send it yourself first. This files it as sent, in the conversation, and closes it." data-testid="mark-sent">
        {action.busy ? 'Marking' : 'Mark sent'}
      </button>
      {action.say && <Say say={action.say} />}
    </>
  )
}

/** "Not sent after all", under a message marked sent by hand: it goes back to being a draft. */
export function NotSentAfterAll({ messageId, onChanged }: { messageId: string; onChanged(): void }) {
  const action = useAction()
  const press = async () => {
    await action.run(() => postView<InboxHandSent>('draft-unsent', { messageId }), 'It is a draft again.')
    onChanged()
  }
  return (
    <div className="not-sent">
      <button type="button" className="btn" disabled={action.busy} onClick={() => void press()} data-testid="not-sent-after-all">
        Not sent after all
      </button>
      {action.say && <Say say={action.say} />}
    </div>
  )
}
