import type { CalendarAccess, CalendarAccessRefusal } from '@space/workspace'

/**
 * Everything the calendar says to Google, in one module: the Calendar API's calendar list, events and push channels. The rest of the app sees the `CalendarApi` interface and never a URL, so the sync is
 * tested against a fake that can fail and this file is tested against a fake `fetch` that answers as the documented API does.
 *
 * ── READING ONLY ─────────────────────────────────────────────────────────
 * The calls here are `calendarList.list`, `events.list`, `events.watch`, `calendarList.watch` and `channels.stop`. The access token the inbox hands over carries `calendar.readonly` and nothing else (it asks Google for that
 * scope alone), so nothing here could change an event or touch mail if a bug tried to. There is no call that writes an event here.
 *
 * ── TOKENS ───────────────────────────────────────────────────────────────
 * The calendar never holds a refresh token. `access(address, fresh)` is the inbox's door (packages/space/docs/adr/0020): a short-lived access token, kept here in memory until a minute before it ends, asked for again
 * with `fresh` after a 401. A token is never logged, never in an error and never sent to the page.
 *
 * ── ERRORS ARE CLASSIFIED HERE, ONCE ─────────────────────────────────────
 * What the sync needs to know is not the status code but what to DO: `CalendarGone` (the sync token is stale: read in full), `CalendarNotFound` (the calendar is gone), `CalendarAccessError` (the grant is
 * lapsed, missing the calendar permission or disconnected: say so and stop asking), `CalendarRefused` (the permission is missing at Google's end), `CalendarError` (anything else: record it and try again later).
 */

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/** Google's default for a channel's life is 7 days (`params.ttl`, seconds). Asked for explicitly; Google's own limits may shorten it, so the answer's `expiration` is what is kept. */
export const CHANNEL_TTL_SECONDS = 604_800

/** Events a page may hold (Google's own maximum is 2,500). */
export const EVENTS_PAGE = 2500

/** A full read follows at most this many pages: a runaway token loop stops here and says so. */
export const MAX_PAGES = 40

/** The sync token is stale or was never good: the calendar's events must be read in full (HTTP 410). */
export class CalendarGone extends Error {
  constructor() {
    super('Google no longer accepts the saved sync token.')
  }
}

/** Google does not have that calendar (HTTP 404). */
export class CalendarNotFound extends Error {}

/** The inbox gave no access token for the account, for the reason `why`. */
export class CalendarAccessError extends Error {
  constructor(
    readonly why: CalendarAccessRefusal,
    message: string,
  ) {
    super(message)
  }
}

/** Google refused the token's permission (403 insufficientPermissions): the grant does not include the calendar. */
export class CalendarRefused extends Error {}

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface RawList<T> {
  items: T[]
  /** The next page's token, or null on the last page. */
  next: string | null
  /** Present only on the last page: the token for the next incremental read. */
  syncToken: string | null
}

export interface EventsQuery {
  /** An incremental read. Google refuses it together with a window, so a read has one or the other. */
  syncToken?: string | undefined
  timeMin?: number | undefined
  timeMax?: number | undefined
  pageToken?: string | null | undefined
}

export interface WatchRequest {
  /** A UUID the calendar chose: Google sends it back as `X-Goog-Channel-ID`. */
  id: string
  /** The secret Google sends back as `X-Goog-Channel-Token`. */
  token: string
  /** The https address notifications are sent to. */
  address: string
}

export interface Watched {
  resourceId: string
  /** When Google ends the channel, ms. */
  expiration: number
}

export interface CalendarApi {
  /** The account's calendars, a page at a time. With `syncToken`, only what changed (deleted ones come with `deleted: true`). */
  listCalendars(syncToken: string | null, pageToken: string | null): Promise<RawList<unknown>>
  /** A calendar's events, expanded (`singleEvents`), a page at a time: a window for a full read, a sync token for the changes since. Throws CalendarGone on a stale token. */
  listEvents(calendarId: string, query: EventsQuery): Promise<RawList<unknown>>
  /** Ask Google to tell the address when this calendar's events change. */
  watchEvents(calendarId: string, request: WatchRequest): Promise<Watched>
  /** Ask Google to tell the address when the account's list of calendars changes. */
  watchCalendarList(request: WatchRequest): Promise<Watched>
  /** End a channel at Google. */
  stopChannel(id: string, resourceId: string): Promise<void>
}

export interface CalendarGoogleConfig {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** The inbox's door: an access token limited to the calendar permission. */
  access: (address: string, fresh: boolean) => Promise<CalendarAccess>
  now: () => number
}

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function readJson(res: Response): Promise<Json> {
  const text = await res.text()
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Google's own sentence for an error body. */
function messageOf(body: Json, fallback: string): string {
  const err = body.error
  if (typeof err === 'string') return err
  if (isRecord(err) && typeof err.message === 'string') return err.message
  return fallback
}

/** The first reason Google gives for an error (`insufficientPermissions`, `rateLimitExceeded`, ...). */
function reasonOf(body: Json): string {
  const err = body.error
  if (isRecord(err) && Array.isArray(err.errors) && isRecord(err.errors[0])) return str(err.errors[0].reason)
  return ''
}

/** The calendar's Google client for one account at a time. */
export function createCalendarGoogle(config: CalendarGoogleConfig): (address: string) => CalendarApi {
  const tokens = new Map<string, { accessToken: string; expiresAt: number }>()

  async function tokenFor(address: string, fresh: boolean): Promise<string> {
    const cached = tokens.get(address)
    if (!fresh && cached && cached.expiresAt - 60_000 > config.now()) return cached.accessToken
    tokens.delete(address)
    const got = await config.access(address, fresh)
    if (!got.ok) throw new CalendarAccessError(got.why, got.message)
    tokens.set(address, { accessToken: got.accessToken, expiresAt: got.expiresAt })
    return got.accessToken
  }

  return (address) => {
    /** One request; a 401 is tried once more with a fresh token (the cached one may have been ended early). */
    async function call(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
      const token = await tokenFor(address, !retry)
      const res = await config.fetch(`${CALENDAR_API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.status === 401 && retry) {
        await res.body?.cancel()
        tokens.delete(address)
        return call(method, path, body, false)
      }
      return res
    }

    /** The body of a call that must succeed; every refusal becomes the right error. */
    async function ok(res: Response, what: string): Promise<Json> {
      const body = await readJson(res)
      if (res.ok) return body
      const message = messageOf(body, `status ${res.status}`)
      if (res.status === 410) throw new CalendarGone()
      if (res.status === 404) throw new CalendarNotFound(`Google has no ${what}.`)
      if (res.status === 401) throw new CalendarAccessError('failed', `Google refused the calendar's access token (${what}).`)
      if (res.status === 403) {
        const reason = reasonOf(body)
        // A missing permission is the grant's, not a passing fault; a rate limit is a 403 too, and passes.
        if (reason === 'insufficientPermissions' || /insufficient (authentication )?scopes?/i.test(message) || message.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
          throw new CalendarRefused(`Google says the calendar permission is not granted (${what}).`)
        }
      }
      throw new CalendarError(`Google refused ${what}: ${message}`, res.status)
    }

    const listOf = (body: Json): RawList<unknown> => ({
      items: Array.isArray(body.items) ? body.items : [],
      next: str(body.nextPageToken) || null,
      syncToken: str(body.nextSyncToken) || null,
    })

    async function watch(path: string, request: WatchRequest, what: string): Promise<Watched> {
      const body = await ok(
        await call('POST', path, { id: request.id, type: 'web_hook', address: request.address, token: request.token, params: { ttl: String(CHANNEL_TTL_SECONDS) } }),
        what,
      )
      const expiration = Number(str(body.expiration))
      const resourceId = str(body.resourceId)
      if (resourceId === '' || !Number.isFinite(expiration) || expiration <= 0) throw new CalendarError(`Google answered ${what} without a channel to keep.`, 502)
      return { resourceId, expiration }
    }

    return {
      async listCalendars(syncToken, pageToken) {
        // Hidden entries are listed too: "shown" is the owner's choice here, not Google's. A read by sync token must also show deleted entries (Google refuses it otherwise), which is how a removed calendar is learned.
        const params = new URLSearchParams({ maxResults: '250', showHidden: 'true' })
        if (syncToken !== null) {
          params.set('syncToken', syncToken)
          params.set('showDeleted', 'true')
        }
        if (pageToken) params.set('pageToken', pageToken)
        return listOf(await ok(await call('GET', `/users/me/calendarList?${params}`), 'the calendar list'))
      },

      async listEvents(calendarId, query) {
        const params = new URLSearchParams({ singleEvents: 'true', maxResults: String(EVENTS_PAGE) })
        if (query.syncToken !== undefined) params.set('syncToken', query.syncToken)
        else {
          if (query.timeMin !== undefined) params.set('timeMin', new Date(query.timeMin).toISOString())
          if (query.timeMax !== undefined) params.set('timeMax', new Date(query.timeMax).toISOString())
        }
        if (query.pageToken) params.set('pageToken', query.pageToken)
        return listOf(await ok(await call('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${params}`), 'the events'))
      },

      watchEvents: (calendarId, request) => watch(`/calendars/${encodeURIComponent(calendarId)}/events/watch`, request, 'a push channel for events'),

      watchCalendarList: (request) => watch('/users/me/calendarList/watch', request, 'a push channel for the calendar list'),

      async stopChannel(id, resourceId) {
        const res = await call('POST', '/channels/stop', { id, resourceId })
        // Already gone is as good as stopped.
        if (res.status === 404) {
          await res.body?.cancel()
          return
        }
        if (res.status === 204 || res.ok) {
          await res.body?.cancel()
          return
        }
        await ok(res, 'stopping a push channel')
      },
    }
  }
}

export { errorText }
