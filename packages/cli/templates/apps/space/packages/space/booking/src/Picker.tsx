// The picker: a small month of days, the times of the chosen day, and the zone they are shown in. It draws the starting times the server sent and decides nothing about them: a day with no time is a day the link has none, and a time is a moment.
import { useEffect, useMemo, useState } from 'react'
import { byDay, clock, dayLong, isZone, monthCells, monthName, monthOf, stepMonth, sundayFirst, weekdayNames, zoneName, zoneShort, zonesOf } from './time'

export interface PickerProps {
  starts: readonly number[]
  /** The zone times are drawn in, and the zones the visitor may pick (the first of `zones` are the ones in use). */
  zone: string
  zones: readonly string[]
  onZone(zone: string): void
  /** The time already picked, if any, to show it chosen. */
  picked: number | null
  onPick(start: number): void
  /** What to say when there is no free time at all. */
  none: string
}

export function Picker({ starts, zone, zones, onZone, picked, onPick, none }: PickerProps) {
  const days = useMemo(() => byDay(starts, zone), [starts, zone])
  const keys = useMemo(() => [...days.keys()], [days])
  const [day, setDay] = useState<string | null>(null)
  const [month, setMonth] = useState<{ year: number; month: number } | null>(null)
  const sunday = useMemo(() => sundayFirst(), [])
  const zoneList = useMemo(() => zonesOf(zones).filter(isZone), [zones])

  // The first day with a time is chosen to begin with, so the times are on the screen at once; a day that is still there when the zone changes stays chosen.
  useEffect(() => {
    const first = keys[0]
    if (first === undefined) {
      setDay(null)
      return
    }
    setDay((held) => (held !== null && days.has(held) ? held : first))
    setMonth((held) => held ?? monthOf(first))
  }, [keys, days])

  if (keys.length === 0) return <p className="pk-none" role="status">{none}</p>
  const shown = month ?? monthOf(keys[0] as string)
  const first = monthOf(keys[0] as string)
  const last = monthOf(keys[keys.length - 1] as string)
  const before = shown.year * 12 + shown.month > first.year * 12 + first.month
  const after = shown.year * 12 + shown.month < last.year * 12 + last.month
  const times = day === null ? [] : (days.get(day) ?? [])
  const names = weekdayNames(sunday)

  return (
    <div className="picker">
      <div className="pk-head">
        <button type="button" className="pk-step" aria-label="Previous month" disabled={!before} onClick={() => setMonth(stepMonth(shown, -1))}>
          <span aria-hidden="true">‹</span>
        </button>
        <h2 className="pk-month" aria-live="polite">
          {monthName(shown.year, shown.month)}
        </h2>
        <button type="button" className="pk-step" aria-label="Next month" disabled={!after} onClick={() => setMonth(stepMonth(shown, 1))}>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div className="pk-week" aria-hidden="true">
        {names.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <div className="pk-days" role="group" aria-label="Days with free times">
        {monthCells(shown.year, shown.month, sunday).map((c) => {
          const has = days.get(c.key)
          if (!c.inMonth) return <span key={c.key} className="pk-pad" />
          if (!has) {
            return (
              <span key={c.key} className="pk-day off" aria-hidden="true">
                {c.day}
              </span>
            )
          }
          return (
            <button key={c.key} type="button" className="pk-day" aria-pressed={day === c.key} aria-label={`${dayLong(has[0] as number, zone)}, ${has.length} free time${has.length === 1 ? '' : 's'}`} onClick={() => setDay(c.key)}>
              {c.day}
            </button>
          )
        })}
      </div>
      <div className="pk-times-wrap">
        {day !== null && times[0] !== undefined && <h3 className="pk-day-name">{dayLong(times[0], zone)}</h3>}
        <ul className="pk-times" aria-label="Free times on the chosen day">
          {times.map((t) => (
            <li key={t}>
              <button type="button" className="pk-time" aria-pressed={picked === t} onClick={() => onPick(t)}>
                {clock(t, zone)}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <label className="pk-zone">
        <span>Time zone</span>
        <select value={zone} onChange={(e) => isZone(e.target.value) && onZone(e.target.value)}>
          {zoneList.map((z) => (
            <option key={z} value={z}>
              {zoneName(z)}
            </option>
          ))}
        </select>
        <span className="pk-zone-short">{times[0] !== undefined ? zoneShort(times[0], zone) : ''}</span>
      </label>
    </div>
  )
}
