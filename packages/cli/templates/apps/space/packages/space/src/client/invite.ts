// What a call card and a booking say, as plain functions: how long a call ran, a meeting's time on the company's clock, the time a person typed read in that
// clock, and the invitation text that goes into the email being written. No React and no clock, so the wording is checked on its own (test/invite.test.ts).
//
// THE INVITATION IS TEXT FOR A PERSON TO SEND. Nothing here sends anything: it is put in the reply box of the email conversation, where the inbox's own send
// (Send, with its compose key and every rule it has) goes out only when the person presses it (and Claude never sends).
import type { MeetCall } from '@space/workspace'
import { type Wall, momentAt, wallAt } from '@space/workspace'

const MIN = 60_000

/** "12 min", "1 h 05 min", "under a minute": how long a call ran. */
export function lengthWords(ms: number): string {
  const minutes = Math.round(ms / MIN)
  if (ms < 45_000 || minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`
}

/** How long a call ran, from its first seat to its last leave; null where either is not known. */
export const ranFor = (call: Pick<MeetCall, 'openedAt' | 'endedAt'>): number | null => (call.openedAt !== null && call.endedAt !== null && call.endedAt >= call.openedAt ? call.endedAt - call.openedAt : null)

// ── The company's clock ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The moment a clock in `zone` shows `wall` (the clock itself is `zoned.ts` in the company layer, packages/workspace/src, which Today's day and the calendar use too). */
export const epochAt = (wall: Wall, zone: string): number => momentAt(wall.y, wall.m, wall.d, wall.h, wall.mi, zone)

/** Read what a `datetime-local` box holds ("2026-11-03T14:00") as a time in the zone; null for anything else. */
export function parseLocal(value: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const wall: Wall = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) }
  if (wall.m < 1 || wall.m > 12 || wall.d < 1 || wall.d > 31 || wall.h > 23 || wall.mi > 59) return null
  const at = epochAt(wall, zone)
  // A day that does not exist (February 30th) came back as another one: not that day.
  const back = wallAt(at, zone)
  return back.d === wall.d && back.m === wall.m ? at : null
}

/** The value a `datetime-local` box shows for a moment read in the zone ("2026-11-03T14:00"): the box's own starting point. */
export function toLocal(ms: number, zone: string): string {
  const w = wallAt(ms, zone)
  const p = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${p(w.y, 4)}-${p(w.m)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`
}

/** "Tue, Nov 3, 2:00 PM PST": a meeting's time, on the company's clock, with the zone named. */
export function whenWords(ms: number, zone: string): string {
  const day = new Date(ms).toLocaleDateString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' })
  const time = new Date(ms).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  return `${day}, ${time}`
}

// ── What a card says ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The card's name for what it is: "huddle" with teammates in a direct message or channel, "call" with outside people by link. */
export const CARD_LABEL: Record<MeetCall['kind'], string> = { huddle: 'Huddle', link: 'Call', new: 'Call', meeting: 'Meeting' }

/**
 * The link Join opens: the call's own link, with the person's name on it so the lobby is not asked for one. Copy link copies `call.link` as it is. The name only
 * fills a box the person can still change.
 */
export function joinHref(call: Pick<MeetCall, 'link'>, name: string): string {
  const url = new URL(call.link)
  if (name.trim() !== '') url.searchParams.set('as', name.trim().slice(0, 40))
  return url.toString()
}

// ── The invitation ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The text of the invitation for the email being written: what the meeting is, when (on the company's clock, the zone named), and its link. It starts a new
 * paragraph where the person already typed something, so it never overwrites their words. `to` is who the email is to, by first name, or none.
 */
export function invitationText(o: { title: string; startsAt: number; zone: string; link: string; to?: string | null }): string {
  const hello = o.to ? `Hi ${o.to.split(/\s+/)[0]},\n\n` : ''
  return `${hello}I have set up "${o.title}" for ${whenWords(o.startsAt, o.zone)}. You can join from any browser, with no account, at:\n\n${o.link}\n\nThe link works from now on. Reply here if the time does not suit you.`
}

/** The reply box's text with a block added under what is there (a call link, an invitation): after a blank line when there is something already, and alone when not. */
export function withBlock(text: string, block: string): string {
  const held = text.replace(/\s+$/, '')
  return held === '' ? block : `${held}\n\n${block}`
}

/** The text a call link adds to the email: the link alone, with a line to say what it is. */
export const callLinkText = (link: string): string => `You can join a call with me from any browser, with no account, at:\n\n${link}`
