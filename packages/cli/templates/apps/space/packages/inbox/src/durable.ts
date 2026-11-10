/// <reference types="vite/client" />

import { DurableObject } from 'cloudflare:workers'
import { liveOf, tellLive } from '@space/workspace'
import {
  ARRIVAL_METHODS,
  type ArrivalMethod,
  ASSISTANT_METHODS,
  type AssistantMethod,
  type Env,
  JMAP_METHODS,
  type JmapMethod,
  MAIL_METHODS,
  type MailMethod,
  NOTIFY_METHODS,
  type NotifyMethod,
  RESTORE_METHODS,
  type RestoreMethod,
  SPACE_METHODS,
  type SpaceMethod,
  STORE_METHODS,
  type StoreMethod,
  TELEGRAM_MEDIA_METHODS,
  TELEGRAM_METHODS,
  type TelegramMediaMethod,
  type TelegramMethod,
} from './app'
import { Assistant } from './assistant/assistant'
import { modelOverFetch } from './assistant/model'
import { Arrivals } from './cloudflare/arrivals'
import { bindingSender } from './cloudflare/send'
import { countInbox } from './counts'
import { DEV_EMAIL, DEV_GOOGLE, DEV_PUSH } from './dev'
import { declaredMailboxes, NO_BUCKET } from './entrances'
import { createGoogle } from './gmail/google'
import { Mailroom } from './gmail/mailroom'
import { pushSettings } from './gmail/push'
import type { DeclaredJmap } from './jmap/declared'
import { JmapRoom } from './jmap/room'
import { changesMail, inboxPeople } from './live'
import { Notifications, pushOverFetch } from './notify/deliver'
import { parseVapidKey } from './notify/webpush'
import { inboxOwnerOf, mailboxPeopleOf } from './owner'
import { Restores } from './restore'
import { migrate } from './store/schema'
import { SpaceStore } from './store/space'
import { assistantKeyFor, googleCredentialsFor, hostedMailboxesFor, spamCheckAiFor } from './switches'
import { TelegramMediaKeeper } from './telegram/media'
import { bundledContent, bundledInstall } from './workspace'

/** The install's owner, read once from the declaration this Worker was built with. */
const owner = inboxOwnerOf(bundledInstall)

/** The mailboxes on the mail server this deployment declares, none unless the install's `hostedMailboxes` switch is on. A declaration that is not valid declares none, and says why (once, when the object starts): nothing is synced or sent for a mailbox whose declaration cannot be trusted. */
function declaredJmap(env: Env): DeclaredJmap[] {
  const declared = hostedMailboxesFor(bundledInstall, env.INBOX_JMAP_MAILBOXES, owner.email)
  if (declared.ok) return declared.mailboxes
  console.error(`the declared mail server mailboxes are not valid, so none is served: ${declared.error}`)
  return []
}

/** Mail moved: tell the live object, for the owner's open pages. Returns at once and cannot throw into the change (packages/workspace/src/live.ts). Not a method of the class: the runtime exposes every method over RPC. */
function mailMoved(env: Env): void {
  tellLive(liveOf(env), { part: 'mail', people: inboxPeople(bundledInstall) })
}

/**
 * The calls after which an object in the bucket may be left to delete: events that deleted a message for everyone, a file kept for a message deleted meanwhile, and every way a draft that carried a picture goes away or
 * loses it (a draft discarded or deleted, a composer's draft whose send was refused, a stuck send the owner says went out, a send settled by its outcome, a picture taken out or replaced). A push is not here, on purpose:
 * it is the busiest call there is, and the one drop row it can leave (a send settled by its copy in the stream, when the copy had kept an object of its own) is swept by the next call in this list.
 */
const SWEEPS_FILES_AFTER: ReadonlySet<string> = new Set([
  'telegramEvents',
  'keepTelegramMedia',
  'telegramOutcomes',
  'sendDraft',
  'resolveSend',
  'discardComposed',
  'deleteDraft',
  'putDraftPicture',
  'updateDraft',
])

/**
 * The inbox's Durable Object and the typed face of its `call`: the one file of this package that touches the Workers runtime. The space's Worker defines the class from it (src: packages/space/src/inbox-do.ts
 * subclasses it for one method) and OWNS the store, and serves the machine entrances (Gmail's push,
 * Cloudflare's mail, the delivery reports, the daily pass) through the functions of src/entrances.ts and src/push-door.ts. The inbox has no Worker of its own. Every rule is in app.ts,
 * gmail/ and store/, which run under plain `bun`; this is the shell that supplies the real Durable Object, alarm and network.
 *
 * A MOVED OBJECT RUNS WITH THE ENV OF THE WORKER THAT OWNS THE CLASS: its bucket, its sender, its Workers AI, its secrets and its vars are that Worker's bindings. The space's
 * the Worker's settings (kit/worker-settings.ts) therefore carries every binding below (`RAW`, `EMAIL`, `AI`, the Google, VAPID and Anthropic secrets, `INBOX_MAILBOXES`), and an object that was awake through the
 * hand-over kept the giving Worker's env and code until it restarted (the operator's restart, below).
 *
 * ── ONE OBJECT, NAMED BY A CONSTANT ──────────────────────────────────────
 * Every request goes to the same Durable Object, and that is the design rather
 * than a simplification waiting to be undone. With one mailbox, ordering matters
 * more than sharding: a conditional write and the read it depends on cannot
 * interleave, which the claim and the double press of Send both rely on. The
 * cost is that everything serialises through one object; for one inbox that is
 * not close to a problem. Renaming the constant is a new, empty inbox.
 *
 * ── THE ALARM AND THE CRON ───────────────────────────────────────────────
 * Nothing polls Gmail. A push sets the Durable Object's alarm to now, and the
 * alarm (`alarm()` below) does the work, so a push is answered before any of it
 * starts. Mail Cloudflare delivers is filed in the request, and so is its spam check (a call to the spam classifier that is cut off after a few
 * seconds and cannot fail the filing); only a filing that failed is owed work, which the same alarm retries. The cron trigger in
 * the Worker's settings (kit/worker-settings.ts) runs once a day (src/entrances.ts `runDaily`) and
 * is only the safety net: it renews Gmail's watch and runs one sync from the
 * cursor. Neither is how mail normally arrives.
 */
export class InboxDO extends DurableObject<Env> {
  private readonly inbox: SpaceStore
  private readonly mailroom: Mailroom
  private readonly jmapRoom: JmapRoom
  private readonly notifications: Notifications
  private readonly arrivals: Arrivals
  private readonly telegramMedia: TelegramMediaKeeper
  private readonly assistant: Assistant
  private readonly restores: Restores

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Before a single request is served, and on every wake from hibernation. THE CALLBACK RUNS AFTER THE CONSTRUCTOR RETURNS (workerd runs it once the constructor is done, which is why `this.inbox` below exists when it does),
    // so everything that needs the schema is IN it, in order: the migrations first, then the people of every mailbox. Anything that read the store in the constructor body would run before the migration and find no table.
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
      // Every mailbox's people agree with the declaration this Worker was built with (and none is left with nobody on it), before a single request is served (the inbox's ADR 0004;
      // src/store/people.ts). Writes nothing once settled. A failure is logged and does not stop the start: the lists the migration filled stand.
      try {
        const settled = this.inbox.settleMailboxPeople()
        if (settled > 0) console.log(`inbox: ${settled} mailbox people set to the declaration`)
      } catch (error) {
        console.error('inbox: the mailbox people could not be settled', error)
      }
      // A new session of this object is where a restore of its history takes effect (src/restore.ts: armed, then the object restarts), and the store is what it is by now: tell the live object, so open pages read
      // mail again. A start for any other reason (waking after a quiet spell, a deploy) tells too, which costs the open pages one read.
      mailMoved(this.env)
    })
    // The line the move's check reads in `wrangler tail space`: a moved object keeps running its old Worker's code until it restarts, so the first start under the space's code is
    // the proof it has (the space's runbook for the move, "The restart of the moved object").
    console.log('inbox: the store object started')
    this.inbox = new SpaceStore({
      sql: ctx.storage.sql,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      owner,
      content: bundledContent,
      mailboxPeople: mailboxPeopleOf(bundledInstall),
    })
    // The VAPID key, checked once here. Unset or not a whole P-256 key, it is null and notifications fail closed: every
    // route says they are not set up, and nothing is sent. In `vite dev` the key is the dev one from .dev.vars, and the
    // push service is a stand-in that calls nothing (src/dev.ts), so dev never reaches Google's.
    const vapid = parseVapidKey(env.INBOX_VAPID_KEY)
    if (!vapid && (env.INBOX_VAPID_KEY ?? '').trim() !== '')
      console.error('INBOX_VAPID_KEY is set but is not a P-256 JWK')
    this.notifications = new Notifications({
      store: this.inbox,
      push: import.meta.env.DEV ? DEV_PUSH : pushOverFetch((url, init) => fetch(url, init)),
      key: vapid,
      now: () => new Date(),
    })
    // The photos and voice notes the Telegram bridge brings (src/telegram/media.ts): kept in the raw-mail bucket under keys of their own, deleted with a message deleted for everyone.
    // A video is up to 50 MB and comes as a stream: R2 writes a stream only of a known length, so the stream goes through a FixedLengthStream, which also fails the write when the file is not the length it said.
    this.telegramMedia = new TelegramMediaKeeper({
      store: this.inbox,
      bucket: env.RAW ?? NO_BUCKET,
      bounded: (body, length) => {
        const fixed = new FixedLengthStream(length)
        body.pipeTo(fixed.writable).catch(() => undefined)
        return fixed.readable
      },
    })
    // Mail Cloudflare delivers (src/cloudflare/): filed from its kept raw copy, and retried by the alarm when filing fails.
    this.arrivals = new Arrivals({
      store: this.inbox,
      bucket: env.RAW ?? NO_BUCKET,
      mailboxes: declaredMailboxes(env),
      content: bundledContent,
      now: () => new Date(),
      // A message that is filed notifies the owner's devices, as Gmail's does (the rule is src/notify/rule.ts).
      notifications: this.notifications,
      // The spam check: Cloudflare's classifier, on Workers AI (src/cloudflare/spam-check.ts). Unbound (a deploy without it, and `vite dev`,
      // where the binding is remote), nothing is judged and mail is in the Inbox as before.
      // Only where some mailbox of the install has spam questions (src/switches.ts, the install's mailbox content): none, nothing is judged. It is the mailbox's, not the assistant's.
      ai: spamCheckAiFor(
        bundledContent,
        env.AI
          ? { run: (model: string, input: unknown) => env.AI?.run(model as never, input as never) as Promise<unknown> }
          : null,
      ),
      // The Durable Object has one alarm and the Gmail side asks for it too: this one only ever moves it earlier.
      scheduleAlarm: async (at) => {
        const current = await ctx.storage.getAlarm()
        if (current === null || current > at.getTime()) await ctx.storage.setAlarm(at.getTime())
      },
    })
    // The assistant (src/assistant/): drafts a reply when the owner asks in the draft chat, on a key of its own. Nothing on arrival
    // calls it. Without the key there is no model port and a chat turn is refused; in `vite dev` that is the same, so dev never
    // calls the model.
    // The key is read only where the install's `assistant` switch is on: off, there is no model port and the draft chat is refused (the assistant checks the switch itself as well).
    const anthropicKey = assistantKeyFor(bundledInstall, env.ANTHROPIC_API_KEY)
    this.assistant = new Assistant({
      store: this.inbox,
      install: bundledInstall,
      content: bundledContent,
      // The knowledge base is the knowledge app's (packages/knowledge), asked for the conversation's business before the model is: the service
      // binding to its InboxKnowledgeAccess. Absent in `vite dev`, where a chat turn is refused for want of a key anyway.
      knowledge: this.knowledgePort(env),
      model: anthropicKey === '' ? null : modelOverFetch((url, init) => fetch(url, init), anthropicKey),
      now: () => new Date(),
    })
    // Point-in-time recovery of this object's own storage (src/restore.ts). Never reached by a request that is not the owner's.
    this.restores = new Restores({
      storage: {
        currentBookmark: () => ctx.storage.getCurrentBookmark(),
        bookmarkForTime: (at) => ctx.storage.getBookmarkForTime(at),
        armRestore: (bookmark) => ctx.storage.onNextSessionRestoreBookmark(bookmark),
        get: (key) => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: (key) => ctx.storage.delete(key),
        restart: () => ctx.abort('restarting to apply a restore of the store'),
      },
      exclusive: (fn) => ctx.blockConcurrencyWhile(fn),
      bucket: env.RAW ?? null,
      now: () => new Date(),
      newToken: () =>
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
      owner,
    })
    // The mailboxes on the install's own mail server (src/jmap/room.ts): its own chain and its own wish for the alarm, so the owner's Gmail never waits on the mail server.
    const jmapDeclared = declaredJmap(env)
    const push = pushSettings(env)
    const access =
      (env.JMAP_ACCESS_CLIENT_ID ?? '').trim() !== '' && (env.JMAP_ACCESS_CLIENT_SECRET ?? '').trim() !== ''
        ? { id: (env.JMAP_ACCESS_CLIENT_ID as string).trim(), secret: (env.JMAP_ACCESS_CLIENT_SECRET as string).trim() }
        : null
    this.jmapRoom = new JmapRoom({
      store: this.inbox,
      declared: () => jmapDeclared,
      secret: (name) => {
        const value = (env as unknown as Record<string, unknown>)[name]
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
      },
      access: () => access,
      fetch: (url, init) => fetch(url, init),
      now: () => new Date(),
      scheduleAlarm: (at) => {
        this.wanted.jmap = at.getTime()
        return this.armAlarm()
      },
      // The push address the server is told to call: the inbox's public push hostname, which answers this path as well as Gmail's.
      pushOrigin: ((host) => (host === null ? null : `https://${host}`))(
        push.ok ? push.host : bundledInstall.gmailPushHost(),
      ),
      deviceClientId: `${bundledInstall.company.id}-space`,
      newToken: () =>
        Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join(''),
      notifications: this.notifications,
    })
    // Google is reached only where the install's `gmail` switch is on and both halves of its app are there (src/switches.ts).
    const googleCredentials = googleCredentialsFor(
      bundledInstall,
      env.INBOX_GOOGLE_CLIENT_ID,
      env.INBOX_GOOGLE_CLIENT_SECRET,
    )
    this.mailroom = new Mailroom({
      store: this.inbox,
      // Without both halves there is no Google to talk to, and every Gmail route
      // says so rather than failing somewhere deeper. In `vite dev` (and only there) a
      // stand-in answers instead, so opening and Close work against the seeded store.
      google: googleCredentials
        ? createGoogle({ fetch: (url, init) => fetch(url, init), ...googleCredentials, now: () => Date.now() })
        : import.meta.env.DEV
          ? DEV_GOOGLE
          : null,
      now: () => new Date(),
      // Replaces the alarm, as the Mailroom says it does, but never to a time later than a kept message is owed a filing, or than the mail server's side wants (the board below).
      scheduleAlarm: (at) => {
        this.wanted.gmail = at.getTime()
        return this.armAlarm()
      },
      topicName: (env.GMAIL_TOPIC_NAME ?? '').trim(),
      notifications: this.notifications,
      // Sending as a Cloudflare mailbox. In `vite dev` a stand-in answers (src/dev.ts) and sends nothing.
      cloudflare: {
        sender: import.meta.env.DEV ? DEV_EMAIL : env.EMAIL ? bindingSender(env.EMAIL) : null,
        bucket: env.RAW ?? NO_BUCKET,
      },
      jmap: this.jmapRoom,
    })
    this.catchUpOnCalendarMail(ctx)
    this.catchUpOnMailServer(ctx)
  }

  /**
   * What each side of the one alarm wants: the Gmail Mailroom's and the JMAP room's, each the time it last asked for. The object has ONE alarm and setting it replaces it, so the real alarm is the earliest of the two
   * and of a kept message's filing (`armAlarm`). Without this, the mail server's side asking for a retry in half a minute would replace Gmail's retry in an hour, or the other way round.
   */
  private readonly wanted: { gmail: number | null; jmap: number | null } = { gmail: null, jmap: null }

  private armAlarm(): Promise<void> {
    const owed = this.inbox.nextOwedAt()
    const times = [
      this.wanted.gmail,
      this.wanted.jmap,
      typeof owed === 'string' ? Date.parse(owed) : typeof owed === 'number' ? owed : null,
    ].filter((t): t is number => typeof t === 'number' && !Number.isNaN(t))
    return times.length === 0 ? Promise.resolve() : this.ctx.storage.setAlarm(Math.min(...times))
  }

  /**
   * Asks for the alarm when a mailbox on the mail server has anything to do: one declared that has no row yet (the first alarm after a deploy makes it and starts its fill), a fill or a resync under way, a sync owed, or a
   * verification code waiting. The mail server's side of what `catchUpOnCalendarMail` does for Gmail's; a failure is logged and never stops the object starting.
   */
  private catchUpOnMailServer(ctx: DurableObjectState): void {
    ctx.blockConcurrencyWhile(async () => {
      try {
        if (!(await this.jmapRoom.hasJmapWork())) return
        this.wanted.jmap = Date.now()
        await this.armAlarm()
      } catch (error) {
        console.error('inbox: could not ask for the alarm for the mail server mailboxes', error)
      }
    })
  }

  /**
   * Asks for the alarm while the one-time pass over calendar mail stored before the store knew which event a message is about (migration 15)
   * is not done, so a meeting already shown several times is cleaned up as soon as this deploys and not a day later (not the daily pass). The pass is the
   * Mailroom's (`keyStoredCalendarMail`: it reads each candidate again from Gmail, for the headers the store never kept) and the closing of what it finds is
   * the sweep's, both in the alarm. A setting row says it is done, so every later start reads that one row and does nothing: a conversation the owner reopens
   * is never touched by a start. A failure is logged and never stops the object starting.
   */
  private catchUpOnCalendarMail(ctx: DurableObjectState): void {
    ctx.blockConcurrencyWhile(async () => {
      try {
        if (this.inbox.calendarPassDone()) return
        const current = await ctx.storage.getAlarm()
        if (current === null || current > Date.now()) await ctx.storage.setAlarm(Date.now())
      } catch (error) {
        console.error('inbox: could not ask for the pass over stored calendar mail', error)
      }
    })
  }

  /** The Worker's one way in: a store, Mailroom or notifications method by name. See STORE_METHODS, MAIL_METHODS, NOTIFY_METHODS. */
  async call(
    method:
      | StoreMethod
      | SpaceMethod
      | TelegramMethod
      | TelegramMediaMethod
      | MailMethod
      | JmapMethod
      | NotifyMethod
      | ArrivalMethod
      | AssistantMethod
      | RestoreMethod,
    args: unknown[],
  ): Promise<unknown> {
    // Once a restore is armed nothing may write: the store is about to be replaced, so the object restarts instead (src/restore.ts).
    // First, and before the method is looked up, so a method added later is covered.
    this.restores.restartIfArmed()
    const surfaces: [readonly string[], object][] = [
      [STORE_METHODS, this.inbox],
      [SPACE_METHODS, this.inbox],
      [TELEGRAM_METHODS, this.inbox],
      [TELEGRAM_MEDIA_METHODS, this.telegramMedia],
      [MAIL_METHODS, this.mailroom],
      [JMAP_METHODS, this.jmapRoom],
      [NOTIFY_METHODS, this.notifications],
      [ARRIVAL_METHODS, this.arrivals],
      [ASSISTANT_METHODS, this.assistant],
      [RESTORE_METHODS, this.restores],
    ]
    const target = surfaces.find(([names]) => names.includes(method))?.[1]
    if (!target) throw new Error(`No such method: ${method}`)
    try {
      const out = await ((target as unknown as Record<string, unknown>)[method] as (...a: unknown[]) => unknown).apply(
        target,
        args,
      )
      // A live Telegram push may have marked messages owed (src/store/telegram.ts): hand them on as a Cloudflare arrival's are, after the push is stored. NOT awaited: a slow push service must not
      // hold the bridge's reply until it times out and sends the batch again. The object stays up for the delivery (`waitUntil`), a failure is logged and never touches the push, and an owed mark
      // that is left is delivered, or dropped past the hour, by the next delivery run.
      if (method === 'pushTelegram') {
        this.ctx.waitUntil(
          this.notifications
            .deliverOwed()
            .catch((error) => console.error('telegram: could not hand on the notifications owed', error)),
        )
      }
      // A file of a message deleted for everyone, or a picture whose draft went away, is deleted from the bucket after the call that left it; a failure is logged and left for the next sweep.
      if (SWEEPS_FILES_AFTER.has(method)) {
        this.ctx.waitUntil(
          this.telegramMedia
            .sweepTelegramMedia()
            .catch((error) => console.error('telegram: could not sweep the files to delete', error)),
        )
      }
      return out
    } finally {
      // Told AFTER the call, whatever it came to: a send that failed has still stored its failure, and a refusal tells the pages one read they did not need. Never before the store has the change (src/live.ts).
      if (changesMail(method)) mailMoved(this.env)
    }
  }

  /**
   * The knowledge app as the assistant is given it. Where the knowledge app is a Worker of its own it is the service binding `KNOWLEDGE` to that Worker's `InboxKnowledgeAccess`; in the space,
   * where `KNOWLEDGE` is the knowledge store's own class, the space's subclass (packages/space/src/inbox-do.ts) asks the store in-process instead. A method and not an `env` check, because
   * a service binding answers to any property name and cannot be told from a namespace by its shape.
   */
  protected knowledgePort(env: Env): Env['KNOWLEDGE'] {
    return env.KNOWLEDGE
  }

  // THE OPERATOR'S THREE, for a move of this class between Workers. Like `call` they are meant for the Workers that own or bind
  // the class alone, and the only caller that reaches them for a person is the space's owner-only routes (packages/inbox/src/space-operator.ts). They touch no message, draft or contact.
  // test/worker-exports.test.ts pins this class's methods.

  /** Cloudflare's bookmark of this object's history now: what a restore goes back to. */
  bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark()
  }

  /** How many rows each counted table holds (src/counts.ts): numbers under names, read before and after a move. */
  counts(): Record<string, number> {
    return countInbox(this.ctx.storage.sql)
  }

  /**
   * Drop this object's in-memory state; its next call starts it afresh under the code and env of the Worker that owns the class. The caller sees an error (the object was reset under it),
   * which is the answer. An abort like this is how an object is moved onto its new Worker's code.
   */
  restart(): void {
    this.ctx.abort('restarted on the owner’s word')
  }

  /**
   * `vite dev` only: fill the local store with synthetic conversations (src/dev.ts), after emptying it
   * when `reset` is true. In a build `import.meta.env.DEV` is false, this does nothing, and the module
   * is not in the bundle.
   */
  async devSeed(reset: boolean): Promise<string> {
    if (!import.meta.env.DEV) return 'Not available.'
    const { seedDevInbox } = await import('./dev')
    if (this.inbox.gmailMailboxes().length > 0) {
      if (!reset) return 'The store already holds a mailbox. POST /__dev/seed?reset=1 empties it first.'
      await this.ctx.storage.deleteAll()
      migrate(this.ctx.storage.sql)
    }
    seedDevInbox(this.inbox, this.ctx.storage.sql)
    return 'Seeded.'
  }

  /**
   * `vite dev` only: a reply arrives on a seeded conversation (src/dev.ts), stored as the sync stores mail, so it is
   * put to the notification rule, and what it owes is handed to the dev push service, which logs and sends nothing.
   */
  async devArrive(thread: string): Promise<string> {
    if (!import.meta.env.DEV) return 'Not available.'
    const { arriveDevMessage } = await import('./dev')
    const said = arriveDevMessage(this.inbox, thread)
    await this.notifications.deliverOwed()
    return said
  }

  /**
   * Whatever is owed: a kept message the inbox has not filed yet (first, and a failure there never stops the rest), then
   * whatever is owed to Gmail: a push, a sync someone asked for, a fill, or a retry after a failure.
   */
  override async alarm(): Promise<void> {
    this.restores.restartIfArmed()
    try {
      await this.arrivals.runOwed()
    } catch (error) {
      console.error('filing kept messages failed', error)
    }
    // Gmail first: the owner's own mail never waits on a model, or on the mail server.
    let gmailFailed = false
    let gmailFailure: unknown = null
    try {
      // Gmail's side runs unless it asked for a LATER time (a retry after a failure) and this alarm is only the mail server's: it is then left to wait for its own.
      if (this.wanted.gmail === null || this.wanted.gmail <= Date.now() + 1_000) {
        this.wanted.gmail = null
        try {
          await this.mailroom.runAlarm()
        } catch (error) {
          // Gmail's failure is kept and thrown AFTER the mail server's mailboxes have had their turn: it still fails the alarm as it always did (the runtime retries it), but it no longer takes the mail server's pass with it,
          // which would otherwise be skipped by every retry for as long as Gmail keeps failing.
          gmailFailed = true
          gmailFailure = error
        }
      }
      // Then the mailboxes on the mail server (src/jmap/room.ts). A failure there is its own and never reaches Gmail's.
      this.wanted.jmap = null
      try {
        await this.jmapRoom.runAlarm()
      } catch (error) {
        console.error('the mail server mailboxes failed', error)
      }
    } finally {
      // The alarm is where a push's sync and a Cloudflare filing retry store mail (and where a failed account's state is written): the pages read again.
      mailMoved(this.env)
      // The alarm that fired is spent: whatever either side still wants (a retry that is not yet due) is set again.
      await this.armAlarm()
    }
    if (gmailFailed) throw gmailFailure
  }
}
