// The Calendar tab's Week and Month views. Both draw what the tab already read (the agenda answer for the days
// shown) and read nothing themselves. EVENT TEXT IS UNTRUSTED here as in the agenda: a title is drawn as text, and a block or chip is a link only to the event's card, which is the space's own address.
//
// Week: a time grid, a column a day (seven; three on a phone), an all-day row on top, overlapping events side by side, a line for now, today lit. Month: weeks of days; a day's things are chips coloured by account with
// "+N more" past three, and on a phone a day is its number and a few dots. A booked Meet meeting is drawn grey and is not a link (its Join is in the agenda).
import { useEffect, useRef } from 'react'
import { hueClass, type Go, follow } from './calendar-shared'
import { byDay, cellSplit, LEAST_MINUTES, minutesOnTheWall, placeDay, shortClock, titleOfItem, weekdayOf } from './calendar-grid'
import { type AgendaItem, clock, dayKey, timeRange } from './calendar-words'

export const HOUR_PX = 48
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 24 }, (_, h) => h)
/** The hour a week's grid is scrolled to when today is not in it. */
const FIRST_HOUR = 7

const dayOfMonth = (key: string): number => Number(key.slice(8))

/** The classes that say how the person answered, the same words the agenda's rows use. */
function stateClasses(i: AgendaItem): string[] {
  if (i.kind === 'meeting') return ['meeting']
  const e = i.event
  return [e.response === 'declined' ? 'declined' : '', e.status === 'tentative' || e.response === 'tentative' ? 'tentative' : '', e.stale ? 'stale' : ''].filter(Boolean)
}
const hueOf = (i: AgendaItem): string => (i.kind === 'event' ? hueClass(i.event.accounts[0]?.hue ?? 0) : '')

/** What a thing says when it is hovered, or read by a screen reader: the whole of it, since the block may cut the title short. */
function hover(i: AgendaItem, zone: string): string {
  if (i.kind === 'meeting') return `${i.meeting.title}, ${clock(i.meeting.startsAt, zone)}, a call booked in Meet`
  return `${i.event.title}, ${timeRange(i.event, zone)}`
}

interface ThingProps {
  item: AgendaItem
  zone: string
  hrefFor(id: string): string
  openKey: string | null
  go: Go
  /** The class of the thing's shape: a block of the week, an all-day strip, a month's chip. */
  shape: 'block' | 'strip' | 'chip'
  style?: React.CSSProperties
  extra?: string
}

/** One event or meeting, as a link to its card (an event) or an inert mark (a meeting). */
function Thing({ item, zone, hrefFor, openKey, go, shape, style, extra }: ThingProps) {
  const classes = [`cal-${shape}`, hueOf(item), ...stateClasses(item), extra ?? '', item.allDay ? 'allday' : '', item.kind === 'event' && openKey === item.event.id ? 'current' : ''].filter(Boolean).join(' ')
  const inner =
    shape === 'chip' ? (
      <>
        {!item.allDay && <span className="cal-chip-dot" aria-hidden="true" />}
        {!item.allDay && <span className="cal-chip-time">{shortClock(item.at, zone)}</span>}
        <span className="cal-chip-title">{titleOfItem(item)}</span>
      </>
    ) : shape === 'strip' ? (
      <span className="cal-chip-title">{titleOfItem(item)}</span>
    ) : (
      <>
        <span className="cal-block-title">{titleOfItem(item)}</span>
        <span className="cal-block-time">{clock(item.at, zone)}</span>
      </>
    )
  if (item.kind === 'meeting') {
    return (
      <div className={classes} style={style} title={hover(item, zone)} data-testid="cal-block" data-kind="meeting" data-id={item.meeting.id}>
        {inner}
      </div>
    )
  }
  const href = hrefFor(item.event.id)
  return (
    <a className={classes} style={style} href={href} onClick={(ev) => follow(ev, href, go)} title={hover(item, zone)} data-testid="cal-block" data-kind="event" data-id={item.event.id} aria-current={openKey === item.event.id ? 'true' : undefined}>
      {inner}
    </a>
  )
}

// ── Week ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WeekProps {
  days: readonly string[]
  items: readonly AgendaItem[]
  zone: string
  now: number
  openKey: string | null
  hrefFor(id: string): string
  go: Go
  /** The span read is not the one asked for yet: the grid is drawn empty and dimmed. */
  busy: boolean
}

export function WeekView({ days, items, zone, now, openKey, hrefFor, go, busy }: WeekProps) {
  const today = dayKey(now, zone)
  const scroller = useRef<HTMLDivElement | null>(null)
  const by = byDay(items, days, zone)
  const first = days[0] ?? ''
  const hasToday = days.includes(today)
  // Scrolled to an hour before now when today is in the grid, and to the start of the working day when it is not: moving to another week does not leave the top of the night on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolled when the first day changes; `now` moves every minute and must not.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const hour = hasToday ? Math.max(0, Math.floor(minutesOnTheWall(Date.now(), zone) / 60) - 1) : FIRST_HOUR
    // The hour's line sits just below the day names and the all-day row (which stay on top as the grid scrolls), with room for its label, which is centred on the line.
    el.scrollTop = Math.max(0, hour * HOUR_PX - 12)
  }, [first, hasToday, zone])

  const cols = { gridTemplateColumns: `var(--gutter) repeat(${days.length}, minmax(0, 1fr))` }
  const hasAllDay = days.some((d) => (by.get(d) ?? []).some((i) => i.allDay))
  return (
    <div className={`cal-wk${busy ? ' busy' : ''}`} ref={scroller} data-testid="cal-week" data-days={days.length} aria-busy={busy}>
      <div className="cal-wk-top">
        <div className="cal-wk-row" style={cols}>
          <div />
          {days.map((d) => (
            <div key={d} className={`cal-wk-day${d === today ? ' today' : ''}`} data-day={d} data-testid="cal-week-day" aria-current={d === today ? 'date' : undefined}>
              <span className="cal-wk-dow">{WEEKDAYS[weekdayOf(d)]}</span>
              <span className="cal-wk-num">{dayOfMonth(d)}</span>
            </div>
          ))}
        </div>
        <div className="cal-wk-row cal-wk-allday" style={cols} data-testid="cal-allday" data-empty={!hasAllDay}>
          <div className="cal-wk-label sub">All day</div>
          {days.map((d) => {
            // The row grows with the day that has most: an all-day thing is never hidden behind a count in the week.
            const strips = (by.get(d) ?? []).filter((i) => i.allDay)
            return (
              <div key={d} className={`cal-wk-adcell${d === today ? ' today' : ''}`} data-day={d}>
                {strips.map((i) => (
                  <Thing key={i.kind === 'event' ? i.event.id : i.meeting.id} item={i} zone={zone} hrefFor={hrefFor} openKey={openKey} go={go} shape="strip" />
                ))}
              </div>
            )
          })}
        </div>
      </div>
      <div className="cal-wk-body" style={{ ...cols, height: 24 * HOUR_PX }}>
        <div className="cal-wk-hours" aria-hidden="true">
          {HOURS.slice(1).map((h) => (
            <span key={h} style={{ top: h * HOUR_PX }}>
              {h === 12 ? 'Noon' : `${h % 12} ${h < 12 ? 'AM' : 'PM'}`}
            </span>
          ))}
        </div>
        {days.map((d) => {
          const placed = busy ? [] : placeDay(by.get(d) ?? [], d, zone)
          return (
            <div key={d} className={`cal-wk-col${d === today ? ' today' : ''}`} data-day={d} data-testid="cal-week-col">
              {placed.map((p) => (
                <Thing
                  key={`${p.item.kind === 'event' ? p.item.event.id : p.item.meeting.id}-${d}`}
                  item={p.item}
                  zone={zone}
                  hrefFor={hrefFor}
                  openKey={openKey}
                  go={go}
                  shape="block"
                  extra={p.span <= LEAST_MINUTES ? 'short' : ''}
                  style={{ top: (p.top / 60) * HOUR_PX, height: Math.max((p.span / 60) * HOUR_PX - 2, 16), left: `calc(${(p.col / p.cols) * 100}% + 1px)`, width: `calc(${100 / p.cols}% - 3px)` }}
                />
              ))}
              {d === today && <div className="cal-now" style={{ top: (minutesOnTheWall(now, zone) / 60) * HOUR_PX }} data-testid="cal-now" aria-hidden="true" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Month ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MonthProps {
  /** Whole weeks, Sunday first. */
  days: readonly string[]
  /** The day the address names: on a phone, the one whose things are listed under the grid (and drawn chosen). */
  selected: string
  /** The month shown, as a day of it: days of the neighbouring months are dimmed. */
  month: string
  items: readonly AgendaItem[]
  zone: string
  now: number
  narrow: boolean
  openKey: string | null
  hrefFor(id: string): string
  /** The address of a day: the week of it on a computer, and on a phone the month with that day chosen. */
  dayHref(day: string): string
  go: Go
  busy: boolean
}

const monthOf = (key: string): string => key.slice(0, 7)

export function MonthView({ days, selected, month, items, zone, now, narrow, openKey, hrefFor, dayHref, go, busy }: MonthProps) {
  const today = dayKey(now, zone)
  const by = byDay(busy ? [] : items, days, zone)
  const weeks = Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7))
  const label = (d: string) => (dayOfMonth(d) === 1 ? new Date(Date.UTC(2000, Number(d.slice(5, 7)) - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' }) + ' 1' : String(dayOfMonth(d)))
  return (
    <div className={`cal-mo${narrow ? ' narrow' : ''}${busy ? ' busy' : ''}`} data-testid="cal-month" data-weeks={weeks.length} aria-busy={busy}>
      <div className="cal-mo-head" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w}>{narrow ? w.slice(0, 1) : w}</span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]} className="cal-mo-week" data-testid="cal-month-week">
          {week.map((d) => {
            const things = by.get(d) ?? []
            const classes = ['cal-mo-cell', monthOf(d) !== monthOf(month) ? 'other' : '', d === today ? 'today' : '', narrow && d === selected ? 'selected' : ''].filter(Boolean).join(' ')
            const href = dayHref(d)
            if (narrow) {
              const dots = things.slice(0, 3)
              return (
                <a key={d} className={classes} href={href} onClick={(ev) => follow(ev, href, go)} data-day={d} data-testid="cal-month-day" data-count={things.length} aria-label={`${label(d)}, ${things.length === 0 ? 'nothing on' : `${things.length} thing${things.length === 1 ? '' : 's'}`}`} aria-current={d === today ? 'date' : undefined}>
                  <span className="cal-mo-num">{dayOfMonth(d)}</span>
                  <span className="cal-mo-dots" aria-hidden="true">
                    {dots.map((i) => (
                      <span key={i.kind === 'event' ? i.event.id : i.meeting.id} className={`cal-dot ${hueOf(i)}${i.kind === 'meeting' ? ' meeting' : ''}`} />
                    ))}
                    {things.length > dots.length && <span className="cal-mo-count">+{things.length - dots.length}</span>}
                  </span>
                </a>
              )
            }
            const { shown, more } = cellSplit(things)
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the cell's click is a convenience; the date and "+N more" inside it are the links a keyboard reaches.
              <div
                key={d}
                className={classes}
                data-day={d}
                data-testid="cal-month-day"
                data-count={things.length}
                onClick={(ev) => {
                  if (ev.target === ev.currentTarget) go(href)
                }}
              >
                <a className="cal-mo-num" href={href} onClick={(ev) => follow(ev, href, go)} aria-label={`${label(d)}: open the week`} aria-current={d === today ? 'date' : undefined}>
                  {label(d)}
                </a>
                {shown.map((i) => (
                  <Thing key={`${i.kind === 'event' ? i.event.id : i.meeting.id}-${d}`} item={i} zone={zone} hrefFor={hrefFor} openKey={openKey} go={go} shape="chip" />
                ))}
                {more > 0 && (
                  <a className="cal-more-link" href={href} onClick={(ev) => follow(ev, href, go)} data-testid="cal-day-more">
                    +{more} more
                  </a>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
