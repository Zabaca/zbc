import { ALLOWED_KINDS, type AllowContext, type AllowedKind, classify, downloadPath } from './allow'
import {
  JmapAuthError,
  type JmapChanges,
  type JmapCursor,
  type JmapEmail,
  JmapError,
  type JmapFolder,
  type JmapIdentity,
  JmapOutcomeUnknown,
  type JmapOutgoing,
  type JmapPushSubscription,
  JmapStateGone,
  type JmapSubmitted,
  JmapUnreachable,
} from './types'

/**
 * Everything the inbox says to the company's own mail server, in one module: the session, JMAP's method calls and one download. The rest of the app sees `JmapApi` and never a URL, so the JMAP room (src/jmap/room.ts)
 * is tested against a fake server that can fail (test-support/fake-jmap.ts) and this file against the same fake behind a recording `fetch`. The shape is src/gmail/google.ts's: classified errors, and a short list of
 * what may be asked (src/jmap/allow.ts, which every request here is checked against before it leaves).
 *
 * ── THE DOOR ──────────────────────────────────────────────────────────────────────────────────────────────────────
 * The space reaches the server through its own hostname on the mail server's Cloudflare Tunnel (set up in the mail server's operator runbook), which serves the JMAP paths only, behind an Access application and
 * a service token of its own. Every request carries that token (two headers) and the mailbox's API key (a bearer): the key opens that one mailbox and nothing else, and the server itself holds it to the
 * calls in `SPACE_KEY_PERMISSIONS` (set when the mailbox's key is made). The session document names the server's own hostname, which the space cannot reach (measured), so this module calls the door's fixed paths
 * (`/jmap`, `/jmap/session`, `/jmap/download/...`) and takes only the account id from the session.
 *
 * ── ERRORS ARE CLASSIFIED HERE, ONCE ───────────────────────────────────────────────────────────────────────────────
 * What the caller needs is what to DO: `JmapAuthError` (the credential or the gate refused it: nothing syncs or sends until a deploy changes it, and it is NOT retried, so the server is not hammered and no
 * failed-sign-in ban is invited), `JmapStateGone` (the cursor cannot be answered from: resync), `JmapUnreachable` (no answer at all: back off), `JmapError` (anything else the server said: record it and back off),
 * and, for the send alone, `JmapOutcomeUnknown` (the request left and nothing certain came back: the message may be out).
 */

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission']

/** Messages read in one `Email/get`. */
const GET_CHUNK = 50

/** How long a send waits for the server before it says it does not know. */
export const SEND_TIMEOUT_MS = 25_000
/** How long any other request waits. */
export const READ_TIMEOUT_MS = 20_000

/** The properties of a message the inbox reads (the text is read from the raw copy). */
const EMAIL_PROPERTIES = ['id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt', 'blobId', 'size']
const STRUCTURE_PROPERTIES = ['from', 'to', 'cc', 'replyTo', 'subject', 'sentAt', 'preview', 'messageId', 'inReplyTo']

export interface JmapConnection {
  /** The door, e.g. https://jmap.northfield.example (no trailing slash). */
  door: string
  /** The Access service token's two halves. */
  accessId: string
  accessSecret: string
  /** The mailbox's API key. */
  key: string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
}

/** A submission the server refused after it made the message: the unsent copy is in Drafts and the caller removes it. */
export class JmapSubmitRefused extends JmapError {
  constructor(
    message: string,
    status: number,
    /** The message the server made, when it did; null when it made nothing. */
    readonly emailId: string | null,
  ) {
    super(message, status)
  }
}

export interface JmapApi {
  /** The account's id, from the session. */
  accountId(): Promise<string>
  folders(): Promise<{ list: JmapFolder[]; state: string }>
  identities(): Promise<JmapIdentity[]>
  /** The Email and Mailbox states now: what a fill's cursor starts from. */
  states(): Promise<JmapCursor>
  /**
   * Message ids in these folders, OLDEST first, received at or after `after` (ISO), a page at a time, and the time the page's last message was received (null for an empty page): the next page is asked for from there
   * (`after` is inclusive, so the last message comes again, harmlessly) and not by position, because a position over a query that is alive skips a message when one ahead of it moves out of the folders meanwhile.
   */
  list(input: {
    folderIds: string[]
    after: string | null
    position: number
    limit: number
  }): Promise<{ ids: string[]; total: number; lastAt: string | null }>
  /** What changed since the cursor's Email state. Throws `JmapStateGone` when the server cannot say. */
  changes(since: JmapCursor, max: number): Promise<{ emails: JmapChanges; mailboxState: string }>
  /** Messages by id; one the server no longer has is left out. */
  emails(ids: string[], options?: { structure?: boolean }): Promise<JmapEmail[]>
  /** The ids of the messages in a thread. */
  thread(threadId: string): Promise<string[]>
  /** The message exactly as the server holds it. */
  raw(blobId: string): Promise<Uint8Array>
  /** Put or take the read mark on messages. */
  setSeen(ids: string[], seen: boolean): Promise<void>
  /** Move messages out of one folder and into another. Answers the ids it moved; the others (gone, or refused) are in `failed`. */
  move(ids: string[], from: string, to: string): Promise<{ moved: string[]; failed: { id: string; reason: string }[] }>
  /** Make one message in Drafts and submit it, filing it in Sent when the submission succeeds. See `JmapSubmitRefused`, `JmapOutcomeUnknown`. */
  submit(message: JmapOutgoing, folders: { drafts: string; sent: string }): Promise<JmapSubmitted>
  /** Remove the unsent copy of a message the server refused to submit. */
  removeUnsent(emailId: string): Promise<void>
  pushGet(): Promise<JmapPushSubscription[]>
  pushMake(input: { url: string; deviceClientId: string; types: string[] }): Promise<JmapPushSubscription>
  pushVerify(id: string, code: string): Promise<void>
  pushRenew(id: string, expires: string): Promise<JmapPushSubscription>
  pushRemove(id: string): Promise<void>
}

type MethodResponse = [string, Record<string, unknown>, string]

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const trueKeys = (v: unknown): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(asRecord(v))
      .filter(([, on]) => on === true)
      .map(([k]) => [k, true as boolean]),
  )

/** The method-level error types that say the method did NOT run (RFC 8620 section 3.6.2); `serverFail` and anything unlisted may have done part of it, so they are not a refusal. */
const NOT_RUN = new Set([
  'forbidden',
  'invalidArguments',
  'invalidResultReference',
  'unknownMethod',
  'requestTooLarge',
  'accountNotFound',
  'accountNotSupportedByMethod',
  'accountReadOnly',
  'stateMismatch',
])

/**
 * What the one request that makes and submits a message came to. **Refused ONLY on an explicit refusal**: a method that did not run (an error of a type in `NOT_RUN`), or a `notCreated` entry for the message or the
 * submission. Every other shape (a response missing, the wrong method named, neither `created` nor `notCreated` for the message or the submission, a `serverFail`) is an unknown outcome, because the message may be out or
 * already in Sent, and removing the copy or putting the draft back would let it be sent twice. A refusal after the message was made carries its id so the unsent copy in Drafts can be removed.
 */
function submitOutcome(responses: MethodResponse[]): JmapSubmitted {
  const unknown = (why: string) =>
    new JmapOutcomeUnknown(`The mail server’s answer did not say whether the message was sent (${why}).`)
  const words = (what: string, r: Record<string, unknown>) =>
    `${what}: ${asString(r.type) || 'refused'}${asString(r.description) ? ` (${asString(r.description)})` : ''}.`
  const made = responses.find((r) => r[2] === 'c0')
  const submitted = responses.find((r) => r[2] === 'c1')

  if (!made) throw unknown('no answer for making it')
  if (made[0] === 'error') {
    if (NOT_RUN.has(asString(made[1].type)))
      throw new JmapSubmitRefused(words('The mail server would not make the message', made[1]), 200, null)
    throw unknown(`making it failed: ${asString(made[1].type) || 'error'}`)
  }
  if (made[0] !== 'Email/set') throw unknown(`${made[0]} where Email/set was expected`)
  const created = asRecord(asRecord(made[1].created).out)
  const emailId = asString(created.id)
  if (emailId === '') {
    const why = asRecord(asRecord(made[1].notCreated).out)
    if (Object.keys(why).length > 0)
      throw new JmapSubmitRefused(words('The mail server would not make the message', why), 200, null)
    throw unknown('it named neither a message made nor one refused')
  }

  if (!submitted) throw unknown('no answer for sending it')
  if (submitted[0] === 'error') {
    if (NOT_RUN.has(asString(submitted[1].type)))
      throw new JmapSubmitRefused(words('The mail server refused to send the message', submitted[1]), 200, emailId)
    throw unknown(`sending it failed: ${asString(submitted[1].type) || 'error'}`)
  }
  if (submitted[0] !== 'EmailSubmission/set') throw unknown(`${submitted[0]} where EmailSubmission/set was expected`)
  if (asString(asRecord(asRecord(submitted[1].created).send).id) !== '')
    return { emailId, threadId: asString(created.threadId) }
  const refused = asRecord(asRecord(submitted[1].notCreated).send)
  if (Object.keys(refused).length > 0)
    throw new JmapSubmitRefused(words('The mail server refused to send the message', refused), 200, emailId)
  throw unknown('it named neither a submission made nor one refused')
}

export function createJmap(connection: JmapConnection): JmapApi {
  const door = connection.door.replace(/\/+$/, '')
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'CF-Access-Client-Id': connection.accessId,
    'CF-Access-Client-Secret': connection.accessSecret,
    authorization: `Bearer ${connection.key}`,
    accept: 'application/json',
    ...extra,
  })
  let account: string | null = null
  /** The folders and the unsent copy the allow-list lets a write name (src/jmap/allow.ts `AllowContext`): learned from the server's own folder list, never from the caller. */
  const allowed: AllowContext = { inbox: null, archive: null, drafts: null, sent: null, unsent: null }

  /** One round trip. `unknownOnDrop` says a request that left and got no answer is an unknown outcome (a send) and not just an unreachable server. */
  async function request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    unknownOnDrop: boolean,
  ): Promise<Response> {
    let res: Response
    try {
      res = await connection.fetch(`${door}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      if (unknownOnDrop) throw new JmapOutcomeUnknown(`The mail server did not answer (${why}).`)
      throw new JmapUnreachable(`The mail server could not be reached: ${why}`)
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel()
      throw new JmapAuthError(
        res.status === 401
          ? 'The mail server refused the space’s key for this mailbox.'
          : 'Cloudflare Access refused the space’s service token at the mail server’s door.',
        res.status,
      )
    }
    if (!res.ok) {
      await res.body?.cancel()
      // A refusal the server made in words (4xx, a 429 included: it is turned away before anything is done) is the server's answer; a 5xx is the server unwell, and for a send it is not known what it did.
      if (unknownOnDrop && res.status >= 500) throw new JmapOutcomeUnknown(`The mail server answered ${res.status}.`)
      throw new JmapError(`The mail server answered ${res.status}.`, res.status)
    }
    return res
  }

  async function accountIdOf(): Promise<string> {
    if (account !== null) return account
    const res = await request('/jmap/session', { method: 'GET', headers: headers() }, READ_TIMEOUT_MS, false)
    let body: Record<string, unknown>
    try {
      body = asRecord(await res.json())
    } catch {
      throw new JmapError('The mail server’s session was not JSON.', 502)
    }
    const primary = asString(asRecord(body.primaryAccounts)['urn:ietf:params:jmap:mail'])
    if (primary === '') throw new JmapAuthError('The mail server’s session names no mail account for this key.', 200)
    account = primary
    return primary
  }

  /**
   * One JMAP request of one or more method calls. Every call is classified against the allow-list first, and a request that fits no kind is refused HERE, before anything leaves. A method-level error
   * is thrown as what it means; the responses are handed back in order.
   */
  async function call(
    calls: [string, Record<string, unknown>][],
    options: { send?: boolean; keepErrors?: boolean } = {},
  ): Promise<MethodResponse[]> {
    const tagged: [string, Record<string, unknown>, string][] = []
    for (const [n, [name, args]] of calls.entries()) {
      const kind: AllowedKind | null = classify(name, args, allowed)
      if (kind === null || !ALLOWED_KINDS.includes(kind))
        throw new Error(`The inbox may not ask the mail server for ${name} like this (src/jmap/allow.ts).`)
      tagged.push([name, args, `c${n}`])
    }
    const send = options.send === true
    const res = await request(
      '/jmap',
      {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ using: USING, methodCalls: tagged }),
      },
      send ? SEND_TIMEOUT_MS : READ_TIMEOUT_MS,
      send,
    )
    return methodResponsesOf(res, send, options.keepErrors === true)
  }

  /**
   * The method responses of an answer, with a method-level error thrown as what it means. A send whose answer cannot be read is of unknown outcome. `keepErrors` hands the errors back as responses instead:
   * the send reads them itself, because what an error means there depends on which method it is on and on what the other one did (`submitOutcome`).
   */
  async function methodResponsesOf(res: Response, send: boolean, keepErrors: boolean): Promise<MethodResponse[]> {
    const unreadable = (words: string) => (send ? new JmapOutcomeUnknown(words) : new JmapError(words, 502))
    let body: { methodResponses?: MethodResponse[] }
    try {
      body = (await res.json()) as { methodResponses?: MethodResponse[] }
    } catch {
      throw unreadable('The mail server’s answer was not JSON.')
    }
    if (!Array.isArray(body.methodResponses)) throw unreadable('The mail server’s answer named no method responses.')
    for (const r of keepErrors ? [] : body.methodResponses) {
      if (r[0] === 'error') throw methodError(asString(asRecord(r[1]).type), asString(asRecord(r[1]).description))
    }
    return body.methodResponses
  }

  function methodError(type: string, description: string): Error {
    const detail = description ? ` (${description})` : ''
    if (type === 'forbidden') return new JmapAuthError(`The mail server does not let this key do that${detail}.`, 200)
    if (type === 'cannotCalculateChanges') return new JmapStateGone()
    return new JmapError(`The mail server refused a call: ${type || 'error'}${detail}.`, 200, type)
  }

  const get = (responses: MethodResponse[], name: string, n = 0): Record<string, unknown> => {
    const r = responses[n]
    if (!r || r[0] !== name)
      throw new JmapError(`The mail server answered ${r?.[0] ?? 'nothing'} where ${name} was expected.`, 502)
    return r[1]
  }

  const emailOf = (r: Record<string, unknown>): JmapEmail => {
    const email: JmapEmail = {
      id: asString(r.id),
      threadId: asString(r.threadId),
      mailboxIds: trueKeys(r.mailboxIds),
      keywords: trueKeys(r.keywords),
      receivedAt: asString(r.receivedAt),
      blobId: asString(r.blobId),
      size: typeof r.size === 'number' ? r.size : 0,
    }
    if ('subject' in r || 'preview' in r) {
      const people = (v: unknown) =>
        Array.isArray(v)
          ? v
              .map((p) => ({
                name: typeof asRecord(p).name === 'string' ? (asRecord(p).name as string) : null,
                email: asString(asRecord(p).email),
              }))
              .filter((p) => p.email !== '')
          : null
      email.structure = {
        from: people(r.from),
        to: people(r.to),
        cc: people(r.cc),
        replyTo: people(r.replyTo),
        subject: typeof r.subject === 'string' ? r.subject : null,
        sentAt: typeof r.sentAt === 'string' ? r.sentAt : null,
        preview: asString(r.preview),
        messageId: Array.isArray(r.messageId) ? asStrings(r.messageId) : null,
        inReplyTo: Array.isArray(r.inReplyTo) ? asStrings(r.inReplyTo) : null,
      }
    }
    return email
  }

  const pushOf = (r: Record<string, unknown>, id: string): JmapPushSubscription => ({
    id,
    verificationCode: typeof r.verificationCode === 'string' ? r.verificationCode : null,
    expires: typeof r.expires === 'string' ? r.expires : null,
  })

  return {
    accountId: accountIdOf,

    async folders() {
      const accountId = await accountIdOf()
      const r = get(
        await call([['Mailbox/get', { accountId, ids: null, properties: ['name', 'role'] }]]),
        'Mailbox/get',
      )
      const list = (Array.isArray(r.list) ? r.list : []).map((m) => ({
        id: asString(asRecord(m).id),
        name: asString(asRecord(m).name),
        role: typeof asRecord(m).role === 'string' ? (asRecord(m).role as string) : null,
      }))
      const idOf = (role: string): string | null => list.find((f) => f.role === role)?.id ?? null
      allowed.inbox = idOf('inbox')
      allowed.archive = idOf('archive')
      allowed.drafts = idOf('drafts')
      allowed.sent = idOf('sent')
      return { list, state: asString(r.state) }
    },

    async identities() {
      const accountId = await accountIdOf()
      const r = get(
        await call([['Identity/get', { accountId, ids: null, properties: ['email', 'name'] }]]),
        'Identity/get',
      )
      return (Array.isArray(r.list) ? r.list : []).map((i) => ({
        id: asString(asRecord(i).id),
        email: asString(asRecord(i).email).toLowerCase(),
        name: asString(asRecord(i).name),
      }))
    },

    async states() {
      const accountId = await accountIdOf()
      const responses = await call([
        ['Email/get', { accountId, ids: [], properties: ['id'] }],
        ['Mailbox/get', { accountId, ids: [], properties: ['id'] }],
      ])
      return {
        email: asString(get(responses, 'Email/get', 0).state),
        mailbox: asString(get(responses, 'Mailbox/get', 1).state),
      }
    },

    async list({ folderIds, after, position, limit }) {
      const accountId = await accountIdOf()
      const condition = (folder: string) => ({ inMailbox: folder, ...(after !== null && { after }) })
      const filter =
        folderIds.length === 1
          ? condition(folderIds[0] as string)
          : { operator: 'OR', conditions: folderIds.map(condition) }
      const r = get(
        await call([
          [
            'Email/query',
            {
              accountId,
              filter,
              sort: [{ property: 'receivedAt', isAscending: true }],
              position,
              limit,
              calculateTotal: true,
            },
          ],
        ]),
        'Email/query',
      )
      const ids = asStrings(r.ids)
      const total = typeof r.total === 'number' ? r.total : ids.length
      const last = ids.at(-1)
      if (last === undefined) return { ids, total, lastAt: null }
      const got = get(await call([['Email/get', { accountId, ids: [last], properties: ['receivedAt'] }]]), 'Email/get')
      const lastAt = asString(asRecord((Array.isArray(got.list) ? got.list : [])[0]).receivedAt)
      return { ids, total, lastAt: lastAt === '' ? null : lastAt }
    },

    async changes(since, max) {
      const accountId = await accountIdOf()
      let responses: MethodResponse[]
      try {
        responses = await call([
          ['Email/changes', { accountId, sinceState: since.email, maxChanges: max }],
          ['Mailbox/changes', { accountId, sinceState: since.mailbox }],
        ])
      } catch (error) {
        // A state the server cannot even read (it answers invalidArguments) is as stale as one it cannot calculate from: the only thing in these two calls that varies is the cursor.
        if (error instanceof JmapError && error.type === 'invalidArguments') throw new JmapStateGone()
        throw error
      }
      const e = get(responses, 'Email/changes', 0)
      const m = get(responses, 'Mailbox/changes', 1)
      return {
        emails: {
          oldState: asString(e.oldState),
          newState: asString(e.newState),
          hasMoreChanges: e.hasMoreChanges === true,
          created: asStrings(e.created),
          updated: asStrings(e.updated),
          destroyed: asStrings(e.destroyed),
        },
        mailboxState: asString(m.newState),
      }
    },

    async emails(ids, options = {}) {
      if (ids.length === 0) return []
      const accountId = await accountIdOf()
      const out: JmapEmail[] = []
      for (let i = 0; i < ids.length; i += GET_CHUNK) {
        const properties = options.structure ? [...EMAIL_PROPERTIES, ...STRUCTURE_PROPERTIES] : EMAIL_PROPERTIES
        const r = get(
          await call([['Email/get', { accountId, ids: ids.slice(i, i + GET_CHUNK), properties }]]),
          'Email/get',
        )
        for (const m of Array.isArray(r.list) ? r.list : []) out.push(emailOf(asRecord(m)))
      }
      return out
    },

    async thread(threadId) {
      const accountId = await accountIdOf()
      const r = get(await call([['Thread/get', { accountId, ids: [threadId] }]]), 'Thread/get')
      const found = (Array.isArray(r.list) ? r.list : [])[0]
      return found ? asStrings(asRecord(found).emailIds) : []
    },

    async raw(blobId) {
      const accountId = await accountIdOf()
      const res = await request(
        downloadPath(accountId, blobId),
        { method: 'GET', headers: headers({ accept: 'message/rfc822' }) },
        READ_TIMEOUT_MS * 2,
        false,
      )
      return new Uint8Array(await res.arrayBuffer())
    },

    async setSeen(ids, seen) {
      if (ids.length === 0) return
      const accountId = await accountIdOf()
      const update = Object.fromEntries(ids.map((id) => [id, { 'keywords/$seen': seen ? true : null }]))
      const r = get(await call([['Email/set', { accountId, update }]]), 'Email/set')
      const notUpdated = Object.entries(asRecord(r.notUpdated))
      if (notUpdated.length > 0)
        throw new JmapError(
          `The mail server would not change ${notUpdated.length} of ${ids.length} messages: ${asString(asRecord(notUpdated[0]?.[1]).type) || 'refused'}.`,
          200,
        )
    },

    async move(ids, from, to) {
      if (ids.length === 0) return { moved: [], failed: [] }
      const accountId = await accountIdOf()
      const update = Object.fromEntries(
        ids.map((id) => [id, { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true }]),
      )
      const r = get(await call([['Email/set', { accountId, update }]]), 'Email/set')
      const failed = Object.entries(asRecord(r.notUpdated)).map(([id, why]) => ({
        id,
        reason: asString(asRecord(why).type) || 'refused',
      }))
      return { moved: ids.filter((id) => !failed.some((f) => f.id === id)), failed }
    },

    async submit(m, folders) {
      const accountId = await accountIdOf()
      allowed.unsent = null
      const addresses = (list: string[]) => list.map((email) => ({ email }))
      const message: Record<string, unknown> = {
        mailboxIds: { [folders.drafts]: true },
        keywords: { $seen: true, $draft: true },
        from: [{ name: m.from.name, email: m.from.email }],
        to: addresses(m.to),
        ...(m.cc.length > 0 && { cc: addresses(m.cc) }),
        subject: m.subject,
        messageId: [m.messageId.replace(/^<|>$/g, '')],
        ...(m.inReplyTo !== null && { inReplyTo: [m.inReplyTo.replace(/^<|>$/g, '')] }),
        ...(m.references.length > 0 && { references: m.references.map((r) => r.replace(/^<|>$/g, '')) }),
        sentAt: m.at,
        textBody: [{ partId: 'body', type: 'text/plain' }],
        bodyValues: { body: { value: m.body } },
      }
      const responses = await call(
        [
          ['Email/set', { accountId, create: { out: message } }],
          [
            'EmailSubmission/set',
            {
              accountId,
              create: { send: { identityId: m.identityId, emailId: '#out' } },
              onSuccessUpdateEmail: {
                '#send': {
                  [`mailboxIds/${folders.drafts}`]: null,
                  [`mailboxIds/${folders.sent}`]: true,
                  'keywords/$draft': null,
                },
              },
            },
          ],
        ],
        { send: true, keepErrors: true },
      )
      try {
        return submitOutcome(responses)
      } catch (error) {
        // The unsent copy of a refusal is the one message that may be destroyed, once, by the removal that follows.
        if (error instanceof JmapSubmitRefused) allowed.unsent = error.emailId
        throw error
      }
    },

    async removeUnsent(emailId) {
      const accountId = await accountIdOf()
      // the allow-list lets this one id through, and only once
      if (allowed.unsent !== emailId)
        throw new Error(
          'The inbox may remove only the unsent copy of a submission the server refused (src/jmap/allow.ts).',
        )
      const r = get(await call([['Email/set', { accountId, destroy: [emailId] }]]), 'Email/set')
      allowed.unsent = null
      const failed = asRecord(asRecord(r.notDestroyed)[emailId])
      if (Object.keys(failed).length > 0)
        throw new JmapError(
          `The mail server would not remove the unsent copy: ${asString(failed.type) || 'refused'}.`,
          200,
        )
    },

    async pushGet() {
      const r = get(await call([['PushSubscription/get', { ids: null }]]), 'PushSubscription/get')
      return (Array.isArray(r.list) ? r.list : []).map((s) => pushOf(asRecord(s), asString(asRecord(s).id)))
    },

    async pushMake({ url, deviceClientId, types }) {
      const r = get(
        await call([['PushSubscription/set', { create: { p: { deviceClientId, url, types } } }]]),
        'PushSubscription/set',
      )
      const made = asRecord(asRecord(r.created).p)
      const id = asString(made.id)
      if (id === '')
        throw new JmapError(
          `The mail server would not make the push subscription: ${asString(asRecord(asRecord(r.notCreated).p).description) || 'refused'}.`,
          200,
        )
      return pushOf(made, id)
    },

    async pushVerify(id, code) {
      const r = get(
        await call([['PushSubscription/set', { update: { [id]: { verificationCode: code } } }]]),
        'PushSubscription/set',
      )
      if (asRecord(r.notUpdated)[id] !== undefined)
        throw new JmapError(
          `The mail server would not accept the verification code: ${asString(asRecord(asRecord(r.notUpdated)[id]).type) || 'refused'}.`,
          200,
        )
    },

    async pushRenew(id, expires) {
      const r = get(await call([['PushSubscription/set', { update: { [id]: { expires } } }]]), 'PushSubscription/set')
      if (asRecord(r.notUpdated)[id] !== undefined)
        throw new JmapError(
          `The mail server would not renew the push subscription: ${asString(asRecord(asRecord(r.notUpdated)[id]).type) || 'refused'}.`,
          200,
          'notFound',
        )
      const updated = asRecord(asRecord(r.updated)[id])
      return pushOf(updated, id)
    },

    async pushRemove(id) {
      get(await call([['PushSubscription/set', { destroy: [id] }]]), 'PushSubscription/set')
    },
  }
}
