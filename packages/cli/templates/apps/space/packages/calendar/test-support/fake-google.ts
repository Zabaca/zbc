import type { CalendarAccess, CalendarAccessRefusal } from '@space/workspace'

/**
 * A Google Calendar that can fail, for driving the calendar's sync without a network: it answers the REQUESTS the calendar makes (a `fetch`), as the documented API does, so the real client
 * (src/google.ts) is exercised too. Modelled on the inbox's fake Google (packages/inbox/test-support/fake-google.ts): accounts whose tokens reach only their own data, a grant that can be made to lapse, and a
 * record of every call made.
 *
 * What it models, from Google's documents (developers.google.com/workspace/calendar/api/guides/sync and /push):
 *  - `calendarList.list` and `events.list` with `nextPageToken` pages, and `nextSyncToken` ONLY on the last page;
 *  - an incremental read (`syncToken`) answers what changed since, cancelled events included; a token may be made stale (`expireTokens`), which is a 410; a token refuses `timeMin` and `timeMax` with it (a 400);
 *  - `events.watch` and `calendarList.watch` answer a `resourceId` and an `expiration` (ms, as text), the channel lives `ttl` seconds (7 days by default) or what the test sets (`channelLife`), and `channels.stop` ends one;
 *  - a notification has no body: its HEADERS name the channel, its secret, the resource and the state (`exists`).
 * It is NOT evidence about Google. What it does with a sync token and a window is what the documents say, written by the same person who wrote the code under test; the hand test against the real calendars is where
 * those assumptions are checked (packages/calendar/docs/runbooks/calendar-google-setup.md lists them).
 */

export interface Clock {
  t: number
}

type Json = Record<string, unknown>

export interface EventSpec {
  id?: string
  summary?: string
  /** Timed: ISO strings with an offset. */
  start?: string
  end?: string
  /** All-day: dates, the end exclusive as Google gives it. */
  startDate?: string
  endDate?: string
  location?: string
  description?: string
  iCalUID?: string
  attendees?: Json[]
  organizer?: Json
  hangoutLink?: string
  htmlLink?: string
  transparency?: 'transparent' | 'opaque'
  status?: 'confirmed' | 'tentative' | 'cancelled'
  eventType?: string
  conferenceData?: Json
}

interface StoredEvent {
  raw: Json
  /** The change counter when it was last written. */
  seq: number
}

export interface FakeCalendar {
  id: string
  summary: string
  primary?: boolean
  accessRole: 'owner' | 'reader' | 'writer' | 'freeBusyReader'
  backgroundColor?: string
  summaryOverride?: string
  /** Hidden from the list unless `showHidden`. */
  hidden?: boolean
  events: Map<string, StoredEvent>
  seq: number
  deleted?: boolean
  listSeq: number
}

export interface FakeChannel {
  id: string
  token: string
  address: string
  resourceId: string
  expiration: number
  calendarId: string | null
  account: string
  stopped: boolean
}

export class FakeAccount {
  readonly calendars = new Map<string, FakeCalendar>()
  /** Counts changes to the calendar list, for the list's own sync token. */
  listSeq = 0
  /** Set to make the access door refuse this account. */
  refusal: { why: CalendarAccessRefusal; message: string } | null = null
  /** The token currently good for this account (a refresh changes it). */
  token = ''

  constructor(readonly address: string) {}
}

export class FakeGoogle {
  readonly accounts = new Map<string, FakeAccount>()
  /** Every call made to Google, as `name:detail`, in order. */
  readonly calls: string[] = []
  /** The bearer token each call carried, in step with `calls`. */
  readonly bearers: string[] = []
  readonly channels: FakeChannel[] = []
  /** Every request to the access door: which account, and whether a fresh token was asked for. */
  readonly accessAsked: { address: string; fresh: boolean }[] = []
  pageSize = 2500
  /** Answer reads with no sync token (a Google that does not behave as its pages say), to prove the calendar does not spin on it. */
  noSyncToken = false
  /** Called after each request has been answered and before the answer is returned, so a test can make something happen DURING a read (a notification, a change). */
  afterRequest: ((op: string) => void | Promise<void>) | null = null
  /** How long a channel lives, ms. Default: 7 days (Google's `params.ttl` default). */
  channelLife = 604_800_000
  private tokenNo = 0
  private pageNo = 0
  private readonly tokenHolders = new Map<string, string>()
  private failures: { op: string; status: number; body: Json; times: number; address?: string }[] = []
  /** Tokens (list and events) older than this counter are stale. */
  private readonly staleBelow = new Map<string, number>()
  /** The window a sync token was made with, by token. */
  private readonly windows = new Map<string, { from: number; to: number } | null>()

  constructor(readonly clock: Clock) {}

  // ── Setting the world up ──────────────────────────────────────────────────────────────────────────────────────────────

  account(address: string): FakeAccount {
    let a = this.accounts.get(address)
    if (!a) {
      a = new FakeAccount(address)
      this.accounts.set(address, a)
    }
    return a
  }

  /** Add a calendar to an account (it is in the account's calendar list from now on). */
  addCalendar(address: string, c: Partial<FakeCalendar> & { id: string; summary: string }): FakeCalendar {
    const account = this.account(address)
    account.listSeq += 1
    const calendar: FakeCalendar = { accessRole: 'owner', events: new Map(), seq: 0, listSeq: account.listSeq, ...c }
    account.calendars.set(c.id, calendar)
    return calendar
  }

  /** The account's calendar list changed (a rename, a colour): it is read again by its token. */
  touchCalendar(address: string, id: string, change: Partial<FakeCalendar>): void {
    const account = this.account(address)
    const c = account.calendars.get(id)
    if (!c) throw new Error(`no calendar ${id}`)
    Object.assign(c, change)
    account.listSeq += 1
    c.listSeq = account.listSeq
  }

  /** Delete a calendar from an account's list. */
  deleteCalendar(address: string, id: string): void {
    this.touchCalendar(address, id, { deleted: true })
  }

  /** Put an event on a calendar (or change it, by the same id). Answers its id. */
  setEvent(address: string, calendarId: string, spec: EventSpec): string {
    const calendar = this.calendarOf(address, calendarId)
    calendar.seq += 1
    const id = spec.id ?? `ev${calendar.seq}-${calendarId.length}`
    const raw: Json = {
      kind: 'calendar#event',
      id,
      status: spec.status ?? 'confirmed',
      summary: spec.summary ?? 'An event',
      iCalUID: spec.iCalUID ?? `${id}@google.com`,
      start: spec.startDate !== undefined ? { date: spec.startDate } : { dateTime: spec.start },
      end: spec.endDate !== undefined ? { date: spec.endDate } : { dateTime: spec.end },
      ...(spec.location !== undefined && { location: spec.location }),
      ...(spec.description !== undefined && { description: spec.description }),
      ...(spec.attendees !== undefined && { attendees: spec.attendees }),
      ...(spec.organizer !== undefined && { organizer: spec.organizer }),
      ...(spec.hangoutLink !== undefined && { hangoutLink: spec.hangoutLink }),
      ...(spec.htmlLink !== undefined && { htmlLink: spec.htmlLink }),
      ...(spec.transparency !== undefined && { transparency: spec.transparency }),
      ...(spec.eventType !== undefined && { eventType: spec.eventType }),
      ...(spec.conferenceData !== undefined && { conferenceData: spec.conferenceData }),
    }
    calendar.events.set(id, { raw, seq: calendar.seq })
    return id
  }

  /** The organiser cancels (or deletes) an event: it is still in the changes since a token, as `cancelled`. */
  cancelEvent(address: string, calendarId: string, id: string): void {
    const calendar = this.calendarOf(address, calendarId)
    const held = calendar.events.get(id)
    if (!held) throw new Error(`no event ${id}`)
    calendar.seq += 1
    calendar.events.set(id, { raw: { ...held.raw, status: 'cancelled' }, seq: calendar.seq })
  }

  /** Every sync token made so far is stale from now on (Google's 410). */
  expireTokens(): void {
    this.staleBelow.set('all', this.tokenNo + 1)
  }

  /** Make the next `times` requests for `op` (`events.list`, `calendarList.list`, `events.watch`, `calendarList.watch`, `channels.stop`) answer `status` and `body`. */
  failNext(op: string, status: number, body: Json = {}, times = 1, address?: string): void {
    this.failures.push({ op, status, body, times, ...(address !== undefined && { address }) })
  }

  private calendarOf(address: string, id: string): FakeCalendar {
    const c = this.account(address).calendars.get(id)
    if (!c) throw new Error(`no calendar ${id} on ${address}`)
    return c
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length
  }

  // ── The access door the inbox keeps (src/google.ts `access`) ──────────────────────────────────────────────────────────

  access = async (address: string, fresh: boolean): Promise<CalendarAccess> => {
    this.accessAsked.push({ address, fresh })
    const a = this.accounts.get(address)
    if (!a) return { ok: false, why: 'disconnected', message: `${address} is not connected.` }
    if (a.refusal) return { ok: false, ...a.refusal }
    this.tokenNo += 1
    if (a.token !== '') this.tokenHolders.delete(a.token)
    a.token = `tok-${address}-${this.tokenNo}`
    this.tokenHolders.set(a.token, address)
    return { ok: true, accessToken: a.token, expiresAt: this.clock.t + 3_600_000 }
  }

  /** Google ends an access token early (the next call with it is a 401). */
  endToken(address: string): void {
    const a = this.account(address)
    this.tokenHolders.delete(a.token)
  }

  // ── The notification Google would send for a channel ─────────────────────────────────────────────────────────────────

  /** The headers of a notification for the newest live channel of an account's calendar (or of its list: `calendarId` null). Null when there is no such channel. */
  notification(address: string, calendarId: string | null, state = 'exists'): Record<string, string> | null {
    const channel = [...this.channels].reverse().find((c) => c.account === address && c.calendarId === calendarId && !c.stopped)
    return channel ? this.headersOf(channel, state) : null
  }

  headersOf(channel: FakeChannel, state = 'exists'): Record<string, string> {
    return {
      'x-goog-channel-id': channel.id,
      'x-goog-channel-token': channel.token,
      'x-goog-resource-id': channel.resourceId,
      'x-goog-resource-state': state,
      'x-goog-message-number': '2',
    }
  }

  // ── The requests ──────────────────────────────────────────────────────────────────────────────────────────────────────

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const res = await this.answer(url, init)
    await this.afterRequest?.(this.calls.at(-1)?.split(':')[0] ?? '')
    return res
  }

  private answer = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    const bearer = /^Bearer (.+)$/.exec(new Headers(init.headers).get('authorization') ?? '')?.[1] ?? ''
    const body: Json = typeof init.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Json) : {}
    const path = u.pathname.replace('/calendar/v3', '')
    const op = this.opOf(method, path)
    this.calls.push(`${op}:${this.detailOf(op, path, u.searchParams)}`)
    this.bearers.push(bearer)

    const address = this.tokenHolders.get(bearer)
    if (address === undefined) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401)
    const failure = this.failures.find((f) => f.op === op && f.times > 0 && (f.address === undefined || f.address === address))
    if (failure) {
      failure.times -= 1
      return json(failure.body, failure.status)
    }
    const account = this.account(address)

    if (op === 'calendarList.list') return this.listCalendars(account, u.searchParams)
    if (op === 'events.list') return this.listEvents(account, decodeURIComponent(path.split('/')[2] ?? ''), u.searchParams)
    if (op === 'events.watch') return this.watch(account, decodeURIComponent(path.split('/')[2] ?? ''), body)
    if (op === 'calendarList.watch') return this.watch(account, null, body)
    if (op === 'channels.stop') {
      const channel = this.channels.find((c) => c.id === body.id && c.resourceId === body.resourceId)
      if (!channel) return json({ error: { code: 404, message: 'Channel not found' } }, 404)
      channel.stopped = true
      return new Response(null, { status: 204 })
    }
    return json({ error: { code: 404, message: 'Not Found' } }, 404)
  }

  private opOf(method: string, path: string): string {
    if (method === 'GET' && path === '/users/me/calendarList') return 'calendarList.list'
    if (method === 'POST' && path === '/users/me/calendarList/watch') return 'calendarList.watch'
    if (method === 'GET' && /^\/calendars\/[^/]+\/events$/.test(path)) return 'events.list'
    if (method === 'POST' && /^\/calendars\/[^/]+\/events\/watch$/.test(path)) return 'events.watch'
    if (method === 'POST' && path === '/channels/stop') return 'channels.stop'
    return `unknown ${method} ${path}`
  }

  private detailOf(op: string, path: string, params: URLSearchParams): string {
    if (op === 'events.list') return `${decodeURIComponent(path.split('/')[2] ?? '')}:${params.has('syncToken') ? 'sync' : 'full'}`
    if (op === 'events.watch') return decodeURIComponent(path.split('/')[2] ?? '')
    if (op === 'calendarList.list') return params.has('syncToken') ? 'sync' : 'full'
    return ''
  }

  private page<T>(items: T[], params: URLSearchParams): { slice: T[]; next: string | null } {
    const start = params.get('pageToken') ? Number(params.get('pageToken')?.replace(/^p\d+-/, '')) : 0
    const slice = items.slice(start, start + this.pageSize)
    this.pageNo += 1
    return { slice, next: start + this.pageSize < items.length ? `p${this.pageNo}-${start + this.pageSize}` : null }
  }

  private newSyncToken(prefix: string, seq: number, window: { from: number; to: number } | null): string {
    this.tokenNo += 1
    const token = `${prefix}-${seq}-${this.tokenNo}`
    this.windows.set(token, window)
    return token
  }

  private stale(token: string): boolean {
    const made = Number(token.split('-').at(-1))
    return made < (this.staleBelow.get('all') ?? 0)
  }

  private listCalendars(account: FakeAccount, params: URLSearchParams): Response {
    const token = params.get('syncToken')
    let since = -1
    if (token !== null) {
      if (this.stale(token) || !token.startsWith('list-')) return json({ error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' } }, 410)
      since = Number(token.split('-')[1])
      if (params.get('showDeleted') === 'false' || params.get('showHidden') === 'false') return json({ error: { code: 400, message: 'showDeleted and showHidden cannot be false with a syncToken' } }, 400)
    }
    const all = [...account.calendars.values()].filter((c) => c.listSeq > since && (token !== null ? true : !c.deleted) && (params.get('showHidden') === 'true' || !c.hidden))
    const { slice, next } = this.page(all, params)
    return json({
      kind: 'calendar#calendarList',
      items: slice.map((c) => ({
        kind: 'calendar#calendarListEntry',
        id: c.id,
        summary: c.summary,
        ...(c.summaryOverride !== undefined && { summaryOverride: c.summaryOverride }),
        ...(c.primary && { primary: true }),
        accessRole: c.accessRole,
        ...(c.backgroundColor !== undefined && { backgroundColor: c.backgroundColor }),
        ...(c.deleted && { deleted: true }),
      })),
      ...(next !== null ? { nextPageToken: next } : this.noSyncToken ? {} : { nextSyncToken: this.newSyncToken('list', account.listSeq, null) }),
    })
  }

  private listEvents(account: FakeAccount, calendarId: string, params: URLSearchParams): Response {
    const calendar = account.calendars.get(calendarId)
    if (!calendar || calendar.deleted) return json({ error: { code: 404, message: 'Not Found' } }, 404)
    if (calendar.accessRole === 'freeBusyReader') return json({ error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } }, 403)
    if (params.get('singleEvents') !== 'true') return json({ error: { code: 400, message: 'the fake serves only expanded events (singleEvents=true)' } }, 400)
    const token = params.get('syncToken')
    let items: StoredEvent[]
    let window: { from: number; to: number } | null
    if (token !== null) {
      if (params.has('timeMin') || params.has('timeMax')) return json({ error: { code: 400, message: 'timeMin and timeMax cannot be used with a syncToken' } }, 400)
      if (this.stale(token) || !token.startsWith('events-')) return json({ error: { code: 410, message: 'Sync token is no longer valid, a full sync is required.' } }, 410)
      const since = Number(token.split('-')[1])
      window = this.windows.get(token) ?? null
      items = [...calendar.events.values()].filter((e) => e.seq > since && this.inWindow(e.raw, window))
    } else {
      window = { from: Date.parse(params.get('timeMin') ?? ''), to: Date.parse(params.get('timeMax') ?? '') }
      if (!Number.isFinite(window.from) || !Number.isFinite(window.to)) window = null
      // A full read leaves cancelled events out (showDeleted defaults to false).
      items = [...calendar.events.values()].filter((e) => e.raw.status !== 'cancelled' && this.inWindow(e.raw, window))
    }
    const { slice, next } = this.page(items, params)
    return json({
      kind: 'calendar#events',
      items: slice.map((e) => e.raw),
      ...(next !== null ? { nextPageToken: next } : this.noSyncToken ? {} : { nextSyncToken: this.newSyncToken('events', calendar.seq, window) }),
    })
  }

  private inWindow(raw: Json, window: { from: number; to: number } | null): boolean {
    if (window === null) return true
    const start = raw.start as Json
    const end = raw.end as Json
    const s = typeof start.dateTime === 'string' ? Date.parse(start.dateTime) : Date.parse(`${String(start.date)}T00:00:00Z`)
    const e = typeof end.dateTime === 'string' ? Date.parse(end.dateTime) : Date.parse(`${String(end.date)}T00:00:00Z`)
    return e > window.from && s < window.to
  }

  private watch(account: FakeAccount, calendarId: string | null, body: Json): Response {
    if (body.type !== 'web_hook' || typeof body.address !== 'string' || !body.address.startsWith('https://')) {
      return json({ error: { code: 400, message: 'Invalid address: HTTPS is required for web_hook channels' } }, 400)
    }
    if (typeof body.id !== 'string' || this.channels.some((c) => c.id === body.id)) return json({ error: { code: 400, message: 'channel id not unique' } }, 400)
    if (calendarId !== null && !account.calendars.has(calendarId)) return json({ error: { code: 404, message: 'Not Found' } }, 404)
    const ttl = Number((body.params as Json | undefined)?.ttl)
    const life = Math.min(this.channelLife, Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : this.channelLife)
    const channel: FakeChannel = {
      id: body.id,
      token: typeof body.token === 'string' ? body.token : '',
      address: body.address,
      resourceId: `res-${this.channels.length + 1}`,
      expiration: this.clock.t + life,
      calendarId,
      account: account.address,
      stopped: false,
    }
    this.channels.push(channel)
    return json({ kind: 'api#channel', id: channel.id, resourceId: channel.resourceId, resourceUri: 'x', token: channel.token, expiration: String(channel.expiration) })
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
