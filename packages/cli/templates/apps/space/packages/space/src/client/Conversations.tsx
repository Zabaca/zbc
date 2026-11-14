// The list of a tab, whoever wrote last on top (an Intercom-style list). The one Conversations tab was split in two: Chat / Channels / Calls and Phone are a Meet top level nav
// and are not combined into Conversations, which is the Inbox again. This
// is the list both draw, by `scope`: `mail` is the Inbox (email conversations, drafts, search, New email) and `chat` is Meet (channels, direct messages, calls, the Phone, New
// call). `ConversationsScreen` draws it from an answer and is pure, so the tests draw it with literal answers; `Conversations` fetches, keeps it fresh and
// is told by the page's one live connection when the parts it draws move (liveHub.tsx).
//
// A row opens that person's or channel's conversation beside the list (Conversation.tsx); on a phone it takes the screen. A search hit opens the conversation of the first other
// person on it, here beside the list, with the thread among their others.
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConversationsAnswer, ListedRow, Scope } from '../conversations'
import type { LooseDraft } from '../drafts'
import type { ListedHit, SearchAnswer } from '../list'
import type { Me } from '../me'
import { type Problem, read } from './api'
import { CallPane } from './CallPane'
import { CallsList } from './CallsList'
import { ChannelTools } from './Channels'
import { changes } from './changes'
import { mintKey } from './compose'
import { DRAFT_BY } from './convo'
import { ConversationPane } from './Conversation'
import { DraftPane } from './DraftPane'
import { NEW_EMAIL, NewEmailPane } from './NewEmail'
import {
  CAME_LABEL,
  cameGlyph,
  type ListView,
  MEET_REQUEST,
  MEET_UNREAD_NOTE,
  type MeetView,
  type Who,
  UNREAD_NOTE,
  ago,
  meetViewOf,
  narrow,
  narrowMeet,
  markFor,
  lastByPrefix,
  newestSubject,
  noticesFor,
  readingFor,
  requestFor,
  unreadBreakdown,
  viewAt,
  whoLine,
} from './format'
import { Glyph } from './icons'
import { type LiveStatus, readsOpen } from './live'
import { useLive, useLiveStatus } from './liveHub'
import { MeetViewsSheet, ViewsSheet, announceChange, setPhoneRow } from './nav'
import { SAFETY_NET_MS, useKeepFresh } from './notify'
import { PhonePane } from './PhonePane'
import { useSwitches } from './switches'
import { callPath, conversationKey, conversationPath, draftIdAt, draftPath, follow, inboxPath, tabNameOf, tabPathOf } from './route'
import { postView } from './views'

/** Fewest characters a search is sent for: one letter finds half the inbox. */
export const SEARCH_MIN = 2

export interface ScreenProps {
  me: Me
  /** Which tab's list: the Inbox (`mail`, the default) or Meet (`chat`). */
  scope?: Scope
  now: number
  answer: ConversationsAnswer | null
  loading: boolean
  problem: Problem | null
  /** The inbox's own menu says which list (Inbox, Unread, Drafts, Bulk, Closed, a mailbox, a Client): it is in the address. Meet's is `meetView`. */
  view: ListView
  /** Meet's own menu says which list (All, Chat, Channels, Calls): in the address too. Read only in Meet. */
  meetView?: MeetView
  /** Everyone, outside people or the team: the one cut the menu has no item for. */
  who: Who
  onWho(who: Who): void
  query: string
  onQuery(query: string): void
  /** Null when no search is shown; otherwise the answer once it has come. */
  results: { answer: SearchAnswer | null; searching: boolean; problem: Problem | null } | null
  live: LiveStatus
  /** The key of the conversation that is open, or null. */
  selected: string | null
  /** The id of the draft on no conversation that is open (`/inbox/draft/<id>`), or null. */
  selectedDraft?: string | null
  /** The open conversation, drawn beside the list; the note that asks for a pick where there is none. */
  detail?: ReactNode
  go(path: string): void
  /** The App's own `go`, with nothing added: the sheet's items are places, and Inbox is the main list, which `go` (keeping the current view) could not reach. */
  navigate?(path: string): void
  /** Make a call with no conversation (New call), Meet's. Absent where the page offers none. */
  onNewCall?(): void
  /** Open the box for a new email, the Inbox's. */
  onNewEmail?(): void
  /** Load the next screen of older conversations, at the foot of a list that has more (the Inbox's). Absent where the page offers none. */
  onLoadOlder?(): void
  /** Older conversations are being read: the control says so and is held. */
  loadingOlder?: boolean
  /** What the last New call said, when it did not make one. */
  newCallSay?: string | null
  newCallBusy?: boolean
  /** Counts up when the list is read again: the Calls list is read with it. */
  refreshes?: number
  /** New channel and Browse channels (Channels.tsx), above Meet's rows. Absent where the page offers none. */
  channelTools?: ReactNode
}

// ── The rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Lead({ row }: { row: ListedRow }) {
  const mark = markFor(row)
  if (mark.kind === 'channel') {
    return (
      <span className="avatar-lg channel" data-mark="channel" aria-hidden="true">
        <Glyph name="hash" size={14} />
      </span>
    )
  }
  if (mark.kind === 'call') {
    return (
      <span className="avatar-lg call" data-mark="call" aria-hidden="true">
        <Glyph name="video" size={14} />
      </span>
    )
  }
  return (
    <span className={`avatar-lg ${row.type === 'person' ? row.side : ''}`} data-mark={mark.kind} aria-hidden="true">
      {mark.kind === 'phone' ? <Glyph name="phone" size={14} /> : mark.text}
    </span>
  )
}

function Row({ row, scope, now, on, go }: { row: ListedRow; scope: Scope; now: number; on: boolean; go(path: string): void }) {
  const subject = row.type === 'person' ? newestSubject(row) : null
  const breakdown = row.unread > 0 ? unreadBreakdown(row) : ''
  const shared = row.type === 'person' && row.sharedWith.length > 0 ? row.sharedWith : null
  return (
    <li>
      <a
        className={`row${row.unread > 0 ? ' unread' : ''}${on ? ' on' : ''}`}
        href={conversationPath(scope, row.key)}
        onClick={(e) => follow(e, conversationPath(scope, row.key), go)}
        aria-current={on ? 'true' : undefined}
        data-testid="row"
        data-key={row.key}
      >
        <Lead row={row} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">{row.name}</span>
            {row.at > 0 && (
              <time className="sub when" dateTime={new Date(row.at).toISOString()}>
                {ago(now, row.at)}
              </time>
            )}
          </span>
          <span className="sub clamp">{whoLine(row)}</span>
          <span className="row-sub">
            <span className="sub">
              {lastByPrefix(row.lastBy)}
              {subject && <b className="subject">{subject}</b>}
              {subject && ' '}
              {row.text}
            </span>
          </span>
          <span className="row-badges">
            <span className="kindtag" data-came={row.came} {...(row.came === 'telegram' && { 'data-testid': 'telegram-pill' })}>
              <Glyph name={cameGlyph(row)} size={11} />
              {row.type === 'channel' ? 'Channel' : CAME_LABEL[row.came]}
            </span>
            {row.type === 'person' && row.telegramChat !== null && (
              <span className="kindtag" data-testid="telegram-chat-tag">
                {row.telegramChat === 'group' ? 'Group' : 'Channel'}
              </span>
            )}
            {/* A Telegram row's pill is the one above: its mailbox is named Telegram too, and the word is not said twice. */}
            {row.type === 'person' && row.mailbox && !(row.came === 'telegram' && row.mailbox === CAME_LABEL.telegram) && (
              <span className="kindtag" data-testid="mailbox-tag">
                {row.mailbox}
              </span>
            )}
            {row.type === 'person' &&
              row.clients.map((c) => (
                <span key={c.id} className="clientpill" title={`Linked to ${c.name}`} data-testid="client-pill">
                  {c.name}
                </span>
              ))}
            {row.type === 'person' && row.clients.length === 0 && row.suggestedClient && (
              <span className="clientpill suggested" title={`The inbox suggests ${row.suggestedClient.name}. Not counted until it is linked there.`} data-testid="client-suggested">
                {row.suggestedClient.name} ?
              </span>
            )}
            {row.type === 'person' && row.drafts > 0 && (
              <span className="kindtag" data-testid="drafts-tag">
                {row.drafts === 1 ? 'Draft waiting' : `${row.drafts} drafts waiting`}
              </span>
            )}
            {row.unread > 0 && (
              <span className="pill accent" title={breakdown} aria-label={`${row.unread} new: ${breakdown}`} data-testid="unread">
                {row.unread} new
              </span>
            )}
            {shared && (
              <span className="kindtag" data-testid="shared" title={`Also on this person's email threads: ${shared.join(', ')}`}>
                Shared thread, with {shared.slice(0, 2).join(', ')}
                {shared.length > 2 ? ` and ${shared.length - 2} more` : ''}
              </span>
            )}
          </span>
        </span>
      </a>
    </li>
  )
}

/** What a draft on no conversation is, in a word: the channel it goes by. */
const LOOSE_KIND = { email: 'Email draft', sms: 'Text draft', manual: 'Direct message draft', telegram: 'Telegram draft' } as const

/**
 * A draft that sits on no conversation (a first email to a new address, a first LinkedIn message to a new contact), under the Drafts view's "Not on a conversation yet": a row that opens its own
 * page at `/inbox/draft/<id>`, where the card has every action a draft in a conversation has.
 */
function LooseRow({ draft, now, on, go }: { draft: LooseDraft; now: number; on: boolean; go(path: string): void }) {
  const path = draftPath(draft.id)
  return (
    <li>
      <a className={`row${on ? ' on' : ''}`} href={path} onClick={(e) => follow(e, path, go)} aria-current={on ? 'true' : undefined} data-testid="loose-draft" data-draft={draft.id}>
        <span className="avatar-lg outside" aria-hidden="true">
          <Glyph name="note" size={14} />
        </span>
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">To {draft.toName}</span>
            <time className="sub when" dateTime={new Date(draft.at).toISOString()}>
              {ago(now, draft.at)}
            </time>
          </span>
          <span className="sub clamp">{draft.subject.trim() !== '' ? draft.subject : draft.to}</span>
          <span className="row-sub">
            <span className="sub">{draft.text.replace(/\s+/g, ' ').trim()}</span>
          </span>
          <span className="row-badges">
            <span className="kindtag">{draft.stuck ? 'Not confirmed as sent' : DRAFT_BY[draft.author]}</span>
            {draft.kind != null && <span className="kindtag">{LOOSE_KIND[draft.kind]}</span>}
          </span>
        </span>
      </a>
    </li>
  )
}

// ── Notices ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Notices({ answer }: { answer: ConversationsAnswer }) {
  const notices = noticesFor(answer.parts)
  if (notices.length === 0) return null
  return (
    <div className="notices">
      {notices.map((n) => (
        <p key={n.part} className={`notice ${n.kind}`} role="status" data-notice={n.kind} data-part={n.part}>
          <Glyph name={n.kind === 'unreachable' ? 'warn' : 'lock'} size={13} />
          <span>{n.text}</span>
        </p>
      ))}
    </div>
  )
}

/** At the foot of a list that has older conversations than it shows: what the list is, and the way to the rest. The newest screen is never the whole list, and this is where the rest is. */
function LoadOlder({ busy, onLoad }: { busy: boolean; onLoad(): void }) {
  return (
    <div className="load-older" data-testid="load-older-row">
      <p className="sub" data-notice="more">
        These are the newest email conversations.
      </p>
      <button type="button" className="btn" onClick={onLoad} disabled={busy} data-testid="load-older">
        {busy ? 'Loading' : 'Load older'}
      </button>
    </div>
  )
}

// ── Who ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Chip({ on, onClick, children, testid }: { on: boolean; onClick(): void; children: React.ReactNode; testid: string }) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick} data-testid={testid}>
      {children}
    </button>
  )
}

/** All, Outside and Team: the one cut of the list the inbox's menu has no item for. Bulk, Closed, each mailbox and each Client are the menu's (nav.tsx), the tree beside the list or the sheet on a phone. */
function WhoChips({ who, onWho }: { who: Who; onWho(w: Who): void }) {
  return (
    <div className="chips" role="group" aria-label="Show">
      {(['all', 'outside', 'team'] as const).map((f) => (
        <Chip key={f} on={who === f} onClick={() => onWho(f)} testid={`filter-${f}`}>
          {f === 'all' ? 'All' : f === 'outside' ? 'Outside' : 'Team'}
        </Chip>
      ))}
    </div>
  )
}

const EMPTY = {
  all: 'No email conversations yet. People will be listed here, whoever wrote last on top.',
  unread: 'Nothing unread.',
  drafts: 'No one has a draft waiting.',
  bulk: 'No newsletters or automated mail.',
  sent: 'You have not sent any email yet.',
  closed: 'No closed email conversations.',
  mailbox: 'No open conversations in this mailbox.',
  client: 'No conversations with this Client’s people.',
  outside: 'No conversations with people outside the team.',
  team: 'No conversations with the team.',
} as const

/** What Meet's empty list says. */
const MEET_EMPTY = {
  all: 'Nothing here yet. Channels, direct messages and calls will be listed here, whoever wrote last on top.',
  chat: 'No direct messages yet.',
  channels: 'No channels yet.',
  calls: 'No calls yet.',
} as const

/** What an empty list says: the who's words when one is chosen, else the view's. */
const emptyWords = (view: ListView, who: Who): string => (who !== 'all' ? EMPTY[who] : EMPTY[view.startsWith('mailbox:') ? 'mailbox' : view.startsWith('client:') ? 'client' : (view as 'all' | 'unread' | 'sent' | 'drafts' | 'bulk' | 'closed')])

// ── Search results, by source ─────────────────────────────────────────────────────────────────────────────────────────────

function Hit({ hit, now, go }: { hit: ListedHit; now: number; go(path: string): void }) {
  const body = (
    <>
      <span className="avatar-lg outside" aria-hidden="true">
        <Glyph name="mail" size={14} />
      </span>
      <span className="row-main">
        <span className="row-top">
          <span className="row-title">{hit.subject || '(no subject)'}</span>
          <time className="sub when" dateTime={new Date(hit.at).toISOString()}>
            {ago(now, hit.at)}
          </time>
        </span>
        <span className="sub clamp">{hit.people.join(', ') || 'No one else'}</span>
        <span className="row-sub">
          <span className="sub">{hit.match ?? hit.snippet}</span>
        </span>
        <span className="row-badges">
          {hit.mailbox && <span className="kindtag">{hit.mailbox}</span>}
          {hit.bulk && <span className="kindtag">Bulk</span>}
          {!hit.open && <span className="kindtag">Closed</span>}
          {hit.unread && <span className="pill accent">New</span>}
        </span>
      </span>
    </>
  )
  const className = `row${hit.unread ? ' unread' : ''}`
  // A hit with no one on it has no conversation to open; it is drawn, and says nothing it cannot do.
  if (hit.key === null) {
    return (
      <li>
        <div className={className} data-testid="hit" data-key="">
          {body}
        </div>
      </li>
    )
  }
  const path = inboxPath(hit.key)
  return (
    <li>
      <a className={className} href={path} onClick={(e) => follow(e, path, go)} data-testid="hit" data-key={hit.key} title="Opens their conversation">
        {body}
      </a>
    </li>
  )
}

function Results({ results, now, go }: { results: NonNullable<ScreenProps['results']>; now: number; go(path: string): void }) {
  const { answer } = results
  if (results.problem === 'signin') return <SignIn />
  if (!answer) {
    return (
      <p className="empty-line sub" role="status">
        {results.problem === 'network' ? 'Search could not be reached.' : 'Searching'}
      </p>
    )
  }
  const notices = noticesFor([answer.mail.status])
  return (
    <div data-testid="results">
      <section aria-labelledby="src-mail">
        <h2 id="src-mail" className="source">
          Email <span className="sub">{answer.mail.status.state === 'ok' ? `${answer.mail.hits.length}${answer.mail.more ? '+' : ''} found` : ''}</span>
        </h2>
        {notices.map((n) => (
          <p key={n.part} className={`notice ${n.kind}`} role="status" data-notice={n.kind} data-part={n.part}>
            <Glyph name={n.kind === 'unreachable' ? 'warn' : 'lock'} size={13} />
            <span>{n.text}</span>
          </p>
        ))}
        {answer.mail.status.state === 'ok' && answer.mail.hits.length === 0 && <p className="empty-line sub">No email matches “{answer.query}”.</p>}
        <ul className="rows">
          {answer.mail.hits.map((h) => (
            <Hit key={h.conversationId} hit={h} now={now} go={go} />
          ))}
        </ul>
      </section>
    </div>
  )
}

function SignIn() {
  return (
    <div className="notice unreachable" role="alert" data-notice="signin">
      <Glyph name="warn" size={13} />
      <span>
        Your sign-in may have ended. <button type="button" className="linkish" onClick={() => window.location.reload()}>Reload the page</button> to sign in again.
      </span>
    </div>
  )
}

// ── The screen ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const LIVE_WORDS: Partial<Record<LiveStatus, string>> = { open: 'Chat is live', reconnecting: 'Reconnecting chat' }

/** The "pick one" note beside the list while nothing is open. */
const PICK = {
  mail: { title: 'Pick a conversation.', sub: 'A person’s emails open here.' },
  chat: { title: 'Pick a conversation.', sub: 'A channel, a direct message, a call or the Phone opens here.' },
} as const

export function ConversationsScreen(p: ScreenProps) {
  const { me, answer, view, who, now } = p
  const scope = p.scope ?? 'mail'
  const mail = scope === 'mail'
  const meetView = p.meetView ?? 'all'
  const rows = answer ? (mail ? narrow(answer.rows, view, who) : narrowMeet(answer.rows, meetView)) : []
  // Drafts on no conversation are in no row: the Drafts view lists them above the rows (the Team cut is people on the team, whom a first email to a new address is not to).
  const loose = mail && answer && view === 'drafts' && who !== 'team' ? answer.looseDrafts : []
  const searching = mail && p.results !== null
  const liveWord = mail ? undefined : LIVE_WORDS[p.live]
  const name = tabNameOf(scope)
  const pick = PICK[scope]
  return (
    <div className={`split${p.selected !== null || (p.selectedDraft ?? null) !== null ? ' open' : ''}`} data-scope={scope}>
      <section className="list" aria-labelledby="h-conv" aria-busy={p.loading}>
        <header className="list-head">
          <h1 id="h-conv">{name}</h1>
          {mail && p.onNewEmail && (
            <button type="button" className="btn new-call" onClick={p.onNewEmail} title="Write an email to anyone, from the mailbox you choose" data-testid="new-email-button">
              <Glyph name="plus" size={13} />
              New email
            </button>
          )}
          {!mail && p.onNewCall && (
            <button type="button" className="btn new-call" onClick={p.onNewCall} disabled={p.newCallBusy} title="Make a call with no conversation, and copy its link" data-testid="new-call">
              <Glyph name="plus" size={13} />
              New call
            </button>
          )}
          {liveWord && (
            <span className={`live ${p.live}`} data-testid="live" role="status">
              <span className="dot" aria-hidden="true" />
              {liveWord}
            </span>
          )}
        </header>
        {mail && (
          <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
            <Glyph name="search" size={13} />
            <input
              type="search"
              name="q"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
              placeholder="Search email"
              aria-label="Search email"
              autoComplete="off"
              enterKeyHint="search"
              data-testid="search"
            />
            {p.query !== '' && (
              <button type="button" className="clear" aria-label="Clear the search" onClick={() => p.onQuery('')}>
                <Glyph name="x" size={12} />
              </button>
            )}
          </form>
        )}
        {searching ? (
          <Results results={p.results as NonNullable<ScreenProps['results']>} now={now} go={p.go} />
        ) : (
          <>
            <div className="views-row">{mail ? <ViewsSheet view={view} go={p.navigate ?? p.go} /> : <MeetViewsSheet view={meetView} go={p.navigate ?? p.go} />}</div>
            {p.newCallSay && (
              <p className="notice unreachable" role="alert" data-testid="new-call-say">
                <Glyph name="warn" size={13} />
                <span>{p.newCallSay}</span>
              </p>
            )}
            {!mail && meetView === 'calls' ? (
              <CallsList me={me} refreshes={p.refreshes ?? 0} go={p.go} />
            ) : (
              <>
                {!mail && p.channelTools}
                {mail && <WhoChips who={who} onWho={p.onWho} />}
                {p.problem === 'signin' && <SignIn />}
                {p.problem === 'network' && (
                  <p className="notice unreachable" role="status" data-notice="network">
                    <Glyph name="warn" size={13} />
                    <span>The space could not be reached just now. {answer ? 'This is the last list it had.' : 'It will be tried again.'}</span>
                  </p>
                )}
                {answer && <Notices answer={answer} />}
                {!answer && p.loading && (
                  <p className="empty-line sub" role="status" data-testid="loading">
                    Loading conversations
                  </p>
                )}
                {answer && rows.length === 0 && loose.length === 0 && answer.parts.every((x) => x.state === 'ok') && (
                  <p className="empty-line sub" data-testid="empty-conversations">
                    {mail ? emptyWords(view, who) : MEET_EMPTY[meetView]}
                  </p>
                )}
                {loose.length > 0 && (
                  <section aria-labelledby="h-loose" data-testid="loose-drafts">
                    <h2 id="h-loose" className="source">
                      Not on a conversation yet <span className="sub">{loose.length}</span>
                    </h2>
                    <ul className="rows">
                      {loose.map((d) => (
                        <LooseRow key={d.id} draft={d} now={now} on={d.id === p.selectedDraft} go={p.go} />
                      ))}
                    </ul>
                  </section>
                )}
                <ul className="rows" data-testid="rows">
                  {rows.map((r) => (
                    <Row key={r.key} row={r} scope={scope} now={now} on={r.key === p.selected} go={p.go} />
                  ))}
                </ul>
                {mail && answer?.more && answer.floor && p.onLoadOlder && <LoadOlder busy={p.loadingOlder === true} onLoad={p.onLoadOlder} />}
                {answer && rows.some((r) => r.unread > 0) && <p className="foot sub">{mail ? UNREAD_NOTE : MEET_UNREAD_NOTE}</p>}
              </>
            )}
          </>
        )}
      </section>
      <div className="detail" data-testid="detail">
        {p.detail ?? (
          <div className="detail-note">
            <p>{pick.title}</p>
            <p className="sub">{pick.sub}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── The tab: fetching, keeping fresh, going live ──────────────────────────────────────────────────────────────────────────

/** The views whose rows are open conversations: a row whose last open thread was just closed is not in them. Sent, Drafts and Closed hold it whatever state it is in. */
const holdsOpenOnly = (view: ListView): boolean => view !== 'sent' && view !== 'drafts' && view !== 'closed'

export function Conversations({ scope, me, pathname, search = '', go: goTo }: { scope: Scope; me: Me; pathname: string; search?: string; go(path: string): void }) {
  const mail = scope === 'mail'
  const base = tabPathOf(scope)
  // The view is in the address, so the tree beside the list (or the sheet on a phone) and the list agree, and opening a conversation keeps it.
  const draftId = mail ? draftIdAt(pathname) : null
  // A draft's address keeps the Drafts view beside it when it names no view (an outside tool's links and the drafting skill's carry none).
  const view = mail ? viewAt(pathname, search) : 'all'
  const switches = useSwitches()
  // The Calls view is a call's: an install without calls has none, and its address shows the main list.
  const meetView = mail || (meetViewOf(search) === 'calls' && !switches.calls) ? 'all' : meetViewOf(search)
  const [who, setWho] = useState<Who>('all')
  const go = useCallback((path: string) => goTo(path.startsWith(base) && !path.includes('?') ? `${path}${search}` : path), [goTo, search, base])
  const [answer, setAnswer] = useState<ConversationsAnswer | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [refreshes, setRefreshes] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScreenProps['results']>(null)
  // A person just closed from the conversation open beside this list leaves it at once, in the views that hold open conversations; the inbox's answer, read after the close, is the last word (changes.ts).
  const closing = useSyncExternalStore(changes.subscribe, changes.snapshot, changes.snapshot).rows
  const listed = useMemo(
    () => (answer && mail && closing.size > 0 && holdsOpenOnly(view) ? { ...answer, rows: answer.rows.filter((r) => !(r.type === 'person' && closing.has(r.key))) } : answer),
    [answer, mail, closing, view],
  )

  // Meet asks for its one list (every Meet view is cut from it); the Inbox for the view's.
  const request = mail ? requestFor(view) : MEET_REQUEST
  const current = useRef(request)
  current.current = request
  const inflight = useRef<AbortController | null>(null)
  // HOW FAR DOWN THE LIST IS READ. The list is the newest screen of the view; Load older reads further, down to a POSITION (the `floor` the last answer gave), and every read of this list after it,
  // a live message, the minute's, a read or a send, asks down to the same position. So what was loaded stays, what arrived since is on top and nothing is repeated (a count of rows would shift
  // as mail arrives). Each answer is the whole list down to there, never a page to be added to what is held, so a refresh cannot double a row. `older` is set while one more screen is asked for.
  // Null until Load older is pressed, and again whenever another list is opened.
  const reading = useRef<{ through: string; older: boolean } | null>(null)
  const heldAnswer = useRef<ConversationsAnswer | null>(null)
  heldAnswer.current = answer
  const [loadingOlder, setLoadingOlder] = useState(false)

  // `again` is for the reads that mean the world changed (chat said so, the page was shown again, a minute passed): the open conversation is read
  // again with the list. A read the page makes itself (after it marked something read, or sent) is the list alone.
  const load = useCallback((quiet: boolean, again = true) => {
    inflight.current?.abort()
    const ctl = new AbortController()
    inflight.current = ctl
    if (!quiet) setLoading(true)
    if (again && quiet) setRefreshes((n) => n + 1)
    const startedAt = Date.now()
    void read<ConversationsAnswer>(readingFor(current.current, reading.current), ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      setLoading(false)
      setLoadingOlder(false)
      // The list now reaches down to where this answer ends, and one more screen is no longer owed; a read that failed leaves the position, and the control free to be pressed again.
      if (reading.current !== null) reading.current = { through: (r.ok ? r.value.floor : null) ?? reading.current.through, older: false }
      // A close that ended before this read began is in what it says: its row need not be held out of the list any more.
      if (r.ok) changes.release('rows', startedAt)
      setNow(Date.now())
      if (r.ok) {
        setAnswer(r.value)
        setProblem(null)
      } else setProblem(r.problem)
    })
  }, [])
  // Meet's menu has the Phone only for a person whose list has its row.
  useEffect(() => {
    if (!mail && answer) setPhoneRow(answer.rows.some((r) => r.type === 'phone'))
  }, [answer, mail])
  // Something was read or sent from here: the list, and the menu's counts beside it, are read again.
  const listAgain = useCallback(() => {
    load(true, false)
    announceChange()
  }, [load])

  // Load older: one more screen of conversations below the ones shown, of the same list. Pressed twice before the answer, it is one read.
  const loadOlder = useCallback(() => {
    const from = heldAnswer.current?.floor ?? null
    if (from === null || reading.current?.older === true) return
    reading.current = { through: from, older: true }
    setLoadingOlder(true)
    load(true, false)
  }, [load])

  // A different list (Bulk, Closed, a mailbox, a Client) is read from the start, down to its newest screen.
  useEffect(() => {
    setAnswer(null)
    reading.current = null
    setLoadingOlder(false)
    load(false)
    return () => inflight.current?.abort()
  }, [request, load])

  // Read again when the page is shown again, every ten minutes while it is visible (the net for a lost live message), and when the service worker kept a
  // notification quiet because this page shows that person (the list and the open conversation are read again).
  useKeepFresh(load, SAFETY_NET_MS)

  // THE LIVE CONNECTION (liveHub.tsx) says which part moved. The Inbox's list draws mail; Meet's draws chat and calls. The list is read again for those, and the open conversation with it only when the message
  // named it or named none (`readsOpen`). A conversation also draws the documents sent from it (and, in the Inbox, a call's card), which are not in the list: those read the open conversation alone.
  const openKey = draftId !== null ? `draft:${draftId}` : conversationKey(pathname, scope)
  const openRef = useRef(openKey)
  openRef.current = openKey
  useLive(mail ? ['mail', 'clients'] : ['chat', 'calls'], (e) => load(true, readsOpen(e, openRef.current)))
  useLive(mail ? ['documents', 'calls'] : [], (e) => {
    // A reconnect (no part) is read by the list's own handler above, which reads the open conversation with it: not twice.
    if (e.part !== null && readsOpen(e, openRef.current)) setRefreshes((n) => n + 1)
  })
  const live: LiveStatus = useLiveStatus()


  // Search: the inbox's, in the same box, a moment after the typing stops.
  useEffect(() => {
    const q = query.trim()
    if (!mail || q.length < SEARCH_MIN) {
      setResults(null)
      return
    }
    const ctl = new AbortController()
    setResults((r) => ({ answer: r?.answer ?? null, searching: true, problem: null }))
    const timer = setTimeout(() => {
      void read<SearchAnswer>(`/api/search?q=${encodeURIComponent(q)}`, ctl.signal).then((r) => {
        if (ctl.signal.aborted) return
        setNow(Date.now())
        setResults(r.ok ? { answer: r.value, searching: false, problem: null } : { answer: null, searching: false, problem: r.problem })
      })
    }, 300)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [query, mail])

  // New call: a call with no conversation, which gets a row of its own and opens on its own screen with the link to copy. Once per press (a key made for it).
  const [newCallBusy, setNewCallBusy] = useState(false)
  const [newCallSay, setNewCallSay] = useState<string | null>(null)
  const newCall = useCallback(async () => {
    setNewCallBusy(true)
    setNewCallSay(null)
    const got = await postView<{ name: string }>('meet/call', { key: mintKey() })
    setNewCallBusy(false)
    if (!got.ok) return setNewCallSay(got.say.text)
    listAgain()
    go(callPath(got.value.name))
  }, [go, listAgain])

  const selected = conversationKey(pathname, scope)
  // Moving to another address without leaving this one behind: the page a draft's link opened on is not one to come Back to once the draft is a conversation.
  // The view in the address (`?view=drafts`) goes with it, as it does when a row is opened.
  const replace = useCallback(
    (path: string) => {
      window.history.replaceState(null, '', path.includes('?') ? path : `${path}${search}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    },
    [search],
  )
  // The Inbox: a draft, a new email, or a person's emails. Meet: a call or the Phone is a screen of its own; every other key is a channel or a direct message.
  const detail = mail
    ? draftId !== null
      ? <DraftPane key={draftId} draftId={draftId} refreshes={refreshes} onChanged={listAgain} go={go} replace={replace} />
      : selected === null
        ? undefined
        : selected === NEW_EMAIL
          ? <NewEmailPane key={NEW_EMAIL} to={new URLSearchParams(search).get('to') ?? ''} onChanged={listAgain} go={go} />
          : <ConversationPane key={selected} scope="mail" me={me} convKey={selected} fromClosed={view === 'closed'} refreshes={refreshes} onChanged={listAgain} go={go} />
    : selected === null
      ? undefined
      : selected === 'phone'
        ? <PhonePane key="phone" refreshes={refreshes} onChanged={listAgain} go={go} />
        : selected.startsWith('call:')
          ? <CallPane key={selected} me={me} name={selected.slice('call:'.length)} refreshes={refreshes} onChanged={listAgain} go={go} />
          : <ConversationPane key={selected} scope="chat" me={me} convKey={selected} fromClosed={false} refreshes={refreshes} onChanged={listAgain} go={go} />
  return (
    <ConversationsScreen
      me={me}
      scope={scope}
      now={now}
      answer={listed}
      loading={loading}
      problem={problem}
      view={view}
      meetView={meetView}
      who={who}
      onWho={setWho}
      navigate={goTo}
      query={query}
      onQuery={setQuery}
      results={results}
      live={live}
      selected={selected}
      selectedDraft={draftId}
      detail={detail}
      go={go}
      {...(mail ? { onNewEmail: () => go(inboxPath(NEW_EMAIL)), onLoadOlder: loadOlder, loadingOlder } : switches.calls ? { onNewCall: () => void newCall() } : {})}
      newCallBusy={newCallBusy}
      newCallSay={newCallSay}
      refreshes={refreshes}
      {...(!mail && { channelTools: <ChannelTools go={go} onChanged={listAgain} /> })}
    />
  )
}
