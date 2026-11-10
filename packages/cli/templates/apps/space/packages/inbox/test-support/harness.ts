import {
  type ClientsForInbox,
  type InboxForSpace,
  type Install,
  identify,
  issuerOf,
  jwksUrl,
  refusalStatus,
  type SignedIn,
  signedIn,
} from '@space/workspace'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createApp, type Deps, type Env, type ServiceIdentity, type StoreApi } from '../src/app'
import { Assistant } from '../src/assistant/assistant'
import { Arrivals } from '../src/cloudflare/arrivals'
import { type DeclaredMailbox, parseDeclared } from '../src/cloudflare/declared'
import { type Entered, type InboundEmail, receiveEmail } from '../src/cloudflare/entrance'
import { bindingSender } from '../src/cloudflare/send'
import { countInbox } from '../src/counts'
import { Mailroom } from '../src/gmail/mailroom'
import { type DeclaredJmap, parseJmapDeclared } from '../src/jmap/declared'
import { JmapRoom } from '../src/jmap/room'
import { type MailboxContent, readMailboxContent } from '../src/mailbox-content'
import { Notifications } from '../src/notify/deliver'
import { generateVapidKey, parseVapidKey } from '../src/notify/webpush'
import { inboxOwnerOf, mailboxPeopleOf } from '../src/owner'
import { createPushApp } from '../src/push-door'
import { Restores } from '../src/restore'
import { createSpaceInbox } from '../src/space'
import type { MailStore } from '../src/store/mail'
import { migrate } from '../src/store/schema'
import { SpaceStore } from '../src/store/space'
import { createTelegramApp } from '../src/telegram/app'
import { TelegramMediaKeeper } from '../src/telegram/media'
import { bundledContent, bundledInstall } from '../src/workspace'
import { TestClients } from './clients-part'
import { FakeAi } from './fake-ai'
import { FakeBucket } from './fake-bucket'
import { FakeEmailBinding } from './fake-email'
import { FakeGoogle } from './fake-google'
import { FakeJmapServer } from './fake-jmap'
import { FakeKnowledge } from './fake-knowledge'
import { FakeModel } from './fake-model'
import { FakeObjectStorage } from './fake-object-storage'
import { OWNER_EMAIL } from './owner'
import { FakePushService } from './push-device'
import { memoryDatabase } from './sql-over-sqlite'

/**
 * Everything a test needs to drive the inbox from outside: the real router, the
 * real verifier, the real store over a real SQLite with the real migrations, and
 * the real Mailroom over a Google that can fail (fake-google.ts). What is stood
 * in for is only what lives outside the process: Cloudflare's and Google's
 * signing keys, Google itself and the Durable Object's alarm.
 *
 * The Worker has two kinds of caller that are not the space: Claude's door (`request`, the router the space hands the token to) and Gmail's push (`push`, the router
 * the push hostname gets). A person never reaches the router: the owner's side of the inbox is `space()`, the part the space's Worker calls.
 */

export const TEAM = 'northfield.cloudflareaccess.com'
/** An audience that is nobody's: an assertion minted for it must be refused by every door. */
export const AUD = 'a'.repeat(64)
/** The audience of the Access application on the space's agent path: what the space's check of Claude's door verifies the assertion against. */
export const AGENT_AUD = 'd'.repeat(64)
export const AGENT_ID = 'abc123.access'
/** The audience of the Access application on the Telegram bridge's path, and the bridge's token id: its own, never Claude's. */
export const TELEGRAM_AUD = 'e'.repeat(64)
export const TELEGRAM_ID = 'bridge123.access'
/** The return address a Gmail sign-in was started with (the space's); the exchange must use the same. */
export const GMAIL_RETURN = 'https://space.northfield.example/api/inbox/gmail/callback'

/** The push hostname's settings, as the Google module will output them. */
export const PUSH_ENDPOINT = 'https://inbox-push.northfield.example/api/gmail/push'
export const PUSH_ACCOUNT = 'inbox-push@northfield-mail-000000.iam.gserviceaccount.com'
export const TOPIC = 'projects/northfield-mail-000000/topics/inbox-gmail'

/** Our own RSA key standing in for Cloudflare's, and a second that is nobody's. */
const cloudflare = await generateKeyPair('RS256', { extractable: true })
export const forger = await generateKeyPair('RS256', { extractable: true })
const cloudflareJwk = { ...(await exportJWK(cloudflare.publicKey)), kid: 'real', alg: 'RS256' }

/** Cloudflare's key endpoint, as the company layer fetches it: Northfield's team domain publishes our key, nobody else's. */
export const accessFetch = async (url: string): Promise<Response> =>
  url === jwksUrl(TEAM) ? Response.json({ keys: [cloudflareJwk] }) : new Response('no', { status: 404 })

/** A third pair standing in for GOOGLE's signing keys, which sign the push (exported for the space's tests of the push hostname, packages/space/test/worker.test.ts). */
const google = await generateKeyPair('RS256', { extractable: true })
export const googleKeys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(google.publicKey)), kid: 'google', alg: 'RS256' }],
})

export interface MintOptions {
  claims?: Record<string, unknown>
  audience?: string
  issuer?: string
  expiresIn?: number
  key?: CryptoKey
}

/** An assertion of exactly the shape Cloudflare Access sends. */
export async function mint(
  claims: Record<string, unknown>,
  options: Omit<MintOptions, 'claims'> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ type: 'app', country: 'US', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'real' })
    .setIssuer(options.issuer ?? issuerOf(TEAM))
    .setAudience(options.audience ?? AUD)
    .setSubject('subject-id')
    .setIssuedAt(now - 60)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.key ?? cloudflare.privateKey)
}

/**
 * The token Pub/Sub attaches to a push, of the shape Google documents: issued by
 * accounts.google.com, for the audience the subscription names, for the push
 * service account with its email verified. Every field can be overridden, which is
 * how the refusals are tested.
 */
export async function mintPush(
  options: {
    claims?: Record<string, unknown>
    audience?: string
    issuer?: string
    expiresIn?: number
    key?: CryptoKey
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: PUSH_ACCOUNT, email_verified: true, ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'google' })
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? PUSH_ENDPOINT)
    .setSubject('1234567890')
    .setIssuedAt(now - 60)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(options.key ?? google.privateKey)
}

/** The Cloudflare mailbox the deploy config declares in tests: Ridgeway's, as it is declared for real. */
export const RIDGEWAY = { address: 'info@ridgewaycycles.example', name: 'Ridgeway Cycles' }

/** The same mailbox with the spam check running on it to begin with, as wrangler.jsonc declares it for real (the key keeps its first name, `assistant`). */
export const RIDGEWAY_ASSISTED = { ...RIDGEWAY, assistant: true }

/** ShiftLantern's, as wrangler.jsonc declares it: no `assistant`, so the spam check is off until Tessa turns it on. */
export const SHIFTLANTERN = { address: 'hello@shiftlantern.example', name: 'ShiftLantern' }

/** ShiftLantern's with the spam check running, as it is once Tessa has pressed the switch. */
export const SHIFTLANTERN_ASSISTED = { ...SHIFTLANTERN, assistant: true }

export const OWNER = { email: OWNER_EMAIL }
export const AGENT = { common_name: AGENT_ID }
export const BRIDGE = { common_name: TELEGRAM_ID }
export const STRANGER = { email: 'someone@example.com' }

export const T0 = Date.parse('2026-10-20T12:00:00.000Z')

/** The inbox's VAPID key in tests: a real P-256 JWK with both halves, as the Worker secret holds one. */
export const TEST_VAPID = await generateVapidKey()

/** What Pub/Sub POSTs: the mailbox and a history id, base64 inside a message. */
export const pushBody = (address = 'tessa@northfield.example', historyId = '123456') => ({
  message: {
    data: btoa(JSON.stringify({ emailAddress: address, historyId })),
    messageId: '2070443601311540',
    publishTime: '2026-10-20T12:00:01.000Z',
  },
  subscription: 'projects/northfield-mail-000000/subscriptions/inbox-gmail-push',
})

export function harness(
  overrides: Partial<Deps> = {},
  options: {
    googleConfigured?: boolean
    topic?: string
    vapid?: string | null
    /** The declared Cloudflare mailboxes (INBOX_MAILBOXES); Ridgeway's unless a test says otherwise, `[]` for none. */
    mailboxes?: { address: string; name: string; assistant?: boolean }[]
    /** False for a Worker deployed with no raw-mail bucket, which then restores nothing. */
    restoreBucket?: boolean
    /** False for a Worker deployed without the `send_email` binding. */
    emailConfigured?: boolean
    /**
     * The mailboxes on the mail server (INBOX_JMAP_MAILBOXES): `true` declares the test mailbox (test@harborline.example, "harborline") behind the fake server, an array declares exactly those. None by default, so every other
     * test runs with no JMAP room to do anything.
     */
    jmap?: boolean | { address: string; name: string }[]
    /** The model the assistant calls: a fake that answers as the test says, or `null` for a Worker with no key. A fake by default. */
    model?: FakeModel | null
    /** Workers AI, which the spam check asks Clef through: a fake that answers as the test says, or `null` for a Worker with no binding. A fake by default. */
    ai?: FakeAi | null
    /** How long Clef may take before it counts as no answer. */
    clefTimeoutMs?: number
    /** The install the whole Worker is built for (its owner, its people): Northfield's unless a test runs the suites on another company's. */
    install?: Install
    /** The install's mailbox content (personas and spam questions): Northfield's where the install is Northfield's, none for another install unless a test gives it. */
    content?: MailboxContent
    /** The knowledge app (its inbox face), a fake holding nothing unless a test seeds it. */
    knowledge?: FakeKnowledge
    /** False for a Worker deployed without the service binding to it. */
    knowledgeBound?: boolean
    /** How long the assistant waits for the knowledge app; the real wait is four seconds, a test shortens it. */
    knowledgeWithinMs?: number
  } = {},
) {
  const { db, sql, transaction } = memoryDatabase()
  migrate(sql)
  const install = options.install ?? bundledInstall
  const owner = inboxOwnerOf(install)
  const content = options.content ?? (options.install === undefined ? bundledContent : readMailboxContent({}, install))

  let now = T0
  let n = 0
  const clock = () => new Date(now)
  const inbox = new SpaceStore({
    sql,
    transaction,
    now: clock,
    newId: () => `id-${++n}`,
    owner,
    content,
    mailboxPeople: mailboxPeopleOf(install),
  })

  /** Move the clock on, so two writes never share a timestamp. */
  const tick = (ms = 60_000) => {
    now += ms
  }

  const fake = new FakeGoogle()
  /** Google's push service for notifications (not Gmail's push to the inbox, which is `push` below). */
  const pushService = new FakePushService()
  const notifications = new Notifications({
    store: inbox,
    push: pushService,
    key: options.vapid === null ? null : parseVapidKey(options.vapid ?? TEST_VAPID),
    now: clock,
  })
  /** Every alarm the Mailroom asked for, in order. The last one is the one that stands. */
  const alarms: Date[] = []
  const bucket = new FakeBucket()
  /** Cloudflare's sending binding, which the Mailroom reaches through the real `bindingSender`. */
  const email = new FakeEmailBinding()
  /** The mail server, as a fake that can fail (fake-jmap.ts), stamping with the harness's own clock. */
  const jmapServer = new FakeJmapServer(() => now)
  const jmapDeclaration = parseJmapDeclared(
    options.jmap === undefined || options.jmap === false
      ? []
      : options.jmap === true
        ? [
            {
              address: jmapServer.address,
              name: 'harborline',
              door: jmapServer.door,
              secret: 'INBOX_JMAP_HARBORLINE_TEST',
            },
          ]
        : options.jmap.map((m) => ({ ...m, door: jmapServer.door, secret: 'INBOX_JMAP_HARBORLINE_TEST' })),
    owner.email,
  )
  const jmapDeclared: DeclaredJmap[] = jmapDeclaration.ok ? jmapDeclaration.mailboxes : []
  let pushTokens = 0
  const jmapEnv = { INBOX_JMAP_HARBORLINE_TEST: jmapServer.key } as Record<string, string>
  const jmapAlarms: Date[] = []
  const jmapRoom = new JmapRoom({
    store: inbox,
    declared: () => jmapDeclared,
    secret: (name) => jmapEnv[name],
    access: () => ({ id: jmapServer.accessId, secret: jmapServer.accessSecret }),
    fetch: jmapServer.fetch,
    now: clock,
    scheduleAlarm: (at) => {
      alarms.push(at)
      jmapAlarms.push(at)
    },
    pushOrigin: 'https://inbox-push.northfield.example',
    deviceClientId: 'northfield-space',
    newToken: () => `${(++pushTokens).toString(16).padStart(8, '0')}${'a'.repeat(24)}`,
    notifications,
  })
  const mailroom = new Mailroom({
    store: inbox,
    google: options.googleConfigured === false ? null : fake,
    now: clock,
    scheduleAlarm: (at) => {
      alarms.push(at)
    },
    topicName: options.topic ?? TOPIC,
    notifications,
    cloudflare: {
      sender: options.emailConfigured === false ? null : bindingSender(email as unknown as SendEmail),
      bucket,
    },
    jmap: jmapRoom,
  })

  const declaration = parseDeclared(options.mailboxes ?? [RIDGEWAY], owner.email)
  const declared: DeclaredMailbox[] = declaration.ok ? declaration.mailboxes : []
  const ai = options.ai === undefined ? new FakeAi() : options.ai
  const arrivals = new Arrivals({
    store: inbox,
    bucket,
    mailboxes: declared,
    content,
    now: clock,
    scheduleAlarm: (at) => {
      alarms.push(at)
    },
    notifications,
    ai,
    ...(options.clefTimeoutMs !== undefined && { clefTimeoutMs: options.clefTimeoutMs }),
  })

  /** The keeper of Telegram's photos and voice notes, over the same fake bucket, as the Durable Object builds it. */
  const telegramMedia = new TelegramMediaKeeper({ store: inbox, bucket })
  const model = options.model === undefined ? new FakeModel() : options.model
  const knowledge = options.knowledge ?? new FakeKnowledge()
  const knowledgePort = options.knowledgeBound === false ? null : knowledge
  const assistant = new Assistant({
    store: inbox,
    install,
    content,
    knowledge: knowledgePort,
    ...(options.knowledgeWithinMs !== undefined && { knowledgeWithinMs: options.knowledgeWithinMs }),
    model,
    now: clock,
  })

  /**
   * The restore step over a fake of the object's storage. A restart makes a NEW Restores, as the runtime makes a new object (the
   * armed flag does not survive it), so `restores` is read through the harness each time and never held.
   */
  const objectStorage = new FakeObjectStorage(() => now)
  let tokens = 0
  const makeRestores = () =>
    new Restores({
      storage: objectStorage,
      exclusive: (fn) => fn(),
      bucket: options.restoreBucket === false ? null : bucket,
      now: clock,
      newToken: () => `token-${String(++tokens).padStart(4, '0')}-aaaaaaaaaaaaaaaaaaaa`,
      owner,
    })
  let restores = makeRestores()
  objectStorage.onRestart = () => {
    restores = makeRestores()
  }

  /**
   * Run the alarm for as long as one is due now, as the runtime would. An alarm in
   * the future (a backoff) is left standing. Bounded, so a loop is a failure and
   * not a hang.
   */
  async function drain(limit = 60): Promise<number> {
    let runs = 0
    while (runs < limit) {
      const due = alarms.at(-1)
      if (!due || due.getTime() > now) return runs
      alarms.length = 0
      await arrivals.runOwed()
      // As the Durable Object's alarm does: kept messages, then Gmail.
      await mailroom.runAlarm()
      await jmapRoom.runAlarm()
      runs += 1
    }
    throw new Error(`the alarm was still asking to run after ${limit} runs`)
  }

  // A Durable Object's RPC structured-clones what it returns. Doing it here too
  // means a result that would not survive the real thing fails here.
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    // As the Durable Object's `call` does, first: an armed restore restarts the object instead of serving.
    restores.restartIfArmed()
    const owners: [object, unknown][] = [
      [Restores.prototype, restores],
      [TelegramMediaKeeper.prototype, telegramMedia],
      [JmapRoom.prototype, jmapRoom],
      [Mailroom.prototype, mailroom],
      [Notifications.prototype, notifications],
      [Arrivals.prototype, arrivals],
      [Assistant.prototype, assistant],
    ]
    const target = owners.find(([prototype]) => method in prototype)?.[1] ?? inbox
    const fn = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method] as (
      ...a: unknown[]
    ) => unknown
    return structuredClone(await fn.apply(target, args))
  }
  const store = { call: (method: string, ...args: unknown[]) => call(method, args) } as unknown as StoreApi

  const env: Env = {
    INBOX: {} as never,
    INBOX_ACCESS_CLIENT_ID: AGENT_ID,
    TELEGRAM_ACCESS_CLIENT_ID: TELEGRAM_ID,
    INBOX_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    INBOX_GOOGLE_CLIENT_SECRET: 'client-secret',
    GMAIL_PUSH_ENDPOINT: PUSH_ENDPOINT,
    GMAIL_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT,
    GMAIL_TOPIC_NAME: TOPIC,
    RAW: bucket as unknown as R2Bucket,
    EMAIL: email as unknown as SendEmail,
    INBOX_MAILBOXES: options.mailboxes ?? [RIDGEWAY],
    INBOX_JMAP_MAILBOXES: jmapDeclared,
    JMAP_ACCESS_CLIENT_ID: jmapServer.accessId,
    JMAP_ACCESS_CLIENT_SECRET: jmapServer.accessSecret,
    ...(knowledgePort && { KNOWLEDGE: knowledgePort }),
  }

  /** The site's Client directory: Acme Legal (1) and Bolt Machines (2), until a test says otherwise or makes it fail. */
  const directory = new TestClients()

  /**
   * Claude's door, as it runs in the space: the SPACE checks the assertion once, for the agent application's audience and
   * a service token only (packages/space/src/agent.ts, proven in packages/space/test/agent.test.ts), and hands the inbox's router the token it verified. The router here is the real one
   * (src/app.ts, built as src/space-part.ts builds it, with `named`); what stands in front of it is a copy of that one check, with the company layer's `identify` and Cloudflare's keys as the
   * tests have them, so that a test written with a minted assertion still reaches it the way a request reaches it in the Worker. Its refusals are the space's: 401 for no proof or a proof that
   * does not verify, 403 for a verified one that is not a service token.
   */
  const named = new WeakMap<Request, ServiceIdentity>()
  const router = createApp({
    store: () => store,
    clients: () => directory,
    named: (req) => named.get(req) ?? null,
    ...overrides,
  })
  /** What the router is handed for a proof the space would refuse with a 403 (a person, a token with a person, a stranger): nobody it admits, so its own 403 answers, with its own headers. */
  const NOT_THE_AGENT: ServiceIdentity = { kind: 'service', commonName: 'not-the-agent.access', exp: 0 }
  const door = async (request: Request, e?: Env): Promise<Response> => {
    // `vite dev` only: no assertion at all on localhost is the router's own dev identity, if it was built with one.
    if (overrides.devActor !== undefined && !request.headers.has('cf-access-jwt-assertion'))
      return router.fetch(request, e ?? env)
    const out = await identify(
      overrides.install ?? install,
      request.headers,
      { fetch: accessFetch, aud: AGENT_AUD, now: Date.now() },
      { allowServiceTokens: true },
    )
    // Nothing named is a 401 from the router; a refusal the space answers with a 403 is the router's 403, by naming it nobody.
    if (!out.ok) {
      if (refusalStatus(out.refusal) === 403) named.set(request, NOT_THE_AGENT)
    } else named.set(request, out.identity.kind === 'service' ? out.identity : NOT_THE_AGENT)
    return router.fetch(request, e ?? env)
  }
  const app = {
    request: (input: string | Request, init?: RequestInit, e?: Env) =>
      door(input instanceof Request ? input : new Request(input, init), e),
    fetch: (request: Request, e?: Env) => door(request, e),
  }

  /**
   * The Telegram bridge's door, as it runs in the space: the space checks the assertion once, for the bridge application's audience and a service token only (packages/space/src/telegram.ts,
   * proven in packages/space/test/telegram.test.ts), and hands the inbox's bridge router the token it verified. The router is the real one (src/telegram/app.ts); what stands in front of it is a copy of
   * that one check, as Claude's door has.
   */
  const namedBridge = new WeakMap<Request, ServiceIdentity>()
  const bridgeRouter = createTelegramApp({ store: () => store, named: (req) => namedBridge.get(req) ?? null })
  const bridgeDoor = async (request: Request, e?: Env): Promise<Response> => {
    const out = await identify(
      install,
      request.headers,
      { fetch: accessFetch, aud: TELEGRAM_AUD, now: Date.now() },
      { allowServiceTokens: true },
    )
    if (!out.ok) {
      if (refusalStatus(out.refusal) === 403) namedBridge.set(request, NOT_THE_AGENT)
    } else namedBridge.set(request, out.identity.kind === 'service' ? out.identity : NOT_THE_AGENT)
    return bridgeRouter.fetch(request, e ?? env)
  }

  /** Gmail's push, the one thing the Worker answers on a hostname (src/push-door.ts). */
  const pushApp = createPushApp({ store: () => store, pushKeys: googleKeys })

  /** The store's Durable Object for the operator's three: a bookmark and a restart that are recorded, and the counts over the real SQLite. */
  const objectCalls: string[] = []
  const object = {
    bookmark: async () => {
      objectCalls.push('bookmark')
      return `00000001-00000002-00000003-${'a'.repeat(32)}`
    },
    counts: async () => countInbox(sql),
    restart: async () => {
      objectCalls.push('restart')
      throw new Error('restarted')
    },
  }

  /**
   * The inbox's part of the space (src/space.ts), as the space's Worker calls it in-process: over the same store, Mailroom and Client directory as Claude's door, handed the person
   * the space's one sign-in check named (`asker`). Nothing verifies an assertion here: the space's one check did.
   */
  const space = (
    over: { install?: Install; googleClientId?: string; object?: boolean; clients?: ClientsForInbox } = {},
  ): InboxForSpace =>
    createSpaceInbox({
      store,
      install: over.install ?? install,
      clients: over.clients ?? directory,
      googleClientId: 'googleClientId' in over ? over.googleClientId : env.INBOX_GOOGLE_CLIENT_ID,
      ...(over.object !== false && { object: () => object }),
    })

  /**
   * One request as the space forwards it to Claude's door: at the inbox's own path, on the space's host, with an assertion minted for the AGENT
   * application's audience unless a test says otherwise. `who` null sends none.
   */
  async function request(
    who: Record<string, unknown> | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    options: Omit<MintOptions, 'claims'> = {},
  ) {
    const h: Record<string, string> = { ...headers }
    if (who) h['cf-access-jwt-assertion'] = await mint(who, { audience: AGENT_AUD, ...options })
    // A picture is put as the body's bytes (Claude's script does the same); everything else is JSON.
    const raw = body instanceof Uint8Array
    if (body !== undefined) h['content-type'] = raw ? 'application/octet-stream' : 'application/json'
    const res = await app.request(
      `https://space.northfield.example${path}`,
      {
        method,
        headers: h,
        body: body === undefined ? undefined : raw ? (body as unknown as BodyInit) : JSON.stringify(body),
      },
      env,
    )
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, json, text, bytes, headers: res.headers }
  }

  /**
   * One request as the space forwards it to the Telegram bridge's door: at the inbox's own path, with an assertion minted for the BRIDGE application's audience unless a test says
   * otherwise. `who` null sends none.
   */
  async function bridge(
    who: Record<string, unknown> | null,
    path: string,
    body?: unknown,
    options: {
      method?: string
      headers?: Record<string, string>
      audience?: string
      raw?: string
      bytes?: Uint8Array
    } = {},
  ) {
    const h: Record<string, string> = { ...options.headers }
    if (who) h['cf-access-jwt-assertion'] = await mint(who, { audience: options.audience ?? TELEGRAM_AUD })
    const payload =
      (options.bytes as unknown as BodyInit | undefined) ??
      options.raw ??
      (body === undefined ? undefined : JSON.stringify(body))
    // A real request carries its length (the bridge's does, and the door refuses one that does not); a Request built here does not set the header itself.
    if (options.bytes !== undefined) {
      h['content-type'] = 'application/octet-stream'
      h['content-length'] ??= String(options.bytes.length)
    } else if (payload !== undefined) h['content-type'] = 'application/json'
    const res = await bridgeDoor(
      new Request(`https://space.northfield.example${path}`, {
        method: options.method ?? 'POST',
        headers: h,
        body: payload,
      }),
    )
    const bytes = new Uint8Array(await res.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, json, text, bytes, headers: res.headers }
  }

  /**
   * Cloudflare hands the Worker a message: the real entrance, over the fake bucket and the real arrival work, as
   * worker.ts wires them. `raw` is the message as text; its line ends are made CRLF, as they are on the wire. Answers what the
   * entrance did, or throws as it does, and says whether it was refused and why.
   */
  async function deliver(
    raw: string | Uint8Array,
    envelope: { from?: string; to?: string } = {},
  ): Promise<{ entered: Entered; rejected: string | null }> {
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw.replace(/\r?\n/g, '\r\n')) : raw
    let rejected: string | null = null
    const message: InboundEmail = {
      from: envelope.from ?? 'tessa@northfield.example',
      to: envelope.to ?? 'test@ridgewaycycles.example',
      raw: new Response(bytes as BodyInit).body as ReadableStream<Uint8Array>,
      rawSize: bytes.byteLength,
      setReject: (reason) => {
        rejected = reason
      },
    }
    const entered = await receiveEmail(message, {
      mailboxes: declared,
      bucket,
      file: (input) => store.call('fileArrival', input),
      now: clock,
    })
    // As worker.ts does, after the handler has answered: the notification for what was filed.
    if (entered === 'filed') await store.call('deliverNotifications')
    return { entered, rejected }
  }

  /** One request to the PUSH hostname, which has no Access in front of it. */
  async function push(
    options: { token?: string | null; body?: unknown; method?: string; path?: string; host?: string } = {},
  ) {
    const token = options.token === undefined ? await mintPush() : options.token
    const res = await pushApp.request(
      `https://${options.host ?? 'inbox-push.northfield.example'}${options.path ?? '/api/gmail/push'}`,
      {
        method: options.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: (options.method ?? 'POST') === 'GET' ? undefined : JSON.stringify(options.body ?? pushBody()),
      },
      env,
    )
    return { status: res.status, text: await res.text(), headers: res.headers }
  }

  /**
   * Connect Gmail the way the space does for Tessa: the inbox's own connection, exchanging Google's code with the space's return
   * address. Answers the store's result.
   */
  function connect(code = 'good-code') {
    return mailroom.connectMailbox(code, owner.email, GMAIL_RETURN)
  }

  return {
    install,
    /** The install's owner, whom the store admits. */
    owner,
    app,
    pushApp,
    env,
    inbox,
    space,
    objectCalls,
    db,
    request,
    bridge,
    push,
    connect,
    tick,
    store,
    google: fake,
    directory,
    knowledge,
    mailroom,
    /** The mailboxes on the mail server (src/jmap/room.ts), over the fake server below. */
    jmapRoom,
    jmapServer,
    jmapAlarms,
    /** The Worker secrets the room reads a key from, by name (a deploy that changes a key changes this); and the declaration it serves (a test may take a mailbox out of it, as a deploy does). */
    jmapSecrets: jmapEnv,
    jmapDeclared,
    arrivals,
    assistant,
    model,
    ai,
    objectStorage,
    /** The restore step now standing: a restart replaces it, as the runtime replaces the object. */
    get restores() {
      return restores
    },
    bucket,
    email,
    deliver,
    notifications,
    pushService,
    alarms,
    drain,
    now: () => now,
  }
}

/** The oldest Gmail account of a store that holds one (most tests connect one), or null: what a single-account test means by "the mailbox". Production names an account. */
export const firstGmail = (inbox: MailStore) => inbox.gmailMailboxes()[0] ?? null

/** `firstGmail`'s status as the header shows it. */
export const firstGmailStatus = (inbox: MailStore) => inbox.mailboxStatuses()[0] ?? null

/** Every conversation as the queue would show it (the latest screen of them), for tests that look at the store directly. */
export const everyConversation = (inbox: MailStore) => inbox.listConversations(inbox.listQueueFacts().map((f) => f.id))

/**
 * A store or Mailroom result (`{ ok: true, value }` or `{ ok: false, status, error }`) as the HTTP answer the inbox's own routes used to give for it, so a test that
 * drives a rule as the owner (a method called with `OWNER_EMAIL` as the actor, since the owner no longer has a router) keeps its
 * assertions on `status` and `json`. A result that is not one (a value) is a 200.
 */
export const asHttp = (r: unknown): { status: number; json: any } => {
  if (r !== null && typeof r === 'object' && 'ok' in r) {
    const result = r as { ok: boolean; value?: unknown; status?: number; error?: string }
    return result.ok
      ? { status: 200, json: result.value }
      : { status: result.status ?? 500, json: { error: result.error } }
  }
  return { status: 200, json: r }
}

/**
 * Tessa's draft, made as the owner: what `POST /api/drafts` did for the owner (the same `DraftInput` from the same body fields), now a call of the Mailroom's
 * `createDraft` with `OWNER_EMAIL` as the actor. Answers `{ status, json }` like the route did (201 on success).
 */
export async function ownerDraft(
  h: ReturnType<typeof harness>,
  b: Record<string, any>,
): Promise<{ status: number; json: any }> {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const input = {
    ...(b.copyEveryone === true && { copyEveryone: true }),
    body: text(b.body),
    subject: text(b.subject),
    why: text(b.why),
    name: text(b.name),
    ...(text(b.conversationId) && { conversationId: text(b.conversationId) }),
    ...(text(b.contactId) && { contactId: text(b.contactId) }),
    ...(text(b.address) && { address: text(b.address) }),
  }
  const r = asHttp(await h.store.call('createDraft', input as never, h.owner.email))
  return r.status === 200 ? { status: 201, json: r.json } : r
}

/** A row count, for the assertions that something was or was not written. */
export const count = (h: ReturnType<typeof harness>, table: string): number =>
  (h.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

/**
 * The person the space's one sign-in check named, as the inbox's part is handed them: a person of the install by their sign-in address (or, in a test that names them by it, their work address), or, for an address the install does not
 * know, a member of it who is not the inbox's owner (the check cannot name a stranger, so there is none to hand in; a teammate is the closest, and the inbox refuses a teammate).
 */
export function asker(who: Record<string, unknown> = OWNER, install: Install = bundledInstall): SignedIn {
  const address = String(who.email ?? '').toLowerCase()
  const person = install.personBySignIn(address) ??
    install.person(address) ?? {
      address,
      name: 'A teammate',
      signIn: address,
      role: 'member' as const,
      sharedAddresses: [],
    }
  return signedIn(person, Math.floor(Date.now() / 1000) + 3600)
}
