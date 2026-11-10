// A draft that sits on no conversation, opened at its own address (`/inbox/draft/<id>`): a first email Claude drafted to a new address, a first LinkedIn message to a new contact.
// The inbox page's "looseDrafts" were the only place these could be worked; this is theirs in the space, with the card a draft has in a conversation and every action on it: Edit, Send as it
// stands (an email), Copy address and Copy words and Mark sent (a text or a LinkedIn message).
//
// THE ADDRESS KEEPS WORKING. A link made while the message was a draft is asked of the inbox (`/api/draft`, the inbox's `draftAt`): still a draft on no conversation, it is this card; on a
// conversation, or sent or marked sent since, it is that person's conversation, and the page moves there (replacing this address, so Back does not come back to a redirect).
//
// `DraftPaneView` draws the state and is pure; `DraftPane` reads, sends and keeps the key. The send is the conversation's own (compose.ts): a key made once for the draft, the revision shown,
// and no position (a draft on no conversation has no thread to have read to).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LooseDraft } from '../drafts'
import { type Fetched, read, write } from './api'
import { type Compose, begin, mintKey, newCompose, outcomeFromResponse, requestFor, settle } from './compose'
import { DraftCard, Mark } from './Conversation'
import { Glyph } from './icons'
import { draftListPath, follow, inboxPath } from './route'

/** What `/api/draft` answers. */
type Opened = { state: 'draft'; draft: LooseDraft } | { state: 'conversation'; key: string }

type State =
  | { kind: 'loading' }
  | { kind: 'draft'; draft: LooseDraft }
  /** The draft is no longer waiting on this address: sent, marked sent or deleted since it was shown. `contactId` is who it was to, when it was shown. */
  | { kind: 'done'; contactId: string; toName: string; notice: { tone: 'ok' | 'warn'; text: string } | null }
  | { kind: 'failed'; message: string; signin: boolean }

export interface PaneViewProps {
  state: State
  compose: Compose | undefined
  onSend(draft: LooseDraft): void
  onDismiss(): void
  onChanged(): void
  go(path: string): void
}

export function DraftPaneView(p: PaneViewProps) {
  const { state } = p
  const back = (
    <a className="back" href={draftListPath()} onClick={(e) => follow(e, draftListPath(), p.go)} data-testid="back">
      <Glyph name="back" size={14} />
      Drafts
    </a>
  )
  if (state.kind === 'loading') {
    return (
      <div className="detail-note" role="status" data-testid="draft-loading">
        <p className="sub">Opening the draft</p>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className="detail-note" role="alert" data-testid="draft-failed">
        <p>{state.message}</p>
        {state.signin ? (
          <p>
            <button type="button" className="linkish" onClick={() => window.location.reload()}>
              Reload the page
            </button>{' '}
            to sign in again.
          </p>
        ) : (
          <p>
            <a href={draftListPath()} onClick={(e) => follow(e, draftListPath(), p.go)}>
              Back to Drafts
            </a>
          </p>
        )}
      </div>
    )
  }
  if (state.kind === 'done') {
    return (
      <div className="e-detail" data-testid="draft-pane" data-state="done">
        <div className="e-convo">
          {back}
          <div className="timeline">
            {state.notice && (
              <p className={`cnotice ${state.notice.tone}`} role="status" data-testid="draft-sent-notice" data-tone={state.notice.tone}>
                <Glyph name={state.notice.tone === 'ok' ? 'mail' : 'warn'} size={13} />
                <span>{state.notice.text}</span>
              </p>
            )}
            <p data-testid="draft-done">
              {state.notice === null && `This draft to ${state.toName} is no longer waiting: it was sent, marked sent or deleted. `}
              <a href={inboxPath(`mail:${state.contactId}`)} onClick={(e) => follow(e, inboxPath(`mail:${state.contactId}`), p.go)} data-testid="open-conversation">
                Open their conversation
              </a>
            </p>
          </div>
        </div>
      </div>
    )
  }
  const { draft } = state
  return (
    <div className="e-detail" data-testid="draft-pane" data-state="draft" data-draft-id={draft.id}>
      <div className="e-convo">
        {back}
        <div className="d-head e-head">
          <Mark name={draft.toName} kind="outside" />
          <div className="grow">
            <h2 data-testid="draft-title">Draft to {draft.toName}</h2>
            <div className="sub">Not on a conversation yet. It is one when it is sent.</div>
          </div>
        </div>
        <div className="timeline">
          <DraftCard draft={draft} state={p.compose} onSend={() => p.onSend(draft)} onDismiss={p.onDismiss} onChanged={p.onChanged} />
        </div>
      </div>
    </div>
  )
}

const failure = (r: Extract<Fetched<unknown>, { ok: false }>): State => {
  if (r.problem === 'signin') return { kind: 'failed', message: 'Your sign-in may have ended.', signin: true }
  return { kind: 'failed', message: r.message ?? 'The space could not be reached just now.', signin: false }
}

export interface PaneProps {
  draftId: string
  /** Counts up whenever the lists are read again: the draft is read again with them. */
  refreshes: number
  /** The list should be read again: the draft was sent, edited, marked sent. */
  onChanged(): void
  go(path: string): void
  /** Move to another address without leaving this one in the history. */
  replace(path: string): void
}

export function DraftPane({ draftId, refreshes, onChanged, go, replace }: PaneProps) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [compose, setCompose] = useState<Compose | undefined>(undefined)
  const shown = useRef<LooseDraft | null>(null)
  const busy = useRef(false)
  const started = useRef(0)
  const landed = useRef(0)

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++started.current
      const r = await read<Opened>(`/api/draft?id=${encodeURIComponent(draftId)}`)
      if (mine < landed.current) return
      landed.current = mine
      if (!r.ok) {
        const had = shown.current
        // Gone since it was shown: sent, marked sent, or deleted. The way on is its person's conversation.
        if (r.status === 404 && had) {
          setState((s) => (s.kind === 'done' ? s : { kind: 'done', contactId: had.contactId, toName: had.toName, notice: null }))
          return
        }
        if (!quiet || r.problem === 'signin') setState(failure(r))
        return
      }
      if (r.value.state === 'conversation') {
        replace(inboxPath(r.value.key))
        return
      }
      shown.current = r.value.draft
      setState({ kind: 'draft', draft: r.value.draft })
    },
    [draftId, replace],
  )

  useEffect(() => {
    shown.current = null
    setCompose(undefined)
    setState({ kind: 'loading' })
    void load(false)
  }, [load])
  // The lists were read again (a minute passed, the page was shown again): so is the draft, unless a send is waiting on its answer.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!busy.current) void load(true)
  }, [refreshes, load])

  const send = async (d: LooseDraft) => {
    if (busy.current) return
    const held = compose ?? { ...newCompose(mintKey), text: d.text }
    if (held.phase !== 'writing') return
    busy.current = true
    const begun = begin(held)
    setCompose(begun)
    const req = requestFor({ via: 'draft', draftId: d.id, rev: d.rev, through: null }, begun.key, '')
    const outcome = outcomeFromResponse(await write(req.url, req.body))
    const after = settle(begun, outcome, 'email')
    busy.current = false
    if (outcome.result === 'done' || outcome.result === 'repeated') {
      // It went (or was sent before): this is no longer a draft, and the words say so and where to read it. The key is finished with; the person can open the conversation it made.
      const tone = after.notice?.tone === 'ok' ? 'ok' : 'warn'
      setCompose(undefined)
      setState({ kind: 'done', contactId: d.contactId, toName: d.toName, notice: { tone, text: after.notice?.text ?? 'Sent.' } })
      onChanged()
      return
    }
    setCompose(after)
    // A refusal (the draft changed, a new revision is on screen) shows the draft as it is now; an unknown outcome is left alone and offers no second try.
    if (outcome.result !== 'outcome-unknown') void load(true)
  }

  return (
    <DraftPaneView
      state={state}
      compose={compose}
      onSend={(d) => void send(d)}
      onDismiss={() => setCompose(undefined)}
      onChanged={() => {
        void load(true)
        onChanged()
      }}
      go={go}
    />
  )
}
