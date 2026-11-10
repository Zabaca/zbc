// Settings, Calendars: one card per Google account, with its calendars and a switch for whether each is shown in the Calendar tab and Today.
//
// THE GRANT IS THE INBOX'S. One Google permission per account serves mail and calendar (the calendar reuses the inbox's Google client), so this section has no Connect or Disconnect of its own: an account
// that needs the calendar permission, or whose sign-in Google ended, is connected again through the same sign-in as its mail (a link to it, with the account hinted), and removing an account is Mailboxes' Disconnect, which takes
// mail and calendar away together. Saying so is part of the page. Nothing here changes Google.
import type { MouseEvent } from 'react'
import { type CalendarAccountView, type CalendarView, GMAIL_ACCOUNT_PARAM, GMAIL_FOR_PARAM, GMAIL_START_PATH, type InboxMailboxes } from '@space/workspace'
import { Glyph } from './icons'
import { useFresh } from './liveHub'
import { settingsPath } from './route'
import { agoText, Block, Done, Say, Switch, useAction, Viewed } from './settings-parts'
import { postView, useView } from './views'

type Go = (path: string) => void

/**
 * Where the buttons go. MAIL IS NEVER HELD BEHIND A CALENDAR CONSENT: "Connect again" (a lapsed or disconnected account) is the mailboxes' own sign-in, mail's permissions alone, with the account hinted so Google offers it first; "Connect calendar" (an account
 * connected for mail without the calendar permission) is the calendar's own, which asks for the calendar permission alone, incrementally, and keeps what the account already granted. A Workspace admin who restricts the calendar scope breaks only the second.
 */
const connectPath = (id: string | undefined, forCalendar = false): string => {
  const params = new URLSearchParams()
  if (id !== undefined) params.set(GMAIL_ACCOUNT_PARAM, id)
  if (forCalendar) params.set(GMAIL_FOR_PARAM, 'calendar')
  const query = params.toString()
  return query === '' ? GMAIL_START_PATH : `${GMAIL_START_PATH}?${query}`
}

const STATE_TEXT: Record<CalendarAccountView['state'], string> = {
  syncing: 'Reading the calendars in',
  live: 'Live',
  lapsed: 'Sign-in ended: connect it again',
  'needs-calendar': 'Connected for mail: the calendar needs its permission',
  disconnected: 'Not connected',
}

function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

function CalendarRow({ c, busy, onToggle, now }: { c: CalendarView; busy: boolean; onToggle(next: boolean): void; now: number }) {
  return (
    <li className="cs-cal" data-testid="calendar-row" data-id={c.id} data-shown={c.shown}>
      <span className="cs-swatch" style={c.color !== null ? { background: c.color } : undefined} aria-hidden="true" />
      <span className="cs-name">
        <span>{c.name}</span>
        {c.primary && <span className="kindtag">Main</span>}
        {c.shown && c.readAt !== null && <span className="sub cs-read">Read {agoText(now, c.readAt)}</span>}
        {c.shown && c.readAt === null && c.problem === null && <span className="sub cs-read">Reading it in</span>}
        {c.problem !== null && <span className="cs-problem">{c.problem}</span>}
        {c.problem === null && c.note !== null && (
          <span className="sub cs-note" data-testid="calendar-note">
            {c.note}
          </span>
        )}
      </span>
      <Switch on={c.shown} label={`Show ${c.name}`} busy={busy} onChange={onToggle} testid="calendar-switch" />
    </li>
  )
}

function AccountCard({ a, now, connectHref, calendarHref, busy, onToggle }: { a: CalendarAccountView; now: number; connectHref: string; calendarHref: string; busy: boolean; onToggle(calendarId: string, next: boolean): void }) {
  const broken = a.state === 'lapsed' || a.state === 'needs-calendar' || a.state === 'disconnected'
  return (
    <section className={`s-card cs-account hue-${a.hue % 6}${broken || a.reason !== null ? ' amber' : ''}`} aria-label={`${a.address} calendars`} data-testid="calendar-account" data-account={a.address} data-state={a.state}>
      <h3 className="s-sub">
        <span className="cal-dot" aria-hidden="true" /> {a.address} <span className="sub">({a.label})</span>
      </h3>
      <p className="sub" data-testid="calendar-state">
        {STATE_TEXT[a.state]}
        {a.readAt !== null && !broken ? `. Brought up to date ${agoText(now, a.readAt)}.` : ''}
      </p>
      {a.reason !== null && (
        <p className="s-warn" role="status" data-testid="calendar-reason">
          {a.reason}
        </p>
      )}
      {a.note !== null && (
        <p className="sub" data-testid="calendar-account-note">
          {a.note}
        </p>
      )}
      {a.calendars.length > 0 && (
        <ul className="cs-cals" aria-label={`Calendars of ${a.address}`}>
          {a.calendars.map((c) => (
            <CalendarRow key={c.id} c={c} busy={busy} onToggle={(next) => onToggle(c.id, next)} now={now} />
          ))}
        </ul>
      )}
      {a.calendars.length === 0 && a.state === 'live' && <p className="sub">No calendars read yet.</p>}
      {(a.state === 'live' || a.state === 'syncing') && !a.events && (
        <p className="sub" data-testid="calendar-events-hint">
          Connected for reading. Editing events needs <a href={calendarHref}>Connect calendar</a> again.
        </p>
      )}
      {a.state === 'needs-calendar' && (
        <div className="s-actions">
          <a className="btn primary" href={calendarHref} data-testid="calendar-connect">
            Connect calendar
          </a>
          <span className="sub">Google asks for the calendar permission alone; mail is not touched.</span>
        </div>
      )}
      {(a.state === 'lapsed' || a.state === 'disconnected') && (
        <div className="s-actions">
          <a className="btn primary" href={connectHref} data-testid="calendar-connect-again">
            Connect again
          </a>
          <span className="sub">This is the same sign-in as the account's mail. If its calendar does not come back with it, press Connect calendar here afterwards.</span>
        </div>
      )}
    </section>
  )
}

/** The calendars section. */
export function CalendarsSection({ go }: { go: Go }) {
  const view = useView<CalendarAccountView[]>('calendar/accounts')
  // The inbox's own list of accounts says which mailbox is which address, so "Connect again" can hint Google to offer the right account first. Without it the link still works (Google asks which).
  const mailboxes = useView<InboxMailboxes>('mailboxes')
  useFresh(['calendar', 'mail'], () => {
    view.reload()
    mailboxes.reload()
  })
  const action = useAction()
  const now = Date.now()
  const idOf = (address: string): string | undefined => (mailboxes.state.kind === 'value' ? mailboxes.state.value.gmailAccounts.find((g) => g.address.toLowerCase() === address.toLowerCase())?.id : undefined)

  const toggle = async (calendarId: string, shown: boolean) => {
    await action.run(() => postView<CalendarView>('calendar/shown', { calendar: calendarId, shown }), shown ? 'It is shown now, and being read in.' : 'It is hidden now, and its events are dropped.')
    view.reload()
  }
  const checkNow = async () => {
    await action.run(() => postView<{ asked: number }>('calendar/sync', {}), (v) => `Asked Google about ${v.asked} calendar${v.asked === 1 ? '' : 's'}.`)
    view.reload()
  }

  return (
    <Block title="Calendars" testid="section-calendars">
      <p className="sub cs-lead">
        Your Google calendars are read into the space and kept here, so the Calendar tab and Today never wait on Google. Each account is the same Google sign-in as its mail; the calendar's permission is added to it here, on its own. A calendar you switch on is read in full and then kept current by Google telling the space
        when it changes.
      </p>
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the calendars">
        {(accounts) => (
          <div data-testid="calendar-accounts" data-count={accounts.length}>
            {accounts.length === 0 && (
              <div className="s-card amber" data-testid="calendar-none">
                <p>
                  No Google account is connected. Connect one in{' '}
                  <a href={settingsPath('mailboxes')} onClick={(e) => follow(e, settingsPath('mailboxes'), go)}>
                    Mailboxes
                  </a>
                  ; Google asks for the calendar permission in the same step.
                </p>
              </div>
            )}
            {accounts.map((a) => (
              <AccountCard key={a.address} a={a} now={now} connectHref={connectPath(idOf(a.address))} calendarHref={connectPath(idOf(a.address), true)} busy={action.busy} onToggle={(id, next) => void toggle(id, next)} />
            ))}
            <div className="s-actions">
              <button type="button" className="btn" disabled={action.busy} onClick={() => void checkNow()} data-testid="calendar-sync">
                Check now
              </button>
            </div>
            <p className="sub cs-foot">
              <Glyph name="lock" size={12} /> The calendar can only read. To remove an account, use Disconnect in{' '}
              <a href={settingsPath('mailboxes')} onClick={(e) => follow(e, settingsPath('mailboxes'), go)}>
                Mailboxes
              </a>
              : one permission serves mail and calendar, so it takes both away.
            </p>
          </div>
        )}
      </Viewed>
      {action.say && <Say say={action.say} />}
      <Done text={action.done} />
    </Block>
  )
}
