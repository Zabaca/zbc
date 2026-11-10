// Today: what needs the person, from the inbox, meet and forms behind the space. Its
// sections: Happening now, Later today, Waiting on you, Drafts not sent, Waiting on others, Signed and back, Tomorrow.
//
// TODAY HOLDS NOTHING TO ACT ON. Every row is a link to where the work is: a conversation in this space, a call on meet's own address, a document
// in Forms. A part that did not answer leaves the other parts on screen with a line saying what is missing (noticesFor), as the Inbox does, and
// Today never says "Nothing needs you" while a part is missing.
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { Me } from '../me'
import { type Draft, type LiveCallRow, type Meeting, type Waiting, type DocumentRow, type Section, type TodayAnswer, type TodayEvent } from '../today-shape'
import { CopyLink } from './CallCard'
import { joinHref } from './invite'
import { type Fetched, type Problem, read } from './api'
import { Glyph, TabIcon } from './icons'
import { ago, agoWords } from './format'
import { useLive } from './liveHub'
import { SAFETY_NET_MS, useKeepFresh } from './notify'
import { draftPath, eventPath, INBOX, inboxPath, MEET, meetPath, PHONE_PATH } from './route'
import { accountsWords, responseTag } from './calendar-words'
import { backLine, callHref, clockIn, documentPath, draftAuthorWords, draftDocumentLine, draftTitle, noticesFor, outLine, peopleWords, summaryLine } from './day'

type Go = (path: string) => void

/** A click inside the space moves without reloading, unless it means "open it somewhere else". */
function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

// ── A row ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Where = 'Inbox' | 'Forms' | 'Meet' | 'Calendar'

function WhereTag({ where }: { where: Where }) {
  return (
    <span className="where" data-where={where}>
      {where === 'Forms' ? <TabIcon tab="forms" size={11} /> : where === 'Meet' ? <TabIcon tab="meet" size={11} /> : where === 'Calendar' ? <TabIcon tab="calendar" size={11} /> : <TabIcon tab="inbox" size={11} />}
      {where}
    </span>
  )
}

interface RowProps {
  testid: string
  /** The row's own handle, so a test and a screen reader can tell rows of one section apart. */
  id: string
  href: string
  where: Where
  lead: ReactNode
  title: ReactNode
  sub: ReactNode
  end?: ReactNode
  when?: string
  go: Go
  /** A call opens meet in a tab of its own: it is not the space's page. */
  newTab?: boolean
  /** Buttons under the row (a meeting's Join and Copy link): beside the link and not inside it, since a button cannot be inside one. */
  act?: ReactNode
}

function Row(p: RowProps) {
  // Only a path inside the space moves without a load: the Inbox's and Meet's. Forms is the Forms application's own sign-in, which a full load of /forms is what renews; a call's link is meet's own address (`newTab`).
  const inSpace = p.where !== 'Forms' && p.newTab !== true
  return (
    <li>
      <a
        className="trow"
        href={p.href}
        onClick={inSpace ? (e) => follow(e, p.href, p.go) : undefined}
        {...(p.newTab ? { target: '_blank', rel: 'noopener' } : {})}
        data-testid={p.testid}
        data-id={p.id}
      >
        <span className="tlead" aria-hidden="true">
          {p.lead}
        </span>
        <span className="tmain">
          <span className="ttop">
            <span className="ttitle">{p.title}</span>
            {p.when && <span className="sub twhen">{p.when}</span>}
          </span>
          <span className="sub tsub">{p.sub}</span>
        </span>
        <span className="tend">
          {p.end}
          <WhereTag where={p.where} />
        </span>
      </a>
      {p.act && <div className="tact">{p.act}</div>}
    </li>
  )
}

const Pill = ({ tone, children, testid }: { tone?: 'warn' | 'accent' | 'ok'; children: ReactNode; testid?: string }) => (
  <span className={`pill${tone ? ` ${tone}` : ''}`} data-testid={testid}>
    {children}
  </span>
)

// ── The sections ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function Group({ id, title, count, children, more }: { id: string; title: string; count?: number; children: ReactNode; more?: ReactNode }) {
  return (
    <section className="tsec" data-section={id} aria-labelledby={`t-${id}`}>
      <h2 className="group" id={`t-${id}`}>
        {title}
        {count !== undefined && count > 0 && <span className="tcount">{count}</span>}
      </h2>
      {children}
      {more}
    </section>
  )
}

/** "3 more in Inbox": a section shows its newest few, and the rest is where the work is. */
function More({ section, label, href, go }: { section: Section<unknown>; label: string; href: string; go: Go }) {
  const left = section.total - section.rows.length
  if (left <= 0) return null
  return (
    <p className="sub tmore" data-testid="more">
      <a href={href} onClick={href.startsWith('/forms') ? undefined : (e) => follow(e, href, go)}>
        {left} more in {label}
      </a>
    </p>
  )
}

/** "3 more in Inbox" and "2 more in Meet": Waiting on you mixes email, direct messages and the Phone, so what is not shown is counted where it is (`waitingOnYouLeft`) and each count links to its tab. */
function WaitingMore({ left, go }: { left: TodayAnswer['waitingOnYouLeft']; go: Go }) {
  const tabs = [
    { n: left.inbox, name: 'Inbox', href: INBOX },
    { n: left.meet, name: 'Meet', href: MEET },
  ].filter((t) => t.n > 0)
  if (tabs.length === 0) return null
  return (
    <p className="sub tmore" data-testid="more">
      {tabs.map((t, i) => (
        <span key={t.name}>
          {i > 0 && ', '}
          <a href={t.href} onClick={(e) => follow(e, t.href, go)}>
            {t.n} more in {t.name}
          </a>
        </span>
      ))}
    </p>
  )
}

function WaitingRow({ w, now, go }: { w: Waiting; now: number; go: Go }) {
  if (w.kind === 'phone') {
    return (
      <Row
        testid="waiting-phone"
        id={w.key}
        href={PHONE_PATH}
        where="Meet"
        lead={<Glyph name="phone" size={14} />}
        title="Phone"
        sub={w.snippet}
        end={<Pill tone="accent">{w.unread} new</Pill>}
        when={ago(now, w.at)}
        go={go}
      />
    )
  }
  if (w.kind === 'chat') {
    return (
      <Row
        testid="waiting-chat"
        id={w.key}
        href={meetPath(w.key)}
        where="Meet"
        lead={<Glyph name="chat" size={14} />}
        title={w.person}
        sub={w.snippet}
        end={<Pill tone="accent">{w.unread} new</Pill>}
        when={ago(now, w.at)}
        go={go}
      />
    )
  }
  return (
    <Row
      testid="waiting-mail"
      id={w.id}
      href={inboxPath(w.key)}
      where="Inbox"
      lead={<Glyph name="mail" size={14} />}
      title={
        <>
          {peopleWords(w.people)}
          {w.client && <span className="clientpill">{w.client}</span>}
        </>
      }
      sub={
        <>
          {w.subject && <b className="subject">{w.subject}</b>} {w.snippet}
        </>
      }
      end={
        <>
          {w.mailbox && <span className="kindtag">{w.mailbox}</span>}
          {w.needsReply && <Pill tone="warn">Needs reply</Pill>}
          {w.unread && <Pill tone="accent">Unread</Pill>}
        </>
      }
      when={ago(now, w.at)}
      go={go}
    />
  )
}

function DraftRowView({ d, now, go }: { d: Draft; now: number; go: Go }) {
  if (d.kind === 'document') {
    return (
      <Row
        testid="draft-document"
        id={d.id}
        href={documentPath(d.id)}
        where="Forms"
        lead={<TabIcon tab="forms" size={14} />}
        title={d.title}
        sub={draftDocumentLine(d)}
        end={<Pill>Draft</Pill>}
        when={ago(now, d.at)}
        go={go}
      />
    )
  }
  return (
    <Row
      testid="draft-email"
      id={d.id}
      // A reply is in its person's conversation; a new email has none yet, so it opens at its own address (a first email to a new address has no conversation to open).
      href={d.reply ? inboxPath(d.key) : draftPath(d.id)}
      where="Inbox"
      lead={<Glyph name="note" size={14} />}
      title={draftTitle(d)}
      sub={
        <>
          {d.subject && <b className="subject">{d.subject}</b>} {draftAuthorWords(d.author)}
        </>
      }
      end={d.stuck ? <Pill tone="warn">Not confirmed</Pill> : <Pill>Draft</Pill>}
      when={ago(now, d.at)}
      go={go}
    />
  )
}

function DocumentRowView({ d, now, go, back }: { d: DocumentRow; now: number; go: Go; back: boolean }) {
  // A signed document opens the conversation it came from; one with none, or whose conversation is not in the list, opens in Forms.
  const there = back && d.conversationKey !== undefined
  const tab = d.conversationTab ?? 'inbox'
  return (
    <Row
      testid={back ? 'signed-back' : 'waiting-on-others'}
      id={d.id}
      href={there ? (tab === 'meet' ? meetPath(d.conversationKey as string) : inboxPath(d.conversationKey as string)) : documentPath(d.id)}
      where={there ? (tab === 'meet' ? 'Meet' : 'Inbox') : 'Forms'}
      lead={back ? <Glyph name="check" size={14} /> : <TabIcon tab="forms" size={14} />}
      title={d.title}
      sub={back ? backLine(d, now) : outLine(d, now)}
      end={back ? <Pill tone="ok">Signed</Pill> : d.state === 'sealing' ? <Pill tone="accent">Sealing</Pill> : <Pill tone="accent">{d.signed} of {d.signers} signed</Pill>}
      when={ago(now, d.at)}
      go={go}
    />
  )
}

function MeetingRowView({ m, zone, name, go }: { m: Meeting; zone: string; name: string; go: Go }) {
  const who = m.with && m.with.length > 0 ? `, with ${peopleWords(m.with)}` : ''
  return (
    <Row
      testid="meeting"
      id={m.id}
      // A meeting made from an email conversation opens in the Inbox; one made in a direct message or channel, or in none, in Meet (where its call is listed).
      href={m.conversation ? (m.conversationTab === 'meet' ? meetPath(m.conversation) : inboxPath(m.conversation)) : `${MEET}?view=calls`}
      where={m.conversation && m.conversationTab !== 'meet' ? 'Inbox' : 'Meet'}
      lead={<Glyph name="video" size={14} />}
      title={m.title}
      sub={`${clockIn(zone, m.startsAt)}${who}`}
      go={go}
      // Meet's own link, on its public address: Join opens it in a tab of its own (it needs no sign-in), and Copy link copies it as it is.
      act={
        m.link ? (
          <>
            <a className="btn" href={joinHref({ link: m.link }, name)} target="_blank" rel="noopener noreferrer" data-testid="meeting-join">
              Join
            </a>
            <CopyLink link={m.link} />
          </>
        ) : undefined
      }
    />
  )
}

/**
 * An event from Google's calendars as Later today and Tomorrow draw it: its time, where, and which account it is on, opening its card in the Calendar tab. An invitation not yet answered says so. A call link Google holds
 * is a Join of its own beside the row, as a Meet meeting's is.
 */
function EventRowView({ e, zone, go }: { e: TodayEvent; zone: string; go: Go }) {
  const tag = responseTag(e.response)
  const place = e.location ?? (e.videoLink !== null ? 'Video call' : null)
  return (
    <Row
      testid="event"
      id={e.id}
      href={eventPath(e.id)}
      where="Calendar"
      lead={<Glyph name="calendar" size={14} />}
      title={e.title}
      sub={[e.allDay ? 'All day' : clockIn(zone, e.start), place, accountsWords(e.accounts)].filter((x): x is string => x !== null && x !== '').join(' · ')}
      end={tag !== null && e.response === 'needsAction' ? <Pill tone="warn">{tag}</Pill> : undefined}
      go={go}
      act={
        e.videoLink !== null ? (
          <a className="btn" href={e.videoLink} target="_blank" rel="noopener noreferrer" data-testid="event-join">
            Join
          </a>
        ) : undefined
      }
    />
  )
}

type DayItem = { kind: 'meeting'; at: number; m: Meeting } | { kind: 'event'; at: number; e: TodayEvent }

/** Meet's meetings and Google's events for one day, in the order the day goes: all-day events first, then by time. */
export function dayItems(meetings: readonly Meeting[], events: readonly TodayEvent[]): DayItem[] {
  const items: DayItem[] = [...events.map((e): DayItem => ({ kind: 'event', at: e.allDay ? Number.NEGATIVE_INFINITY : e.start, e })), ...meetings.map((m): DayItem => ({ kind: 'meeting', at: m.startsAt, m }))]
  return items.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1))
}

function DayRows({ meetings, events, zone, name, go }: { meetings: readonly Meeting[]; events: readonly TodayEvent[]; zone: string; name: string; go: Go }) {
  return (
    <ul className="trows">
      {dayItems(meetings, events).map((i) => (i.kind === 'meeting' ? <MeetingRowView key={`m-${i.m.id}`} m={i.m} zone={zone} name={name} go={go} /> : <EventRowView key={`e-${i.e.id}`} e={i.e} zone={zone} go={go} />))}
    </ul>
  )
}

/** Why a call with people in it is on this person's list, in a few words. */
const CALL_WHY: Record<LiveCallRow['why'], string> = { started: 'You made it', invited: 'You are invited to it', conversation: 'A huddle in one of your conversations', other: 'Yours to join' }

// ── The screen ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TodayProps {
  me: Me
  now: number
  answer: TodayAnswer | null
  loading: boolean
  problem: Problem | null
  go: Go
}

function Notices({ answer }: { answer: TodayAnswer }) {
  const notices = noticesFor(answer.sources)
  if (notices.length === 0 && !answer.more) return null
  return (
    <div className="notices tnotices">
      {notices.map((n) => (
        <p key={`${n.part}-${n.kind}`} className={`notice ${n.kind}`} role="status" data-notice={n.kind} data-part={n.part}>
          <Glyph name={n.kind === 'unreachable' ? 'warn' : 'lock'} size={13} />
          <span>{n.text}</span>
        </p>
      ))}
      {answer.more && (
        <p className="notice quiet" data-notice="more">
          <span>Showing the newest only.</span>
        </p>
      )}
    </div>
  )
}

export function TodayScreen({ me, now, answer, loading, problem, go }: TodayProps) {
  const a = answer
  return (
    <section className="page today" aria-labelledby="h-today" data-testid="today">
      <h1 id="h-today">Today</h1>
      {a && (
        <p className="sub" data-testid="today-summary">
          {summaryLine(a)}
        </p>
      )}
      {problem === 'signin' && (
        <div className="notice unreachable tproblem" role="alert" data-notice="signin">
          <Glyph name="warn" size={13} />
          <span>
            Your sign-in may have ended. <button type="button" className="linkish" onClick={() => window.location.reload()}>Reload the page</button> to sign in again.
          </span>
        </div>
      )}
      {problem === 'network' && (
        <p className="notice unreachable tproblem" role="status" data-notice="network">
          <Glyph name="warn" size={13} />
          <span>The space could not be reached just now. {a ? 'This is the last Today it had.' : 'It will be tried again.'}</span>
        </p>
      )}
      {!a && loading && (
        <p className="empty-line sub" role="status" data-testid="loading">
          Loading Today
        </p>
      )}
      {a && <Notices answer={a} />}
      {a && (
        <>
          {a.happeningNow.length > 0 && (
            <Group id="now" title="Happening now" count={a.happeningNow.length}>
              <ul className="trows">
                {a.happeningNow.map((c) => (
                  <Row
                    key={c.name}
                    testid="call"
                    id={c.name}
                    href={callHref(me.origin, c.name)}
                    where="Meet"
                    newTab
                    lead={<span className="livedot" />}
                    title={c.why === 'conversation' ? 'Huddle in progress' : 'Call in progress'}
                    sub={`${c.present} ${c.present === 1 ? 'person is' : 'people are'} in it. ${CALL_WHY[c.why]}, made ${agoWords(now, c.startedAt)}`}
                    end={<span className="pill primary">Join</span>}
                    go={go}
                  />
                ))}
              </ul>
            </Group>
          )}
          {a.events.connected && !a.events.listed && (
            <p className="notice unreachable tproblem" role="status" data-notice="events">
              <Glyph name="warn" size={13} />
              <span>Your Google calendars are not listed right now, so Later today and Tomorrow show only the meetings booked in Meet.</span>
            </p>
          )}
          {a.laterToday.length + a.events.laterToday.length > 0 && (
            <Group id="later" title="Later today" count={a.laterToday.length + a.events.laterToday.length}>
              <DayRows meetings={a.laterToday} events={a.events.laterToday} zone={a.zone} name={me.name} go={go} />
            </Group>
          )}
          {a.waitingOnYou.rows.length > 0 && (
            <Group id="waiting-on-you" title="Waiting on you" count={a.waitingOnYou.total} more={<WaitingMore left={a.waitingOnYouLeft} go={go} />}>
              <ul className="trows">
                {a.waitingOnYou.rows.map((w) => (
                  <WaitingRow key={w.kind === 'mail' ? `m-${w.id}` : `${w.kind}-${w.key}`} w={w} now={now} go={go} />
                ))}
              </ul>
            </Group>
          )}
          {a.drafts.rows.length > 0 && (
            <Group id="drafts" title="Drafts not sent" count={a.drafts.total} more={<More section={a.drafts} label="Inbox" href={`${INBOX}?view=drafts`} go={go} />}>
              <ul className="trows">
                {a.drafts.rows.map((d) => (
                  <DraftRowView key={`${d.kind}-${d.id}`} d={d} now={now} go={go} />
                ))}
              </ul>
            </Group>
          )}
          {a.waitingOnOthers.rows.length > 0 && (
            <Group id="waiting-on-others" title="Waiting on others" count={a.waitingOnOthers.total} more={<More section={a.waitingOnOthers} label="Forms" href="/forms" go={go} />}>
              <ul className="trows">
                {a.waitingOnOthers.rows.map((d) => (
                  <DocumentRowView key={d.id} d={d} now={now} go={go} back={false} />
                ))}
              </ul>
            </Group>
          )}
          {a.signedAndBack.rows.length > 0 && (
            <Group id="signed-back" title="Signed and back" count={a.signedAndBack.total} more={<More section={a.signedAndBack} label="Forms" href="/forms" go={go} />}>
              <ul className="trows">
                {a.signedAndBack.rows.map((d) => (
                  <DocumentRowView key={d.id} d={d} now={now} go={go} back />
                ))}
              </ul>
            </Group>
          )}
          {a.tomorrow.length + a.events.tomorrow.length > 0 && (
            <Group id="tomorrow" title="Tomorrow" count={a.tomorrow.length + a.events.tomorrow.length}>
              <DayRows meetings={a.tomorrow} events={a.events.tomorrow} zone={a.zone} name={me.name} go={go} />
            </Group>
          )}
          {a.laterToday.length + a.events.laterToday.length === 0 && a.tomorrow.length + a.events.tomorrow.length === 0 && (
            <Group id="meetings" title="Later today and tomorrow">
              <p className="sub tquiet" data-testid="no-meetings">
                {a.meetingsListed
                  ? a.events.listed
                    ? 'Nothing on your calendars or booked in Meet for the rest of today or for tomorrow.'
                    : 'No meetings with a time today or tomorrow.'
                  : 'Meetings with a time are not listed yet. They will be made from a conversation, and will show here the day they are on.'}
              </p>
            </Group>
          )}
        </>
      )}
    </section>
  )
}

// ── The tab: fetching, keeping fresh ──────────────────────────────────────────────────────────────────────────────────────

export function Today({ me, go }: { me: Me; pathname: string; search: string; go: Go }) {
  const [answer, setAnswer] = useState<TodayAnswer | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const inflight = useRef<AbortController | null>(null)

  const load = useCallback((quiet: boolean) => {
    inflight.current?.abort()
    const ctl = new AbortController()
    inflight.current = ctl
    if (!quiet) setLoading(true)
    void read<TodayAnswer>('/api/today', ctl.signal).then((r: Fetched<TodayAnswer>) => {
      if (ctl.signal.aborted) return
      setLoading(false)
      if (r.ok) {
        setAnswer(r.value)
        setNow(r.value.now)
        setProblem(null)
      } else setProblem(r.problem)
    })
  }, [])

  useEffect(() => {
    load(false)
    return () => inflight.current?.abort()
  }, [load])

  // Read again as the Inbox's and Meet's lists are: when the page is shown again, every ten minutes while it is visible, and when a notification was kept quiet; and, at once, when a part Today draws moves
  // (what needs the person comes from mail, chat, calls, documents and the calendar: today.ts).
  useKeepFresh(load, SAFETY_NET_MS)
  useLive(['mail', 'chat', 'calls', 'documents', 'calendar'], () => load(true))

  return <TodayScreen me={me} now={now} answer={answer} loading={loading} problem={problem} go={go} />
}
