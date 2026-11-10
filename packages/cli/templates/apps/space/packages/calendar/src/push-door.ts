/**
 * Google's calendar notifications, at the push host: `POST https://inbox-push.northfield.example/calendar/push` (the host the inbox's Gmail push already uses, which no Access application covers).
 *
 * A notification is a POST with NO BODY; what it says is in its headers: the channel (`X-Goog-Channel-ID`), the secret the calendar chose when it made the channel (`X-Goog-Channel-Token`), the resource Google named
 * (`X-Goog-Resource-ID`) and the state (`X-Goog-Resource-State`: `sync` when the channel is made, `exists` when something changed). Google does not sign it, so the channel's own secret and resource are the whole defence, and
 * they are checked in the store (src/sync.ts `receivePush`, a constant-time comparison). The notification only says that changes are owed; the changes are read from Google with the sync token, so a forged or replayed one
 * can at worst cause one read.
 *
 * Everything that is not exactly that is a 404 with the same body as any other path of the host, so a caller learns nothing about which channels exist. Google wants a 2xx within a short time: the answer is one write and an
 * alarm, never a call to Google.
 */

import { CALENDAR_PUSH_PATH } from '@space/workspace'
import type { PushHeaders } from './sync'

/** The two calls the door makes of the calendar's object. */
export interface PushTarget {
  call(method: 'receivePush', headers: PushHeaders): Promise<boolean>
}

/** Whether a request is for this door: a POST to the calendar's push path. (The host is the caller's to check.) */
export const isCalendarPush = (request: Request): boolean => request.method === 'POST' && new URL(request.url).pathname === CALENDAR_PUSH_PATH

const MAX = 300

/** The notification's headers, or null when it does not name a channel. Each value is cut to a length: a header is attacker text until the store has matched it. */
export function pushHeaders(headers: Headers): PushHeaders | null {
  const channelId = headers.get('x-goog-channel-id')
  if (channelId === null || channelId === '' || channelId.length > MAX) return null
  const cut = (name: string): string | null => {
    const v = headers.get(name)
    return v === null || v.length > MAX ? null : v
  }
  return { channelId, token: cut('x-goog-channel-token'), resourceId: cut('x-goog-resource-id'), state: cut('x-goog-resource-state') }
}

const NOTHING = { 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }

export async function calendarPush(request: Request, target: PushTarget | null): Promise<Response> {
  const notFound = () => Response.json({ error: 'Not found.' }, { status: 404, headers: NOTHING })
  if (!isCalendarPush(request) || target === null) return notFound()
  const headers = pushHeaders(request.headers)
  if (headers === null) return notFound()
  try {
    // Google sends no body; whatever is sent is not read.
    await request.body?.cancel()
    return (await target.call('receivePush', headers)) ? new Response(null, { status: 204, headers: NOTHING }) : notFound()
  } catch (error) {
    // The store failed: a 500 is right, Google tries again.
    console.error('calendar: a push could not be kept', error instanceof Error ? error.message : String(error))
    return new Response(null, { status: 500, headers: NOTHING })
  }
}
