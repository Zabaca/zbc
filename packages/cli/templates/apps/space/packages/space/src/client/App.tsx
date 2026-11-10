// The space's page: a shell with the seven tabs and, under each, what it holds. People is the directory with a profile for each person (People.tsx). Knowledge is the organisation's one knowledge base, with a row of businesses to read it by (KnowledgeTab.tsx). Today is what needs the person from the three apps (Today.tsx). Inbox and Meet (two tabs, not one) are the lists of email conversations and of channels, direct messages, calls and the Phone (Conversations.tsx draws both). Forms (drawn here as part of the page, and loaded when the tab is first opened: ADR 0007) is forms' admin screens (forms/FormsTab.tsx). The look is
// the tabs down the side on a computer and, on a phone, a strip across the top with
// the icon above the label.
import { Fragment, lazy, type MouseEvent, type ReactNode, Suspense, useCallback, useEffect, useState } from 'react'
import type { TabId } from '@space/workspace'
import type { Me } from '../me'
import { takeRecovery } from '../recover'
import { Boundary } from './Boundary'
import { CalendarTab } from './Calendar'
import { Conversations } from './Conversations'
import { KnowledgeTab } from './KnowledgeTab'
import { People } from './People'
import { Today } from './Today'
import { Settings } from './Settings'
import { FormsTree } from './forms/FormsTree'
import { safeStorage } from './forms/session'
import { Glyph, TabIcon } from './icons'
import { LiveProvider } from './liveHub'
import { CalendarContext, MeetRailTree, NavContext, RailTree, SettingsFoot, useCalendarData, useNavData } from './nav'
import { InstallContext, installWordsOf } from './install'
import { OwnerContext } from './owner'
import { SwitchesContext } from './switches'
import { PhoneBars, PhoneHost } from './phone/PhoneHost'
import { meetViewOf, viewAt } from './format'
import { onSettings, PHONE_PATH, tabAt } from './route'
import { refreshLists, useNotificationBridge } from './notify'
import { titleWith, useChatUnread } from './unread'

type Go = (path: string) => void

const SETTINGS_PATH = '/settings'

// Forms' screens, with everything they need (forms' rules, pdf.js, the builder, Tailwind's utilities), are loaded when the tab is first opened, so the other tabs'
// page, on a phone too, is not made larger by them. The rail's tree of sections is outside it (forms/FormsTree.tsx).
const FormsTab = lazy(() => import('./forms/FormsTab').then((m) => ({ default: m.FormsTab })))

function FormsScreen(p: { pathname: string; search: string; go: Go }) {
  return (
    <Boundary what="Forms">
      <Suspense fallback={<div className="boot sub">Opening Forms</div>}>
        <FormsTab pathname={p.pathname} search={p.search} go={p.go} />
      </Suspense>
    </Boundary>
  )
}

function InboxScreen({ me, pathname, search, go }: { me: Me; pathname: string; search: string; go: Go }) {
  return <Conversations scope="mail" me={me} pathname={pathname} search={search} go={go} />
}

function MeetScreen({ me, pathname, search, go }: { me: Me; pathname: string; search: string; go: Go }) {
  return <Conversations scope="chat" me={me} pathname={pathname} search={search} go={go} />
}

function CalendarScreen({ me, pathname, search, go }: { me: Me; pathname: string; search: string; go: Go }) {
  return <CalendarTab me={me} pathname={pathname} search={search} go={go} />
}

function PeopleScreen({ pathname, go }: { me: Me; pathname: string; search: string; go: Go }) {
  return <People pathname={pathname} go={go} />
}

function KnowledgeScreen({ me, search, go }: { me: Me; pathname: string; search: string; go: Go }) {
  return <KnowledgeTab me={me} search={search} go={go} />
}

function NotFound({ me, go }: { me: Me; go: Go }) {
  const home = me.tabs.find((t) => t.id === me.home)
  return (
    <section className="page" aria-labelledby="h-nf">
      <h1 id="h-nf">Not found</h1>
      <p className="sub">There is nothing at this address.</p>
      {home && (
        <p>
          <a className="btn" href={home.path} onClick={(e) => follow(e, home.path, go)}>
            Go to {home.label}
          </a>
        </p>
      )}
    </section>
  )
}

/** A tab or link inside the space moves without reloading, unless the click means "open it somewhere else". */
function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

const SCREENS: Record<TabId, (p: { me: Me; pathname: string; search: string; go: Go }) => ReactNode> = {
  today: Today,
  inbox: InboxScreen,
  meet: MeetScreen,
  calendar: CalendarScreen,
  forms: FormsScreen,
  people: PeopleScreen,
  knowledge: KnowledgeScreen,
}

/** The shell and the screen the path is on. Pure: the page's state (`App`) and the tests both drive it. */
export function Space({ me, pathname, search = '', go }: { me: Me; pathname: string; search?: string; go: Go }) {
  const settings = onSettings(pathname)
  // The inbox's own menu, read once for the whole shell: the tree under Inbox, the sheet on a phone, and the lines under Settings all draw from it.
  const nav = useNavData()
  // The calendar's accounts, read once for the whole shell: the foot of the menu says when a calendar needs a look.
  // Only where the install has a Google account: without one there is no calendar to ask.
  const calendar = useCalendarData(me.switches.gmail)
  const view = viewAt(pathname, search)
  const meetView = meetViewOf(search)
  // Settings is not one of the four tabs: it is the menu behind the gear under them, and no tab is current while it is open.
  const tab = settings ? null : tabAt(pathname, me.tabs, me.home)
  const Screen = tab ? SCREENS[tab] : null
  return (
    <InstallContext.Provider value={installWordsOf(me)}>
    <OwnerContext.Provider value={me.owner}>
    <SwitchesContext.Provider value={me.switches}>
    <NavContext.Provider value={nav}>
    <CalendarContext.Provider value={calendar}>
    <PhoneHost enabled={me.switches.phone}>
    <div className="shell">
      <nav className="rail" aria-label="Space">
        <div className="ws">
          <span className="ws-mark" aria-hidden="true">
            {me.company.name.charAt(0).toUpperCase()}
          </span>
          <b className="ws-name">{me.company.name}</b>
        </div>
        {me.tabs.map((t) => (
          <Fragment key={t.id}>
            <a
              href={t.path}
              className={`rail-item${t.id === tab ? ' on' : ''}`}
              aria-current={t.id === tab ? 'page' : undefined}
              data-tab={t.id}
              onClick={t.ownSignIn ? undefined : (e) => follow(e, t.path, go)}
            >
              <TabIcon tab={t.id} />
              <span className="rail-label">{t.label}</span>
            </a>
            {/* The inbox's views, mailboxes and Clients, as a tree under Inbox while that tab is the page. On a phone the strip has no room: the list's own button opens them. */}
            {t.id === 'inbox' && tab === 'inbox' && (
              <div className="rail-tree">
                <RailTree view={view} onList go={go} />
              </div>
            )}
            {/* Meet's All, Chat, Channels, Calls and Phone, as a tree under Meet while that tab is the page (the Phone only where the person has one). */}
            {t.id === 'meet' && tab === 'meet' && (
              <div className="rail-tree">
                <MeetRailTree view={meetView} onList={pathname !== PHONE_PATH} onPhone={pathname === PHONE_PATH} go={go} />
              </div>
            )}
            {/* Forms' sections, as a tree under the Forms tab while it is the page. */}
            {t.id === 'forms' && tab === 'forms' && (
              <div className="rail-tree">
                <FormsTree pathname={pathname} search={search} go={go} />
              </div>
            )}
          </Fragment>
        ))}
        <span className="grow" />
        {/* Settings at the foot, with the lines the inbox says there (Gmail's last push, each mailbox's last mail). A phone shows the gear alone, in the strip. */}
        <div className="rail-foot">
          <SettingsFoot nav={nav} now={Date.now()} active={settings} go={go} />
        </div>
        <a
          href={SETTINGS_PATH}
          className={`rail-item gear${settings ? ' on' : ''}`}
          aria-label="Settings"
          aria-current={settings ? 'page' : undefined}
          data-testid="settings-gear"
          onClick={(e) => follow(e, SETTINGS_PATH, go)}
        >
          <Glyph name="gear" size={18} />
          <span className="rail-label">Settings</span>
        </a>
        <div className="me" data-testid="me">
          <span className="avatar" aria-hidden="true">
            {me.name.charAt(0).toUpperCase()}
          </span>
          <span className="sub">{me.name}</span>
        </div>
      </nav>
      <main className="main">
        {/* A call to the install's number ringing, or a phone call on: wherever the person is in the space (nothing at all where they have no phone). */}
        {me.switches.phone && <PhoneBars openPhone={() => go(PHONE_PATH)} />}
        {settings ? <Settings me={me} pathname={pathname} go={go} /> : Screen ? <Screen me={me} pathname={pathname} search={search} go={go} /> : <NotFound me={me} go={go} />}
      </main>
    </div>
    </PhoneHost>
    </CalendarContext.Provider>
    </NavContext.Provider>
    </SwitchesContext.Provider>
    </OwnerContext.Provider>
    </InstallContext.Provider>
  )
}

/** The page's state: asks who is signed in and which tabs there are, then keeps the address and the tab in step. */
export function Shell() {
  const [me, setMe] = useState<Me | null>(null)
  const [failed, setFailed] = useState(false)
  // Where the page is: the path and its query, because the list's view is in the address (`/inbox?view=bulk`).
  const [where, setWhere] = useState(() => window.location.pathname + window.location.search)
  const [pathname, search] = [where.split('?')[0] as string, where.includes('?') ? `?${where.split('?').slice(1).join('?')}` : '']

  // Sent through /today by a first visit to /forms (recover.ts), and signed in there: back to where the person was.
  useEffect(() => {
    const storage = safeStorage()
    const back = storage ? takeRecovery(storage, Date.now()) : null
    if (back && !window.location.pathname.startsWith('/forms')) window.location.replace(back)
  }, [])

  useEffect(() => {
    let live = true
    fetch('/api/me', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : Promise.reject(new Error(String(r.status)))))
      .then((m) => live && setMe(m))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const onPop = () => setWhere(window.location.pathname + window.location.search)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go: Go = useCallback((path) => {
    window.history.pushState(null, '', path)
    setWhere(path)
    window.scrollTo(0, 0)
  }, [])

  // The service worker's questions and orders (notify.ts): which conversation is open, open this path (a tap on a notification), read the lists again.
  useNotificationBridge(go, refreshLists)

  // The unread chat messages go in front of the title, wherever in the space the person is (unread.ts).
  const chatUnread = useChatUnread()
  useEffect(() => {
    if (!me) return
    const tab = me.tabs.find((t) => t.id === tabAt(pathname, me.tabs, me.home))
    document.title = titleWith(`${onSettings(pathname) ? 'Settings' : tab ? tab.label : 'Not found'} | ${me.company.name}`, chatUnread)
  }, [me, pathname, chatUnread])

  if (failed) {
    return (
      <div className="boot" role="alert">
        <p>The space could not be opened. Your sign-in may have ended.</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
  if (!me) return <div className="boot sub">Opening the space</div>
  return <Space me={me} pathname={pathname} search={search} go={go} />
}

/** The page, with the tab's ONE live connection above everything it draws (liveHub.tsx): the shell and the chat unread count in the title both hear it. */
export function App() {
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  )
}
