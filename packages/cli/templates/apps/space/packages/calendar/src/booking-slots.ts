/**
 * The starting times a booking link offers (the space's ADR 0025): a pure function of the link's rules, the clock and the times that are not free. No runtime import and no store, so `bun test` drives it with literal rows across zones and a change of the clocks.
 *
 * Every time is worked out on the SERVER from the link's rules on the company's clock; the page only draws the moments it is given, in the visitor's zone.
 *
 * ── WHAT A TIME NEEDS ────────────────────────────────────────────────────
 * It is inside the hours of its weekday (the whole meeting, to its end), no earlier than the least notice and no later than the window ahead, clear of every busy interval by the gap on both sides, and on a day that the link's most-per-day has not filled. A time
 * on a day the clocks change is a time the clock really shows: one the clocks skip is not offered, and one they repeat is offered once, at its first passing.
 */

import { BOOKING_WEEKDAYS, type BookingRules, momentAt, wallAt } from '@space/workspace'

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** The starting times of one day are this far apart: half an hour, or a quarter of one for a meeting shorter than that. */
export const slotStepMinutes = (meetingMinutes: number): number => (meetingMinutes < 30 ? 15 : 30)

/** A stretch of time that is taken (an event that makes the owner busy, or a time another booking holds). */
export interface Busy {
  start: number
  end: number
}

export interface SlotQuery {
  rules: BookingRules
  /** The meeting's length, in minutes. */
  minutes: number
  now: number
  /** The company's time zone, the hours' clock. */
  zone: string
  busy: readonly Busy[]
  /** The starts of the link's bookings that count towards its most-per-day. */
  taken: readonly number[]
}

/** The company-clock day a moment is on, as `YYYY-MM-DD`. */
export function dayOf(ms: number, zone: string): string {
  const w = wallAt(ms, zone)
  return `${String(w.y).padStart(4, '0')}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`
}

/** Busy intervals widened by the gap, in order and with overlaps joined. */
function blockedBy(busy: readonly Busy[], gapMs: number): Busy[] {
  const widened = busy.map((b) => ({ start: b.start - gapMs, end: b.end + gapMs })).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Busy[] = []
  for (const b of widened) {
    const last = out[out.length - 1]
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end)
    else out.push({ ...b })
  }
  return out
}

/** The starting times (moments, in order) a link with these rules offers from now. */
export function slotStarts(q: SlotQuery): number[] {
  const { rules, minutes, now, zone } = q
  const lengthMs = minutes * MIN
  const earliest = now + rules.noticeMinutes * MIN
  const latest = now + rules.aheadDays * DAY
  const blocked = blockedBy(q.busy, rules.gapMinutes * MIN)
  const step = slotStepMinutes(minutes)
  const perDay = new Map<string, number>()
  for (const t of q.taken) perDay.set(dayOf(t, zone), (perDay.get(dayOf(t, zone)) ?? 0) + 1)

  const out: number[] = []
  let at = 0
  const first = wallAt(earliest, zone)
  // Calendar days are walked as plain dates, so the length of a day on which the clocks change never moves one.
  for (let day = Date.UTC(first.y, first.m - 1, first.d); ; day += DAY) {
    const date = new Date(day)
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    if (momentAt(y, m, d, 0, 0, zone) > latest) break
    const key = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (rules.perDay !== null && (perDay.get(key) ?? 0) >= rules.perDay) continue
    const weekday = BOOKING_WEEKDAYS[(date.getUTCDay() + 6) % 7]
    const spans = [...(weekday ? rules.hours[weekday] : [])].sort((a, b) => a.from - b.from)
    for (const span of spans) {
      for (let from = span.from; from + minutes <= span.to; from += step) {
        const start = momentAt(y, m, d, Math.floor(from / 60), from % 60, zone)
        // A time the clocks skip is moved by `momentAt` to the hour after: it is not a time the clock shows.
        const shown = wallAt(start, zone)
        if (shown.d !== d || shown.h !== Math.floor(from / 60) || shown.mi !== from % 60) continue
        if (start < earliest || start > latest) continue
        // Times come in order, so the blocked stretches that ended before this start are behind for good.
        while (at < blocked.length && (blocked[at] as Busy).end <= start) at += 1
        const next = blocked[at]
        if (next !== undefined && next.start < start + lengthMs) continue
        if (out[out.length - 1] === start) continue
        out.push(start)
      }
    }
  }
  return out
}
