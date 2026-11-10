// A zone's clock, written once for the Worker (Today's day, today.ts), the page (a booking's time, client/invite.ts) and the calendar (an all-day event's days, packages/calendar). Pure: no I/O and no imports, so all can use it.
// It lived in the space until the calendar needed it too, and moved here with its importers.

/** What a clock shows: a calendar day and a time of day. */
export interface Wall {
  y: number
  m: number
  d: number
  h: number
  mi: number
}

/** What a clock in `zone` reads at this moment. */
export function wallAt(ms: number, zone: string): Wall & { s: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms)
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') }
}

/** How far the zone's clock is ahead of UTC at this moment, in milliseconds (negative west of Greenwich). */
export function offsetAt(ms: number, zone: string): number {
  const w = wallAt(ms, zone)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000
}

/**
 * The moment a clock in `zone` shows year/month/day/hour/minute. The offset can differ across the day where the clocks change, so it is settled in a few steps. A time the clocks skip is read
 * as the hour after, which is where the clock goes; a time they repeat is the first of the two.
 */
export function momentAt(y: number, m: number, d: number, h: number, mi: number, zone: string): number {
  const asUtc = Date.UTC(y, m - 1, d, h, mi)
  let t = asUtc
  for (let i = 0; i < 3; i++) t = asUtc - offsetAt(t, zone)
  return t
}
