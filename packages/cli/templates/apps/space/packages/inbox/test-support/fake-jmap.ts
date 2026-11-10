import { type AllowContext, classify } from '../src/jmap/allow'

/**
 * A mail server that speaks JMAP, for driving the JMAP room without a network: one account with the folders Stalwart gives it, messages that carry their keywords and folders, states and a change
 * history the way the server keeps them, identities, a submission that "sends", push subscriptions that must be verified before they are used, and the door's own gates (the Access token and the bearer key).
 * It answers as `fetch` does, so the real client (src/jmap/client.ts) runs against it unchanged, and it can fail: refuse the key or the gate, be unreachable, answer an error to the next call, say it cannot
 * calculate changes, act and then lose its answer, and refuse a submission.
 *
 * What it is NOT is evidence about Stalwart. What it does with a state, a keyword, a move or a push is what RFC 8620 and 8621 document and what a real server was measured
 * to do, written by the same person who wrote the code under test. The live checks (packages/inbox/docs/runbooks/inbox-jmap-mailbox.md) are where the real server is asked.
 */

/** A value a test has just made certain exists (an index into a list it has just filled). */
export function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('the test expected a value that is not there')
  return value
}

export interface FakeMessageSpec {
  from?: string
  to?: string
  cc?: string
  subject?: string
  body?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  /** The folder by role. Defaults to the Inbox. */
  folder?: 'inbox' | 'sent' | 'drafts' | 'junk' | 'trash' | 'archive'
  seen?: boolean
  flagged?: boolean
  /** The server's time for it, in ms. Defaults to the clock. */
  at?: number
  /** Joins this thread (a thread id), else a reply joins its parent's and anything else starts one. */
  threadId?: string
  /** The raw bytes, when a test wants a message the builder cannot make (an attachment, an odd charset). */
  raw?: string | Uint8Array
  /** What the server is told its size is, when a test wants a large message without the bytes. */
  size?: number
}

export interface FakeEmail {
  id: string
  threadId: string
  mailboxIds: Record<string, true>
  keywords: Record<string, true>
  receivedAt: number
  blobId: string
  raw: Uint8Array
  size: number
  messageId: string
  inReplyTo: string | null
  references: string[]
  from: string
  to: string
  cc: string
  subject: string
  preview: string
}

interface Change {
  state: number
  created: string[]
  updated: string[]
  destroyed: string[]
}

interface Sub {
  id: string
  url: string
  types: string[]
  deviceClientId: string
  code: string
  verified: boolean
  expires: number
}

export interface Submitted {
  emailId: string
  from: string
  to: string[]
  cc: string[]
  raw: string
}

const DAY = 24 * 60 * 60 * 1000
const FOLDERS = [
  { id: 'a', name: 'Inbox', role: 'inbox' },
  { id: 'c', name: 'Junk Mail', role: 'junk' },
  { id: 'd', name: 'Drafts', role: 'drafts' },
  { id: 'e', name: 'Sent Items', role: 'sent' },
  { id: 'b', name: 'Deleted Items', role: 'trash' },
  { id: 'h', name: 'Archive', role: 'archive' },
]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class FakeJmapServer {
  readonly accountId = 'c'
  address = 'test@harborline.example'
  /** Addresses that arrive in the mailbox as aliases; each has an identity of its own. */
  aliases = ['info@harborline.example', 'postmaster@harborline.example']
  /** The name the account's identities carry: the account's description, as Stalwart names them. */
  accountName = 'Phase 1 proof mailbox'
  door = 'https://jmap-test.harborline.example'
  key = 'key-good'
  accessId = 'access-id'
  accessSecret = 'access-secret'
  /** The clock the server stamps with, in ms; tests move it (or hand the constructor the clock they already move). */
  private ownClock = Date.parse('2026-11-05T12:00:00.000Z')
  get clock(): number {
    return this.readClock ? this.readClock() : this.ownClock
  }
  set clock(ms: number) {
    this.ownClock = ms
  }
  folders = FOLDERS.map((f) => ({ ...f }))
  readonly emails = new Map<string, FakeEmail>()
  private emailState = 100
  private mailboxState = 200
  private identityState = 1
  private readonly changes: Change[] = []
  /** States at or below this are gone, as the server forgets them: asking from one is `cannotCalculateChanges`. */
  forgotten = 0
  private n = 0
  private subs: Sub[] = []
  /** Every request, in order: what the allow-list test reads. */
  readonly requests: {
    method: string
    path: string
    calls: { name: string; args: Record<string, unknown>; kind: string | null }[]
  }[] = []
  /** Every raw download. */
  readonly downloads: string[] = []
  /** What was submitted for delivery. */
  readonly submitted: Submitted[] = []
  /** The pushes the server owes, as it would POST them (a verification, or a state change). `drainPushes` hands them over. */
  readonly owed: { url: string; body: unknown }[] = []

  /** Where the pushes owed go while a PushSubscription/set is still being answered (the real server's speed); null: they wait for `drainPushes`. */
  pushesBeforeAnswer: ((url: string, body: unknown) => Promise<unknown> | unknown) | null = null

  // ── what a test can make go wrong ─────────────────────────────────────────────
  /** The server answers 401 to the key. */
  refuseKey = false
  /** The Access gate answers 403 to the service token. */
  refuseAccess = false
  /** Every request fails to connect. */
  unreachable = false
  /** The next request(s) the predicate matches are answered with this status (an HTML body, as a gate or a proxy would). */
  private failures: { when: (path: string, methods: string[]) => boolean; status: number }[] = []
  /** The next request(s) that contain this method run, and then the answer is lost (the connection drops). */
  private loseAnswers: ((methods: string[]) => boolean)[] = []
  /** The next answer(s) to a request that makes a message are changed after the server has acted, to show a shape a server could send (what is acted on stays done). */
  private mangles: ((
    out: [string, Record<string, unknown>, string][],
  ) => [string, Record<string, unknown>, string][])[] = []
  /** Email changes the server cannot calculate, whatever the state. */
  cannotCalculate = false
  /** The submission is refused with this RFC 8621 error type. */
  refuseSubmission: string | null = null
  /** Email/set update of these ids is refused (`notUpdated`). */
  refuseUpdatesOf = new Set<string>()
  /** Mail submitted to the mailbox's own address comes back into its Inbox (what Cloudflare's routing does). */
  loopback = false

  constructor(private readonly readClock?: () => number) {
    this.recordChange({ created: [], updated: [], destroyed: [] })
  }

  failNext(status: number, when: (path: string, methods: string[]) => boolean = () => true): void {
    this.failures.push({ when, status })
  }

  mangleNextAnswer(
    change: (out: [string, Record<string, unknown>, string][]) => [string, Record<string, unknown>, string][],
  ): void {
    this.mangles.push(change)
  }

  loseNextAnswer(when: (methods: string[]) => boolean = () => true): void {
    this.loseAnswers.push(when)
  }

  // ── the mailbox, as a mail app and the world change it ────────────────────────

  folder(role: string): string {
    return (this.folders.find((f) => f.role === role) as { id: string }).id
  }

  private recordChange(change: Omit<Change, 'state'>): number {
    this.emailState += 1
    this.mailboxState += 1
    this.changes.push({ state: this.emailState, ...change })
    return this.emailState
  }

  /** A message arrives (or is filed by a mail app). Answers its id. */
  deliver(spec: FakeMessageSpec = {}): string {
    const id = `e${++this.n}`
    const at = spec.at ?? this.clock
    const messageId = spec.messageId ?? `<${id}@example.com>`
    const subject = spec.subject ?? `Subject of ${id}`
    const from = spec.from ?? 'Dana Smith <dana@example.com>'
    const to = spec.to ?? `Test <${this.address}>`
    const body = spec.body ?? `Body of ${id}`
    const text =
      `From: ${from}\r\nTo: ${to}\r\n${spec.cc ? `Cc: ${spec.cc}\r\n` : ''}Subject: ${subject}\r\nDate: ${new Date(at).toUTCString()}\r\nMessage-ID: ${messageId}\r\n` +
      `${spec.inReplyTo ? `In-Reply-To: ${spec.inReplyTo}\r\n` : ''}${spec.references ? `References: ${spec.references}\r\n` : ''}` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`
    const raw =
      spec.raw === undefined ? encoder.encode(text) : typeof spec.raw === 'string' ? encoder.encode(spec.raw) : spec.raw
    const reply = spec.inReplyTo ? [...this.emails.values()].find((e) => e.messageId === spec.inReplyTo) : undefined
    const threadId = spec.threadId ?? reply?.threadId ?? `t${++this.n}`
    const role = spec.folder ?? 'inbox'
    const email: FakeEmail = {
      id,
      threadId,
      mailboxIds: { [this.folder(role)]: true },
      keywords: {
        ...(spec.seen === true || role === 'sent' || role === 'drafts' ? { $seen: true as const } : {}),
        ...(spec.flagged ? { $flagged: true as const } : {}),
        ...(role === 'drafts' ? { $draft: true as const } : {}),
        ...(role === 'junk' ? { $junk: true as const } : {}),
      },
      receivedAt: at,
      blobId: `blob-${id}`,
      raw,
      size: spec.size ?? raw.length,
      messageId,
      inReplyTo: spec.inReplyTo ?? null,
      references: spec.references ? (spec.references.match(/<[^>]+>/g) ?? []) : [],
      from,
      to,
      cc: spec.cc ?? '',
      subject,
      preview: body.slice(0, 200),
    }
    this.emails.set(id, email)
    this.recordChange({ created: [id], updated: [], destroyed: [] })
    this.notifyPushes()
    return id
  }

  /** A mail app marks a message read or unread. */
  markSeen(id: string, seen: boolean): void {
    const e = this.must(id)
    if (seen) e.keywords.$seen = true
    else delete e.keywords.$seen
    this.recordChange({ created: [], updated: [id], destroyed: [] })
    this.notifyPushes()
  }

  /** A mail app moves a message to another folder (Archive, Trash, Junk, back to the Inbox). */
  moveTo(id: string, role: string): void {
    const e = this.must(id)
    e.mailboxIds = { [this.folder(role)]: true }
    this.recordChange({ created: [], updated: [id], destroyed: [] })
    this.notifyPushes()
  }

  flag(id: string, flagged: boolean): void {
    const e = this.must(id)
    if (flagged) e.keywords.$flagged = true
    else delete e.keywords.$flagged
    this.recordChange({ created: [], updated: [id], destroyed: [] })
    this.notifyPushes()
  }

  /** The message is removed for good (expunged). */
  destroy(id: string): void {
    this.must(id)
    this.emails.delete(id)
    this.recordChange({ created: [], updated: [], destroyed: [id] })
    this.notifyPushes()
  }

  /** The server forgets its history up to now. */
  forgetHistory(): void {
    this.forgotten = this.emailState
  }

  private must(id: string): FakeEmail {
    const e = this.emails.get(id)
    if (!e) throw new Error(`the fake server has no message ${id}`)
    return e
  }

  /** The ids in a folder (by role), oldest first. */
  inFolder(role: string): string[] {
    const folder = this.folder(role)
    return [...this.emails.values()]
      .filter((e) => e.mailboxIds[folder])
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .map((e) => e.id)
  }

  get state(): string {
    return `s${this.emailState}`
  }

  // ── pushes ────────────────────────────────────────────────────────────────────

  get subscriptions(): readonly Sub[] {
    return this.subs
  }

  private notifyPushes(): void {
    for (const s of this.subs) {
      if (!s.verified || s.expires <= this.clock) continue
      this.owed.push({
        url: s.url,
        body: {
          '@type': 'StateChange',
          changed: { [this.accountId]: { Email: `s${this.emailState}`, Mailbox: `s${this.mailboxState}` } },
        },
      })
    }
  }

  /** Hand over every push the server owes, in order, to what stands in for the internet. */
  async drainPushes(deliver: (url: string, body: unknown) => Promise<unknown> | unknown): Promise<number> {
    let sent = 0
    while (this.owed.length > 0) {
      const next = this.owed.shift() as { url: string; body: unknown }
      await deliver(next.url, next.body)
      sent += 1
    }
    return sent
  }

  // ── the door ──────────────────────────────────────────────────────────────────

  /** `fetch`, as the Worker would call it. */
  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (this.unreachable) throw new TypeError('Network connection lost.')
    const url = new URL(input)
    if (`${url.protocol}//${url.host}` !== this.door) return new Response('no such host', { status: 404 })
    const headers = new Headers(init.headers)
    const methods: string[] = []
    let parsed: { methodCalls?: [string, Record<string, unknown>, string][] } | null = null
    if (init.body !== undefined && typeof init.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
        for (const c of parsed?.methodCalls ?? []) methods.push(c[0])
      } catch {
        parsed = null
      }
    }
    this.requests.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      calls: (parsed?.methodCalls ?? []).map(([name, args]) => ({
        name,
        args,
        kind: classify(name, args, this.allowContextFor(args)),
      })),
    })
    // the gate first, as Cloudflare Access is
    if (
      this.refuseAccess ||
      headers.get('CF-Access-Client-Id') !== this.accessId ||
      headers.get('CF-Access-Client-Secret') !== this.accessSecret
    ) {
      return new Response('<html>Cloudflare Access</html>', { status: 403 })
    }
    const failure = this.failures.findIndex((f) => f.when(url.pathname, methods))
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1)
      return new Response('<html>nope</html>', { status: f?.status ?? 500 })
    }
    if (this.refuseKey || headers.get('authorization') !== `Bearer ${this.key}`)
      return new Response('', { status: 401 })

    const lose = this.loseAnswers.findIndex((w) => w(methods))
    let response: Response
    if (url.pathname === '/jmap/session' && (init.method ?? 'GET') === 'GET') response = this.session()
    else if (url.pathname === '/jmap' && init.method === 'POST' && parsed)
      response = await this.answerApi(parsed.methodCalls ?? [], methods)
    else if (url.pathname.startsWith('/jmap/download/') && (init.method ?? 'GET') === 'GET')
      response = this.download(url.pathname)
    else response = new Response('', { status: 404 })
    if (lose >= 0) {
      this.loseAnswers.splice(lose, 1)
      throw new TypeError('Network connection lost.')
    }
    return response
  }

  /** The API's answer. Stalwart was measured POSTing the verification within ~0.1 s of making a subscription, before the caller has read the answer: with `pushesBeforeAnswer` set, the pushes owed are handed over at that point. */
  private async answerApi(calls: [string, Record<string, unknown>, string][], methods: string[]): Promise<Response> {
    const response = this.api(calls)
    if (this.pushesBeforeAnswer && methods.includes('PushSubscription/set'))
      await this.drainPushes(this.pushesBeforeAnswer)
    return response
  }

  private session(): Response {
    return Response.json({
      capabilities: {},
      accounts: { [this.accountId]: { name: this.address, isPersonal: true } },
      primaryAccounts: {
        'urn:ietf:params:jmap:mail': this.accountId,
        'urn:ietf:params:jmap:submission': this.accountId,
      },
      username: this.address,
      // Stalwart names its own hostname here, which the space cannot reach: the module must not follow it.
      apiUrl: 'https://mail-test.harborline.example/jmap/',
      downloadUrl: 'https://mail-test.harborline.example/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
      state: 'x',
    })
  }

  private download(path: string): Response {
    const [, , , account, blob] = path.split('/')
    if (account !== this.accountId) return new Response('', { status: 404 })
    const email = [...this.emails.values()].find((e) => e.blobId === decodeURIComponent(blob ?? ''))
    if (!email) return new Response('', { status: 404 })
    this.downloads.push(email.id)
    return new Response(email.raw as unknown as BodyInit, { headers: { 'content-type': 'message/rfc822' } })
  }

  private api(calls: [string, Record<string, unknown>, string][]): Response {
    const out: [string, Record<string, unknown>, string][] = []
    const created: Record<string, string> = {}
    for (const [name, args, tag] of calls) {
      try {
        out.push([name, this.method(name, args, created), tag])
      } catch (error) {
        if (error instanceof ServerError) out.push(['error', { type: error.type, description: error.message }, tag])
        else throw error
      }
    }
    const mangle = calls.some(([name]) => name === 'EmailSubmission/set') ? this.mangles.shift() : undefined
    return Response.json({ methodResponses: mangle ? mangle(out) : out, sessionState: 'x' })
  }

  /** The allow-list's context as the real client would hold it for this request: the folders by role, and the id a destroy names as the unsent copy (the allow-list test checks the client only asks what fits). */
  private allowContextFor(args: Record<string, unknown>): AllowContext {
    const idOf = (role: string): string | null => this.folders.find((f) => f.role === role)?.id ?? null
    return {
      inbox: idOf('inbox'),
      archive: idOf('archive'),
      drafts: idOf('drafts'),
      sent: idOf('sent'),
      unsent: Array.isArray(args.destroy) && typeof args.destroy[0] === 'string' ? args.destroy[0] : null,
    }
  }

  private parseState(state: unknown): number {
    if (typeof state !== 'string' || !/^s\d+$/.test(state))
      throw new ServerError('invalidArguments', 'invalid JMAP State')
    return Number(state.slice(1))
  }

  private method(
    name: string,
    args: Record<string, unknown>,
    created: Record<string, string>,
  ): Record<string, unknown> {
    if ('accountId' in args && args.accountId !== this.accountId)
      throw new ServerError('accountNotFound', 'The accountId does not correspond to a valid account')
    switch (name) {
      case 'Mailbox/get':
        return {
          accountId: this.accountId,
          state: `s${this.mailboxState}`,
          list: this.folders.map((f) => ({ ...f })),
          notFound: [],
        }
      case 'Mailbox/changes': {
        this.parseState(args.sinceState)
        return {
          accountId: this.accountId,
          oldState: args.sinceState,
          newState: `s${this.mailboxState}`,
          hasMoreChanges: false,
          created: [],
          updated: [],
          destroyed: [],
        }
      }
      case 'Identity/get':
        return {
          accountId: this.accountId,
          state: `i${this.identityState}`,
          list: [this.address, ...this.aliases].map((email, i) => ({ id: `i${i}`, email, name: this.accountName })),
          notFound: [],
        }
      case 'Email/get': {
        const ids = (args.ids as string[] | null) ?? [...this.emails.keys()]
        const wanted = new Set((args.properties as string[] | undefined) ?? [])
        const list: Record<string, unknown>[] = []
        const notFound: string[] = []
        for (const id of ids) {
          const e = this.emails.get(id)
          if (!e) notFound.push(id)
          else list.push(this.project(e, wanted))
        }
        return { accountId: this.accountId, state: this.state, list, notFound }
      }
      case 'Email/query':
        return this.emailQuery(args)
      case 'Email/changes':
        return this.emailChanges(args)
      case 'Thread/get': {
        const ids = (args.ids as string[]) ?? []
        const list = ids.flatMap((id) => {
          const members = [...this.emails.values()]
            .filter((e) => e.threadId === id)
            .sort((a, b) => a.receivedAt - b.receivedAt)
            .map((e) => e.id)
          return members.length === 0 ? [] : [{ id, emailIds: members }]
        })
        return {
          accountId: this.accountId,
          state: this.state,
          list,
          notFound: ids.filter((id) => !list.some((l) => l.id === id)),
        }
      }
      case 'Email/set':
        return this.emailSet(args, created)
      case 'EmailSubmission/set':
        return this.submissionSet(args, created)
      case 'PushSubscription/get':
        return {
          state: 'p',
          list: this.subs.map((s) => ({
            id: s.id,
            deviceClientId: s.deviceClientId,
            verificationCode: null,
            expires: new Date(s.expires).toISOString(),
            types: s.types,
          })),
          notFound: [],
        }
      case 'PushSubscription/set':
        return this.pushSet(args)
      default:
        throw new ServerError('unknownMethod', name)
    }
  }

  private emailQuery(args: Record<string, unknown>): Record<string, unknown> {
    const filter = (args.filter ?? {}) as Record<string, unknown>
    const conditions = (filter.operator === 'OR' ? (filter.conditions as Record<string, unknown>[]) : [filter]).map(
      (c) => ({
        inMailbox: c.inMailbox as string | undefined,
        after: typeof c.after === 'string' ? Date.parse(c.after) : null,
      }),
    )
    const hits = [...this.emails.values()]
      .filter((e) =>
        conditions.some(
          (c) =>
            (c.inMailbox === undefined || e.mailboxIds[c.inMailbox]) && (c.after === null || e.receivedAt >= c.after),
        ),
      )
      .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id))
    const position = typeof args.position === 'number' ? args.position : 0
    const limit = typeof args.limit === 'number' ? args.limit : 5000
    return {
      accountId: this.accountId,
      queryState: this.state,
      canCalculateChanges: true,
      position,
      ids: hits.slice(position, position + limit).map((e) => e.id),
      total: hits.length,
    }
  }

  private emailChanges(args: Record<string, unknown>): Record<string, unknown> {
    const since = this.parseState(args.sinceState)
    if (this.cannotCalculate || since < this.forgotten)
      throw new ServerError('cannotCalculateChanges', 'cannot calculate changes')
    const max = typeof args.maxChanges === 'number' ? args.maxChanges : 500
    const createdIds = new Set<string>()
    const updatedIds = new Set<string>()
    const destroyedIds = new Set<string>()
    let newState = since
    let count = 0
    let more = false
    for (const c of this.changes.filter((c) => c.state > since)) {
      const size = c.created.length + c.updated.length + c.destroyed.length
      if (count > 0 && count + size > max) {
        more = true
        break
      }
      count += size
      newState = c.state
      for (const id of c.created) createdIds.add(id)
      for (const id of c.updated) if (!createdIds.has(id)) updatedIds.add(id)
      for (const id of c.destroyed) {
        if (createdIds.delete(id)) continue
        updatedIds.delete(id)
        destroyedIds.add(id)
      }
    }
    return {
      accountId: this.accountId,
      oldState: args.sinceState,
      newState: `s${newState}`,
      hasMoreChanges: more,
      created: [...createdIds],
      updated: [...updatedIds],
      destroyed: [...destroyedIds],
    }
  }

  private project(e: FakeEmail, wanted: Set<string>): Record<string, unknown> {
    const all: Record<string, unknown> = {
      id: e.id,
      threadId: e.threadId,
      mailboxIds: { ...e.mailboxIds },
      keywords: { ...e.keywords },
      receivedAt: new Date(e.receivedAt).toISOString(),
      blobId: e.blobId,
      size: e.size,
      subject: e.subject,
      preview: e.preview,
      sentAt: new Date(e.receivedAt).toISOString(),
      messageId: [e.messageId.replace(/^<|>$/g, '')],
      inReplyTo: e.inReplyTo ? [e.inReplyTo.replace(/^<|>$/g, '')] : null,
      from: addressesOf(e.from),
      to: addressesOf(e.to),
      cc: e.cc ? addressesOf(e.cc) : null,
      replyTo: null,
    }
    if (wanted.size === 0) return all
    return Object.fromEntries(Object.entries(all).filter(([k]) => wanted.has(k) || k === 'id'))
  }

  private emailSet(args: Record<string, unknown>, created: Record<string, string>): Record<string, unknown> {
    const oldState = this.state
    const result: Record<string, unknown> = { accountId: this.accountId, oldState }
    const updates = (args.update ?? {}) as Record<string, Record<string, unknown>>
    if (Object.keys(updates).length > 0) {
      const updated: Record<string, null> = {}
      const notUpdated: Record<string, { type: string }> = {}
      const touched: string[] = []
      for (const [id, patch] of Object.entries(updates)) {
        const e = this.emails.get(id)
        if (!e) notUpdated[id] = { type: 'notFound' }
        else if (this.refuseUpdatesOf.has(id)) notUpdated[id] = { type: 'forbidden' }
        else {
          this.patch(e, patch)
          updated[id] = null
          touched.push(id)
        }
      }
      if (touched.length > 0) this.recordChange({ created: [], updated: touched, destroyed: [] })
      result.updated = updated
      result.notUpdated = notUpdated
    }
    const creates = (args.create ?? {}) as Record<string, Record<string, unknown>>
    if (Object.keys(creates).length > 0) {
      const made: Record<string, unknown> = {}
      for (const [key, spec] of Object.entries(creates)) {
        const email = this.makeOutgoing(spec)
        created[key] = email.id
        made[key] = { id: email.id, threadId: email.threadId, blobId: email.blobId, size: email.size }
      }
      result.created = made
    }
    const destroys = (args.destroy ?? []) as string[]
    if (destroys.length > 0) {
      const destroyed: string[] = []
      const notDestroyed: Record<string, { type: string }> = {}
      for (const id of destroys) {
        if (this.emails.delete(id)) destroyed.push(id)
        else notDestroyed[id] = { type: 'notFound' }
      }
      if (destroyed.length > 0) this.recordChange({ created: [], updated: [], destroyed })
      result.destroyed = destroyed
      result.notDestroyed = notDestroyed
    }
    result.newState = this.state
    this.notifyPushes()
    return result
  }

  private patch(e: FakeEmail, patch: Record<string, unknown>): void {
    for (const [path, value] of Object.entries(patch)) {
      const [group, key] = path.split('/') as [string, string]
      const target = group === 'keywords' ? e.keywords : e.mailboxIds
      if (value === null) delete target[key]
      else target[key] = true
    }
  }

  private makeOutgoing(spec: Record<string, unknown>): FakeEmail {
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((p) => String((p as { email: string }).email)) : []
    const from = (spec.from as { name?: string; email: string }[])[0] as { name?: string; email: string }
    const to = list(spec.to)
    const cc = list(spec.cc)
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => `<${String(x)}>`) : [])
    const messageId = ids(spec.messageId)[0] ?? `<out${this.n + 1}@${this.address.split('@')[1]}>`
    const inReplyTo = ids(spec.inReplyTo)[0] ?? null
    const body = String((spec.bodyValues as Record<string, { value: string }>)?.body?.value ?? '')
    const id = `e${++this.n}`
    const text =
      `From: ${from.name ? `${from.name} ` : ''}<${from.email}>\r\nTo: ${to.join(', ')}\r\n${cc.length > 0 ? `Cc: ${cc.join(', ')}\r\n` : ''}Subject: ${String(spec.subject ?? '')}\r\n` +
      `Date: ${new Date(String(spec.sentAt ?? new Date(this.clock).toISOString())).toUTCString()}\r\nMessage-ID: ${messageId}\r\n${inReplyTo ? `In-Reply-To: ${inReplyTo}\r\n` : ''}` +
      `${Array.isArray(spec.references) && spec.references.length > 0 ? `References: ${ids(spec.references).join(' ')}\r\n` : ''}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`
    const raw = encoder.encode(text)
    const parent = inReplyTo ? [...this.emails.values()].find((e) => e.messageId === inReplyTo) : undefined
    const email: FakeEmail = {
      id,
      threadId: parent?.threadId ?? `t${++this.n}`,
      mailboxIds: Object.fromEntries(
        Object.keys((spec.mailboxIds as Record<string, boolean>) ?? {}).map((k) => [k, true as const]),
      ),
      keywords: Object.fromEntries(
        Object.keys((spec.keywords as Record<string, boolean>) ?? {}).map((k) => [k, true as const]),
      ),
      receivedAt: this.clock,
      blobId: `blob-${id}`,
      raw,
      size: raw.length,
      messageId,
      inReplyTo,
      references: ids(spec.references),
      from: `${from.name ? `${from.name} ` : ''}<${from.email}>`,
      to: to.join(', '),
      cc: cc.join(', '),
      subject: String(spec.subject ?? ''),
      preview: body.slice(0, 200),
    }
    this.emails.set(id, email)
    this.recordChange({ created: [id], updated: [], destroyed: [] })
    return email
  }

  private submissionSet(args: Record<string, unknown>, created: Record<string, string>): Record<string, unknown> {
    const creates = (args.create ?? {}) as Record<string, { identityId: string; emailId: string }>
    const result: Record<string, unknown> = { accountId: this.accountId, created: {}, notCreated: {} }
    for (const [key, spec] of Object.entries(creates)) {
      const emailId = spec.emailId.startsWith('#') ? created[spec.emailId.slice(1)] : spec.emailId
      const email = emailId ? this.emails.get(emailId) : undefined
      const identity = [this.address, ...this.aliases]
        .map((e, i) => ({ id: `i${i}`, email: e }))
        .find((i) => i.id === spec.identityId)
      if (!email) {
        ;(result.notCreated as Record<string, unknown>)[key] = {
          type: 'invalidProperties',
          description: 'no such email',
        }
        continue
      }
      if (!identity) {
        ;(result.notCreated as Record<string, unknown>)[key] = {
          type: 'invalidProperties',
          description: 'no such identity',
        }
        continue
      }
      if (this.refuseSubmission !== null) {
        ;(result.notCreated as Record<string, unknown>)[key] = { type: this.refuseSubmission, description: 'refused' }
        continue
      }
      ;(result.created as Record<string, unknown>)[key] = { id: `sub-${++this.n}`, undoStatus: 'pending' }
      created[key] = `sub-${this.n}`
      const raw = decoder.decode(email.raw)
      this.submitted.push({
        emailId: email.id,
        from: identity.email,
        to: splitAddresses(email.to),
        cc: splitAddresses(email.cc),
        raw,
      })
      if (this.loopback && splitAddresses(email.to).includes(this.address)) {
        this.deliver({
          from: email.from,
          to: email.to,
          subject: email.subject,
          body: raw.split('\r\n\r\n')[1] ?? '',
          messageId: `<in-${email.id}@cf>`,
        })
      }
    }
    // what the server does to the message once the submission succeeded
    const after = (args.onSuccessUpdateEmail ?? {}) as Record<string, Record<string, unknown>>
    for (const [ref, patch] of Object.entries(after)) {
      const submission = created[ref.replace(/^#/, '')]
      if (!submission || !(result.created as Record<string, unknown>)[ref.replace(/^#/, '')]) continue
      const emailId = this.submitted.at(-1)?.emailId
      const e = emailId ? this.emails.get(emailId) : undefined
      if (e) {
        this.patch(e, patch)
        this.recordChange({ created: [], updated: [e.id], destroyed: [] })
      }
    }
    this.notifyPushes()
    result.newState = 'sub'
    return result
  }

  private pushSet(args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const creates = (args.create ?? {}) as Record<string, { url: string; deviceClientId: string; types: string[] }>
    if (Object.keys(creates).length > 0) {
      const made: Record<string, unknown> = {}
      const notCreated: Record<string, unknown> = {}
      for (const [key, spec] of Object.entries(creates)) {
        if (!spec.url.startsWith('https://')) {
          notCreated[key] = {
            type: 'invalidProperties',
            description: 'URL scheme is not permitted',
            properties: ['url'],
          }
          continue
        }
        const sub: Sub = {
          id: `p${++this.n}`,
          url: spec.url,
          types: spec.types,
          deviceClientId: spec.deviceClientId,
          code: `vc-${this.n}`,
          verified: false,
          expires: this.clock + 7 * DAY,
        }
        this.subs.push(sub)
        made[key] = { id: sub.id, keys: null, expires: new Date(sub.expires).toISOString() }
        this.owed.push({
          url: sub.url,
          body: { '@type': 'PushVerification', pushSubscriptionId: sub.id, verificationCode: sub.code },
        })
      }
      result.created = made
      result.notCreated = notCreated
    }
    const updates = (args.update ?? {}) as Record<string, { verificationCode?: string; expires?: string }>
    if (Object.keys(updates).length > 0) {
      const updated: Record<string, unknown> = {}
      const notUpdated: Record<string, unknown> = {}
      for (const [id, patch] of Object.entries(updates)) {
        const sub = this.subs.find((s) => s.id === id)
        if (!sub) notUpdated[id] = { type: 'notFound' }
        else if (patch.verificationCode !== undefined) {
          if (patch.verificationCode === sub.code) {
            sub.verified = true
            updated[id] = null
          } else notUpdated[id] = { type: 'invalidProperties', properties: ['verificationCode'] }
        } else if (patch.expires !== undefined) {
          sub.expires = Date.parse(patch.expires)
          updated[id] = { expires: new Date(sub.expires).toISOString() }
        }
      }
      result.updated = updated
      result.notUpdated = notUpdated
    }
    const destroys = (args.destroy ?? []) as string[]
    if (destroys.length > 0) {
      this.subs = this.subs.filter((s) => !destroys.includes(s.id))
      result.destroyed = destroys
    }
    return result
  }

  /** The server drops a subscription (it expired, or it was restarted). */
  dropSubscriptions(): void {
    this.subs = []
  }
}

class ServerError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}

function addressesOf(text: string): { name: string | null; email: string }[] {
  return (text.match(/(?:"?([^"<>,]*)"?\s*)?<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g) ?? []).map((part) => {
    const m = /^(?:"?([^"<>]*)"?\s*)?<([^>]+)>$/.exec(part.trim())
    return m ? { name: m[1]?.trim() || null, email: m[2] as string } : { name: null, email: part.trim() }
  })
}

function splitAddresses(text: string): string[] {
  return addressesOf(text).map((a) => a.email.toLowerCase())
}
