// The Calendar tab: an AGENDA of the next days, a WEEK (a time grid) and a MONTH (a grid of weeks), every event of every shown calendar of every
// connected Google account merged by time and coloured by account, with the meetings booked in Meet among them, and an event's card. Read only: nothing here changes Google, and nothing here asks Google either (the
// calendar app keeps its own copy and says when it was read). The view and the day are in the address (`/calendar?view=week&date=<day>`), so a reload keeps them and the back button steps through them.
//
// EVENT TEXT IS UNTRUSTED (a title, a place and a guest's name are whatever the organiser typed, and an invitation can come from a stranger): every word of it is drawn as TEXT by React, none as markup, and the only
// addresses made links are ones the calendar app already refused unless they were https (a call) or on Google's own host (the event in Google Calendar).
//
// The address also holds what is open (`/calendar/event/<key>` is an event's card, with the same query), so the back button closes it. On a phone the card takes the screen; on a computer it sits beside the view.
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CALENDAR_AHEAD_MS, CALENDAR_BACK_MS, type CalendarAgendaAccount, type CalendarEvent } from '@space/workspace'
import type { AgendaMeeting, CalendarAgendaAnswer } from '../calendar'
import type { Me } from '../me'
import { type CalView, daysShown, type Focus, focusSearch, itemsOf, monthStart, parseFocus, type Shape, spanOf, stepFocus, titleOf, VIEW_LABEL, VIEWS } from './calendar-grid'
import { follow, type Go, hueClass } from './calendar-shared'
import { accountsWords, agendaDays, type AgendaItem, addDays, cardWhen, clock, dayKey, guestResponse, responseTag, startWords, timeRange, weekdayDay, zoneName } from './calendar-words'
import { MonthView, WeekView } from './CalendarViews'
import { agoWords } from './format'
import { Glyph } from './icons'
import { joinHref } from './invite'
import { useFresh } from './liveHub'
import { eventKeyAt, eventPath, CALENDAR, settingsPath } from './route'
import { Viewed } from './settings-parts'
import { postView, useView } from './views'

function AccountDots({ accounts }: { accounts: readonly { label: string; hue: number }[] }) {
  return (
    <span className="cal-dots" role="img" aria-label={accounts.map((a) => a.label).join(', ')}>
      {accounts.map((a) => (
        <span key={a.label} className={`cal-dot ${hueClass(a.hue)}`} />
      ))}
    </span>
  )
}

// ── A row of the agenda ───────────────────────────────────────────────────────────────────────────────────────────────────

function EventRow({ e, zone, open, current, go }: { e: CalendarEvent; zone: string; open: string; current: boolean; go: Go }) {
  const tag = responseTag(e.response)
  const sub = [e.allDay ? timeRange(e, zone) : null, e.location, e.videoLink !== null && e.location === null ? 'Video call' : null].filter((x): x is string => x !== null && x !== '')
  const classes = ['cal-row', hueClass(e.accounts[0]?.hue ?? 0), e.response === 'declined' ? 'declined' : '', e.status === 'tentative' || e.response === 'tentative' ? 'tentative' : '', e.stale ? 'stale' : '', current ? 'current' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <li>
      <a className={classes} href={open} onClick={(ev) => follow(ev, open, go)} data-testid="cal-event" data-id={e.id} aria-current={current ? 'true' : undefined}>
        <span className="cal-bar" aria-hidden="true" />
        <span className="cal-time">{startWords(e, zone)}</span>
        <span className="cal-main">
          <span className="cal-title">{e.title}</span>
          {sub.length > 0 && <span className="sub cal-sub">{sub.join(' · ')}</span>}
        </span>
        <span className="cal-end">
          {tag && (
            <span className={`pill${e.response === 'needsAction' ? ' warn' : ''}`} data-testid="cal-response">
              {tag}
            </span>
          )}
          {e.stale && <span className="pill" title="This account is lapsed: this is the last picture of it.">Old</span>}
          <span className="cal-accts" data-testid="cal-accounts">
            <AccountDots accounts={e.accounts} />
            <span className="sub cal-acct-names">{accountsWords(e.accounts)}</span>
          </span>
        </span>
      </a>
    </li>
  )
}

function MeetingRow({ m, zone, name }: { m: AgendaMeeting; zone: string; name: string }) {
  const who = m.with.length > 0 ? `With ${m.with.join(', ')}` : 'A call booked in Meet'
  return (
    <li>
      <div className="cal-row meeting" data-testid="cal-meeting" data-id={m.id}>
        <span className="cal-bar" aria-hidden="true" />
        <span className="cal-time">{clock(m.startsAt, zone)}</span>
        <span className="cal-main">
          <span className="cal-title">{m.title}</span>
          <span className="sub cal-sub">{who}</span>
        </span>
        <span className="cal-end">
          <a className="btn" href={joinHref({ link: m.link }, name)} target="_blank" rel="noopener noreferrer" data-testid="cal-join">
            Join
          </a>
          <span className="where" data-where="Meet">
            <Glyph name="video" size={11} />
            Meet
          </span>
        </span>
      </div>
    </li>
  )
}

// ── The legend and the amber lines ────────────────────────────────────────────────────────────────────────────────────────

function Legend({ accounts }: { accounts: readonly CalendarAgendaAccount[] }) {
  if (accounts.length === 0) return null
  return (
    <ul className="cal-legend" aria-label="Accounts" data-testid="cal-legend">
      {accounts.map((a) => (
        <li key={a.address} className={`cal-key ${a.state}`} data-account={a.address} data-state={a.state}>
          <span className={`cal-dot ${hueClass(a.hue)}`} aria-hidden="true" />
          <span>{a.label}</span>
        </li>
      ))}
    </ul>
  )
}

function Trouble({ accounts, go }: { accounts: readonly CalendarAgendaAccount[]; go: Go }) {
  const sick = accounts.filter((a) => a.reason !== null)
  if (sick.length === 0) return null
  return (
    <div className="cal-trouble" data-testid="cal-trouble">
      {sick.map((a) => (
        <p key={a.address} className="cnotice warn" role="status" data-account={a.address} data-state={a.state}>
          <Glyph name="warn" size={13} />
          <span>
            {a.reason}{' '}
            <a href={settingsPath('calendars')} onClick={(ev) => follow(ev, settingsPath('calendars'), go)}>
              Open Settings
            </a>
          </span>
        </p>
      ))}
    </div>
  )
}

// ── The card ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Fact({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <div className="cal-fact" data-testid={testid}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function EventCard({ e, zone, now, onClose, backTo = 'Agenda' }: { e: CalendarEvent; zone: string; now: number; onClose(): void; backTo?: string }) {
  const tag = responseTag(e.response)
  return (
    <article className={`cal-card ${hueClass(e.accounts[0]?.hue ?? 0)}`} aria-label={e.title} data-testid="cal-card">
      <div className="cal-card-head">
        <button type="button" className="btn cal-back" onClick={onClose} data-testid="cal-close">
          <Glyph name="back" size={13} />
          <span>{backTo}</span>
        </button>
      </div>
      <h2 className="cal-card-title" data-testid="cal-card-title">
        {e.title}
      </h2>
      <p className="cal-card-when" data-testid="cal-card-when">
        {cardWhen(e, zone)}
      </p>
      {(tag !== null || e.status === 'tentative' || e.stale) && (
        <p className="cal-card-flags">
          {tag !== null && <span className={`pill${e.response === 'needsAction' ? ' warn' : ''}`} data-testid="cal-card-response">{e.response === 'needsAction' ? 'Not answered. Answer it in Google Calendar.' : tag}</span>}
          {e.status === 'tentative' && <span className="pill">Tentative</span>}
          {e.stale && <span className="pill warn">Last picture of a lapsed account</span>}
        </p>
      )}
      <dl className="cal-facts">
        {e.location !== null && (
          <Fact label="Where" testid="cal-card-where">
            {e.location}
          </Fact>
        )}
        {e.videoLink !== null && (
          <Fact label="Video call" testid="cal-card-video">
            <a className="btn" href={e.videoLink} target="_blank" rel="noopener noreferrer">
              Open the video call
            </a>
          </Fact>
        )}
        <Fact label={e.accounts.length > 1 ? 'Accounts' : 'Account'} testid="cal-card-accounts">
          <span className="cal-accts">
            <AccountDots accounts={e.accounts} />
            <span>{e.accounts.length > 1 ? `${accountsWords(e.accounts)} (the same meeting is on each)` : (e.accounts[0]?.address ?? '')}</span>
          </span>
        </Fact>
        {e.organizer !== null && (
          <Fact label="Organiser" testid="cal-card-organizer">
            {e.organizer.name ?? e.organizer.email}
            {e.organizer.name !== null && e.organizer.email !== null && <span className="sub"> ({e.organizer.email})</span>}
          </Fact>
        )}
        {e.guests.length > 0 && (
          <Fact label={`Invited (${e.guests.length + e.guestsLeft})`} testid="cal-card-guests">
            <ul className="cal-guests">
              {e.guests.map((g) => (
                <li key={`${g.email ?? ''}-${g.name ?? ''}`} data-response={g.response}>
                  <span>
                    {g.name ?? g.email ?? 'A guest'}
                    {g.self && <span className="sub"> (you)</span>}
                    {g.organizer && <span className="sub"> (organiser)</span>}
                  </span>
                  <span className={`sub cal-ans ${g.response}`}>{guestResponse[g.response]}</span>
                </li>
              ))}
            </ul>
            {e.guestsLeft > 0 && <span className="sub">and {e.guestsLeft} more</span>}
          </Fact>
        )}
        {e.description !== null && (
          <Fact label="Notes" testid="cal-card-notes">
            <p className="cal-notes">{e.description}</p>
          </Fact>
        )}
      </dl>
      <p className="sub cal-card-foot">
        {e.readAt !== null && <span data-testid="cal-card-read">Read from Google {agoWords(now, e.readAt)}. </span>}
        Times are on {zone.replace('_', ' ')} time ({zoneName(e.start, zone)}).
        {e.htmlLink !== null && (
          <>
            {' '}
            <a href={e.htmlLink} target="_blank" rel="noopener noreferrer" data-testid="cal-card-google">
              Open in Google Calendar
            </a>
          </>
        )}
      </p>
    </article>
  )
}

function CardPane({ id, zone, now, back, go }: { id: string; zone: string; now: number; back: { label: string; href: string }; go: Go }) {
  const view = useView<CalendarEvent>('calendar/event', { id })
  useFresh(['calendar'], view.reload)
  return (
    <div className="cal-pane" data-testid="cal-pane">
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the event">
        {(e) => <EventCard e={e} zone={zone} now={now} onClose={() => go(back.href)} backTo={back.label} />}
      </Viewed>
      {view.state.kind === 'said' && (
        <p>
          <a className="btn" href={back.href} onClick={(ev) => follow(ev, back.href, go)}>
            Back to the {back.label.toLowerCase()}
          </a>
        </p>
      )}
    </div>
  )
}

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How many days the agenda shows to begin with, and what "Show more days" adds, up to the most the app answers for in one read (62). */
export const FIRST_DAYS = 14
const MORE_DAYS = 14
const MOST_DAYS = 60

/** At or under this width the Week is three days and the Month is dots (the style sheet's phone breakpoint). */
const PHONE = '(max-width: 760px)'

const phoneQuery = (): MediaQueryList | null => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE) : null)

function onWidth(listener: () => void): () => void {
  const q = phoneQuery()
  q?.addEventListener('change', listener)
  return () => q?.removeEventListener('change', listener)
}

function useNarrow(): boolean {
  return useSyncExternalStore(onWidth, () => phoneQuery()?.matches ?? false, () => false)
}

/** Re-draws the page every minute, so the line for now moves and "Today" turns over at midnight. */
function useMinute(): void {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
}

/** The agenda drawn from an answer, from `from` (a day, today unless the buttons moved it) for `days` days. Pure drawing: the tab reads, this draws. */
export function Agenda({ answer, me, now, days, from, openKey, hrefFor, go }: { answer: CalendarAgendaAnswer; me: Me; now: number; days: number; from?: string; openKey: string | null; hrefFor?: (id: string) => string; go: Go }) {
  const zone = me.company.timeZone
  const list = useMemo(() => agendaDays(answer.events, answer.meetings, now, zone, days, from), [answer, now, zone, days, from])
  const open = hrefFor ?? eventPath
  const today = dayKey(now, zone)
  const first = from ?? today
  return (
    <div className="cal-agenda" data-testid="cal-agenda">
      {list.map((d) => (
        <section key={d.key} className="cal-day" data-testid="cal-day" data-day={d.key} aria-label={d.heading}>
          <h2 className="cal-day-h">
            {d.heading}
            {d.heading === 'Today' || d.heading === 'Tomorrow' ? <span className="sub"> {weekdayDay(d.key)}</span> : null}
          </h2>
          {d.items.length === 0 ? (
            <p className="sub cal-quiet" data-testid="cal-nothing">
              {d.key === today ? 'Nothing on the calendar today.' : d.key === first ? 'Nothing on the calendar this day.' : 'Nothing on the calendar.'}
            </p>
          ) : (
            <ul className="cal-rows">
              {d.items.map((i: AgendaItem) =>
                i.kind === 'event' ? (
                  <EventRow key={`${d.key}-${i.event.id}`} e={i.event} zone={zone} open={open(i.event.id)} current={openKey === i.event.id} go={go} />
                ) : (
                  <MeetingRow key={`${d.key}-m-${i.meeting.id}`} m={i.meeting} zone={zone} name={me.name} />
                ),
              )}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

/** What the tab says above any view: no account yet, Meet's meetings missing, and a span the store does not hold all of. */
function Notices({ answer, from, to, now, go }: { answer: CalendarAgendaAnswer; from: number; to: number; now: number; go: Go }) {
  const none = answer.accounts.length === 0
  const months = (ms: number) => Math.round(ms / (30 * 24 * 3_600_000))
  return (
    <>
      {none && (
        <p className="sub cal-empty" data-testid="cal-no-accounts">
          No Google account is connected yet. Connect each one in{' '}
          <a href={settingsPath('mailboxes')} onClick={(ev) => follow(ev, settingsPath('mailboxes'), go)}>
            Settings, Mailboxes
          </a>
          , then add each one's calendar in Settings, Calendars (Connect calendar).
        </p>
      )}
      {!answer.meetingsListed && !none && (
        <p className="cnotice warn" role="status" data-testid="cal-meetings-missing">
          <Glyph name="warn" size={13} />
          <span>The meetings booked in Meet are not listed right now.</span>
        </p>
      )}
      {!none && (from < now - CALENDAR_BACK_MS || to > now + CALENDAR_AHEAD_MS) && (
        <p className="sub cal-window" data-testid="cal-window-note">
          The calendar keeps events from about {months(CALENDAR_BACK_MS)} months back to {months(CALENDAR_AHEAD_MS)} months ahead, so part of this span is not here.
        </p>
      )}
    </>
  )
}

/** Today, Previous and Next, the title over what is shown, and the choice of view. */
function Nav({ focus, title, shape, today, goTo, reading }: { focus: Focus; title: string; shape: Shape; today: string; goTo(f: Focus): void; reading: boolean }) {
  const unit = focus.view === 'month' ? 'month' : focus.view === 'week' ? (shape.narrow ? '3 days' : 'week') : 'days'
  return (
    <div className="cal-nav" data-testid="cal-nav">
      <div className="cal-step">
        <button type="button" className="btn" onClick={() => goTo({ view: focus.view, date: today })} disabled={focus.date === today} data-testid="cal-today">
          Today
        </button>
        <button type="button" className="btn cal-arrow" onClick={() => goTo(stepFocus(focus, -1, shape))} aria-label={`Previous ${unit}`} data-testid="cal-prev">
          <Glyph name="back" size={13} />
        </button>
        <button type="button" className="btn cal-arrow" onClick={() => goTo(stepFocus(focus, 1, shape))} aria-label={`Next ${unit}`} data-testid="cal-next">
          <Glyph name="forward" size={13} />
        </button>
      </div>
      <h2 className="cal-range" data-testid="cal-range" aria-live="polite" aria-busy={reading}>
        {title}
      </h2>
      <div className="seg cal-views" role="group" aria-label="View">
        {VIEWS.map((v: CalView) => (
          <button key={v} type="button" className={`chip${focus.view === v ? ' on' : ''}`} aria-pressed={focus.view === v} onClick={() => goTo({ view: v, date: focus.date })} data-testid={`cal-view-${v}`}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
    </div>
  )
}

export function CalendarTab({ me, pathname, search = '', go }: { me: Me; pathname: string; search?: string; go: Go }) {
  const zone = me.company.timeZone
  const [days, setDays] = useState(FIRST_DAYS)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<string | null>(null)
  const narrow = useNarrow()
  useMinute()
  const now = Date.now()
  const today = dayKey(now, zone)
  // Which view and which day the address names, the days that view draws, and so the span it reads. The span changes only when the view, the day or "Show more days" does, or the day turns over.
  const focus = useMemo(() => parseFocus(search, today), [search, today])
  const shape: Shape = useMemo(() => ({ narrow, agendaDays: days }), [narrow, days])
  const shown = useMemo(() => daysShown(focus, shape), [focus, shape])
  const { from, to } = useMemo(() => spanOf(shown, zone), [shown, zone])
  const view = useView<CalendarAgendaAnswer>('calendar/agenda', { from: String(from), to: String(to) })
  // Google's changes reach the store, which tells the page; a booked meeting in Meet moves with chat. Besides that, when the page is shown again and every ten minutes (the net for a lost message).
  useFresh(['calendar', 'chat'], view.reload)
  const openKey = eventKeyAt(pathname)
  const query = focusSearch(focus, today)
  const hrefFor = (id: string): string => `${eventPath(id)}${query}`
  const goTo = (f: Focus) => go(`${CALENDAR}${focusSearch(f, today)}`)
  const title = titleOf(focus, shown)

  /** The address of a day: on a computer the week that holds it, on a phone the month with that day chosen. */
  const dayHref = (day: string): string => `${CALENDAR}${focusSearch({ view: narrow ? 'month' : 'week', date: day }, today)}`

  const checkNow = async () => {
    setChecking(true)
    setChecked(null)
    const done = await postView<{ asked: number }>('calendar/sync', {})
    setChecking(false)
    setChecked(done.ok ? `Asked Google about ${done.value.asked} calendar${done.value.asked === 1 ? '' : 's'}. New events appear as they arrive.` : done.say.text)
    view.reload()
  }

  return (
    <section className={`page cal${openKey !== null ? ' has-card' : ''}${focus.view !== 'agenda' ? ' wide' : ''}`} aria-labelledby="h-calendar" data-testid="calendar-tab" data-view={focus.view}>
      <div className="cal-top">
        <h1 id="h-calendar">Calendar</h1>
        <div className="cal-tools">
          {view.state.kind === 'value' && <Legend accounts={view.state.value.accounts} />}
          <button type="button" className="btn" onClick={() => void checkNow()} disabled={checking} data-testid="cal-check">
            {checking ? 'Asking' : 'Check now'}
          </button>
        </div>
      </div>
      {checked !== null && (
        <p className="sub cal-checked" role="status" data-testid="cal-checked">
          {checked}
        </p>
      )}
      <div className="cal-body">
        <div className="cal-list">
          <Nav focus={focus} title={title} shape={shape} today={today} goTo={goTo} reading={view.reading} />
          <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the calendar">
            {(answer) => {
              // What was read is not yet what is asked for (the person moved on): drawn empty and dimmed until it arrives, never the old span's events under the new span's title.
              const current = answer.from === from && answer.to === to
              const items = itemsOf(answer.events, answer.meetings)
              return (
                <>
                  <Trouble accounts={answer.accounts} go={go} />
                  <Notices answer={answer} from={from} to={to} now={now} go={go} />
                  {focus.view === 'agenda' && (
                    <>
                      <Agenda answer={answer} me={me} now={now} days={days} from={focus.date} openKey={openKey} hrefFor={hrefFor} go={go} />
                      {days < MOST_DAYS && (
                        <p className="cal-more">
                          <button type="button" className="btn" onClick={() => setDays((n) => Math.min(MOST_DAYS, n + MORE_DAYS))} data-testid="cal-more">
                            Show more days
                          </button>
                        </p>
                      )}
                    </>
                  )}
                  {focus.view === 'week' && <WeekView days={shown} items={items} zone={zone} now={now} openKey={openKey} hrefFor={hrefFor} go={go} busy={!current} />}
                  {focus.view === 'month' && (
                    <>
                      <MonthView days={shown} selected={focus.date} month={monthStart(focus.date)} items={items} zone={zone} now={now} narrow={narrow} openKey={openKey} hrefFor={hrefFor} dayHref={dayHref} go={go} busy={!current} />
                      {narrow && current && (
                        <div className="cal-chosen" data-testid="cal-chosen">
                          <Agenda answer={answer} me={me} now={now} days={1} from={focus.date} openKey={openKey} hrefFor={hrefFor} go={go} />
                        </div>
                      )}
                    </>
                  )}
                </>
              )
            }}
          </Viewed>
        </div>
        {openKey !== null && <CardPane id={openKey} zone={zone} now={now} back={{ label: VIEW_LABEL[focus.view], href: `${CALENDAR}${query}` }} go={go} />}
      </div>
    </section>
  )
}
