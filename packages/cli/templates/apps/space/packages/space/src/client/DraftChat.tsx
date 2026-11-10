// The owner's chat with the assistant about a draft, kept beside the draft wherever the draft is shown.
// "Shorter", "mention the free quote": the assistant answers, and when the owner asked for a change it revises the draft, which the card then shows.
// NOTHING TYPED HERE SENDS ANYTHING, "send it" included: the chat has no command, and the only way the draft goes out is the Send button on the card.
//
// A turn names the draft AND the revision the card shows, so a draft that changed meanwhile (an edit in the inbox, another turn) is refused as a conflict and shown as
// it is now, rather than overwritten; a second press of Ask over a revision the first one already moved on (before the card has read the new one) is refused the same way. The words typed stay where they were typed.
import { useState } from 'react'
import type { InboxChatAnswer, InboxChatTurn } from '@space/workspace'
import type { DraftView } from '../conversation'
import { Say, Viewed, useAction, when } from './settings-parts'
import { postView, useView } from './views'

const MAX_WORDS = 2000

/** One turn: the owner's words, the assistant's answer, and whether the draft changed. A note the assistant left by itself has no words of the owner's. */
export function TurnLine({ turn }: { turn: InboxChatTurn }) {
  return (
    <li className="turn" data-testid="turn" data-revised={turn.revised}>
      {turn.instruction !== null && (
        <p className="turn-you">
          <b>You</b> <span className="sub">{when(turn.at)}</span>
          <br />
          {turn.instruction}
        </p>
      )}
      <p className={`turn-ai${turn.instruction === null ? ' own' : ''}`}>
        <b>Assistant</b>
        {turn.revised && <span className="kindtag accent">Revised the draft</span>}
        <br />
        {turn.note}
      </p>
    </li>
  )
}

/** The turns and the box, drawn from literal ones. */
export function DraftChatView({ turns, words, busy, onWords, onAsk }: { turns: readonly InboxChatTurn[]; words: string; busy: boolean; onWords(w: string): void; onAsk(): void }) {
  return (
    <section className="draft-chat" aria-label="Chat with the assistant" data-testid="draft-chat">
      <p className="sub">Nothing typed here sends anything. The draft goes out only by Send.</p>
      {turns.length > 0 && (
        <ol className="turns" aria-label="Chat">
          {turns.map((t) => (
            <TurnLine key={t.seq} turn={t} />
          ))}
        </ol>
      )}
      <form
        className="turn-form"
        onSubmit={(e) => {
          e.preventDefault()
          onAsk()
        }}
      >
        <input
          aria-label="Tell the assistant what to change"
          value={words}
          maxLength={MAX_WORDS}
          readOnly={busy}
          placeholder="Shorter, or mention Friday"
          onChange={(e) => onWords(e.target.value)}
          data-testid="chat-words"
        />
        <button type="submit" className="btn" disabled={busy || words.trim() === ''} data-testid="chat-ask">
          {busy ? 'Asking...' : 'Ask'}
        </button>
      </form>
    </section>
  )
}

/** The chat on one draft: closed behind a button until asked for, then its turns are read and a new one is asked. */
export function DraftChat({ draft, onChanged }: { draft: DraftView; onChanged(): void }) {
  const [open, setOpen] = useState(false)
  // A draft on no conversation is not chatted about from the space (the inbox makes an empty draft for that).
  if (draft.conversationId === null || draft.stuck || draft.sending) return null
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="open-chat">
        Ask the assistant
      </button>
    )
  }
  return <Open conversationId={draft.conversationId} draftId={draft.id} rev={draft.rev} onChanged={onChanged} />
}

function Open({ conversationId, draftId, rev, onChanged }: { conversationId: string; draftId: string; rev: number; onChanged(): void }) {
  const turns = useView<InboxChatTurn[]>('draft-chat', { conversation: conversationId, draft: draftId })
  const [words, setWords] = useState('')
  const action = useAction()
  const ask = async () => {
    const instruction = words.trim()
    if (instruction === '' || action.busy) return
    const ok = await action.run(() => postView<InboxChatAnswer>('chat', { conversationId, draftId, rev, instruction }), (a) => (a.turn.revised ? 'The draft is revised.' : 'The assistant answered and left the draft as it was.'))
    if (ok) setWords('')
    // Either way the card is read again: a refusal because the draft moved on shows it as it is now.
    turns.reload()
    onChanged()
  }
  return (
    <>
      <Viewed view={turns.state} problem={turns.problem} reload={turns.reload} loading="Loading the chat">
        {(list) => <DraftChatView turns={list} words={words} busy={action.busy} onWords={setWords} onAsk={() => void ask()} />}
      </Viewed>
      {action.say && <Say say={action.say} />}
    </>
  )
}
