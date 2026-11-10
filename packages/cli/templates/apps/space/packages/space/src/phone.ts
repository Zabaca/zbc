// The phone in the space: the dial pad's own requests, handed to meet's part and nothing else.
//
// meet keeps the phone (its rules, its Telnyx account, the minutes, the 911 address, the voicemails' sound). The page draws meet's own phone screen
// (client/phone/), whose requests are the same ones meet's page makes, now to this Worker at /api/phone[/...]. Each is handed to meet's part in this Worker (its `fetch`, packages/meet/src/space-part.ts),
// at meet's path for the space (`MEET_PHONE_PATH`), with the person the space's one check named: meet's phone rules (packages/meet/src/phone-routes.ts) decide what that person may do. Neither the assertion nor the cookie goes
// (ADR 0003 and 0002). Only this prefix is handed on, and only to that path: the part's `fetch` serves nothing else of meet's but the live socket.
//
// A voicemail's sound comes back through here as meet gives it, a stream: the browser is never given an address of Telnyx's.

import { MEET_PHONE_PATH } from '@space/workspace'

/** The space's address for the phone: `/api/phone` and anything under it. */
export const PHONE_PATH = '/api/phone'

export const isPhonePath = (pathname: string): boolean => pathname === PHONE_PATH || pathname.startsWith(`${PHONE_PATH}/`)

/** What goes to meet's part from the request: the body's type, the Origin (meet refuses a write from another site), a range for a sound; never the assertion or the cookie. */
const FORWARDED = ['content-type', 'accept', 'range', 'origin', 'sec-fetch-site'] as const

/** The request as meet gets it: the same method, the same host, at meet's path for the phone. */
export async function phoneRequest(req: Request): Promise<Request> {
  const url = new URL(req.url)
  url.pathname = `${MEET_PHONE_PATH}${url.pathname.slice(PHONE_PATH.length)}`
  const headers = new Headers()
  for (const name of FORWARDED) {
    const v = req.headers.get(name)
    if (v !== null) headers.set(name, v)
  }
  const bodiless = req.method === 'GET' || req.method === 'HEAD'
  return new Request(url, { method: req.method, headers, ...(bodiless ? {} : { body: await req.text() }) })
}

/** What goes back to the page: meet's answer, never kept anywhere and never carrying a cookie. */
export function phoneAnswer(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('cache-control', 'private, no-store')
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.delete('set-cookie')
  return out
}
