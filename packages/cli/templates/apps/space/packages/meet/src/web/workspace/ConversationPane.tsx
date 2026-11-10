// One open conversation: its header and members, the messages (with the "New" line, edit and delete of your own),
// and the box to write in. Messages are text: every one is rendered as text nodes, and a link is an <a> only for an
// address the in-call chat's rule accepts (call/chat.ts), opened in a new tab with rel="noopener noreferrer nofollow".

import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CHAT_MAX } from '../../model'
import type { ConversationView, PersonView, WMessage } from '../../workspace-model'
import { ApiError } from '../api'
import { formatTime } from '../call/chat'
import { Icon } from '../ui'
import type { WorkspaceApi } from './api'
import { siteOrigin } from '../site'
import { messageParts } from './links'
import { useSite } from '../site'
import { type WState, conversationName, firstNewId, otherPerson, personTag } from './store'

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

function Text({ text }: { text: string }) {
  return (
    <p className="msg-text">
      {messageParts(text, siteOrigin()).map((part, i) =>
        part.kind === 'link' ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow" data-testid={part.label === 'Join call' ? 'join-call' : undefined}>
            {part.label}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  )
}

function MessageRow({
  m,
  mine,
  canDeleteAny,
  onEdit,
  onDelete,
}: {
  m: WMessage
  mine: boolean
  canDeleteAny: boolean
  onEdit: (id: number, text: string) => Promise<string | null>
  onDelete: (id: number) => Promise<string | null>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.text)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e?: FormEvent) {
    e?.preventDefault()
    const bad = await onEdit(m.id, draft)
    if (bad) setError(bad)
    else {
      setEditing(false)
      setError(null)
    }
  }
  return (
    <div className={`msg ws-msg ${mine ? 'msg-self' : ''}`} data-testid="ws-message" data-id={m.id} data-mine={mine}>
      <div className="msg-head">
        <strong className="msg-name">{m.name}</strong>
        <time dateTime={new Date(m.at).toISOString()}>{formatTime(m.at)}</time>
        {m.editedAt !== null && <span className="ws-edited">edited</span>}
        {m.phone?.kind !== 'emergency' && (mine || canDeleteAny || m.phone !== undefined) && !editing && !confirming && (
          <span className="ws-msg-actions">
            {mine && m.phone === undefined && (
              <button type="button" className="ws-link-btn" onClick={() => (setDraft(m.text), setEditing(true))} data-testid="msg-edit">
                Edit
              </button>
            )}
            <button type="button" className="ws-link-btn" onClick={() => setConfirming(true)} data-testid="msg-delete">
              Delete
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <form className="ws-edit" onSubmit={(e) => void save(e)}>
          <textarea
            value={draft}
            maxLength={CHAT_MAX}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Edit message"
            data-testid="msg-edit-input"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void save()
              }
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <div className="row">
            <button type="submit" className="btn btn-small btn-primary" disabled={draft.trim() === ''} data-testid="msg-edit-save">
              Save
            </button>
            <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <Text text={m.text} />
      )}
      {confirming && (
        <div className="call-row-confirm" role="alertdialog" aria-label="Delete message">
          <span>{m.phone?.kind === 'voicemail' ? 'Delete this voicemail for everyone? Its recording is deleted too.' : 'Delete this message for everyone?'}</span>
          <button
            type="button"
            className="btn btn-small btn-danger"
            data-testid="msg-delete-yes"
            onClick={async () => {
              const bad = await onDelete(m.id)
              if (bad) setError(bad)
              setConfirming(false)
            }}
          >
            Delete
          </button>
          <button type="button" className="btn btn-small" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function Composer({ conv, onSend, label }: { conv: number; onSend: (text: string) => Promise<string | null>; label: string }) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  // Each conversation keeps its own half-written message while it is open; changing conversation starts clean.
  useEffect(() => {
    setDraft('')
    setError(null)
  }, [conv])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    // The draft is kept until the workspace has taken the message, so a refusal (too fast, too long) loses nothing.
    const bad = await onSend(text)
    if (bad) setError(bad)
    else {
      setDraft('')
      setError(null)
    }
    setSending(false)
    input.current?.focus()
  }
  return (
    <div className="ws-composer">
      {error && (
        <p className="chat-error" role="alert" data-testid="ws-error">
          {error}
        </p>
      )}
      <form className="chat-form" onSubmit={(e) => void submit(e)}>
        <textarea
          ref={input}
          value={draft}
          rows={2}
          maxLength={CHAT_MAX}
          placeholder={`Message ${label}`}
          aria-label="Message"
          data-testid="ws-input"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''} data-testid="ws-send">
          <Icon name="send" />
          <span>Send</span>
        </button>
      </form>
    </div>
  )
}

function MembersPanel({ s, conv, onClose, onMessage }: { s: WState; conv: ConversationView; onClose: () => void; onMessage: (person: string) => void }) {
  const { company } = useSite()
  const me = s.me
  const members = conv.members.map((id) => s.people[id]).filter((p): p is PersonView => Boolean(p))
  return (
    <aside className="ws-members" aria-label="People in this channel" data-testid="members">
      <header className="ws-members-head">
        <h3>People ({members.length})</h3>
        <button type="button" className="ws-icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>
      <ul className="ws-people">
        {members.map((p) => (
          <li key={p.id} data-testid="member" data-person={p.id}>
            <div className="ws-person ws-person-static">
              <span className="ws-avatar">{p.name.charAt(0).toUpperCase()}</span>
              <span className="ws-person-name">
                {p.name}
                {p.id === me?.id ? ' (you)' : ''}
                {p.email && <small>{p.email}</small>}
              </span>
              <span className="ws-tag">{personTag(p, company)}</span>
            </div>
            {p.id !== me?.id && (
              <div className="ws-person-actions">
                <button type="button" className="btn btn-small" onClick={() => onMessage(p.id)} data-testid="member-message">
                  Message
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}

export function ConversationPane({
  s,
  conv,
  api,
  openedAt,
  onBack,
  onSend,
  onEdit,
  onDelete,
  onOlder,
  onMessage,
  onChanged,
}: {
  s: WState
  conv: ConversationView
  api: WorkspaceApi
  /** Where this conversation's read position and newest message stood when it was opened: the "New" line's place. */
  openedAt: { read: number; last: number }
  onBack: () => void
  onSend: (text: string) => Promise<string | null>
  onEdit: (id: number, text: string) => Promise<string | null>
  onDelete: (id: number) => Promise<string | null>
  onOlder: () => Promise<void>
  onMessage: (person: string) => void
  onChanged: () => void
}) {
  const me = s.me
  const { company } = useSite()
  const [panel, setPanel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messages = s.messages[conv.id] ?? []
  const loaded = s.loaded[conv.id] === true
  const list = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  const settled = useRef<number | null>(null)
  const name = conversationName(s, conv)
  const newId = firstNewId(messages, me?.id, openedAt.read, openedAt.last)
  const isChannel = conv.kind === 'channel'
  const other = otherPerson(s, conv)

  // Opening: show the "New" line if there is one, else the newest. After that, follow new messages only while at the bottom.
  useLayoutEffect(() => {
    const el = list.current
    if (!el || !loaded) return
    if (settled.current !== conv.id) {
      settled.current = conv.id
      const line = el.querySelector('[data-testid=new-line]')
      if (line) line.scrollIntoView({ block: 'center' })
      else el.scrollTop = el.scrollHeight
      pinned.current = !line
      return
    }
    if (pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, loaded, conv.id])

  useEffect(() => {
    setPanel(false)
    setError(null)
  }, [conv.id])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(errorText(e, 'That did not work.'))
    }
  }

  return (
    <section className="ws-conv" aria-label={name} data-testid="conversation" data-conv={conv.id}>
      <header className="ws-conv-head">
        <button type="button" className="ws-icon-btn ws-back" onClick={onBack} aria-label="Back to conversations" data-testid="back">
          <Icon name="back" />
        </button>
        <div className="ws-conv-title">
          <h2 data-testid="conv-name">
            <Icon name={isChannel ? (conv.privacy === 'private' ? 'lock' : 'hash') : 'chat'} />
            <span>{name}</span>
          </h2>
          <p className="fine">
            {isChannel ? `${conv.privacy === 'private' ? 'Private' : 'Open'} channel` : other ? `Direct message \u00b7 ${personTag(other, company)}` : 'Direct message'}
          </p>
        </div>
        <div className="ws-conv-actions">
          <button type="button" className="btn btn-small" onClick={() => void act(() => api.huddle(conv.id))} data-testid="start-huddle">
            <Icon name="cam" />
            <span>Start huddle</span>
          </button>
          {isChannel && (
            <button type="button" className="btn btn-small" onClick={() => setPanel((p) => !p)} aria-pressed={panel} data-testid="members-toggle">
              <Icon name="users" />
              <span>{conv.members.length}</span>
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="ws-conv-body">
        <div className="ws-log">
          {!loaded ? (
            <p className="chat-empty">Loading</p>
          ) : (
            <ol
              ref={list}
              className="messages ws-messages"
              data-testid="ws-messages"
              onScroll={(e) => {
                const el = e.currentTarget
                pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              }}
            >
              {s.more[conv.id] && (
                <li className="ws-older">
                  <button type="button" className="btn btn-small" onClick={() => void onOlder()} data-testid="older">
                    Show older messages
                  </button>
                </li>
              )}
              {messages.length === 0 && (
                <li className="chat-empty" data-testid="ws-empty">
                  {isChannel ? 'No messages yet. Say hello.' : `This is the start of your conversation with ${name}.`}
                </li>
              )}
              {messages.map((m) => (
                <li key={m.id} className="ws-row">
                  {m.id === newId && (
                    <div className="ws-new" data-testid="new-line" role="separator" aria-label="New messages">
                      <span>New</span>
                    </div>
                  )}
                  <MessageRow
                    m={m}
                    mine={m.person === me?.id}
                    canDeleteAny={me?.owner === true}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                </li>
              ))}
            </ol>
          )}
          <Composer conv={conv.id} onSend={onSend} label={isChannel ? `#${name}` : name} />
        </div>
        {panel && isChannel && <MembersPanel s={s} conv={conv} onClose={() => setPanel(false)} onMessage={onMessage} />}
      </div>
    </section>
  )
}
