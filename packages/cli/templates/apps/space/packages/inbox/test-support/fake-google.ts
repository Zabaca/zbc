import {
  type AccessGrant,
  GMAIL_SCOPE,
  type GmailApi,
  GmailAuthError,
  GmailError,
  GmailHistoryGone,
  GmailPartialChange,
  GmailSendUnknown,
  type GoogleAuth,
  type GrantedTokens,
  type SentMessage,
} from '../src/gmail/google'
import type { GmailMessage, HistoryPage, HistoryRecord } from '../src/gmail/types'

/**
 * A Google that can fail, for driving the Mailroom without a network: a mailbox
 * model that keeps messages with labels and a change history the way Gmail does,
 * behind the same `GoogleAuth` and `GmailApi` the real module implements.
 *
 * It models only what the inbox reads, and the one thing it is NOT is evidence
 * about Gmail. What it does with a history id, a label event or the `after:`
 * search is what the documented API says, written by the same person who wrote
 * the code under test. The hand test against the real mailbox is where those
 * assumptions are checked (packages/inbox/docs/runbooks/inbox-google-setup.md lists them).
 */

const b64url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const b64urlBytes = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const fromB64url = (data: string): string => {
  const standard = data.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

/** A message the fake was asked to send, as it arrived: the headers by name (unfolded) and the decoded text body. */
export interface SentRecord {
  raw: string
  threadId: string | null
  headers: Record<string, string>
  body: string
  /** The id Gmail gave it. */
  id: string
}

export interface MessageSpec {
  id?: string
  threadId?: string
  labels?: string[]
  from?: string
  to?: string
  cc?: string
  subject?: string
  body?: string
  /** Gmail's time for it, in ms. Defaults to the mailbox's clock. */
  at?: number
  headers?: Record<string, string>
  /**
   * Files attached to it. The message becomes multipart/mixed as Gmail shapes one: a text/plain part, then a part per
   * attachment with its filename and an attachmentId whose bytes `getAttachment` answers. `inline: true` puts the bytes
   * in the part's own body (Gmail does that for a very small one) and gives it no attachmentId.
   */
  attachments?: { name: string; mimeType: string; bytes: Uint8Array; inline?: boolean }[]
  /** An iCalendar body, as Google Calendar sends one: the message becomes multipart/alternative with a text/plain part and an inline text/calendar part. */
  ics?: string
}

export class FakeMailbox {
  address = 'tessa@northfield.example'
  historyId = 1000
  pageSize = 100
  /** The clock messages are stamped with; tests move it. */
  clock = Date.parse('2026-10-20T12:00:00.000Z')
  readonly messages = new Map<string, GmailMessage>()
  /** The bytes behind each attachmentId the fake has handed out. */
  readonly attachmentBytes = new Map<string, Uint8Array>()
  history: HistoryRecord[] = []
  /** History ids at or below this are gone, as Gmail forgets them: asking from one is a 404. */
  forgotten = 0
  private n = 0

  private record(r: Omit<HistoryRecord, 'id'>): void {
    this.historyId += 1
    this.history.push({ id: String(this.historyId), ...r })
  }

  /** A message arrives (or is sent), with a history record. Answers its id. */
  add(spec: MessageSpec = {}): string {
    const id = spec.id ?? `m${++this.n}`
    const labels = spec.labels ?? ['INBOX', 'UNREAD']
    const at = spec.at ?? this.clock
    const headers = [
      ['From', spec.from ?? 'Dana Smith <dana@example.com>'],
      ['To', spec.to ?? 'Tessa Marlow <tessa@northfield.example>'],
      ...(spec.cc ? [['Cc', spec.cc]] : []),
      ['Subject', spec.subject ?? `Subject of ${id}`],
      ['Date', new Date(at).toUTCString()],
      ['Message-ID', `<${id}@example.com>`],
      ...Object.entries(spec.headers ?? {}),
    ].map(([name, value]) => ({ name: name as string, value: value as string }))
    this.messages.set(id, {
      id,
      threadId: spec.threadId ?? `t-${id}`,
      labelIds: [...labels],
      snippet: (spec.body ?? `Body of ${id}`).slice(0, 80),
      internalDate: String(at),
      payload: spec.attachments?.length
        ? {
            mimeType: 'multipart/mixed',
            headers,
            body: { size: 0 },
            parts: [
              { mimeType: 'text/plain', body: { size: 10, data: b64url(spec.body ?? `Body of ${id}`) } },
              ...spec.attachments.map((a, i) => {
                const attachmentId = `att-${id}-${i}`
                if (!a.inline) this.attachmentBytes.set(attachmentId, a.bytes)
                return {
                  mimeType: a.mimeType,
                  filename: a.name,
                  headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.name}"` }],
                  body: a.inline
                    ? { size: a.bytes.length, data: b64urlBytes(a.bytes) }
                    : { size: a.bytes.length, attachmentId },
                }
              }),
            ],
          }
        : spec.ics !== undefined
          ? {
              mimeType: 'multipart/alternative',
              headers,
              body: { size: 0 },
              parts: [
                { mimeType: 'text/plain', body: { size: 10, data: b64url(spec.body ?? `Body of ${id}`) } },
                { mimeType: 'text/calendar', body: { size: spec.ics.length, data: b64url(spec.ics) } },
              ],
            }
          : {
              mimeType: 'text/plain',
              headers,
              body: { size: 10, data: b64url(spec.body ?? `Body of ${id}`) },
            },
    })
    this.record({ messagesAdded: [{ message: { id, threadId: spec.threadId ?? `t-${id}`, labelIds: [...labels] } }] })
    return id
  }

  /** A label change, with its history record. */
  label(id: string, change: { add?: string[]; remove?: string[] }): void {
    const m = this.messages.get(id)
    if (!m) throw new Error(`no message ${id}`)
    const ref = { id, threadId: m.threadId }
    const labels = new Set(m.labelIds ?? [])
    for (const l of change.add ?? []) labels.add(l)
    for (const l of change.remove ?? []) labels.delete(l)
    m.labelIds = [...labels]
    if (change.add?.length)
      this.record({ labelsAdded: [{ message: { ...ref, labelIds: m.labelIds }, labelIds: change.add }] })
    if (change.remove?.length) {
      this.record({ labelsRemoved: [{ message: { ...ref, labelIds: m.labelIds }, labelIds: change.remove }] })
    }
  }

  /**
   * A label change on a whole thread, as `threads.modify` does it: every message in
   * it takes the change, and Gmail records history for the messages it actually
   * changed and for no others. A thread that is not there is Gmail's 404.
   */
  labelThread(threadId: string, change: { add?: string[]; remove?: string[] }, inPlayOnly = false): void {
    const inThread = [...this.messages.values()].filter((m) => m.threadId === threadId)
    if (inThread.length === 0) throw new GmailError('Gmail no longer has that conversation.', 404)
    for (const m of inThread) {
      // Putting a thread back in the Inbox leaves a message in the trash, spam or drafts where it is.
      if (inPlayOnly && (m.labelIds ?? []).some((l) => ['TRASH', 'SPAM', 'DRAFT'].includes(l))) continue
      const have = new Set(m.labelIds ?? [])
      const add = (change.add ?? []).filter((l) => !have.has(l))
      const remove = (change.remove ?? []).filter((l) => have.has(l))
      if (add.length > 0 || remove.length > 0) this.label(m.id, { add, remove })
    }
  }

  /** Every message the fake has been asked to send, in order. */
  readonly sent: SentRecord[] = []
  /** When set, Gmail keeps its own Message-ID instead of the one it was given, as the real one may. */
  rewriteMessageId = false

  /**
   * What `messages.send` does with a finished message: reads it as Gmail would
   * (headers, then a base64 body), makes it, labels it SENT, and records it in the
   * history. A thread that is not there is Gmail's 404.
   */
  send(raw: string, threadId: string | null): SentRecord {
    if (threadId !== null && ![...this.messages.values()].some((m) => m.threadId === threadId)) {
      throw new GmailError('Requested entity was not found.', 404)
    }
    const text = fromB64url(raw)
    const split = text.indexOf('\r\n\r\n')
    const head = text.slice(0, split)
    const encoded = text.slice(split + 4)
    const headers: Record<string, string> = {}
    for (const line of head.replace(/\r\n([ \t])/g, '$1').split('\r\n')) {
      const at = line.indexOf(':')
      headers[line.slice(0, at)] = line.slice(at + 1).trim()
    }
    const body = new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/\s+/g, '')), (c) => c.charCodeAt(0)))
    const id = `sent-${++this.n}`
    const thread = threadId ?? `t-${id}`
    if (this.rewriteMessageId) headers['Message-ID'] = `<rewritten-${id}@mail.gmail.com>`
    const at = this.clock
    this.messages.set(id, {
      id,
      threadId: thread,
      labelIds: ['SENT'],
      snippet: body.slice(0, 80),
      internalDate: String(at),
      payload: {
        mimeType: 'text/plain',
        headers: [...Object.entries(headers), ['Date', new Date(at).toUTCString()]].map(([name, value]) => ({
          name: name as string,
          value: value as string,
        })),
        body: { size: body.length, data: b64url(body) },
      },
    })
    this.record({ messagesAdded: [{ message: { id, threadId: thread, labelIds: ['SENT'] } }] })
    const record = { raw: text, threadId, headers, body, id }
    this.sent.push(record)
    return record
  }

  /** Gmail forgets all history so far (an outage, a long gap). */
  forgetHistory(): void {
    this.forgotten = this.historyId
  }

  /** Change a message with NO history record, as happens to history Gmail has forgotten. */
  quietly(id: string, change: { add?: string[]; remove?: string[] }): void {
    const m = this.messages.get(id)
    if (!m) throw new Error(`no message ${id}`)
    const labels = new Set(m.labelIds ?? [])
    for (const l of change.add ?? []) labels.add(l)
    for (const l of change.remove ?? []) labels.delete(l)
    m.labelIds = [...labels]
  }

  /** Messages matching what the inbox searches for: Inbox or Sent, newer than `after`, never spam or trash. */
  search(query: string): GmailMessage[] {
    const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0) * 1000
    return [...this.messages.values()]
      .filter((m) => {
        const labels = m.labelIds ?? []
        if (labels.some((l) => ['SPAM', 'TRASH'].includes(l))) return false
        return (labels.includes('INBOX') || labels.includes('SENT')) && Number(m.internalDate) >= after
      })
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
  }
}

export class FakeGoogle implements GoogleAuth {
  /** Tessa's first account (`refresh-token-1`): what a test that has one account means by "the mailbox". */
  readonly mailbox = new FakeMailbox()
  grant: GrantedTokens = { refreshToken: 'refresh-token-1', scopes: [GMAIL_SCOPE, 'openid', 'email'] }
  /** When true, every Gmail call says the grant is gone, for every account. */
  grantRevoked = false
  /** Other accounts, by the refresh token their grant carries; a token that is none of them is the first account's. */
  private readonly accounts = new Map<string, FakeMailbox>()
  /** The grant a code exchanges for, for the accounts added with `addAccount`. */
  private readonly codes = new Map<string, GrantedTokens>()
  /** Refresh tokens whose grant Google has ended (a testing app's seven days, a revoke): only that account's calls say so. */
  readonly lapsed = new Set<string>()
  readonly exchanged: { code: string; redirectUri: string }[] = []
  readonly revoked: string[] = []
  /** Every access token asked for by scope (the calendar's), in order. The token a call returns names its scope and number, so a test can see which permission it was limited to. */
  readonly accessAsked: { refreshToken: string; scope: string; fresh: boolean }[] = []
  /** The clock `accessToken` ends tokens by, in ms. */
  accessClock = Date.parse('2026-11-05T12:00:00.000Z')
  /** Every call made, in order, as `name` or `name:argument`. */
  readonly calls: string[] = []
  /** The refresh token each call in `calls` was made with, in step with it: which account a call was for. */
  readonly calledWith: string[] = []
  private readonly failures = new Map<string, { error: Error; times: number }>()
  /**
   * When set, the next reopen moves this many messages back to the Inbox and then
   * Gmail refuses (a rate limit), as a reopen of several messages can: one-shot.
   */
  reopenFailsAfter: number | null = null
  /** When set, the next send is made by Gmail and then its answer is lost: one-shot. */
  loseSendAnswer = false
  /** When set, every send waits for it after Gmail has made the message and before the answer comes back: a slow Gmail, held by the test. */
  sendGate: Promise<void> | null = null
  watchExpiration = Date.parse('2026-10-27T12:00:00.000Z')
  /** Called as each call begins, so a test can make something happen DURING a run (a push, a new message). */
  onCall: ((call: string) => void) | null = null

  /**
   * Another Gmail account, which `code` exchanges for a grant carrying `refreshToken`. Answers its mailbox, to put mail in. Every call made with that
   * token reaches this mailbox and no other, so two accounts never see each other's mail or cursor.
   */
  addAccount(
    address: string,
    refreshToken: string,
    code: string,
    scopes: string[] = [GMAIL_SCOPE, 'openid', 'email'],
  ): FakeMailbox {
    const account = new FakeMailbox()
    account.address = address
    this.accounts.set(refreshToken, account)
    this.codes.set(code, { refreshToken, scopes: [...scopes] })
    return account
  }

  /**
   * The same account signing in again: `code` now exchanges for a grant carrying `newToken`, which reaches the mailbox `oldToken` reached (so mail that arrived while the
   * old grant had ended is there to catch up on). The old token is not ended by this: a test says so with `lapsed`.
   */
  reissue(oldToken: string, newToken: string, code: string, scopes: string[] = [GMAIL_SCOPE, 'openid', 'email']): void {
    this.accounts.set(newToken, this.accounts.get(oldToken) ?? this.mailbox)
    this.codes.set(code, { refreshToken: newToken, scopes: [...scopes] })
  }

  /** Make the next `times` calls of `op` throw `error`. */
  failNext(op: string, error: Error, times = 1): void {
    this.failures.set(op, { error, times })
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length
  }

  private enter(op: string, detail?: string, token = ''): void {
    const call = detail === undefined ? op : `${op}:${detail}`
    this.calls.push(call)
    this.calledWith.push(token)
    this.onCall?.(call)
    const failure = this.failures.get(op)
    if (failure && failure.times > 0) {
      failure.times -= 1
      throw failure.error
    }
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GrantedTokens> {
    this.enter('exchange', code)
    this.exchanged.push({ code, redirectUri })
    if (code === 'used-code') throw new GmailAuthError('invalid_grant: Bad Request')
    const other = this.codes.get(code)
    if (other) return { refreshToken: other.refreshToken, scopes: [...other.scopes] }
    return { refreshToken: this.grant.refreshToken, scopes: [...this.grant.scopes] }
  }

  async accessToken(refreshToken: string, scope: string, fresh = false): Promise<AccessGrant> {
    this.enter('accessToken', scope, refreshToken)
    this.accessAsked.push({ refreshToken, scope, fresh })
    if (this.grantRevoked || refreshToken === '' || this.lapsed.has(refreshToken))
      throw new GmailAuthError('invalid_grant: Token has been expired or revoked.')
    return { accessToken: `access[${scope}]#${this.accessAsked.length}`, expiresAt: this.accessClock + 3_600_000 }
  }

  async revoke(refreshToken: string): Promise<boolean> {
    this.enter('revoke', undefined, refreshToken)
    this.revoked.push(refreshToken)
    return true
  }

  gmail(refreshToken: string): GmailApi {
    const m = this.accounts.get(refreshToken) ?? this.mailbox
    const guard = (op: string, detail?: string) => {
      // The account is part of the call, so a test can say which account's calls it means.
      this.enter(op, detail, refreshToken)
      if (this.grantRevoked || refreshToken === '' || this.lapsed.has(refreshToken)) {
        throw new GmailAuthError('Gmail refused the saved sign-in.')
      }
    }
    return {
      getProfile: async () => {
        guard('getProfile')
        return { emailAddress: m.address, historyId: String(m.historyId) }
      },
      listMessageIds: async (query, pageToken) => {
        guard('listMessageIds', pageToken ?? 'first')
        const found = m.search(query)
        const start = pageToken ? Number(pageToken) : 0
        const slice = found.slice(start, start + m.pageSize)
        return {
          ids: slice.map((x) => ({ id: x.id, threadId: x.threadId })),
          next: start + m.pageSize < found.length ? String(start + m.pageSize) : null,
        }
      },
      getMessage: async (id) => {
        guard('getMessage', id)
        const found = m.messages.get(id)
        return found ? structuredClone(found) : null
      },
      getAttachment: async (messageId, attachmentId) => {
        guard('getAttachment', `${messageId}/${attachmentId}`)
        return m.attachmentBytes.get(attachmentId) ?? null
      },
      listHistory: async (startHistoryId, pageToken): Promise<HistoryPage> => {
        guard('listHistory', startHistoryId)
        if (Number(startHistoryId) < m.forgotten) throw new GmailHistoryGone()
        const after = m.history.filter((h) => Number(h.id) > Number(startHistoryId))
        const start = pageToken ? Number(pageToken) : 0
        const slice = after.slice(start, start + m.pageSize)
        return {
          history: structuredClone(slice),
          nextPageToken: start + m.pageSize < after.length ? String(start + m.pageSize) : null,
          historyId: String(m.historyId),
        }
      },
      getThreadLabels: async (threadId) => {
        guard('getThreadLabels', threadId)
        const inThread = [...m.messages.values()].filter((x) => x.threadId === threadId)
        return inThread.length === 0 ? null : inThread.map((x) => ({ id: x.id, labels: [...(x.labelIds ?? [])] }))
      },
      watch: async (topicName) => {
        guard('watch', topicName)
        return { historyId: String(m.historyId), expiration: new Date(this.watchExpiration).toISOString() }
      },
      stop: async () => {
        guard('stop')
      },
      sendMessage: async (raw, threadId): Promise<SentMessage> => {
        guard('send', threadId ?? 'new')
        const made = m.send(raw, threadId)
        // The answer takes a moment to come back, as over a network: anything else that is
        // allowed to run meanwhile (a sync, a second press) gets the chance to.
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (this.sendGate) await this.sendGate
        // The message is out, but the answer never arrives: the case that must never be retried.
        if (this.loseSendAnswer) {
          this.loseSendAnswer = false
          throw new GmailSendUnknown('The connection to Gmail failed during the send: socket closed')
        }
        return { id: made.id, threadId: m.messages.get(made.id)?.threadId ?? '', labels: ['SENT'] }
      },
      changeThread: async (threadId, change) => {
        guard(`thread-${change}`, threadId)
        if (change === 'read') m.labelThread(threadId, { remove: ['UNREAD'] })
        else if (change === 'close') m.labelThread(threadId, { remove: ['INBOX'] })
        else if (this.reopenFailsAfter !== null) {
          const after = this.reopenFailsAfter
          this.reopenFailsAfter = null
          const eligible = [...m.messages.values()].filter(
            (x) =>
              x.threadId === threadId &&
              !(x.labelIds ?? []).includes('INBOX') &&
              !(x.labelIds ?? []).some((l) => ['TRASH', 'SPAM', 'DRAFT'].includes(l)),
          )
          for (const x of eligible.slice(0, after)) m.label(x.id, { add: ['INBOX'] })
          const refused = new GmailError('Gmail refused to move it back to the Inbox: Rate Limit Exceeded', 429)
          throw after > 0 ? new GmailPartialChange(after, eligible.length, refused) : refused
        } else m.labelThread(threadId, { add: ['INBOX'] }, true)
      },
    }
  }
}
