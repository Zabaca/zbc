import { CALENDAR_EVENTS_SCOPE, CALENDAR_READONLY_SCOPE } from '@space/workspace'
import { CHANGE_VERBS, type ConversationChange } from '../types'
import { base64Bytes } from './parse'
import { type GmailMessage, type HistoryPage, type HistoryRecord, inPlay, LABEL } from './types'

/**
 * Everything the inbox says to Google, in one module: the OAuth web flow and the
 * handful of Gmail calls it needs. The rest of the app sees two interfaces
 * (`GoogleAuth`, `GmailApi`) and never a URL, so the Mailroom is tested against a
 * fake that can fail and this file is tested against a fake `fetch`.
 *
 * ── THE SCOPE OF WHAT IT CAN ASK FOR ─────────────────────────────────────
 * `gmail.modify` is the permission the inbox holds, and it could do far more
 * than this file asks. This file asks for: the profile, a listing, a message, a
 * thread's labels, one attachment's bytes (`messages.attachments.get`, a read, asked for
 * when the owner opens a picture and never in a sync), the history, and the watch, and it makes exactly
 * THREE changes to labels: read (take UNREAD off a thread), close (take INBOX off
 * it: archive) and reopen (put INBOX back). They are `THREAD_CHANGES`, a table of
 * three fixed request bodies, and `changeThread` takes a NAME from it and never a
 * label, so no caller can ask for a fourth: no other label, no trash, no delete,
 * no star, no setting. A bug elsewhere in the app cannot reach what is not offered
 * here (ADR 0001, decision 5).
 *
 * ── THE ONE CALL THAT SENDS ──────────────────────────────────────────────
 * `sendMessage` is `messages.send`, and it is the only way out: it takes a
 * finished message and an optional thread id, has no Bcc, no draft, no schedule and
 * no "send as", and answers what Gmail made. It is the one call in this file whose
 * failure can mean two different things, so it says which (see GmailSendUnknown):
 * a refusal is a GmailError or GmailAuthError and nothing went out; anything that
 * leaves it unknown whether Gmail acted (a connection that dropped after the request
 * left, a 5xx, an answer that names no message) is a GmailSendUnknown, and the
 * caller must not send again. It never retries a send itself: the one retry the
 * module makes (a 401 for a stale access token) happens only when Gmail says it did
 * not authenticate the request, so nothing was processed.
 * The thread id comes from the store's own conversation, so the inbox only ever
 * touches a conversation it holds. The names are the inbox's own (ConversationChange),
 * so there is one vocabulary from the button to the request.
 *
 * REOPEN is the one that is not a single request. Gmail's thread-level "add INBOX"
 * would also put a message in the trash or spam back in the Inbox, so reopen reads
 * the thread's labels and changes the messages in play one at a time (never a batch).
 *
 * ── EVERY CALL IS FROM A REFRESH TOKEN ───────────────────────────────────
 * `gmail(refreshToken)` mints a short-lived access token when it first needs one
 * and again after it expires, keeps it in memory only, and retries a call ONCE on
 * a 401 with a fresh token. The refresh token is never logged and never put in an
 * error message.
 *
 * ── ERRORS ARE CLASSIFIED HERE, ONCE ─────────────────────────────────────
 * What the caller needs to know is not the status code but what to DO:
 * `GmailHistoryGone` (the cursor is stale, resync), `GmailAuthError` (the grant
 * was revoked, retrying is pointless until the owner reconnects), `GmailError`
 * (anything else: record it and try again later with backoff).
 */

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** The one Gmail permission the inbox holds. It covers reading, watching, sending and relabelling. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

/** gmail.modify, plus the account's email address so the inbox knows which account signed in. THE MAILBOXES' CONNECT ASKS FOR THESE AND NOTHING ELSE: no calendar scope is ever in it, so a calendar consent a Workspace admin restricts cannot block mail. */
export const OAUTH_SCOPES = [GMAIL_SCOPE, 'openid', 'email'] as const

/**
 * What Settings, Calendars' own Connect asks for (the calendar reuses this Google client and project, and each account is connected once for both reading and, later, booking): the calendar's reading permission and its
 * permission to create and change events (`calendar.events`, never the full `calendar` scope), incrementally, with `include_granted_scopes` so the new grant also carries mail's (Google adds what the account already granted). It is a
 * separate request from the mailboxes' so mail is never held behind it. `test/calendar-grants.test.ts` holds both lists to that.
 */
export const CALENDAR_OAUTH_SCOPES = [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE] as const

/** Messages and history records per request. Small enough that a page's fetches fit a Worker's subrequest budget. */
export const PAGE_SIZE = 100

export class GmailHistoryGone extends Error {
  constructor() {
    super('Gmail no longer has the history since the saved cursor.')
  }
}

/** The grant is gone (revoked, or the token expired for good). Reconnecting is the only fix. */
export class GmailAuthError extends Error {}

export class GmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * A reopen that Gmail did for some of a thread's messages and then refused (a rate
 * limit, a message that vanished). The ones before it ARE back in the Inbox, so
 * the caller must not say nothing was changed.
 */
export class GmailPartialChange extends GmailError {
  constructor(
    readonly moved: number,
    readonly total: number,
    cause: GmailError,
  ) {
    super(cause.message, cause.status)
  }
}

/**
 * A send whose outcome is not known: the request may or may not have reached
 * Gmail and been acted on. NOT a GmailError on purpose, so a caller that handles
 * "Gmail refused" cannot catch it by accident and treat the message as unsent.
 */
export class GmailSendUnknown extends Error {}

/** How long a send waits for Gmail before it gives up and says it does not know. */
export const SEND_TIMEOUT_MS = 25_000

export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>
  /** Message ids matching a Gmail search, a page at a time. Spam and trash are never listed. */
  listMessageIds(
    query: string,
    pageToken: string | null,
  ): Promise<{ ids: { id: string; threadId: string }[]; next: string | null }>
  /** The full message, or null when it is gone. */
  getMessage(id: string): Promise<GmailMessage | null>
  /**
   * The bytes of one attachment of a message (`attachmentId` is the one the message's own part names, read just before:
   * Gmail's ids for an attachment are not promised to last), or null when Gmail has no such attachment. A read; changes
   * nothing, and in particular marks nothing read.
   */
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array | null>
  /** Throws GmailHistoryGone when Gmail no longer has `startHistoryId`. */
  listHistory(startHistoryId: string, pageToken: string | null): Promise<HistoryPage>
  /** The labels of every message in a thread, or null when the thread is gone. */
  getThreadLabels(threadId: string): Promise<{ id: string; labels: string[] }[] | null>
  /** Ask Gmail to publish this mailbox's changes to the topic. `expiration` is ISO. */
  watch(topicName: string): Promise<{ historyId: string; expiration: string }>
  /** Stop the watch. Called when Gmail is disconnected, so Gmail stops publishing for a mailbox nobody reads. */
  stop(): Promise<void>
  /**
   * The inbox's only three changes to Gmail (see THREAD_CHANGES). Read and close
   * apply to every message in the thread, as Gmail does; reopen to every message in
   * it that is not in the trash, spam or drafts. Each throws when Gmail refuses and
   * has no other effect; a thread Gmail no longer has is a GmailError with status 404.
   */
  changeThread(threadId: string, change: ConversationChange): Promise<void>
  /**
   * Send a finished message (`raw` is the base64url of its RFC 5322 text, see mime.ts),
   * into `threadId` when given. Answers the message Gmail made. Throws GmailError or
   * GmailAuthError when Gmail refused (nothing was sent) and GmailSendUnknown when it
   * cannot be known whether it was. Never retried here.
   */
  sendMessage(raw: string, threadId: string | null): Promise<SentMessage>
}

/** What Gmail answers a send with: the message it made, and where it put it. */
export interface SentMessage {
  id: string
  threadId: string
  labels: string[]
}

/**
 * The request bodies of the inbox's three changes to Gmail, and the only ones it
 * can send. Exported so a test can hold the module to them.
 */
export const THREAD_CHANGES = {
  read: { removeLabelIds: [LABEL.unread] },
  close: { removeLabelIds: [LABEL.inbox] },
  reopen: { addLabelIds: [LABEL.inbox] },
} as const satisfies Record<ConversationChange, { addLabelIds?: readonly string[]; removeLabelIds?: readonly string[] }>

export interface GrantedTokens {
  /** Null when Google did not return one (it only does when asked for offline access with consent). */
  refreshToken: string | null
  scopes: string[]
}

/** A short-lived access token and when it ends (milliseconds since the epoch). */
export interface AccessGrant {
  accessToken: string
  expiresAt: number
}

export interface GoogleAuth {
  exchangeCode(code: string, redirectUri: string): Promise<GrantedTokens>
  /**
   * An access token from a refresh token, LIMITED TO ONE PERMISSION: Google is asked for `scope` alone (the refresh grant takes a subset of what was granted), so the token the calendar is handed
   * can read calendars and nothing of the mail that rides on the same grant. Cached in memory per refresh token and scope until a minute before it ends; `fresh` skips the cache (after a 401).
   * Throws GmailAuthError when the grant is gone. The refresh token is never in an error.
   */
  accessToken(refreshToken: string, scope: string, fresh?: boolean): Promise<AccessGrant>
  /** Revoke a grant at Google. False when Google did not confirm it. */
  revoke(refreshToken: string): Promise<boolean>
  gmail(refreshToken: string): GmailApi
}

export interface GoogleConfig {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  clientId: string
  clientSecret: string
  now: () => number
}

/** The sign-in address for Google's consent screen. Pure. */
export function buildAuthUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  /** `mail` (the default: the mailboxes' Connect) or `calendar` (Settings, Calendars' button). */
  purpose?: 'mail' | 'calendar' | undefined
  /** The account to offer first (an account being connected again). Decides nothing: whichever account signs in is the one connected. */
  loginHint?: string | undefined
}): string {
  const url = new URL(AUTH_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', (input.purpose === 'calendar' ? CALENDAR_OAUTH_SCOPES : OAUTH_SCOPES).join(' '))
  // Keep whatever the account has already granted: a sign-in adds permissions and never takes one away. For the calendar's it is what carries mail's permissions into the new grant.
  url.searchParams.set('include_granted_scopes', 'true')
  // `offline` asks for a refresh token; `consent` makes Google return one every
  // time, so a reconnect after a revoke gets a fresh one rather than none.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', input.state)
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint)
  return url.toString()
}

type Json = Record<string, unknown>

/**
 * Whether Google honoured a refresh that asked for ONE scope: its answer names the scopes the new access token carries. Google's reference says a refresh may name a subset of what was granted; it does not say the token is narrowed to it,
 * so the answer is read: `wider` is true when the token came back carrying anything but what was asked, which means the calendar's token could read mail too. The line carries scope names only, never a token.
 */
export function narrowingNote(asked: string, returned: unknown): { wider: boolean; text: string } | null {
  if (typeof returned !== 'string' || returned.trim() === '') return null
  const got = returned.split(/\s+/).filter(Boolean)
  const wider = got.some((s) => s !== asked)
  return {
    wider,
    text: wider
      ? `google: a token asked for "${asked}" came back carrying "${got.join(' ')}": the narrowing was not honoured, so this token reaches more than it was asked for`
      : `google: a token asked for "${asked}" came back carrying exactly that`,
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function readJson(res: Response): Promise<Json> {
  const text = await res.text()
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Json) : {}
  } catch {
    return {}
  }
}

/** Google's own sentence for an error body, in either of its two shapes. */
function messageOf(body: Json, fallback: string): string {
  const err = body.error
  if (typeof err === 'string')
    return typeof body.error_description === 'string' ? `${err}: ${body.error_description}` : err
  if (err && typeof err === 'object' && typeof (err as Json).message === 'string')
    return (err as Json).message as string
  return fallback
}

/**
 * What Gmail's answer to a send means, and the one place that decides. Only an answer that
 * says Gmail did NOT act is a refusal: a 401 (not signed in) or another 4xx. A 5xx, an answer
 * that cannot be read, and a 200 that names no message all leave it unknown whether the
 * message went out, and are GmailSendUnknown: the caller must not send again.
 */
async function sentFrom(res: Response): Promise<SentMessage> {
  let answer: Json
  try {
    answer = await readJson(res)
  } catch (error) {
    throw new GmailSendUnknown(`Gmail's answer to the send could not be read: ${errorText(error)}`)
  }
  if (res.status === 401) {
    throw new GmailAuthError(`Gmail refused the saved sign-in (to send): ${messageOf(answer, 'status 401')}`)
  }
  if (res.status >= 500) {
    throw new GmailSendUnknown(`Gmail answered the send with ${res.status}: ${messageOf(answer, 'no reason given')}`)
  }
  if (!res.ok) {
    throw new GmailError(`Gmail refused to send it: ${messageOf(answer, `status ${res.status}`)}`, res.status)
  }
  const id = typeof answer.id === 'string' ? answer.id : ''
  if (id === '') throw new GmailSendUnknown('Gmail accepted the send but did not say which message it made.')
  return {
    id,
    threadId: typeof answer.threadId === 'string' ? answer.threadId : '',
    labels: Array.isArray(answer.labelIds) ? answer.labelIds.filter((l): l is string => typeof l === 'string') : [],
  }
}

export function createGoogle(config: GoogleConfig): GoogleAuth {
  const tokens = new Map<string, { accessToken: string; expiresAt: number }>()
  /** Said once per process: what Google answered a narrowed refresh with (the live check in the operator's runbook reads it). */
  let narrowedSaid = false
  /** The cache is per refresh token and per scope, so a token minted for one permission is never given to a caller that asked for another. */
  const cacheKey = (refreshToken: string, scope: string | undefined): string =>
    scope === undefined ? refreshToken : `${scope}\n${refreshToken}`

  async function tokenRequest(params: Record<string, string>): Promise<Json> {
    const res = await config.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
    })
    const body = await readJson(res)
    if (!res.ok) {
      const message = messageOf(body, `status ${res.status}`)
      // invalid_grant is Google's word for a code that was used, a grant that was
      // revoked, or a token that expired for good.
      if (body.error === 'invalid_grant') throw new GmailAuthError(message)
      throw new GmailError(`Google's token endpoint refused: ${message}`, res.status)
    }
    return body
  }

  async function grantFor(refreshToken: string, fresh = false, scope?: string): Promise<AccessGrant> {
    const key = cacheKey(refreshToken, scope)
    const cached = tokens.get(key)
    if (!fresh && cached && cached.expiresAt - 60_000 > config.now()) return cached
    const body = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(scope === undefined ? {} : { scope }),
    })
    const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
    if (accessToken === '') throw new GmailError('Google returned no access token.', 502)
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600
    const grant = { accessToken, expiresAt: config.now() + seconds * 1000 }
    tokens.set(key, grant)
    if (scope !== undefined) {
      const note = narrowingNote(scope, body.scope)
      if (note !== null && (note.wider || !narrowedSaid)) {
        narrowedSaid = true
        ;(note.wider ? console.warn : console.log)(note.text)
      }
    }
    return grant
  }

  async function accessTokenFor(refreshToken: string, fresh = false): Promise<string> {
    return (await grantFor(refreshToken, fresh)).accessToken
  }

  function gmail(refreshToken: string): GmailApi {
    async function call(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
      const token = await accessTokenFor(refreshToken, !retry)
      const res = await config.fetch(`${GMAIL_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.status === 401 && retry) {
        await res.body?.cancel()
        tokens.delete(refreshToken)
        return call(method, path, body, false)
      }
      return res
    }

    /** The body of a call that must succeed; a refusal becomes the right error. */
    async function ok(res: Response, what: string): Promise<Json> {
      const body = await readJson(res)
      if (res.ok) return body
      const message = messageOf(body, `status ${res.status}`)
      if (res.status === 401) throw new GmailAuthError(`Gmail refused the saved sign-in (${what}): ${message}`)
      throw new GmailError(`Gmail refused ${what}: ${message}`, res.status)
    }

    const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')

    /** The labels of every message in a thread, or null when it is gone. */
    async function threadLabels(threadId: string): Promise<{ id: string; labels: string[] }[] | null> {
      const res = await call('GET', `/threads/${encodeURIComponent(threadId)}?format=minimal`)
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      const body = await ok(res, 'a thread')
      return array<Json>(body.messages).map((m) => ({
        id: str(m.id),
        labels: array<string>(m.labelIds).filter((l) => typeof l === 'string'),
      }))
    }

    /** One of the three changes, as a request to `path` (a thread's, or one message's). A 404 is Gmail not having it. */
    async function modify(path: string, change: ConversationChange): Promise<void> {
      const res = await call('POST', `${path}/modify`, THREAD_CHANGES[change])
      if (res.status === 404) {
        await res.body?.cancel()
        throw new GmailError('Gmail no longer has that conversation.', 404)
      }
      await ok(res, `to ${CHANGE_VERBS[change]}`)
    }

    /** An access token for the send. Getting one sends nothing, so any failure here is a plain refusal. */
    async function sendToken(fresh: boolean): Promise<string> {
      try {
        return await accessTokenFor(refreshToken, fresh)
      } catch (error) {
        if (error instanceof GmailError || error instanceof GmailAuthError) throw error
        throw new GmailError(`Could not reach Google to sign in: ${errorText(error)}`, 502)
      }
    }

    /** The one request that sends. If it cannot be known whether it arrived, that is GmailSendUnknown. */
    async function postSend(token: string, body: string): Promise<Response> {
      try {
        return await config.fetch(`${GMAIL_API}/messages/send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })
      } catch (error) {
        throw new GmailSendUnknown(`The connection to Gmail failed during the send: ${errorText(error)}`)
      }
    }

    return {
      async getProfile() {
        const body = await ok(await call('GET', '/profile'), 'the profile')
        return { emailAddress: str(body.emailAddress), historyId: str(body.historyId) }
      },

      async listMessageIds(query, pageToken) {
        const params = new URLSearchParams({ q: query, maxResults: String(PAGE_SIZE) })
        if (pageToken) params.set('pageToken', pageToken)
        const body = await ok(await call('GET', `/messages?${params}`), 'the message list')
        return {
          ids: array<Json>(body.messages).map((m) => ({ id: str(m.id), threadId: str(m.threadId) })),
          next: str(body.nextPageToken) || null,
        }
      },

      async getMessage(id) {
        const res = await call('GET', `/messages/${encodeURIComponent(id)}?format=full`)
        if (res.status === 404) {
          await res.body?.cancel()
          return null
        }
        return (await ok(res, 'a message')) as unknown as GmailMessage
      },

      async getAttachment(messageId, attachmentId) {
        const res = await call(
          'GET',
          `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        )
        if (res.status === 404) {
          await res.body?.cancel()
          return null
        }
        const body = await ok(res, 'an attachment')
        return base64Bytes(str(body.data))
      },

      async listHistory(startHistoryId, pageToken) {
        const params = new URLSearchParams({ startHistoryId, maxResults: String(PAGE_SIZE) })
        for (const type of ['messageAdded', 'labelAdded', 'labelRemoved']) params.append('historyTypes', type)
        if (pageToken) params.set('pageToken', pageToken)
        const res = await call('GET', `/history?${params}`)
        if (res.status === 404) {
          await res.body?.cancel()
          throw new GmailHistoryGone()
        }
        const body = await ok(res, 'the history')
        return {
          history: array<HistoryRecord>(body.history),
          nextPageToken: str(body.nextPageToken) || null,
          historyId: str(body.historyId),
        }
      },

      getThreadLabels: threadLabels,

      async watch(topicName) {
        // No label filter: everything in the mailbox is watched. Filtering to
        // INBOX and SENT could hide the label change that matters most (a message
        // LEAVING the inbox), and a push is only a hint, so an extra one costs a
        // history call that finds nothing to store. To be confirmed against the
        // live mailbox (packages/inbox/docs/runbooks/inbox-google-setup.md).
        const body = await ok(await call('POST', '/watch', { topicName }), 'the watch')
        const ms = Number(str(body.expiration))
        if (!Number.isFinite(ms) || ms <= 0) throw new GmailError('Gmail returned a watch with no expiry.', 502)
        return { historyId: str(body.historyId), expiration: new Date(ms).toISOString() }
      },

      async stop() {
        await ok(await call('POST', '/stop'), 'stopping the watch')
      },

      async sendMessage(raw, threadId) {
        const body = JSON.stringify({ raw, ...(threadId ? { threadId } : {}) })
        let res = await postSend(await sendToken(false), body)
        // A 401 says the request was not authenticated, so nothing was processed: one more try with a new token.
        if (res.status === 401) {
          await res.body?.cancel()
          tokens.delete(refreshToken)
          res = await postSend(await sendToken(true), body)
        }
        return sentFrom(res)
      },

      async changeThread(threadId, change) {
        if (!Object.hasOwn(THREAD_CHANGES, change)) throw new GmailError(`Not a change the inbox makes: ${change}`, 400)
        const thread = `/threads/${encodeURIComponent(threadId)}`
        if (change !== 'reopen') return modify(thread, change)

        // Reopen: only what is in play goes back to the Inbox, one message at a time.
        const messages = await threadLabels(threadId)
        if (messages === null) throw new GmailError('Gmail no longer has that conversation.', 404)
        const todo = messages.filter((m) => !m.labels.includes(LABEL.inbox) && inPlay(m.labels))
        let moved = 0
        for (const m of todo) {
          try {
            await modify(`/messages/${encodeURIComponent(m.id)}`, change)
            moved += 1
          } catch (error) {
            // Some are back already: say so rather than let it read as untouched.
            throw moved > 0 && error instanceof GmailError ? new GmailPartialChange(moved, todo.length, error) : error
          }
        }
      },
    }
  }

  return {
    accessToken: (refreshToken, scope, fresh = false) => grantFor(refreshToken, fresh, scope),

    async exchangeCode(code, redirectUri) {
      const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
      const refresh = typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : null
      // The access token it also returns is deliberately dropped: every call
      // after this mints its own from the refresh token, so there is one path.
      return {
        refreshToken: refresh,
        scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
      }
    },

    async revoke(refreshToken) {
      try {
        const res = await config.fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }),
        })
        await res.body?.cancel()
        return res.ok
      } catch {
        return false
      }
    },

    gmail,
  }
}
