// The inbox's own left menu, in the space: a tree under Inbox in the rail on a computer, and the same items in a sheet opened from a button above the list on a phone
// (the inbox's views, mailboxes and Clients sit as a tree; once under the one Conversations tab, now under Inbox).
// Meet has a menu of its own, the same way (Chat / Channels / Calls and Phone are a Meet top level nav): All, Chat, Channels, Calls and, for a person with a phone, Phone.
//
//   VIEWS      Inbox, Unread, Sent, Drafts, Bulk, Closed, each with its count of rows (and, in the accent, how many of those rows are unread); Sent has no count, as Gmail's has none
//   MAILBOXES  each Gmail account (by the short label its pill wears), then each business mailbox, each mailbox on the mail server and Telegram's, each with its count; a Gmail account that lapsed or was disconnected stays, its mail is still held
//   CLIENTS    each Client with the rows of its open conversations
//   (no People group: it would only link to People, which is a tab of its own)
//   Settings   at the foot, with the lines the inbox says there: Gmail live and its last push, each mailbox's last mail, the Telegram bridge's state
//
// Picking a view or a mailbox or a Client narrows the Inbox's list, which reads it from the address (`?view=`). The counts are of ROWS, the unit the list is drawn in (one per person), so a number is how many rows
// the view shows when it is opened; the inbox counts them (packages/inbox/src/store/row-counts.ts), held to the lists by test/nav-counts.test.ts.
//
// Pure functions (`treeOf`, `statusLines`) make the entries and the words; the components only draw them.
import { createContext, type KeyboardEvent, type MouseEvent, type ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CalendarAccountView, InboxNav } from '@space/workspace'
import type { ListView, MeetView } from './format'
import { Glyph } from './icons'
import { useFresh, useLive } from './liveHub'
import { REFRESH_EVENT, SAFETY_NET_MS } from './notify'
import { usePhoneHandle } from './phone/PhoneHost'
import { useSwitches } from './switches'
import { MEET, PHONE_PATH } from './route'
import { agoText } from './settings-parts'
import { telegramWords } from './telegram'
import { type Loaded, useView } from './views'

/** Said by the components that change what the menu counts (a read, a send), so the menu reads again without waiting for the minute. */
export const CHANGED_EVENT = 'space:changed'
export const announceChange = (): void => {
  window.dispatchEvent(new Event(CHANGED_EVENT))
}

export const NavContext = createContext<Loaded<InboxNav>>({ kind: 'loading' })
export const useNav = (): Loaded<InboxNav> => useContext(NavContext)

/** The menu's data, read when the page opens and kept fresh: when mail moves (the live connection), the page shown again, a change made here, the service worker saying so, and ten minutes as the net. */
export function useNavData(): Loaded<InboxNav> {
  const { state, reload } = useView<InboxNav>('navigation')
  // The menu counts mail (its views, mailboxes and Clients) and the Gmail lines: it is read again when mail moves.
  useLive(['mail', 'clients'], reload)
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') reload()
    }
    const timer = setInterval(again, SAFETY_NET_MS)
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    window.addEventListener(CHANGED_EVENT, again)
    window.addEventListener(REFRESH_EVENT, again)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener(CHANGED_EVENT, again)
      window.removeEventListener(REFRESH_EVENT, again)
    }
  }, [reload])
  return state
}

/** The calendar's accounts, read once for the whole shell: the lines at the menu's foot draw from them. */
export const CalendarContext = createContext<Loaded<CalendarAccountView[]>>({ kind: 'loading' })

/** The calendar's accounts, kept fresh when the calendar moves (and by the ten-minute net). */
export function useCalendarData(enabled = true): Loaded<CalendarAccountView[]> {
  const { state, reload } = useView<CalendarAccountView[]>('calendar/accounts', {}, enabled)
  useFresh(['calendar'], reload)
  return state
}

/**
 * What the foot says of the calendar: a line only for an account whose CALENDAR needs a look. A lapsed account is already said by its Gmail line (the grant is one: the same sentence would be said twice), so it is not
 * said here; an account connected for mail without the calendar permission says to connect the calendar, and a calendar that could not be read says so.
 */
export function calendarLines(accounts: readonly CalendarAccountView[]): StatusLine[] {
  const href = '/settings/calendars'
  return accounts.flatMap((a): StatusLine[] => {
    if (a.state === 'needs-calendar') return [{ key: `calendar:${a.address}`, text: `${a.label} calendar: connect it`, amber: true, title: a.reason ?? `${a.address}: connected for mail without the calendar permission. Connect the calendar in Settings, Calendars.`, href }]
    if (a.state === 'live' && a.reason !== null) return [{ key: `calendar:${a.address}`, text: `${a.label} calendar needs a look`, amber: true, title: a.reason, href }]
    return []
  })
}

// ── The entries ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TreeItem {
  key: string
  label: string
  href: string
  /** Unread, said in the accent before the count; 0 draws nothing. */
  unread: number
  /** The count, or null where the item has none. */
  count: number | null
  active: boolean
  /** A longer name for a title: a Client's name is cut with an ellipsis and never renamed. */
  title?: string
}

export interface StatusLine {
  key: string
  text: string
  amber: boolean
  title: string
  /** Where the line goes when it is pressed; Settings, Mailboxes when absent. */
  href?: string
}

export const LIST = '/inbox'

/** Where a view lives: the list, with the view in the address. The main list has no query. */
export const viewHref = (view: ListView): string => (view === 'all' ? LIST : `${LIST}?view=${encodeURIComponent(view)}`)

const VIEW_LABEL = { all: 'Inbox', unread: 'Unread', sent: 'Sent', drafts: 'Drafts', bulk: 'Bulk', closed: 'Closed' } as const

/**
 * The menu's items in the order it draws them. `current` is the view the list is on and `onList` whether the page is the Inbox's list (an item is the current one only
 * there). Pure, so a table can check the counts and which item is lit.
 */
export function treeOf(nav: InboxNav, current: ListView, onList: boolean): { views: TreeItem[]; mailboxes: TreeItem[]; clients: TreeItem[] } {
  const lit = (view: ListView) => onList && current === view
  const standing = [
    ['all', nav.views.inbox],
    ['unread', nav.views.unread],
    // Sent carries no number: a count of the conversations the owner sent in would not be the rows the list shows (it is cut at the newest screen), and Gmail's has none.
    ['sent', null],
    ['drafts', nav.views.drafts],
    ['bulk', nav.views.bulk],
    ['closed', nav.views.closed],
  ] as const
  return {
    views: standing.map(([view, c]) => ({
      key: view,
      label: VIEW_LABEL[view],
      href: viewHref(view),
      // Unread's own number is its count; the others say how many of theirs are unread.
      unread: view === 'unread' || c === null ? 0 : c.unread,
      count: c === null ? null : c.count,
      active: lit(view),
    })),
    // The owner's Gmail accounts first (a lapsed or disconnected one too: its mail is still held and its list still opens), then the business mailboxes, the ones on the mail server (a business mailbox to a person) and Telegram's:
    // each narrows the list to its rows the same way (a conversation carries the mailbox it is in).
    mailboxes: [...nav.gmailAccounts, ...nav.mailboxes, ...(nav.jmap ?? []), ...(nav.telegram ? [nav.telegram] : [])].map((m) => ({
      key: `mailbox:${m.id}`,
      label: m.name,
      href: viewHref(`mailbox:${m.id}`),
      unread: m.unread,
      count: m.count,
      active: lit(`mailbox:${m.id}`),
      title: m.address,
    })),
    clients: nav.clients.map((c) => ({ key: `client:${c.id}`, label: c.name, href: viewHref(`client:${c.id}`), unread: c.unread, count: c.count, active: lit(`client:${c.id}`), title: c.name })),
  }
}

/** The lines the inbox says at the foot of its menu: each Gmail account, then each business mailbox, then the Telegram bridge (`zone` is for a test; the person's own time zone is the default). Amber when one needs a look, so a list gone quiet is never trusted without it; a lapsed account says so by name. */
export function statusLines(nav: InboxNav, now: number, zone?: string): StatusLine[] {
  const gmail: StatusLine[] =
    nav.gmailAccounts.length === 0
      ? [{ key: 'gmail', text: 'Gmail not connected', amber: true, title: 'Gmail is not connected, so no mail is coming in.' }]
      : nav.gmailAccounts.map((g): StatusLine => {
          const key = `gmail:${g.id}`
          if (!g.connected) return { key, text: `${g.name} Gmail disconnected`, amber: true, title: `${g.address}: connect it to receive mail.` }
          if (g.state === 'lapsed') return { key, text: `${g.name} Gmail: connect it again`, amber: true, title: g.reason ?? `${g.address}: Google no longer accepts the saved sign-in. Connect it again in Settings.` }
          if (g.reason !== null) return { key, text: `${g.name} Gmail needs a look`, amber: true, title: g.reason }
          return {
            key,
            text: g.state === 'filling' ? `${g.name} Gmail reading in mail` : g.state === 'resyncing' ? `${g.name} Gmail catching up` : g.lastPushAt ? `${g.name} Gmail live, last push ${agoText(now, g.lastPushAt)}` : `${g.name} Gmail live, no push yet`,
            amber: false,
            title: `${g.address}. Open Settings for the connection.`,
          }
        })
  return [
    ...gmail,
    ...nav.mailboxes.map(
      (m): StatusLine =>
        m.reason !== null
          ? { key: `status:${m.id}`, text: `${m.name} needs a look`, amber: true, title: m.reason }
          : { key: `status:${m.id}`, text: m.lastArrivalAt ? `${m.name}: last mail ${agoText(now, m.lastArrivalAt)}` : `${m.name}: no mail yet`, amber: false, title: `${m.address}. Open Settings for the mailbox.` },
    ),
    // A mailbox on the mail server says how it stands in a few words (live, reading in, refused, unreachable), and why when it needs a look; the Settings card says the rest.
    ...(nav.jmap ?? []).map((m) => jmapLine(m, now)),
    // The bridge's line says the same sentence as its Settings card (telegram.ts), so signed out and not checked in are read at the foot without opening Settings.
    ...(nav.telegram ? [telegramLine(nav.telegram, now, zone)] : []),
  ]
}

function jmapLine(m: NonNullable<InboxNav['jmap']>[number], now: number): StatusLine {
  const key = `jmap:${m.id}`
  if (m.state === 'refused') return { key, text: `${m.name}: the mail server refused the space`, amber: true, title: m.reason ?? `${m.address}: nothing arrives or goes out until a deploy changes the key.` }
  if (m.state === 'unreachable') return { key, text: `${m.name}: mail server not answering`, amber: true, title: m.reason ?? `${m.address}: the mail server did not answer.` }
  if (m.state === 'undeclared' || m.state === 'no-credential') return { key, text: `${m.name} needs a look`, amber: true, title: m.reason ?? `${m.address}: not synced.` }
  if (m.reason !== null) return { key, text: `${m.name} needs a look`, amber: true, title: m.reason }
  const text =
    m.state === 'filling' ? `${m.name} reading in mail` : m.state === 'resyncing' ? `${m.name} catching up` : m.lastSyncAt ? `${m.name} live, synced ${agoText(now, m.lastSyncAt)}` : `${m.name} live`
  return { key, text, amber: false, title: `${m.address}. Open Settings for the mailbox.` }
}

function telegramLine(t: NonNullable<InboxNav['telegram']>, now: number, zone?: string): StatusLine {
  const words = telegramWords(t, now, zone)
  return { key: `telegram:${t.id}`, text: words.text, amber: words.amber, title: `Telegram user ${t.address}. Open Settings for the bridge.` }
}

/** The name of the current view for the button on a phone, with its count. */
export function currentOf(nav: InboxNav, view: ListView): { label: string; count: number | null } {
  const t = treeOf(nav, view, true)
  const found = [...t.views, ...t.mailboxes, ...t.clients].find((i) => i.active)
  return found ? { label: found.label, count: found.count } : { label: 'Inbox', count: nav.views.inbox.count }
}

// ── The tree ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Go = (path: string) => void

function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go, then?: () => void): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
  then?.()
}

function Counts({ item }: { item: TreeItem }) {
  return (
    <>
      {item.unread > 0 && (
        <span className="t-unread">
          {item.unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
      {item.count !== null && <span className="t-count">{item.count}</span>}
    </>
  )
}

function Item({ item, go, then, child }: { item: TreeItem; go: Go; then?: () => void; child?: boolean }) {
  return (
    <a href={item.href} className={`t-item${item.active ? ' on' : ''}${child ? ' child' : ''}`} aria-current={item.active ? 'page' : undefined} data-testid="tree-item" data-key={item.key} title={item.title ?? item.label} onClick={(e) => follow(e, item.href, go, then)}>
      <span className="t-label">{item.label}</span>
      <Counts item={item} />
    </a>
  )
}

/** The items of the menu, without the foot. Drawn in the rail on a computer and in the sheet on a phone. */
export function TreeBody({ nav, view, onList, go, then }: { nav: InboxNav; view: ListView; onList: boolean; go: Go; then?: () => void }) {
  const { views, mailboxes, clients } = treeOf(nav, view, onList)
  return (
    <div className="tree" data-testid="tree">
      {views.map((i) => (
        <Item key={i.key} item={i} go={go} {...(then && { then })} />
      ))}
      {mailboxes.length > 0 && <div className="t-group">Mailboxes</div>}
      {mailboxes.map((m) => (
        <Item key={m.key} item={m} go={go} {...(then && { then })} />
      ))}
      {clients.length > 0 && <div className="t-group">Clients</div>}
      {clients.map((i) => (
        <Item key={i.key} item={i} go={go} {...(then && { then })} />
      ))}
    </div>
  )
}

/** Settings, and under it the lines the inbox says there. Drawn at the foot of the rail and of the sheet. */
export function SettingsFoot({ nav, now, active, go, then }: { nav: Loaded<InboxNav>; now: number; active: boolean; go: Go; then?: () => void }) {
  const calendar = useContext(CalendarContext)
  const lines = [...(nav.kind === 'value' ? statusLines(nav.value, now) : []), ...(calendar.kind === 'value' ? calendarLines(calendar.value) : [])]
  return (
    <div className="t-foot" data-testid="settings-foot">
      <a href="/settings" className={`t-item gear${active ? ' on' : ''}`} aria-current={active ? 'page' : undefined} data-testid="settings-link" onClick={(e) => follow(e, '/settings', go, then)}>
        <Glyph name="gear" size={14} />
        <span className="t-label">Settings</span>
      </a>
      {lines.map((l) => (
        <a key={l.key} href={l.href ?? '/settings/mailboxes'} className="t-status" title={l.title} onClick={(e) => follow(e, l.href ?? '/settings/mailboxes', go, then)} data-testid="status-line" data-amber={l.amber}>
          <span className={`t-dot${l.amber ? ' amber' : ''}`} aria-hidden="true" />
          {l.text}
        </a>
      ))}
    </div>
  )
}

/** The tree in the rail, under the Inbox tab, while that tab is the page. While the menu is being read the tab has nothing under it; if it could not be read, a line says so. */
export function RailTree({ view, onList, go }: { view: ListView; onList: boolean; go: Go }) {
  const nav = useNav()
  if (nav.kind === 'value') return <TreeBody nav={nav.value} view={view} onList={onList} go={go} />
  if (nav.kind === 'said') {
    return (
      <p className="t-note sub" role="status" data-testid="tree-down">
        The inbox’s views could not be read just now.
      </p>
    )
  }
  return (
    <p className="t-note sub" role="status" data-testid="tree-loading">
      Loading the views
    </p>
  )
}

// ── Meet's menu ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const MEET_LABEL = { all: 'All', chat: 'Chat', channels: 'Channels', calls: 'Calls' } as const

/** Where a Meet view lives: the list, with the view in the address. The main list has no query. */
export const meetViewHref = (view: MeetView): string => (view === 'all' ? MEET : `${MEET}?view=${view}`)

/**
 * Meet's items in the order it draws them: everything, the direct messages, the channels, the past calls, and the Phone for a person who has one. `onList` is whether the page is
 * Meet's list and `onPhone` whether it is the Phone's conversation (an item is the current one only there). Meet counts messages and not conversations, so no item carries a count.
 */
export function meetTreeOf(current: MeetView, onList: boolean, phone: boolean, onPhone: boolean, calls = true): TreeItem[] {
  const views = (calls ? (['all', 'chat', 'channels', 'calls'] as const) : (['all', 'chat', 'channels'] as const)).map((v): TreeItem => ({ key: v, label: MEET_LABEL[v], href: meetViewHref(v), unread: 0, count: null, active: onList && current === v }))
  return phone ? [...views, { key: 'phone', label: 'Phone', href: PHONE_PATH, unread: 0, count: null, active: onPhone }] : views
}

// Whether Meet's list has a Phone row for this person: meet gives the Phone conversation to the people on the phone list, so the row is what says there is one to open. The tree is
// drawn in the rail, apart from the list, so the list says it here (Conversations.tsx) and the tree listens.
let phoneRow = false
const phoneRowListeners = new Set<() => void>()
export function setPhoneRow(present: boolean): void {
  if (phoneRow === present) return
  phoneRow = present
  for (const l of phoneRowListeners) l()
}
const usePhoneRow = (): boolean =>
  useSyncExternalStore(
    (l) => {
      phoneRowListeners.add(l)
      return () => void phoneRowListeners.delete(l)
    },
    () => phoneRow,
    () => phoneRow,
  )

/** Meet's items, drawn in the rail and in the sheet. The Phone is there for a person whose list has a Phone row or whose browser phone is set up. */
export function MeetTreeBody({ view, onList, onPhone, go, then }: { view: MeetView; onList: boolean; onPhone: boolean; go: Go; then?: () => void }) {
  const row = usePhoneRow()
  const handle = usePhoneHandle()
  const switches = useSwitches()
  const phone = switches.phone && (row || handle?.status != null)
  return (
    <div className="tree" data-testid="meet-tree">
      {meetTreeOf(view, onList, phone, onPhone, switches.calls).map((i) => (
        <Item key={i.key} item={i} go={go} {...(then && { then })} />
      ))}
    </div>
  )
}

/** Meet's menu in the rail, under the Meet tab, while that tab is the page. */
export function MeetRailTree({ view, onList, onPhone, go }: { view: MeetView; onList: boolean; onPhone: boolean; go: Go }) {
  return <MeetTreeBody view={view} onList={onList} onPhone={onPhone} go={go} />
}

// ── The sheet ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A button above the list that says which view is open, and opens a sheet over the screen with the menu; picking an item, or the close button, shuts it. The rail is a strip of tabs on a
 * phone, so a menu cannot sit under its tab there. `children` draws the menu and is given the way to shut the sheet.
 */
function Sheet({ label, count, children }: { label: string; count: number | null; children(close: () => void): ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  // The sheet takes focus when it opens, so a keyboard or a screen reader is in it and not behind it, and gives it back to the button when it shuts.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) sheet.current?.focus()
    else if (wasOpen.current) button.current?.focus()
    wasOpen.current = open
  }, [open])
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
    }
  }
  return (
    <>
      <button ref={button} type="button" className="views-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="views-button">
        <span>{label}</span>
        {count !== null && <span className="t-count">{count}</span>}
        <span className="views-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-label="Views" tabIndex={-1} onKeyDown={onKey} data-testid="views-sheet">
          <div className="sheet-head">
            <b>Views</b>
            <button type="button" className="btn" onClick={() => setOpen(false)} data-testid="views-close">
              Close
            </button>
          </div>
          <div className="sheet-body">{children(() => setOpen(false))}</div>
        </div>
      )}
    </>
  )
}

/** The Inbox's items on a phone, with Settings under them. */
export function ViewsSheet({ view, go }: { view: ListView; go: Go }): ReactNode {
  const nav = useNav()
  const current = nav.kind === 'value' ? currentOf(nav.value, view) : { label: view === 'all' ? 'Inbox' : 'Views', count: null }
  return (
    <Sheet label={current.label} count={current.count}>
      {(close) => (
        <>
          {nav.kind === 'value' ? <TreeBody nav={nav.value} view={view} onList go={go} then={close} /> : <p className="t-note sub">{nav.kind === 'said' ? 'The inbox’s views could not be read just now.' : 'Loading the views'}</p>}
          <SettingsFoot nav={nav} now={Date.now()} active={false} go={go} then={close} />
        </>
      )}
    </Sheet>
  )
}

/** Meet's items on a phone. */
export function MeetViewsSheet({ view, go }: { view: MeetView; go: Go }): ReactNode {
  return (
    <Sheet label={MEET_LABEL[view]} count={null}>
      {(close) => <MeetTreeBody view={view} onList onPhone={false} go={go} then={close} />}
    </Sheet>
  )
}
