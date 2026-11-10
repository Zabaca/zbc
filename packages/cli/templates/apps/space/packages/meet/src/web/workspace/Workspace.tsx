// The guests' workspace page, /w (their own sign-in). The company's people do not come here: they work in the space, and meet has
// no page of its own for them. A sidebar of the channels a guest was invited to
// and their direct messages, the open conversation, a box to write in. On a phone the sidebar and the conversation are separate screens.
//
// The page asks for everything once (a Bootstrap), then hears changes over one WebSocket and applies them
// (store.ts). A dropped socket reconnects by itself and asks for what it missed (connection.ts), so what is on the
// screen is current whenever it says "Connected" and the page says plainly when it is not.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Change, ConversationView, ServerFrame, SiteView } from '../../workspace-model'
import { ApiError } from '../api'
import { Icon, Wordmark } from '../ui'
import { SignedInSite, useSite } from '../site'
import { WorkspaceApi } from './api'
import { Connection, type ConnectionStatus } from './connection'
import { ConversationPane } from './ConversationPane'
import GuestSignIn from './GuestSignIn'
import { NewDm, Privacy, Settings } from './Panels'
import {
  type WState,
  applyChanges,
  conversationName,
  empty,
  fromBootstrap,
  newestId,
  sidebar,
  tabTitle,
  withHistory,
  withOwnMessage,
  withRead,
} from './store'

type Phase = 'loading' | 'ready' | 'signin' | 'removed' | 'forbidden' | 'error'

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

/** The guests' workspace. Once it is signed in, every screen in it words whose workspace it is from its own bootstrap (`SignedInSite`), not from the public site answer. */
export default function Workspace() {
  const [signedIn, setSignedIn] = useState<SiteView | null>(null)
  return (
    <SignedInSite site={signedIn}>
      <Screens onSite={setSignedIn} />
    </SignedInSite>
  )
}

function Screens({ onSite }: { onSite: (site: SiteView) => void }) {
  const api = useMemo(() => new WorkspaceApi(), [])
  const [s, setS] = useState<WState>(empty)
  const sRef = useRef(s)
  /** Change the state and keep the ref in step, so a socket callback never reads a stale one. */
  const update = useCallback((fn: (s: WState) => WState) => {
    sRef.current = fn(sRef.current)
    setS(sRef.current)
  }, [])
  const [phase, setPhase] = useState<Phase>('loading')
  const site = useSite()
  const [owner, setOwner] = useState<SiteView['owner'] | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [active, setActive] = useState<number | null>(null)
  const [screen, setScreen] = useState<'list' | 'main'>('list')
  const [dialog, setDialog] = useState<null | 'dm' | 'settings' | 'privacy'>(null)
  const [openedAt, setOpenedAt] = useState({ read: 0, last: 0 })
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const [problem, setProblem] = useState<string | null>(null)
  const conn = useRef<Connection | null>(null)
  const loadingHistory = useRef(new Set<number>())

  // --- Loading ---------------------------------------------------------------

  const load = useCallback(
    async (reset = false) => {
      try {
        const b = await api.bootstrap()
        update((prev) => fromBootstrap(b, prev, reset))
        setOwner(b.site.owner)
        onSite(b.site)
        setPhase('ready')
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0
        // A guest whose session ended is shown the sign-in.
        if (status === 401) return setPhase('signin')
        if (status === 403) return setPhase('forbidden')
        setPhase((p) => (p === 'ready' ? p : 'error'))
        setProblem(errorText(e, 'Could not load the workspace.'))
      }
    },
    [api, update, onSite],
  )
  useEffect(() => void load(), [load])

  // The socket opens once the page has its picture, and catches up from the newest change it holds.
  useEffect(() => {
    if (phase !== 'ready') return
    const c = new Connection({
      ticket: () => api.ticket(),
      since: () => sRef.current.seq,
      status: setStatus,
      signedOut: () => setPhase('signin'),
      removed: () => setPhase('removed'),
      frame: (f: ServerFrame) => {
        if (f.t === 'catchup') update((st) => applyChanges(st, f.changes))
        else if (f.t === 'change') update((st) => applyChanges(st, [f.change as Change]))
        else if (f.t === 'reload') void load(true)
      },
    })
    conn.current = c
    c.start()
    return () => {
      c.stop()
      conn.current = null
    }
  }, [phase === 'ready', api, load, update])

  // A structure change (a conversation made, someone added or taken out) is answered by asking again.
  useEffect(() => {
    if (!s.refresh) return
    update((st) => ({ ...st, refresh: false }))
    void load()
  }, [s.refresh, load, update])

  // The history of the open conversation, once.
  const open = active !== null ? s.convs[active] : undefined
  useEffect(() => {
    if (active === null || !open || s.loaded[active] || loadingHistory.current.has(active)) return
    loadingHistory.current.add(active)
    api
      .history(active)
      .then((page) => update((st) => withHistory(st, active, page)))
      .catch((e) => setProblem(errorText(e, 'Could not load the messages.')))
      .finally(() => loadingHistory.current.delete(active))
  }, [active, open !== undefined, s.loaded[active ?? -1], api, update])

  // A conversation that went away (archived, left, removed) is closed.
  useEffect(() => {
    if (active !== null && phase === 'ready' && !s.convs[active]) {
      setActive(null)
      setScreen('list')
    }
  }, [active, s.convs, phase])

  // On a wide screen the first conversation opens by itself.
  useEffect(() => {
    if (phase !== 'ready' || active !== null || !window.matchMedia('(min-width: 720px)').matches) return
    const { channels, dms } = sidebar(s)
    const first = [...dms, ...channels].find((c) => c.unread > 0) ?? channels[0] ?? dms[0]
    if (first) openConv(first.id)
  }, [phase, active, s.convs])

  // --- What the person is looking at -------------------------------------------

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  useEffect(() => {
    document.title = tabTitle(s)
  }, [s])

  // Reading what is on screen marks it read, here and (through the workspace) on the person's other devices.
  const newest = active !== null ? newestId(s.messages[active]) : 0
  useEffect(() => {
    if (active === null || !visible || !open || !s.loaded[active]) return
    if (screenIsHidden(screen) || newest <= open.lastRead) return
    update((st) => withRead(st, active, newest))
    if (!conn.current?.send({ t: 'read', conv: active, upTo: newest })) void api.read(active, newest).catch(() => null)
  }, [active, visible, newest, open?.lastRead, s.loaded[active ?? -1], screen])

  function openConv(id: number) {
    const known = sRef.current.convs[id]
    setOpenedAt({ read: known?.lastRead ?? 0, last: known?.last?.id ?? 0 })
    setActive(id)
    setScreen('main')
    setDialog(null)
  }

  // --- Doing things ------------------------------------------------------------

  async function send(text: string): Promise<string | null> {
    if (active === null) return 'Open a conversation first.'
    try {
      const { message } = await api.send(active, text)
      update((st) => withOwnMessage(st, message))
      return null
    } catch (e) {
      return errorText(e, 'The message was not sent.')
    }
  }
  async function edit(id: number, text: string): Promise<string | null> {
    try {
      const { message } = await api.edit(id, text)
      update((st) => applyEdit(st, message.conv, id, message.text, message.editedAt ?? Date.now()))
      return null
    } catch (e) {
      return errorText(e, 'The edit was not saved.')
    }
  }
  async function remove(id: number): Promise<string | null> {
    try {
      await api.remove(id)
      update((st) => applyDelete(st, id))
      return null
    } catch (e) {
      return errorText(e, 'The message was not deleted.')
    }
  }
  async function older() {
    if (active === null) return
    const first = s.messages[active]?.[0]
    if (!first) return
    const page = await api.history(active, first.id).catch((e) => {
      setProblem(errorText(e, 'Could not load older messages.'))
      return null
    })
    if (page) update((st) => withHistory(st, active, page))
  }
  async function openDm(person: string) {
    try {
      const { conversation } = await api.openDm(person)
      update((st) => ({ ...st, convs: { ...st.convs, [conversation.id]: st.convs[conversation.id] ?? conversation } }))
      openConv(conversation.id)
    } catch (e) {
      setProblem(errorText(e, 'Could not open that conversation.'))
    }
  }
  async function guestSignOut() {
    await api.signOut().catch(() => null)
    conn.current?.stop()
    setDialog(null)
    setS(empty())
    sRef.current = empty()
    setActive(null)
    setPhase('signin')
  }

  // --- Drawing it --------------------------------------------------------------

  if (phase === 'loading') return <main className="page page-center"><Wordmark /><p className="lede">Loading</p></main>
  if (phase === 'signin') return <GuestSignIn onSignedIn={() => (setPhase('loading'), void load())} />
  if (phase === 'removed')
    return (
      <main className="page page-center">
        <Wordmark />
        <h1 className="title title-sm">You were removed from this workspace.</h1>
        <p className="lede">If that is a surprise, ask the person who invited you.</p>
      </main>
    )
  if (phase === 'forbidden')
    return (
      <main className="page page-center">
        <Wordmark />
        <h1 className="title title-sm">This address is not on the {site.company === '' ? '' : `${site.company} `}list.</h1>
        <p className="lede">Ask {site.owner.name} to add you. If you were invited as a guest, sign in with the address your invitation was sent to.</p>
      </main>
    )
  if (phase === 'error')
    return (
      <main className="page page-center">
        <Wordmark />
        <h1 className="title title-sm">The workspace did not load.</h1>
        <p className="lede">{problem}</p>
        <button type="button" className="btn btn-primary" onClick={() => void load()}>
          Try again
        </button>
      </main>
    )

  const me = s.me
  if (!me) return null
  const { channels, dms } = sidebar(s)
  const messageable = Object.values(s.people).filter((p) => p.id !== me.id && p.status === 'active')

  const item = (c: ConversationView) => {
    const name = conversationName(s, c)
    return (
      <li key={c.id}>
        <button
          type="button"
          className={`ws-item ${active === c.id ? 'ws-item-on' : ''} ${c.unread > 0 ? 'ws-item-unread' : ''}`}
          onClick={() => openConv(c.id)}
          data-testid="conv-item"
          data-conv={c.id}
          data-name={name}
          data-unread={c.unread}
        >
          <Icon name={c.kind === 'dm' ? 'chat' : c.privacy === 'private' ? 'lock' : 'hash'} />
          <span className="ws-item-name">{name}</span>
          {c.unread > 0 && (
            <span className="ws-badge" data-testid="unread-badge" aria-label={`${c.unread} unread`}>
              {c.unread > 99 ? '99+' : c.unread}
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <div className="ws" data-screen={screen} data-testid="workspace" data-door="guest">
      <nav className="ws-side" aria-label="Conversations">
        <header className="ws-side-head">
          <Wordmark />
          <button type="button" className="ws-me" onClick={() => setDialog('settings')} data-testid="me" title="Settings">
            <span className="ws-avatar">{me.name.charAt(0).toUpperCase()}</span>
            <span className="ws-me-name" data-testid="me-name">
              {me.name}
            </span>
          </button>
        </header>
        <div className="ws-side-scroll">
          <section aria-label="Channels">
            <div className="ws-side-title">
              <h2>Channels</h2>
            </div>
            <ul className="ws-list" data-testid="channels">
              {channels.map(item)}
              {channels.length === 0 && <li className="ws-none">You are not in a channel yet.</li>}
            </ul>
          </section>
          <section aria-label="Direct messages">
            <div className="ws-side-title">
              <h2>Direct messages</h2>
              <button type="button" className="ws-icon-btn" onClick={() => setDialog('dm')} aria-label="New message" data-testid="new-dm-btn">
                <Icon name="plus" />
              </button>
            </div>
            <ul className="ws-list" data-testid="dms">
              {dms.map(item)}
              {dms.length === 0 && <li className="ws-none">None yet.</li>}
            </ul>
          </section>
        </div>
        <footer className="ws-side-foot" data-testid="ws-status" data-status={status}>
          <span className={`ws-dot ws-dot-${status}`} aria-hidden="true" />
          <span>{status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Reconnecting'}</span>
        </footer>
      </nav>

      <main className="ws-main">
        {status === 'reconnecting' && (
          <p className="ws-banner" role="status" data-testid="reconnecting">
            Reconnecting. What you see may be out of date until it is back.
          </p>
        )}
        {problem && (
          <p className="notice notice-error ws-problem" role="alert">
            {problem}{' '}
            <button type="button" className="ws-link-btn" onClick={() => setProblem(null)}>
              Dismiss
            </button>
          </p>
        )}
        {open ? (
          <ConversationPane
            s={s}
            conv={open}
            api={api}
            openedAt={openedAt}
            onBack={() => setScreen('list')}
            onSend={send}
            onEdit={edit}
            onDelete={remove}
            onOlder={older}
            onMessage={(p) => void openDm(p)}
            onChanged={() => void load()}
          />
        ) : (
          <div className="ws-empty-main">
            <h2>{channels.length + dms.length === 0 ? 'Nothing here yet' : 'Pick a conversation'}</h2>
            <p className="lede">Choose a channel or a person from the list.</p>
          </div>
        )}
      </main>

      {dialog === 'dm' && <NewDm people={messageable} onPick={(id) => void openDm(id)} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && (
        <Settings
          me={me}
          api={api}
          onSaved={(next) =>
            update((st) => {
              const self = st.people[next.id]
              return { ...st, me: next, people: self ? { ...st.people, [next.id]: { ...self, name: next.name } } : st.people }
            })
          }
          onClose={() => setDialog(null)}
          onPrivacy={() => setDialog('privacy')}
          onSignOut={() => void guestSignOut()}
        />
      )}
      {dialog === 'privacy' && <Privacy onClose={() => setDialog('settings')} owner={owner} />}
      {!me.privacyAcked && me.kind === 'guest' && (
        <Privacy
          onClose={() => undefined}
          owner={owner}
          onAck={() => {
            update((st) => (st.me ? { ...st, me: { ...st.me, privacyAcked: true } } : st))
            void api.ackPrivacy().catch(() => null)
          }}
        />
      )}
    </div>
  )
}

/** A narrow screen showing the list is not showing the conversation, so nothing in it is being read. */
const screenIsHidden = (screen: 'list' | 'main'): boolean => screen === 'list' && window.matchMedia('(max-width: 719px)').matches

function applyEdit(st: WState, conv: number, id: number, text: string, editedAt: number): WState {
  const held = st.messages[conv]
  return held ? { ...st, messages: { ...st.messages, [conv]: held.map((m) => (m.id === id ? { ...m, text, editedAt } : m)) } } : st
}

function applyDelete(st: WState, id: number): WState {
  const messages: WState['messages'] = {}
  for (const [k, list] of Object.entries(st.messages)) messages[Number(k)] = list.filter((m) => m.id !== id)
  return { ...st, messages }
}
