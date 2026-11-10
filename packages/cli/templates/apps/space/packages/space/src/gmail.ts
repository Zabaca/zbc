// Connect Gmail, in the space. Two navigations of the owner's browser, both on this host:
//
//   GET /api/inbox/gmail/start     (optionally ?account=<id> for an account being connected again, which only hints Google's sign-in, and ?for=calendar for Settings, Calendars' own button, which asks for the calendar permission alone and sets a second cookie so the return lands there) makes a check (random, kept in a short cookie scoped to this path), asks the inbox for Google's sign-in address for it and sends the browser there.
//   GET /api/inbox/gmail/callback  Google's return (https://space.northfield.example/api/inbox/gmail/callback, registered by hand on the OAuth client): compares the check Google carried back with
//                                  the cookie, spends the cookie, hands the code to the inbox and lands on Settings, Mailboxes.
//
// The inbox keeps the client secret and the grant and decides who may connect (the owner alone: both its methods admit the owner only, for the person the space's check named; any Gmail address, since an owner may have several); the space
// sees a code that is useless without the secret, and never a token. A refused asker gets no cookie and is sent nowhere. Neither path is a write by the space's rules (a GET), so
// the cookie is what makes the return the owner's own: a sign-in somebody else started cannot be finished in the owner's browser, and a replay finds the cookie spent.

import { ANSWER_WITHIN_MS, GMAIL_ACCOUNT_PARAM, GMAIL_FOR_PARAM, GMAIL_PURPOSES, type GmailPurpose, type InboxGmail, MAILBOX_ID, WRITE_WITHIN_MS } from '@space/workspace'
import { isRecord, isText } from './guards'
import type { Asking } from './list'
import { notConnected, reach, reachWrite } from './reach'
import { answerOf } from './views'

/** The cookie that binds the sign-in Google is sent to to the browser that started it. Scoped to this path, so no other request carries it. */
export const GMAIL_STATE_COOKIE = 'space_gmail_state'
const STATE_MAX_AGE = 600
const COOKIE_PATH = '/api/inbox/gmail'

/**
 * The second cookie, set only by the calendar's own Connect (`start?for=calendar`): it says the sign-in Google is sent to is for the calendar, so the return hands the code to the inbox as one and lands on Settings, Calendars.
 * ITS VALUE IS THE CHECK OF THE SIGN-IN IT BELONGS TO, then `.calendar` (`<check>.calendar`), so it can only ever speak for that one sign-in: a calendar sign-in left unfinished (Google's "access blocked" page, a closed tab, back)
 * leaves a cookie that lives ten minutes, and a mailboxes' Connect started in that time has another check, which the stale cookie does not match, so it is handled as the mail sign-in it is. A mailboxes' start also clears any such
 * cookie, and a return spends it whether or not it was used. It is scoped like the first (this path, HttpOnly, Secure, Lax, ten minutes); a return with no matching cookie is a mailboxes' Connect, which asks for mail alone.
 */
export const GMAIL_FOR_COOKIE = 'space_gmail_for'

/** Where the person lands once it is connected, and where a page that explains a refusal sends them back to. */
export const GMAIL_SETTINGS = '/settings/mailboxes'
/** The same for the calendar's own Connect. */
export const CALENDAR_SETTINGS = '/settings/calendars'

const GOOGLE_ORIGIN = 'https://accounts.google.com'

const setCookie = (value: string, maxAge: number, name: string = GMAIL_STATE_COOKIE): string => `${name}=${value}; Max-Age=${maxAge}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`

function cookieFrom(headers: Headers, name: string): string | null {
  for (const pair of (headers.get('cookie') ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at >= 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim() || null
  }
  return null
}

/** Compare two strings without stopping at the first difference. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)

/** What every answer here carries: nothing kept, and no referrer (the return's address holds Google's one-time code). */
const HEADERS = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }

/** A page that says why it did not connect, in words, with the way back. Text only: the message is escaped, wherever it came from. */
function explain(status: number, message: string, cookie?: string | string[], back = GMAIL_SETTINGS): Response {
  const headers = new Headers({ ...HEADERS, 'content-type': 'text/html; charset=utf-8' })
  for (const c of cookie === undefined ? [] : [cookie].flat()) headers.append('set-cookie', c)
  const body =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gmail</title>` +
    `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${escapeHtml(message)}</p><p><a href="${back}">Back to Settings</a></p>`
  return new Response(body, { status, headers })
}

/** The status a refusal or fault is shown with: 403 when it is not the asker's to do, 503 when the inbox cannot be reached, 502 when it could not do it, 400 for anything the request got wrong. */
function statusOf(answer: Exclude<ReturnType<typeof answerOf>, { result: 'ok' }>): number {
  switch (answer.result) {
    case 'refused':
      return answer.reason === 'not-admitted' || answer.reason === 'not-signed-in' ? 403 : 400
    case 'unreachable':
      return 503
    default:
      return 502
  }
}

const isSignIn = (v: unknown): v is { url: string } => isRecord(v) && isText(v.url)
const isConnected = (v: unknown): v is InboxGmail => isRecord(v) && v.connected === true

const methodNotAllowed = (): Response => new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...HEADERS, allow: 'GET', 'content-type': 'application/json' } })

/** Step one. The check is made here; the inbox builds the address (with the space's return address, from the declaration) and decides whether this person may. */
export async function startGmail(ask: Asking, req: Request): Promise<Response> {
  // HEAD would run the handler as a GET: a prefetch must not start a sign-in.
  if (req.method !== 'GET') return methodNotAllowed()
  const { inbox } = ask.apps
  if (!inbox) return explain(503, notConnected('Email').message)
  // `?account=<id>` is an account being connected again: it only becomes Google's sign-in hint (the inbox resolves it and says not-found for an id that is none).
  const account = new URL(req.url).searchParams.get(GMAIL_ACCOUNT_PARAM) ?? undefined
  if (account !== undefined && !MAILBOX_ID.test(account)) return explain(400, 'That is not a Gmail account the inbox holds.')
  // `?for=calendar` is Settings, Calendars' own button: the sign-in then asks for the calendar permission alone, and the return knows (the second cookie). Anything else is the mailboxes' Connect, which asks for mail alone.
  const asked = new URL(req.url).searchParams.get(GMAIL_FOR_PARAM) ?? undefined
  if (asked !== undefined && !(GMAIL_PURPOSES as readonly string[]).includes(asked)) return explain(400, 'A sign-in is for mail or for the calendar.')
  const purpose: GmailPurpose = asked === 'calendar' ? 'calendar' : 'mail'
  const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
  const answer = answerOf(await reach('Email', () => (purpose === 'calendar' ? inbox.gmailSignIn(ask.signedIn, state, account, 'calendar') : inbox.gmailSignIn(ask.signedIn, state, account)), isSignIn, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
  if (answer.result !== 'ok') return explain(statusOf(answer), answer.message, undefined, purpose === 'calendar' ? CALENDAR_SETTINGS : GMAIL_SETTINGS)
  // Only Google's own address is gone to: whatever the inbox said, a browser is never sent elsewhere from here.
  let to: URL
  try {
    to = new URL(answer.value.url)
  } catch {
    return explain(502, 'The inbox gave an address the space could not read, so nothing was started.')
  }
  if (to.origin !== GOOGLE_ORIGIN) return explain(502, 'The inbox gave an address that is not Google’s, so nothing was started.')
  const headers = new Headers({ ...HEADERS, location: to.toString() })
  headers.append('set-cookie', setCookie(state, STATE_MAX_AGE))
  if (purpose === 'calendar') headers.append('set-cookie', setCookie(`${state}.calendar`, STATE_MAX_AGE, GMAIL_FOR_COOKIE))
  // A mailboxes' Connect never inherits a calendar sign-in left unfinished: any such cookie is cleared here (and would not match this check anyway).
  else if (cookieFrom(req.headers, GMAIL_FOR_COOKIE) !== null) headers.append('set-cookie', setCookie('', 0, GMAIL_FOR_COOKIE))
  return new Response(null, { status: 302, headers })
}

/**
 * Step two. The cookie is spent whatever happens next: a check is good for one attempt, and a replay of the same return finds none. The inbox is asked only when the
 * check Google carried back is the one in the cookie.
 */
export async function returnGmail(ask: Asking, req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed()
  const expected = cookieFrom(req.headers, GMAIL_STATE_COOKIE)
  const forCookie = cookieFrom(req.headers, GMAIL_FOR_COOKIE)
  // The purpose is the calendar's only when its cookie names THE check this sign-in started with; a stale one (another sign-in's) is not this one's word.
  const forCalendar = expected !== null && forCookie !== null && sameString(forCookie, `${expected}.calendar`)
  const purpose: GmailPurpose = forCalendar ? 'calendar' : 'mail'
  // Both cookies are spent whatever happens next, the second whenever the browser sent one (a stale one is cleared too).
  const spent: string | string[] = forCookie !== null ? [setCookie('', 0), setCookie('', 0, GMAIL_FOR_COOKIE)] : setCookie('', 0)
  const back = forCalendar ? CALENDAR_SETTINGS : GMAIL_SETTINGS
  const params = new URL(req.url).searchParams
  const state = params.get('state') ?? ''
  if (expected === null || state === '' || !sameString(state, expected)) {
    return explain(400, 'That sign-in was not started here, or it took too long. Connect Gmail again from Settings.', spent, back)
  }
  if (params.get('error')) return explain(400, 'Google sign-in was cancelled, so nothing was connected.', spent, back)
  const code = params.get('code') ?? ''
  if (code === '') return explain(400, 'Google sent no code, so nothing was connected.', spent, back)
  const { inbox } = ask.apps
  if (!inbox) return explain(503, notConnected('Email').message, spent, back)
  const answer = answerOf(await reachWrite('Email', () => (forCalendar ? inbox.gmailConnect(ask.signedIn, code, purpose) : inbox.gmailConnect(ask.signedIn, code)), isConnected, ask.writeWithinMs ?? WRITE_WITHIN_MS))
  if (answer.result !== 'ok') return explain(answer.result === 'outcome-unknown' ? 502 : statusOf(answer), answer.message, spent, back)
  // The grant now carries the calendar permission (or does not): the calendar is told to ask the inbox who is connected and to read what is owed, so a calendar connected again shows up without waiting for its
  // hourly look. Best effort and after the connection is made: whatever it answers, the person lands where they were going.
  const { calendar } = ask.apps
  if (calendar) await reachWrite('Calendar', () => calendar.syncNow(ask.signedIn), (v): v is { asked: number } => isRecord(v) && typeof v.asked === 'number', 3000).catch(() => undefined)
  const headers = new Headers({ ...HEADERS, location: back })
  for (const c of [spent].flat()) headers.append('set-cookie', c)
  return new Response(null, { status: 302, headers })
}
