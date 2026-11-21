// What the booking page does with times: the server sends moments (milliseconds) and the page draws them on the visitor's clock, in the zone the visitor picked. Pure, so a test can drive it with literal moments in any zone.
// Nothing here computes what is free: every starting time is the server's (the space's ADR 0025).

/** The visitor's own zone, or the company's where the browser will not say. */
export function ownZone(fallback: string): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || fallback
  } catch {
    return fallback
  }
}

/** The zones offered where the browser cannot list its own (an old one): the common ones, which a person picks from when their own is not the one they want. */
const COMMON_ZONES = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Halifax',
  'America/Sao_Paulo',
  'Atlantic/Reykjavik',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Athens',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

/** Every zone the browser knows, with the ones in use first and whatever the browser does not list added. */
export function zonesOf(also: readonly string[]): string[] {
  let all: string[] = []
  try {
    all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    all = []
  }
  return [...new Set([...also, ...(all.length > 0 ? all : COMMON_ZONES)])]
}

/** Whether a zone is one the browser can draw times in (a stranger's text is never trusted to be one). */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** A zone for reading: `America/Los_Angeles` as `America / Los Angeles`. */
export const zoneName = (zone: string): string => zone.replaceAll('_', ' ').replaceAll('/', ' / ')

/** The day a moment is on in a zone, as `YYYY-MM-DD`. */
export function dayKey(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

/** The times of each day in a zone, in order: `YYYY-MM-DD` to the moments on that day. */
export function byDay(starts: readonly number[], zone: string): Map<string, number[]> {
  const days = new Map<string, number[]>()
  for (const t of [...starts].sort((a, b) => a - b)) {
    const key = dayKey(t, zone)
    const held = days.get(key)
    if (held) held.push(t)
    else days.set(key, [t])
  }
  return days
}

/** A time of day: `4:30 PM`. */
export const clock = (ms: number, zone: string): string => new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(ms)

/** A whole day, for a heading: `Thursday, 5 November`. */
export const dayLong = (ms: number, zone: string): string => new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' }).format(ms)

/** A day with its year, for a record that will be read later: `Thursday, 5 November 2026`. */
export const dayFull = (ms: number, zone: string): string => new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(ms)

/** A month for a heading: `November 2026`. */
export const monthName = (year: number, month: number): string => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(Date.UTC(year, month - 1, 1))

/** `4:00 PM to 4:30 PM`. */
export const span = (start: number, end: number, zone: string): string => `${clock(start, zone)} to ${clock(end, zone)}`

/** A zone's short name at a moment (`PST`, `GMT+5:30`), so a time is never read in the wrong zone. */
export function zoneShort(ms: number, zone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')
  return part?.value ?? zone
}

/** How a zone is named beside a time, once: `PST, America / Los Angeles`, or `UTC` where the two say the same. */
export function zoneLabel(ms: number, zone: string): string {
  const short = zoneShort(ms, zone)
  const long = zoneName(zone)
  return short === long ? short : `${short}, ${long}`
}

export interface Cell {
  /** `YYYY-MM-DD`. */
  key: string
  day: number
  /** Whether this day is in the month drawn (the cells before and after it fill the weeks). */
  inMonth: boolean
}

/** The weeks of a month for a grid of seven columns, from the first day of the week to the last. `sundayFirst` says which day the week begins on. */
export function monthCells(year: number, month: number, sundayFirst: boolean): Cell[] {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const lead = (first.getUTCDay() + (sundayFirst ? 0 : 6)) % 7
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const total = Math.ceil((lead + days) / 7) * 7
  const cells: Cell[] = []
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i))
    cells.push({ key: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month - 1 })
  }
  return cells
}

/** The names of the seven days, one letter or short, in the order the week is drawn. */
export function weekdayNames(sundayFirst: boolean): string[] {
  const names: string[] = []
  for (let i = 0; i < 7; i++) names.push(new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short' }).format(Date.UTC(2026, 10, (sundayFirst ? 1 : 2) + i)))
  return names
}

/** Whether the visitor's week begins on Sunday: the browser's own word where it has one, else by the usual places. */
export function sundayFirst(): boolean {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const info = locale.getWeekInfo?.() ?? locale.weekInfo
    if (info) return info.firstDay === 7
    return /^(en-US|en-CA|es-MX|pt-BR|ja|he|ar)/i.test(navigator.language)
  } catch {
    return false
  }
}

/** The year and month of a `YYYY-MM-DD`. */
export function monthOf(key: string): { year: number; month: number } {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }
}

/** The month after (`step` 1) or before (`step` -1). */
export function stepMonth(m: { year: number; month: number }, step: number): { year: number; month: number } {
  const d = new Date(Date.UTC(m.year, m.month - 1 + step, 1))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}
