// A chat message the way /start drew it, in the space: its words with a link where there is one (a call link reads "Join call"), Edit and Delete where meet's `may` says the person
// may, and the "New" line where unread begins. Meet decides who may edit and delete, in its own words; this draws a button only where `may` says so, and shows what meet refuses.
//
// A message is TEXT. It is put in the page as text nodes, and a link is an <a> only for an address the in-call chat's rule accepts (http or https, a host, no embedded sign-in, a lookalike
// host shown as what it really opens: packages/meet/src/web/call/chat.ts `linkify`), opened in a new tab with rel="noopener noreferrer nofollow". The same rule /start applies.
import { CHAT_MAX } from '@space/meet/src/model'
import { messageParts } from '@space/meet/src/web/workspace/links'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import type { ChatMessage } from '../history'
import { initials } from './format'
import { Ask } from './settings-parts'

/** What a conversation gives its chat messages: where meet's address is (a link to a call on it reads "Join call"), and the two writes. Each answers null when it went through, or meet's words when it did not. */
export interface ChatTools {
  origin: string | null
  edit(messageId: number, text: string): Promise<string | null>
  remove(messageId: number): Promise<string | null>
}

/** The origin of meet's public address, or null where the page was not told one (a link to a call is then an ordinary link). */
export function meetOrigin(address: string | undefined): string | null {
  try {
    return address ? new URL(address).origin : null
  } catch {
    return null
  }
}

/** A message's words, with links. Joining the text of every part gives the message back exactly. */
export function ChatText({ text, origin }: { text: string; origin: string | null }) {
  // Without meet's address nothing can be told to be a call link, but an ordinary link is still one.
  const parts = messageParts(text, origin ?? 'https://call-links.invalid')
  return (
    <div className="msg-text" data-testid="chat-text">
      {parts.map((part, i) =>
        part.kind === 'link' ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow" data-testid={part.label === 'Join call' ? 'join-call' : 'chat-link'}>
            {part.label}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </div>
  )
}

/** The line over the first message that was unread when the conversation was opened. */
export function NewLine() {
  return (
    <div className="new-line" data-testid="new-line" role="separator" aria-label="New messages">
      <span>New</span>
    </div>
  )
}

export function ChatMessageRow({ message, name, at, tools }: { message: ChatMessage; name: string; at: React.ReactNode; tools?: ChatTools }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const may = tools ? message.may : undefined

  async function save(e?: FormEvent) {
    e?.preventDefault()
    if (!tools || busy || draft.trim() === '') return
    setBusy(true)
    const bad = await tools.edit(message.id, draft)
    setBusy(false)
    if (bad) setError(bad)
    else {
      setError(null)
      setEditing(false)
    }
  }
  async function remove() {
    if (!tools || busy) return
    setBusy(true)
    const bad = await tools.remove(message.id)
    setBusy(false)
    setAsking(false)
    if (bad) setError(bad)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void save()
    }
    if (e.key === 'Escape') setEditing(false)
  }

  return (
    <div className={`msg${message.mine ? ' mine' : ''}`} data-testid="entry" data-kind="chat" data-id={message.id}>
      <span className="avatar-sm" aria-hidden="true">
        {initials(name) || '?'}
      </span>
      <div className="msg-body">
        <div className="msg-head">
          <b>{name}</b>
          {at}
          {message.edited && (
            <span className="sub" data-testid="edited">
              edited
            </span>
          )}
          {may && !editing && !asking && (may.edit || may.delete) && (
            <span className="msg-acts">
              {may.edit && (
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setDraft(message.text)
                    setError(null)
                    setEditing(true)
                  }}
                  data-testid="msg-edit"
                >
                  Edit
                </button>
              )}
              {may.delete && (
                <button type="button" className="linkish" onClick={() => (setError(null), setAsking(true))} data-testid="msg-delete">
                  Delete
                </button>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <form className="msg-edit" onSubmit={(e) => void save(e)}>
            <textarea value={draft} maxLength={CHAT_MAX} rows={2} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} aria-label="Edit message" data-testid="msg-edit-input" autoFocus />
            <div className="msg-edit-bar">
              <button type="submit" className="btn primary" disabled={busy || draft.trim() === ''} data-testid="msg-edit-save">
                {busy ? 'Saving' : 'Save'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)} data-testid="msg-edit-cancel">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <ChatText text={message.text} origin={tools?.origin ?? null} />
        )}
        {asking && <Ask question="Delete this message for everyone?" yes="Delete" no="Keep it" danger busy={busy} onYes={() => void remove()} onNo={() => setAsking(false)} />}
        {error && (
          <p className="cnotice error msg-error" role="alert" data-testid="msg-error">
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  )
}
