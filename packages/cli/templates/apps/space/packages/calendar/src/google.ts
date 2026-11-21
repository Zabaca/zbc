import type { CalendarAccess, CalendarAccessRefusal } from '@space/workspace'

/**
 * Everything the calendar says to Google, in one module: the Calendar API's calendar list, events and push channels. The rest of the app sees the `CalendarApi` interface and never a URL, so the sync is
 * tested against a fake that can fail and this file is tested against a fake `fetch` that answers as the documented API does.
 *
 * ── TWO CLIENTS, ONE FOR READING AND ONE FOR WRITING ─────────────────────
 * The sync's client (`createCalendarGoogle`) makes `calendarList.list`, `events.list`, `events.watch`, `calendarList.watch`, `channels.stop` and, for a booking (the space's ADR 0025), `freeBusy.query`, which tells when calendars are busy and nothing more. The access token the inbox hands it carries `calendar.readonly` and nothing else (the
 * inbox asks Google for that scope alone), so nothing it does could change an event or touch mail if a bug tried to. It has no call that writes an event.
 * The writer (`createCalendarWriter`, the space's ADR 0023) makes `events.insert`, `events.patch` and `events.delete`, for a call Claude makes on the owner's instruction (the inbox decides that before the engine is asked) and for a visitor's booking, move and cancellation (the space's ADR 0025: the owner's link is the word for it). Its token is for
 * `calendar.events` alone, asked of the inbox for each call, used for that call and dropped: it is never cached, so the permission to change events is held only for as long as one request takes.
 * The same writer, handed a map to keep its tokens in for one run (`createRunWriter`, the space's ADR 0024), serves the calendar's own alarm: the "Busy" blocks the owner's switch keeps are made, moved and removed in one run, with a token for each
 * account asked once, when its first write needs it, and dropped when the run ends (`end`).
 *
 * ── TOKENS ───────────────────────────────────────────────────────────────
 * The calendar never holds a refresh token. `access(address, fresh)` is the inbox's door (packages/space/docs/adr/0020): a short-lived access token, kept here in memory until a minute before it ends (the sync's) or not kept at all
 * (the writer's), asked for again with `fresh` after a 401. A token is never logged, never in an error and never sent to the page.
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
  /**
   * When these calendars of the account are busy between two moments, as Google itself says (`freeBusy.query`: the check a booking makes at the moment of booking, the space's ADR 0025). One answer for each id asked, in Google's own words for it: the busy stretches, or
   * `null` for a calendar Google would not answer for. Nothing of an event comes back, only when. It works with the reading token.
   */
  freeBusy(calendarIds: readonly string[], timeMin: number, timeMax: number): Promise<Record<string, { start: number; end: number }[] | null>>
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

/** The body of a call that must succeed; every refusal becomes the right error. Google's own sentence is kept; the request, and so the token it carried, never is. */
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

/**
 * What the writer does at Google, for one account at a time. Each call is one request. `sendUpdates=all` is on every one, so Google sends the invitation, the change and the cancellation to every guest; `insert` also asks for a Meet link
 * (`conferenceDataVersion=1`) when the body carries a `conferenceData` request. The answer is Google's event, as Google gave it: the engine reads it with `parseEvent` like any other.
 */
export interface CalendarWriteApi {
  /** `calendarId` is the account's primary calendar's id, or `primary`. `quiet` is for the calendar's own busy block: `sendUpdates=none`, so nobody is told, and no Meet link is asked for. */
  insertEvent(calendarId: string, event: Record<string, unknown>, quiet?: boolean): Promise<Record<string, unknown>>
  patchEvent(calendarId: string, eventId: string, changes: Record<string, unknown>, quiet?: boolean): Promise<Record<string, unknown>>
  deleteEvent(calendarId: string, eventId: string, quiet?: boolean): Promise<void>
}

/**
 * The calendar's writing client: a token for `calendar.events` alone, asked of the inbox (`config.access`) for EACH call and dropped after it (a 401 asks once more, fresh). Nothing is cached, so the permission to change events is in
 * this object's hands for as long as one request takes, and the sync's client (which never holds it) is untouched. With `held` (a map the caller owns and empties, see `createRunWriter`) a token is kept in it for as long as the caller keeps the map, which is one run.
 */
export function createCalendarWriter(config: Pick<CalendarGoogleConfig, 'fetch' | 'access'>, held?: Map<string, string>): (address: string) => CalendarWriteApi {
  return (address) => {
    async function send(method: string, path: string, body: unknown, fresh: boolean): Promise<Response> {
      let token = fresh ? undefined : held?.get(address)
      if (token === undefined) {
        const got = await config.access(address, fresh)
        if (!got.ok) throw new CalendarAccessError(got.why, got.message)
        token = got.accessToken
        held?.set(address, token)
      }
      const res = await config.fetch(`${CALENDAR_API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.status === 401 && !fresh) {
        await res.body?.cancel()
        held?.delete(address)
        return send(method, path, body, true)
      }
      return res
    }
    const event = (calendarId: string, eventId?: string) => `/calendars/${encodeURIComponent(calendarId)}/events${eventId === undefined ? '' : `/${encodeURIComponent(eventId)}`}`

    return {
      insertEvent: async (calendarId, body, quiet = false) =>
        ok(await send('POST', `${event(calendarId)}?${quiet ? 'sendUpdates=none' : 'sendUpdates=all&conferenceDataVersion=1'}`, body, false), 'the new event'),

      patchEvent: async (calendarId, eventId, changes, quiet = false) =>
        ok(await send('PATCH', `${event(calendarId, eventId)}?sendUpdates=${quiet ? 'none' : 'all'}`, changes, false), 'that event'),

      async deleteEvent(calendarId, eventId, quiet = false) {
        const res = await send('DELETE', `${event(calendarId, eventId)}?sendUpdates=${quiet ? 'none' : 'all'}`, undefined, false)
        // Already gone (410) is as good as deleted; any other refusal is the caller's to see.
        if (res.status === 410) {
          await res.body?.cancel()
          return
        }
        if (res.ok) {
          await res.body?.cancel()
          return
        }
        await ok(res, 'that event')
      },
    }
  }
}

/** The writing client for ONE RUN of the alarm: tokens are kept in memory for the run and dropped by `end`, whatever the run did. Made new for every run, so nothing outlives it. */
export interface RunWriter {
  writer: (address: string) => CalendarWriteApi
  end(): void
}

/** A factory of run writers (the space's ADR 0024): the same writer as Claude's, its token held for the run and not for each call. */
export function createRunWriter(config: Pick<CalendarGoogleConfig, 'fetch' | 'access'>): () => RunWriter {
  return () => {
    const held = new Map<string, string>()
    return { writer: createCalendarWriter(config, held), end: () => held.clear() }
  }
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

      async freeBusy(calendarIds, timeMin, timeMax) {
        const body = await ok(await call('POST', '/freeBusy', { timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), items: calendarIds.map((id) => ({ id })) }), 'the free time')
        const calendars = isRecord(body.calendars) ? body.calendars : {}
        const out: Record<string, { start: number; end: number }[] | null> = {}
        for (const id of calendarIds) {
          const one = calendars[id]
          // A calendar Google names an error for (not found, not shared) or leaves out is one it did not answer for.
          if (!isRecord(one) || (Array.isArray(one.errors) && one.errors.length > 0) || !Array.isArray(one.busy)) {
            out[id] = null
            continue
          }
          const busy: { start: number; end: number }[] = []
          for (const b of one.busy) {
            const start = isRecord(b) ? Date.parse(str(b.start)) : Number.NaN
            const end = isRecord(b) ? Date.parse(str(b.end)) : Number.NaN
            if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end })
          }
          out[id] = busy
        }
        return out
      },

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
