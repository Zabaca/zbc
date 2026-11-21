// Settings, Calendars: the booking links (the space's ADR 0025). Each link is a page where a visitor with no sign-in picks a free time; a booking becomes an event on the link's account with a Google Meet link, and Google sends the invitation in the owner's name.
// The owner makes, changes, turns off and deletes links here, copies a link's address, and reads what each link did: who booked, when, and when it was booked. Nothing here asks Google: a link is a setting, and no event is made until a visitor books.
//
// What a visitor typed (a name, an email, a note) is drawn as text, never as markup.
import { type ReactNode, useState } from 'react'
import {
  BOOKING_LIMITS,
  BOOKING_WEEKDAYS,
  type BookingHours,
  type BookingLinkInput,
  type BookingLinkView,
  type BookingRecord,
  type BookingWeekday,
  type CalendarBookingLinks,
} from '@space/workspace'
import { useFresh } from './liveHub'
import { Ask, Done, Say, Switch, useAction, Viewed, when } from './settings-parts'
import { postView, useView } from './views'

const DAY_NAMES: Record<BookingWeekday, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

/** Minutes after midnight as `HH:MM` (what a time box takes), and back. 1440 is the end of the day. */
const hhmm = (minutes: number): string => (minutes >= 1440 ? '23:59' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`)
const minutesOf = (text: string): number => {
  const [h = '0', m = '0'] = text.split(':')
  const total = Number(h) * 60 + Number(m)
  return total >= 1439 ? 1440 : total
}

/** The hours of a week as a person reads them: `Mon to Fri 9:00 AM to 5:00 PM`, or the days one by one when they differ. */
export function hoursText(hours: BookingHours): string {
  const time = (m: number) => {
    const h = Math.floor(m / 60) % 24
    return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
  }
  const spans = (day: BookingWeekday) => hours[day].map((s) => `${time(s.from)} to ${time(s.to)}`).join(' and ')
  const groups: { days: BookingWeekday[]; text: string }[] = []
  for (const day of BOOKING_WEEKDAYS) {
    const text = spans(day)
    if (text === '') continue
    const last = groups[groups.length - 1]
    if (last && last.text === text && BOOKING_WEEKDAYS.indexOf(last.days[last.days.length - 1] as BookingWeekday) === BOOKING_WEEKDAYS.indexOf(day) - 1) last.days.push(day)
    else groups.push({ days: [day], text })
  }
  const short = (d: BookingWeekday) => DAY_NAMES[d].slice(0, 3)
  return groups.map((g) => `${g.days.length === 1 ? short(g.days[0] as BookingWeekday) : `${short(g.days[0] as BookingWeekday)} to ${short(g.days[g.days.length - 1] as BookingWeekday)}`} ${g.text}`).join('; ')
}

const lengthText = (minutes: number): string => (minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`)
/** `1 day’s notice`, `4 hours’ notice`, `90 minutes’ notice`. */
const noticeText = (minutes: number): string => {
  const unit = (n: number, one: string): string => (n === 1 ? `${n} ${one}’s notice` : `${n} ${one}s’ notice`)
  return minutes === 0 ? 'no notice needed' : minutes % 1440 === 0 ? unit(minutes / 1440, 'day') : minutes % 60 === 0 ? unit(minutes / 60, 'hour') : unit(minutes, 'minute')
}

/** A time on the company's clock, with the day and the zone, for the record of a booking: `Fri, Nov 6, 10:00 AM PST`. */
const timeIn = (at: number, zone: string): string => {
  try {
    return `${new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(at)}, ${new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at)}`
  } catch {
    return when(at)
  }
}

const STATE_TEXT: Record<BookingRecord['state'], string> = { booked: 'On the calendar', pending: 'Waiting for Google', cancelled: 'Cancelled by the visitor', removed: 'Removed from the calendar' }

/** The fields of the form, as text a person edits. */
interface Draft {
  slug: string
  name: string
  description: string
  account: string
  minutes: string
  hours: Record<BookingWeekday, { from: string; to: string }[]>
  notice: string
  ahead: string
  gap: string
  perDay: string
  enabled: boolean
}

const draftOf = (input: BookingLinkInput | (CalendarBookingLinks['defaults'] & { slug?: string; name?: string; description?: string; account?: string; enabled?: boolean })): Draft => ({
  slug: input.slug ?? '',
  name: input.name ?? '',
  description: input.description ?? '',
  account: input.account ?? '',
  minutes: String(input.minutes),
  hours: Object.fromEntries(BOOKING_WEEKDAYS.map((d) => [d, input.hours[d].map((s) => ({ from: hhmm(s.from), to: hhmm(s.to) }))])) as Draft['hours'],
  notice: String(input.noticeMinutes / 60),
  ahead: String(input.aheadDays),
  gap: String(input.gapMinutes),
  perDay: input.perDay === null ? '' : String(input.perDay),
  enabled: input.enabled ?? true,
})

/** The link the draft says, as the calendar takes it. A field that is not a number is sent as one the calendar refuses in words. */
const inputOf = (d: Draft): BookingLinkInput => ({
  slug: d.slug.trim(),
  name: d.name,
  description: d.description,
  account: d.account,
  minutes: Number(d.minutes),
  hours: Object.fromEntries(BOOKING_WEEKDAYS.map((day) => [day, d.hours[day].map((s) => ({ from: minutesOf(s.from), to: minutesOf(s.to) }))])) as BookingHours,
  noticeMinutes: Math.round(Number(d.notice) * 60),
  aheadDays: Number(d.ahead),
  gapMinutes: Number(d.gap),
  perDay: d.perDay.trim() === '' ? null : Number(d.perDay),
  enabled: d.enabled,
})

/** A link's own fields back as the calendar takes them (what the quick on and off sends). */
const inputOfView = (l: BookingLinkView): BookingLinkInput => ({ slug: l.slug, name: l.name, description: l.description, account: l.account, minutes: l.minutes, hours: l.hours, noticeMinutes: l.noticeMinutes, aheadDays: l.aheadDays, gapMinutes: l.gapMinutes, perDay: l.perDay, enabled: l.enabled })

function BookingRow({ b, zone }: { b: BookingRecord; zone: string }) {
  return (
    <li className="cs-bk" data-testid="booking-row" data-state={b.state}>
      <span className="cs-bk-who">
        <strong>{b.name}</strong> <span className="sub">{b.email}</span>
      </span>
      <span className="cs-bk-when">{timeIn(b.start, zone)}</span>
      <span className={`kindtag cs-bk-state ${b.state}`}>{STATE_TEXT[b.state]}</span>
      <span className="sub cs-bk-at">
        Booked {when(b.bookedAt)}
        {b.checked === 'copy' && ' (checked against the calendar’s own copy for an account Google could not be asked about)'}
      </span>
      {b.note !== null && <span className="sub cs-bk-note">“{b.note}”</span>}
      {b.link !== null && (
        <a className="sub cs-bk-link" href={b.link} target="_blank" rel="noopener noreferrer">
          Open in Google Calendar
        </a>
      )}
    </li>
  )
}

function HoursEditor({ draft, set, disabled }: { draft: Draft; set(next: Draft): void; disabled: boolean }) {
  return (
    <fieldset className="cs-hours">
      <legend>Hours it can be booked (on the company’s clock)</legend>
      {BOOKING_WEEKDAYS.map((day) => (
        <div className="cs-hours-day" key={day} data-testid="booking-day" data-day={day}>
          <span className="cs-hours-name">{DAY_NAMES[day]}</span>
          <div className="cs-hours-spans">
            {draft.hours[day].length === 0 && <span className="sub">Closed</span>}
            {draft.hours[day].map((s, i) => (
              <span className="cs-span" key={`${day}-${i}`}>
                <input type="time" step={300} aria-label={`${DAY_NAMES[day]} opens`} value={s.from} disabled={disabled} onChange={(e) => set({ ...draft, hours: { ...draft.hours, [day]: draft.hours[day].map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) } })} />
                <span aria-hidden="true">to</span>
                <input type="time" step={300} aria-label={`${DAY_NAMES[day]} closes`} value={s.to} disabled={disabled} onChange={(e) => set({ ...draft, hours: { ...draft.hours, [day]: draft.hours[day].map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) } })} />
                <button type="button" className="linkish" aria-label={`Remove these hours on ${DAY_NAMES[day]}`} disabled={disabled} onClick={() => set({ ...draft, hours: { ...draft.hours, [day]: draft.hours[day].filter((_, j) => j !== i) } })}>
                  Remove
                </button>
              </span>
            ))}
            {draft.hours[day].length < BOOKING_LIMITS.spansPerDayMax && (
              <button type="button" className="linkish" disabled={disabled} onClick={() => set({ ...draft, hours: { ...draft.hours, [day]: [...draft.hours[day], draft.hours[day].length === 0 ? { from: '09:00', to: '17:00' } : { from: draft.hours[day][draft.hours[day].length - 1]?.to ?? '13:00', to: '17:00' }] } })}>
                {draft.hours[day].length === 0 ? 'Open this day' : 'Add hours'}
              </button>
            )}
          </div>
        </div>
      ))}
    </fieldset>
  )
}

function LinkForm({ links, id, initial, busy, onSave, onCancel }: { links: CalendarBookingLinks; id: string | null; initial: Draft; busy: boolean; onSave(input: BookingLinkInput): void; onCancel(): void }) {
  const [d, setD] = useState<Draft>(initial)
  const field = <K extends keyof Draft>(key: K) => ({
    value: d[key] as string,
    disabled: busy,
    onChange: (e: { target: { value: string } }) => setD({ ...d, [key]: e.target.value }),
  })
  return (
    <form
      className="s-form cs-booking-form"
      data-testid="booking-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(inputOf(d))
      }}
    >
      <label className="s-field">
        <span>Name (what the visitor reads, and the title of the event with their name)</span>
        <input type="text" name="name" maxLength={BOOKING_LIMITS.nameMax} placeholder="Intro call" data-testid="booking-name" {...field('name')} />
      </label>
      <label className="s-field">
        <span>Address (the last part of the link)</span>
        <span className="cs-slug">
          <code>{links.origin}/book/</code>
          <input type="text" name="slug" maxLength={BOOKING_LIMITS.slugMax} placeholder="intro-call" autoCapitalize="none" spellCheck={false} data-testid="booking-slug" {...field('slug')} />
        </span>
      </label>
      <label className="s-field">
        <span>What it is for (a few lines a visitor reads)</span>
        <textarea name="description" rows={3} maxLength={BOOKING_LIMITS.descriptionMax} data-testid="booking-description" {...field('description')} />
      </label>
      <label className="s-field">
        <span>Make the event on this account’s own calendar</span>
        <select name="account" disabled={busy} value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })} data-testid="booking-account">
          <option value="" disabled>
            Choose an account
          </option>
          {links.accounts.map((a) => (
            <option key={a.address} value={a.address}>
              {a.address}
              {a.canBook ? '' : ' (cannot be booked now)'}
            </option>
          ))}
        </select>
        {d.account !== '' && links.accounts.find((a) => a.address === d.account)?.why != null && <span className="cs-problem">{links.accounts.find((a) => a.address === d.account)?.why}</span>}
      </label>
      <div className="cs-nums">
        <label className="s-field">
          <span>Length, minutes</span>
          <input type="number" name="minutes" min={BOOKING_LIMITS.minutesMin} max={BOOKING_LIMITS.minutesMax} step={5} data-testid="booking-minutes" {...field('minutes')} />
        </label>
        <label className="s-field">
          <span>Least notice, hours</span>
          <input type="number" name="notice" min={0} step={0.5} data-testid="booking-notice" {...field('notice')} />
        </label>
        <label className="s-field">
          <span>How far ahead, days</span>
          <input type="number" name="ahead" min={1} max={BOOKING_LIMITS.aheadMaxDays} data-testid="booking-ahead" {...field('ahead')} />
        </label>
        <label className="s-field">
          <span>Gap around other meetings, minutes</span>
          <input type="number" name="gap" min={0} max={BOOKING_LIMITS.gapMaxMinutes} step={5} data-testid="booking-gap" {...field('gap')} />
        </label>
        <label className="s-field">
          <span>Most in a day (blank: no limit)</span>
          <input type="number" name="perDay" min={1} max={BOOKING_LIMITS.perDayMax} data-testid="booking-perday" {...field('perDay')} />
        </label>
      </div>
      <HoursEditor draft={d} set={setD} disabled={busy} />
      <label className="cs-cal cs-tick">
        <input type="checkbox" checked={d.enabled} disabled={busy} onChange={(e) => setD({ ...d, enabled: e.target.checked })} data-testid="booking-enabled" />
        <span>On: visitors can book it</span>
      </label>
      <div className="s-actions">
        <button type="submit" className="btn primary" disabled={busy} data-testid="booking-save">
          {id === null ? 'Make the link' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel} data-testid="booking-cancel">
          Cancel
        </button>
      </div>
    </form>
  )
}

function LinkItem({ l, zone, busy, editing, asking, onCopy, onEdit, onSwitch, onAskDelete, children }: { l: BookingLinkView; zone: string; busy: boolean; editing: boolean; asking: boolean; onCopy(): void; onEdit(): void; onSwitch(next: boolean): void; onAskDelete(): void; children?: ReactNode }) {
  const upcoming = l.bookings.filter((b) => b.end > Date.now() && b.state !== 'cancelled' && b.state !== 'removed')
  return (
    <li className={`cs-link${l.enabled ? '' : ' off'}`} data-testid="booking-link" data-id={l.id} data-slug={l.slug} data-on={l.enabled}>
      <div className="cs-link-head">
        <span className="cs-name">
          <strong>{l.name}</strong>
          <code className="cs-url" data-testid="booking-url">
            {l.url}
          </code>
          <span className="sub">
            {lengthText(l.minutes)}, on {l.account}. {hoursText(l.hours) || 'No hours set'}; {noticeText(l.noticeMinutes)}, up to {l.aheadDays} days ahead, {l.gapMinutes === 0 ? 'no gap' : `a ${l.gapMinutes} minute gap`}
            {l.perDay === null ? '' : `, at most ${l.perDay} a day`}.
          </span>
        </span>
        <Switch on={l.enabled} label={`${l.name} is on`} busy={busy} onChange={onSwitch} testid="booking-switch" />
      </div>
      {l.problem !== null && (
        <p className="s-warn" role="status" data-testid="booking-problem">
          {l.enabled ? 'It cannot be booked right now: ' : 'When it is turned on it cannot be booked until this is put right: '}
          {l.problem}
        </p>
      )}
      <div className="s-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCopy} data-testid="booking-copy">
          Copy address
        </button>
        <button type="button" className="btn" disabled={busy || editing} onClick={onEdit} data-testid="booking-edit">
          Edit
        </button>
        <button type="button" className="btn danger" disabled={busy || asking} onClick={onAskDelete} data-testid="booking-delete">
          Delete
        </button>
      </div>
      {children}
      <div className="cs-bookings">
        <h4 className="cs-bk-h">
          Bookings <span className="sub">{upcoming.length === 0 ? 'none coming up' : `${upcoming.length} coming up`}</span>
        </h4>
        {l.bookings.length === 0 ? (
          <p className="sub" data-testid="booking-none">
            Nobody has booked this link yet.
          </p>
        ) : (
          <ul className="cs-bks">
            {l.bookings.map((b) => (
              <BookingRow key={b.id} b={b} zone={zone} />
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

/** The Booking links card. */
export function BookingLinksCard() {
  const view = useView<CalendarBookingLinks>('calendar/booking-links')
  // A booking is told to the page the moment the calendar has it, so a visitor's booking shows here as it is made.
  useFresh(['calendar'], () => view.reload())
  const action = useAction()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const save = async (id: string | null, input: BookingLinkInput) => {
    const ok = await action.run(
      () => (id === null ? postView<BookingLinkView>('calendar/booking-links/make', input) : postView<BookingLinkView>('calendar/booking-links/change', { id, link: input })),
      (l) => (id === null ? `The link is made: ${l.url}. It is on, and nothing is public until a visitor opens it.` : `Saved. ${l.name} is ${l.enabled ? 'on' : 'off'}.`),
    )
    if (ok) setEditing(null)
    view.reload()
  }
  const toggle = async (l: BookingLinkView, enabled: boolean) => {
    await action.run(() => postView<BookingLinkView>('calendar/booking-links/change', { id: l.id, link: { ...inputOfView(l), enabled } }), enabled ? `${l.name} is on: visitors can book it.` : `${l.name} is off: it takes no new booking, and bookings already made stay as events.`)
    view.reload()
  }
  const remove = async (l: BookingLinkView) => {
    const ok = await action.run(() => postView<{ id: string }>('calendar/booking-links/delete', { id: l.id }), `${l.name} is deleted. The bookings it made stay as events.`)
    if (ok) setAsking(null)
    view.reload()
  }
  const copy = async (l: BookingLinkView) => {
    try {
      await navigator.clipboard.writeText(l.url)
      setCopied(`Copied ${l.url}`)
      return
    } catch {
      // Where the browser will not let the page write to the clipboard, the address is selected, and Copy is the person's own.
    }
    const el = document.querySelector(`[data-id="${l.id}"] [data-testid="booking-url"]`)
    if (el) window.getSelection()?.selectAllChildren(el)
    setCopied(`The address is selected: copy it (${/Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'} and C).`)
  }

  return (
    <section className="s-card cs-booking" aria-label="Booking links" data-testid="booking-links">
      <h3 className="s-sub">Booking links</h3>
      <p className="sub cs-lead">
        Send someone a link and they pick a free time themselves, with no sign-in. A booking is an event on the link’s account, with a Google Meet link, and Google sends the invitation in your name. A visitor sees only that a time is free, never what you are doing. The times
        come from every connected calendar, and Google is asked again at the moment of booking. A link that is on is your word for the events it makes; turn it off and it takes no new booking.
      </p>
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the booking links">
        {(v) => (
          <>
            {v.links.length === 0 && editing !== 'new' && (
              <p className="sub" data-testid="booking-empty">
                No booking links yet. Nothing is public until you make one.
              </p>
            )}
            {v.links.length > 0 && (
              <ul className="cs-links" aria-label="Your booking links">
                {v.links.map((l) => (
                  <LinkItem
                    key={l.id}
                    l={l}
                    zone={v.zone}
                    busy={action.busy}
                    editing={editing === l.id}
                    asking={asking === l.id}
                    onCopy={() => void copy(l)}
                    onEdit={() => {
                      action.clear()
                      setEditing(l.id)
                    }}
                    onSwitch={(next) => void toggle(l, next)}
                    onAskDelete={() => setAsking(l.id)}
                  >
                    {editing === l.id && <LinkForm links={v} id={l.id} initial={draftOf(inputOfView(l))} busy={action.busy} onSave={(input) => void save(l.id, input)} onCancel={() => setEditing(null)} />}
                    {asking === l.id && (
                      <Ask question={`Delete ${l.name}?`} yes="Delete it" danger busy={action.busy} onYes={() => void remove(l)} onNo={() => setAsking(null)}>
                        <p className="sub">The address stops working at once and takes no new booking. The meetings it made stay on your calendar as ordinary events, and their visitors can still cancel from their invitation.</p>
                      </Ask>
                    )}
                  </LinkItem>
                ))}
              </ul>
            )}
            {editing === 'new' ? (
              <LinkForm links={v} id={null} initial={draftOf({ ...v.defaults, account: v.accounts.find((a) => a.canBook)?.address ?? v.accounts[0]?.address ?? '', enabled: true })} busy={action.busy} onSave={(input) => void save(null, input)} onCancel={() => setEditing(null)} />
            ) : (
              <div className="s-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={action.busy || v.accounts.length === 0}
                  onClick={() => {
                    action.clear()
                    setEditing('new')
                  }}
                  data-testid="booking-new"
                >
                  New booking link
                </button>
                {v.accounts.length === 0 && <span className="sub">Connect a Google account first.</span>}
              </div>
            )}
          </>
        )}
      </Viewed>
      {copied !== null && (
        <p className="cnotice ok" role="status" data-testid="booking-copied">
          {copied}
        </p>
      )}
      {action.say && <Say say={action.say} />}
      <Done text={action.done} />
    </section>
  )
}
