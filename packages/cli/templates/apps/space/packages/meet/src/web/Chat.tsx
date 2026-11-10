// The call's chat panel, and the read-only list of messages the start page shares
// with it. Text only: every message is rendered as text nodes, and a link is an
// <a> for an address call/chat.ts parsed as http or https, opened in a new tab
// with rel="noopener noreferrer nofollow" so the page it opens learns nothing
// about this call and gets no credit from it.

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { CHAT_MAX, CHAT_SAVED_NOTICE, type ChatMessage } from '../model'
import { formatTime, linkify } from './call/chat'
import { Icon } from './ui'

function MessageText({ text }: { text: string }) {
  return (
    <p className="msg-text">
      {linkify(text).map((part, i) =>
        part.kind === 'link' ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">
            {part.label}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  )
}

/** The messages, oldest first, each with who sent it and when. Scrolls to the newest unless the reader has scrolled up. */
export function MessageList({ messages, mine, follow = true }: { messages: ChatMessage[]; mine?: readonly string[]; follow?: boolean }) {
  const ref = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && follow && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, follow])
  return (
    <ol
      ref={ref}
      className="messages"
      data-testid="messages"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {messages.map((m) => (
        <li key={m.id} className={`msg ${mine?.includes(m.memberId) ? 'msg-self' : ''}`} data-testid="message">
          <div className="msg-head">
            <strong className="msg-name">{m.name}</strong>
            <time dateTime={new Date(m.at).toISOString()}>{formatTime(m.at)}</time>
          </div>
          <MessageText text={m.text} />
        </li>
      ))}
    </ol>
  )
}

export function ChatPanel({
  messages,
  mine,
  error,
  onSend,
  onClose,
}: {
  messages: ChatMessage[]
  mine: readonly string[]
  error: string | null
  onSend: (text: string) => Promise<boolean>
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => input.current?.focus(), [])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    // The draft is kept until the call has taken the message, so a refusal (too fast, too long) loses nothing.
    if (await onSend(text)) setDraft('')
    setSending(false)
    input.current?.focus()
  }

  return (
    <aside className="chat" aria-label="Chat" data-testid="chat">
      <header className="chat-head">
        <h2>Chat</h2>
        <button type="button" className="chat-close" onClick={onClose} aria-label="Close chat" data-testid="chat-close">
          <Icon name="close" />
        </button>
      </header>
      <p className="chat-saved" data-testid="chat-saved">
        {CHAT_SAVED_NOTICE}
      </p>
      {messages.length === 0 ? (
        <p className="chat-empty" data-testid="chat-empty">
          No messages yet.
        </p>
      ) : (
        <div className="chat-log" role="log" aria-live="polite">
          <MessageList messages={messages} mine={mine} />
        </div>
      )}
      {error && (
        <p className="chat-error" role="alert" data-testid="chat-error">
          {error}
        </p>
      )}
      <form className="chat-form" onSubmit={(e) => void submit(e)}>
        <textarea
          ref={input}
          value={draft}
          rows={2}
          maxLength={CHAT_MAX}
          placeholder="Write a message"
          aria-label="Message"
          data-testid="chat-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line. Not while an input method is still composing.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault() // not a new line: the message is sent
              void submit()
            }
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''} data-testid="chat-send">
          Send
        </button>
      </form>
    </aside>
  )
}
