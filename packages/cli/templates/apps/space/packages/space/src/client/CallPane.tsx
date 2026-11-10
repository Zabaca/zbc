// A call's own screen: a call with no conversation (a New call has a row of its own), or any call opened from the Calls list or a card. The call as a card (its link, who is in
// it), and its saved chat, which is read here and never written to: the chat of a call is what the people in it said, kept after the call until the owner deletes it, and
// only once nobody is in the call (meet decides).
import type { MeetCallChat } from '@space/workspace'
import { useEffect, useRef, useState } from 'react'
import type { Me } from '../me'
import { CallCard } from './CallCard'
import { stamp } from './convo'
import { Glyph } from './icons'
import { MEET } from './route'
import { Say, Viewed } from './settings-parts'
import { postView, useView } from './views'

/** How often a call that has people in it is read again, so the card follows it. */
const LIVE_MS = 8_000

export function CallPaneView({ chat, now, me, onDelete, deleting, deleted }: { chat: MeetCallChat; now: number; me: Me; onDelete(): void; deleting: boolean; deleted: string | null }) {
  const { call, messages } = chat
  const [asking, setAsking] = useState(false)
  return (
    <div className="call-pane" data-testid="call-pane" data-call={call.name}>
      <div className="d-head">
        <span className="avatar-lg call" aria-hidden="true">
          <Glyph name="video" size={14} />
        </span>
        <div className="grow">
          <h2 data-testid="call-pane-title">{call.title ?? (call.kind === 'huddle' ? 'Huddle' : 'Call')}</h2>
          <div className="sub">{call.kind === 'new' || call.kind === 'link' ? 'A call with no conversation' : call.kind === 'meeting' ? 'A meeting with a time' : 'A huddle in a conversation'}</div>
        </div>
      </div>
      <CallCard call={call} now={now} zone={me.company.timeZone} name={me.name} />
      <section className="call-chat" aria-labelledby="call-chat-h" data-testid="call-chat">
        <h3 id="call-chat-h">Chat in the call</h3>
        {messages.length === 0 ? (
          <p className="sub" data-testid="call-chat-empty">
            {deleted ?? 'Nobody wrote in the call. Messages in a call’s chat are saved after the call, until they are deleted.'}
          </p>
        ) : (
          <>
            <p className="sub">Saved after the call, to read. Nobody can write in it from here.</p>
            <ol>
              {messages.map((m) => (
                <li key={m.id} data-testid="call-chat-message">
                  <span className="sub">
                    <b>{m.name}</b> {stamp(now, m.at)}
                  </span>
                  <p>{m.text}</p>
                </li>
              ))}
            </ol>
            {!asking ? (
              <p>
                <button type="button" className="btn" onClick={() => setAsking(true)} disabled={call.present > 0} title={call.present > 0 ? 'Someone is in the call right now.' : 'Delete these messages for good'} data-testid="call-chat-delete">
                  Delete the chat
                </button>
              </p>
            ) : (
              <div className="call-danger" role="alertdialog" aria-label="Delete the chat" data-testid="call-chat-confirm">
                <span>Delete these {messages.length} messages for good? Nothing can bring them back.</span>
                <button type="button" className="btn" onClick={onDelete} disabled={deleting} data-testid="call-chat-delete-yes">
                  {deleting ? 'Deleting' : 'Delete them'}
                </button>
                <button type="button" className="btn" onClick={() => setAsking(false)}>
                  Keep them
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

export function CallPane({ me, name, refreshes, onChanged, go }: { me: Me; name: string; refreshes: number; onChanged(): void; go(path: string): void }) {
  const { state, reload, problem } = useView<MeetCallChat>('meet/call', { name })
  const [now, setNow] = useState(() => Date.now())
  const [deleting, setDeleting] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<string | null>(null)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    reload()
  }, [refreshes, reload])
  const live = state.kind === 'value' && state.value.call.present > 0
  useEffect(() => {
    setNow(Date.now())
    if (!live) return
    // The clock redraws; who is in the call is read when the call's object tells the live connection it changed (Conversations.tsx hands the pane a new `refreshes`).
    const timer = setInterval(() => setNow(Date.now()), LIVE_MS)
    return () => clearInterval(timer)
  }, [live])

  const remove = async () => {
    setDeleting(true)
    setSay(null)
    const got = await postView<{ deleted: number }>('meet/delete-chat', { name })
    setDeleting(false)
    if (!got.ok) return setSay(got.say.text)
    setDeleted('The chat was deleted.')
    reload()
    onChanged()
  }

  return (
    <div className="detail-call" data-testid="call-detail">
      <a
        className="back"
        href={MEET}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          go(MEET)
        }}
        data-testid="back"
      >
        <Glyph name="back" size={14} />
        Meet
      </a>
      <Viewed view={state} problem={problem} reload={reload} loading="Opening the call">
        {(chat) => <CallPaneView chat={chat} now={now} me={me} onDelete={() => void remove()} deleting={deleting} deleted={deleted} />}
      </Viewed>
      {say && <Say say={{ tone: 'bad', text: say, again: false }} />}
    </div>
  )
}
