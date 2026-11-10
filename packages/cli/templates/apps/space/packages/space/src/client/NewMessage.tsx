// New message: start a direct message with anyone the person can see, as /start's New message did. A list of the people meet lets the person write to (every teammate, and a guest who shares
// a channel with them), searched by name; a person with a direct message that already has something in it is opened, and anyone else gets a box to write the first message in.
//
// THE FIRST MESSAGE IS A POST TO A PERSON (`/api/chat` with `personId`, conversation.ts): meet opens the direct message as it posts, once per compose key, so pressing Send twice is one direct
// message and one message, and a message meet refuses (too long, too fast) opens nothing and gives the message back with the same key. The key is made once for the box (compose.ts) and kept
// until the message has gone; an outcome the space lost track of offers no second try. Nothing is sent to anyone but the person written to; this is chat, not email.
//
// `NewMessageView` draws from its state and is pure, so the tests draw it with literal ones. `NewMessagePanel` keeps the state, reads the people and sends.
import type { MeetReachable } from '@space/workspace'
import { type FormEvent, type KeyboardEvent, useState } from 'react'
import { CHAT_MAX } from '@space/meet/src/model'
import { write } from './api'
import { type Compose, begin, canSend, describe, mintKey, newCompose, outcomeFromResponse, requestFor, settle, typed } from './compose'
import { Glyph } from './icons'
import { useInstall } from './install'
import { meetPath } from './route'
import { Viewed } from './settings-parts'
import { useView } from './views'

type Go = (path: string) => void

/** How a person is tagged beside their name, as /start tagged them. */
const tag = (p: MeetReachable['person'], company: string): string => (p.kind === 'teammate' ? company : 'Guest')

/** Where the conversation with this person lives once it has something in it: their address (a row holding it is found by it), or meet's person for one with no address shown. */
export const conversationWith = (p: MeetReachable['person']): string => meetPath(p.address ?? `chat:${p.id}`)

/** The people whose names hold what was typed, in meet's order. */
export const matching = (people: readonly MeetReachable[], q: string): MeetReachable[] => {
  const wanted = q.trim().toLowerCase()
  return wanted === '' ? [...people] : people.filter((p) => p.person.name.toLowerCase().includes(wanted) || (p.person.address ?? '').toLowerCase().includes(wanted))
}

export function NewMessageView({
  people,
  q,
  onQ,
  to,
  onPick,
  compose,
  onText,
  onSend,
  onClose,
}: {
  people: readonly MeetReachable[]
  q: string
  onQ(q: string): void
  /** Who the first message is to, once chosen. */
  to: MeetReachable['person'] | null
  onPick(p: MeetReachable): void
  compose: Compose
  onText(text: string): void
  onSend(): void
  onClose(): void
}) {
  const { company } = useInstall()
  const shown = matching(people, q)
  const locked = compose.phase !== 'writing'
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }
  return (
    <section className="chan-card" aria-label="New message" data-testid="new-message">
      <h3>New message</h3>
      {to === null ? (
        <>
          <label className="field">
            <span className="sub">To</span>
            <input value={q} placeholder="Search people" autoFocus onChange={(e) => onQ(e.target.value)} data-testid="dm-search" />
          </label>
          {shown.length === 0 ? (
            <p className="sub" data-testid="dm-none">
              {people.length === 0 ? 'There is no one to message yet. People appear here once they share a channel with you.' : 'No one by that name.'}
            </p>
          ) : (
            <ul className="chan-list" data-testid="dm-people">
              {shown.map((p) => (
                <li key={p.person.id}>
                  <button type="button" className="chan-pick" onClick={() => onPick(p)} data-testid="dm-person" data-person={p.person.id} data-direct={p.direct}>
                    <span className="chan-name">
                      {p.person.name}
                      {p.person.address && <span className="sub chan-addr"> {p.person.address}</span>}
                    </span>
                    <span className="pill">{tag(p.person, company)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form
          className="chan-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            onSend()
          }}
        >
          <p className="sub" data-testid="dm-to">
            To {to.name} <span className="pill">{tag(to, company)}</span>
          </p>
          <textarea
            className="chan-text"
            rows={3}
            value={compose.text}
            maxLength={CHAT_MAX}
            placeholder={`Message ${to.name.split(/\s+/)[0]}`}
            aria-label={`Message ${to.name}`}
            readOnly={locked}
            autoFocus
            onChange={(e) => onText(e.target.value)}
            onKeyDown={onKey}
            data-testid="dm-text"
          />
          {compose.notice && (
            <p className={`cnotice ${compose.notice.tone}`} role={compose.notice.tone === 'error' ? 'alert' : 'status'} data-testid="dm-notice" data-tone={compose.notice.tone}>
              <Glyph name={compose.notice.tone === 'ok' ? 'chat' : 'warn'} size={13} />
              <span>{compose.notice.text}</span>
            </p>
          )}
          <div className="chan-bar">
            {compose.phase !== 'unknown' && (
              <button type="submit" className="btn primary" disabled={!canSend(compose)} data-testid="dm-send">
                {compose.phase === 'sending' ? 'Sending' : 'Send'}
              </button>
            )}
            <button type="button" className="btn" onClick={onClose} data-testid="dm-cancel">
              {compose.phase === 'unknown' ? 'Close' : 'Cancel'}
            </button>
          </div>
        </form>
      )}
      {to === null && (
        <div className="chan-bar">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </section>
  )
}

/** The panel above Meet's list: meet's people, a first message to one of them, and the conversation opened once it has gone. */
export function NewMessagePanel({ go, onChanged, onClose }: { go: Go; onChanged(): void; onClose(): void }) {
  const { state, reload, problem } = useView<MeetReachable[]>('meet/people')
  const [q, setQ] = useState('')
  const [to, setTo] = useState<MeetReachable['person'] | null>(null)
  const [compose, setCompose] = useState<Compose>(() => newCompose(mintKey))

  const open = (p: MeetReachable['person']) => {
    onChanged()
    onClose()
    go(conversationWith(p))
  }
  const pick = (p: MeetReachable) => {
    // A direct message with something in it is opened as it is; the first message to anyone else is written here.
    if (p.direct) return open(p.person)
    setTo(p.person)
  }
  async function send() {
    if (to === null || !canSend(compose)) return
    const begun = begin(compose)
    setCompose(begun)
    const req = requestFor({ via: 'chat', personId: to.id }, begun.key, begun.text)
    const outcome = outcomeFromResponse(await write(req.url, req.body))
    const after = settle(begun, outcome, 'chat')
    setCompose(after)
    if (describe(outcome, 'chat').then === 'next') open(to)
  }
  return (
    <>
      <Viewed view={state} problem={problem} reload={reload} loading="Reading the people you can write to">
        {(people) => (
          <NewMessageView
            people={people}
            q={q}
            onQ={setQ}
            to={to}
            onPick={pick}
            compose={compose}
            onText={(text) => setCompose((c) => typed(c, text))}
            onSend={() => void send()}
            onClose={onClose}
          />
        )}
      </Viewed>
    </>
  )
}
