// The booking door: the calendar's public API on the open path `/book/api/...` (the space's ADR 0025), for the visitor of a booking link and for nobody else.
//
//   GET  /book/api/links/<name>              the link: its company, name, description and length, and whether it can be booked now
//   GET  /book/api/links/<name>/slots        the free starting times (moments), from now to the end of the link's window
//   POST /book/api/links/<name>/book         {start, name, email, note}: take a time, and the booking's own secret comes back, once
//   GET  /book/api/manage/<secret>           a booking, by the secret only its visitor has
//   GET  /book/api/manage/<secret>/slots     the times it can be moved to
//   POST /book/api/manage/<secret>/move      {start}
//   POST /book/api/manage/<secret>/cancel
//
// WHO IS ASKING is nobody the space knows: the team's sign-in is not read here (src/guests.ts hands this door the request without it), and what lets a visitor do anything is the link's name (public) or a booking's secret (the calendar checks both, and keeps
// only a hash of the second). The calendar decides every rule; this file carries the request in and the answer out, and keeps three things out of the calendar's way:
//
//  - A WRITE FROM ANOTHER SITE is refused (the same check forms' public API makes: a browser says `Sec-Fetch-Site`, and `Origin` on every write), so a page elsewhere cannot make a visitor's browser book for them.
//  - A FLOOD is refused before it costs the calendar's object a request: the per-caller limit forms' public API already uses (`PUBLIC_LIMIT`), keyed by network address, and a hidden field a person never fills that a script usually does.
//  - NOTHING OF THE CALENDAR'S WORDS GOES THROUGH UNREAD: the calendar's answer is passed on as it is, and a fault is the calendar's own fixed sentence.
//
// The visitor's network address is given to the calendar for its limits (it keeps only a keyed hash) and is never in an answer. Every answer is `no-store`.

import { networkKeyOf } from '@space/calendar/src/bookings'
import { type CalendarForGuests, type RefusalReason, type SpaceReply } from '@space/workspace'
import { isRecord } from './guards'

export interface BookingDoorDeps {
  /** The calendar's third face. */
  face: CalendarForGuests
  /** The per-caller limit of the public APIs (Cloudflare's rate-limiting binding): absent in a local run, where nothing is limited. */
  limit?: { limit(options: { key: string }): Promise<{ success: boolean }> } | undefined
}

/** The most a request's body is read from: a booking is a few hundred characters of words. */
export const BOOKING_BODY_MAX = 8_000

const NO_STORE = { 'cache-control': 'no-store' }
const answer = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } })

const STATUS: Record<RefusalReason, number> = { 'not-signed-in': 401, 'not-admitted': 403, 'not-found': 404, 'bad-request': 400, conflict: 409, limit: 429 }

/** A link's name in a path, and a booking's secret: the shapes the calendar makes them in, so a path-shaped or enormous string never reaches it. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SECRET = /^[A-Za-z0-9_-]{8,200}$/

const clientIp = (req: Request): string => req.headers.get('cf-connecting-ip') ?? 'local'

/** What the calendar answered, as a response: the value, or the refusal in its own words under its own status. */
function reply<T>(r: SpaceReply<T>): Response {
  if (r.ok) return answer(200, { value: r.value })
  if (r.kind === 'refused') return answer(STATUS[r.reason], { error: r.message, reason: r.reason }, r.reason === 'limit' ? { 'retry-after': '3600' } : {})
  return answer(500, { error: r.message })
}

/** A write from a page on another site is refused: a browser says so on every one. */
function crossSite(req: Request): boolean {
  const origin = req.headers.get('origin')
  return req.headers.get('sec-fetch-site') === 'cross-site' || (origin !== null && origin !== new URL(req.url).origin)
}

async function bodyOf(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > BOOKING_BODY_MAX) return { ok: false, response: answer(413, { error: 'That is too much to send.' }) }
  const raw = await req.text()
  if (raw.length > BOOKING_BODY_MAX) return { ok: false, response: answer(413, { error: 'That is too much to send.' }) }
  try {
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, response: answer(400, { error: 'Send a JSON object.', reason: 'bad-request' }) }
  } catch {
    return { ok: false, response: answer(400, { error: 'Send a JSON object.', reason: 'bad-request' }) }
  }
}

/**
 * The answer for a request under `/book/api/`. 404 for a path that is no call of this API, 405 for a method it does not take, 403 for a write from another site, 429 past the limit, and otherwise the calendar's own answer.
 * The request is handed here without the team's sign-in (`asGuest`, src/guests.ts).
 */
export async function bookingAnswer(req: Request, deps: BookingDoorDeps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^\/book\/api/, '').split('/').filter((x) => x !== '')
  const [kind, name, action, ...extra] = path
  const method = req.method.toUpperCase()
  if (extra.length > 0 || (kind !== 'links' && kind !== 'manage') || name === undefined) return answer(404, { error: 'Not found' })
  if (kind === 'links' ? !SLUG.test(name) : !SECRET.test(name)) return answer(404, { error: 'Not found' })
  const read = method === 'GET' || method === 'HEAD'
  const calls: Record<string, { method: 'GET' | 'POST'; run: () => Promise<Response> }> = {}
  const one = (key: string, m: 'GET' | 'POST', run: () => Promise<Response>) => (calls[key] = { method: m, run })

  // The shape of each call, by `<kind>/<action>`: what it takes and what it asks of the calendar.
  if (kind === 'links') {
    one('', 'GET', async () => reply(await deps.face.link(name)))
    one('slots', 'GET', async () => reply(await deps.face.slots(name)))
    one('book', 'POST', async () => {
      const body = await bodyOf(req)
      if (!body.ok) return body.response
      const { website, ...asked } = body.value
      // A hidden field a person never sees: a script that fills every field has filled this one.
      if (typeof website === 'string' && website.trim() !== '') return answer(400, { error: 'That could not be booked.', reason: 'bad-request' })
      return reply(await deps.face.book(name, asked as never, clientIp(req)))
    })
  } else {
    one('', 'GET', async () => reply(await deps.face.booking(name)))
    one('slots', 'GET', async () => reply(await deps.face.bookingSlots(name)))
    one('move', 'POST', async () => {
      const body = await bodyOf(req)
      if (!body.ok) return body.response
      return reply(await deps.face.move(name, body.value.start as never))
    })
    one('cancel', 'POST', async () => reply(await deps.face.cancel(name)))
  }
  const call = calls[action ?? '']
  if (!call) return answer(404, { error: 'Not found' })
  if (call.method === 'GET' ? !read : method !== 'POST') return answer(405, { error: 'Method not allowed' }, { allow: call.method === 'GET' ? 'GET, HEAD' : 'POST' })
  if (call.method === 'POST' && crossSite(req)) return answer(403, { error: 'That did not come from this page.' })
  const limited = await deps.limit?.limit({ key: `book:${networkKeyOf(clientIp(req))}` })
  if (limited && !limited.success) return answer(429, { error: 'Too many requests. Please wait a minute and try again.', reason: 'limit' }, { 'retry-after': '60' })
  try {
    return await call.run()
  } catch (error) {
    // The face answers faults as data; this is the one thing it could not (a stub that threw before it was asked). Never the request: a secret is in it.
    console.error('booking door failed', error instanceof Error ? error.message : 'not an error')
    return answer(500, { error: 'That could not be done just now. Please try again in a moment.' })
  }
}
