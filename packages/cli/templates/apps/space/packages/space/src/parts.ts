// The parts that run INSIDE this Worker: forms, the knowledge app and the calendar app, meet's chat, calls and phone, and the inbox (the company layer's
// ADR 0003).
//
// A part is not an entrypoint and not a binding: it is a function over a store this Worker holds. The knowledge store is a Durable Object CLASS this Worker defines
// (src/index.ts exports it; the transfer handed the store over), reached through the binding `KNOWLEDGE`. Forms' database and bucket are the account's own, bound here by
// their names (`FORMS_DB`, `FORMS_FILES`) where they have always been; nothing was copied. Meet's two stores are two Durable Object classes (`ROOMS`: one object per call and the usage
// ledger; `WORKSPACE`: the one object holding every channel and chat), bound here by the name of whichever Worker owns the classes at the moment (meet's before the transfer, this one's after:
// the Worker's settings), found by their fixed names.
//
// THE ONE SIGN-IN CHECK has already happened by the time any of this runs (app.ts, `whoIsAsking`). A part is handed the person it named (`SignedIn`) and applies only
// its own rule (knowledge: the owner; forms: an operator). Forms' operator API is its own Hono app, built once per `createApp`, which asks `named` for the operator of the
// request instead of verifying an assertion: the answer is put in a WeakMap keyed by the very Request it is about to be handed, so it is for that request alone and for
// nothing a later one could reach. Meet's part does the same for the socket's upgrade and the dial pad's requests (packages/meet/src/space-part.ts).

import { createApp as createFormsApp } from '@space/forms/src/app'
import type { Env as FormsEnv } from '@space/forms/src/http'
import { scheduled as formsSweep } from '@space/forms/src/scheduled'
import { coreFor as formsCoreFor } from '@space/forms/src/signing'
import { createFormsClientNames } from '@space/forms/src/client-names'
import { createSpaceForms } from '@space/forms/src/space-reads'
import { type Operator, operatorOf, serviceWordsOf } from '@space/forms/src/workspace'
import { createSpaceCalendar } from '@space/calendar/src/space'
import { createSpaceClients } from '@space/clients/src/space'
import { createSourceClients } from '@space/clients/src/source'
import { objectFor as clientsObjectFor, storeFor as clientsStoreFor } from '@space/clients/src/store-access'
import { engineFor } from '@space/calendar/src/store-access'
import { createSpaceKnowledge } from '@space/knowledge/src/space'
import { objectFor, storeFor } from '@space/knowledge/src/store-access'
import { createInboxPartFactory, type InboxPartEnv } from '@space/inbox/src/space-part'
import { runCron } from '@space/meet/src/cron'
import { createGuestApp } from '@space/meet/src/space-guests'
import { createMeetPartFactory, type MeetPart } from '@space/meet/src/space-part'
import { BUNDLED_INSTALL } from '@space/meet/src/company'
import { type MeetEnv, type MeetPartEnv, appOriginOf, depsFor, partDepsFor } from '@space/meet/src/wiring'
import type { ClaudeDoor } from './agent'
import type { TelegramDoor } from './telegram'
import type { GuestParts } from './guests'
import { repairFormsNames } from './clients-forms'
import { clientsForInbox } from './inbox-clients'
import { knowledgeForInbox } from './inbox-knowledge'
import type { CalendarForSpace, ClientsForSource, ClientsForSpace, FormsClientNames, FormsForSpace, Http, InboxForSpace, Install, KnowledgeForSpace, SignedIn, WaitUntil } from '@space/workspace'

/** The bindings and secrets the parts read. All optional: a local run and a deploy mid-transfer have fewer, and the tab then says it is not connected. */
export interface PartsEnv {
  /** The knowledge store: this Worker's own Durable Object class `KnowledgeDO`, once the transfer has bound it (the Worker's settings). Absent in the middle of a transfer. */
  KNOWLEDGE?: DurableObjectNamespace
  /**
   * The calendar's store: this Worker's own Durable Object class `CalendarDO`, declared as NEW in the Worker's settings (the space's ADR 0020). It reads the inbox's store (`INBOX`) for who is connected and for a calendar-only access
   * token, and takes Google's push at `CALENDAR_PUSH_URL` (a var; the object reads it from its own env, so it is not named here).
   */
  CALENDAR?: DurableObjectNamespace
  /**
   * The Clients store: this Worker's own Durable Object class `ClientsDO`, declared as NEW in the Worker's settings (the space's ADR 0021). It makes no request to anything and binds nothing of a source's:
   * a source's Clients arrive as pushes through the Clients door (src/clients-door.ts). The Settings screens, the inbox (in-process, by its inbox face) and the Clients door all read and write it; nothing
   * else in this Worker holds a Clients list, and no service binding to any site's directory is left.
   */
  CLIENTS_STORE?: DurableObjectNamespace
  /** Forms' database (`forms-records`) and bucket (`forms-files`), bound by name. */
  FORMS_DB?: D1Database
  FORMS_FILES?: R2Bucket
  /** The one sending binding (`send_email`): forms' and meet's mail go through it, from the install's two senders (`senders` of the declaration), the only addresses it allows. Every link in an email is on the install's space host, not a setting. */
  EMAIL?: { send(message: never): Promise<unknown> }
  /** Forms' Worker secrets: the vault's master key and the seal certificate's key and chain. */
  FORMS_DATA_KEY?: string
  FORMS_SEAL_KEY?: string
  FORMS_SEAL_CERT_CHAIN?: string
  ASSETS?: { fetch(request: Request): Promise<Response> }
  /** The inbox's store: its Durable Object class `InboxDO`, bound by the owning Worker's name or plainly (the Worker's settings); the same name `INBOX` as in the inbox's own Worker. */
  INBOX?: DurableObjectNamespace
  /**
   * The company's one live object (`LiveDO`, src/live-do.ts): it holds every open page's connection, and every store tells it after a change is stored. Bound to every part that tells it (the stores' own objects
   * read it from their env, forms from `formsEnvOf`) and to the socket route. Absent in `vite dev`: nothing is told, and the page reads on its own (on being shown again and every ten minutes).
   */
  LIVE?: DurableObjectNamespace
  /** The inbox's Google OAuth web client id (a var; the sign-in address of Connect Gmail) and Claude's token id (a var; the inbox's router admits that token and none other on Claude's door). */
  INBOX_GOOGLE_CLIENT_ID?: string
  INBOX_ACCESS_CLIENT_ID?: string
  /** The Telegram bridge's token id (a var; the inbox's bridge router admits that token and none other on the bridge's door). */
  TELEGRAM_ACCESS_CLIENT_ID?: string
  /**
   * The guests' and signers' side: forms' per-caller limit on its public API (`PUBLIC_LIMIT`, namespace 7301) and meet's on the guests' sign-in (`AUTH_LIMIT`, 7302), the two ids of the SFU app and the TURN key
   * (plain vars) and their two secrets, which meet's call API signs a join with. None of it is read by the team's side; the sweep and the operator API need none of it.
   */
  PUBLIC_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  AUTH_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  REALTIME_APP_ID?: string
  TURN_KEY_ID?: string
  MEET_REALTIME_APP_SECRET?: string
  MEET_TURN_KEY_TOKEN?: string
  /** Local development only: an SFU that carries no media, honoured on a localhost host alone. */
  FAKE_REALTIME?: string
  /** Meet's two stores: its Durable Object classes `RoomDO` and `WorkspaceDO`, bound by the owning Worker's name or plainly (the Worker's settings). */
  ROOMS?: DurableObjectNamespace
  WORKSPACE?: DurableObjectNamespace
  /** The phone's four Worker secrets (all or none: packages/meet/src/phone-runtime.ts), and the local stand-in's flag. */
  TELNYX_API_KEY?: string
  TELNYX_PUBLIC_KEY?: string
  TELNYX_CONNECTION_ID?: string
  TELNYX_NUMBER?: string
  FAKE_TELNYX?: string
  /** Only in `vite dev`, from .dev.vars, and only honoured on localhost. */
  ALLOW_UNAUTHENTICATED?: string
}

/** What the Worker holds for one request. Absent means not connected. */
export interface Parts {
  /** The inbox's part, called in-process (packages/inbox/src/space-part.ts). Absent where the store is not bound: Email then says it is not connected. */
  inbox?: InboxForSpace | undefined
  /** Claude's door: the inbox's router in this Worker, for the service token the door's check verified (src/agent.ts). Absent where the store is not bound: the door then says it is not connected. */
  claude?: ClaudeDoor | undefined
  /** The Telegram bridge's door: the inbox's bridge router in this Worker, for the service token its own check verified (src/telegram.ts). Absent where the store is not bound. */
  telegram?: TelegramDoor | undefined
  forms?: FormsForSpace | undefined
  /** What the Clients part asks of Forms: which Clients have signing settings, and the one writing of Forms' copy of a Client's names (packages/forms/src/client-names.ts). Absent where Forms' database is not bound. */
  formsNames?: FormsClientNames | undefined
  knowledge?: KnowledgeForSpace | undefined
  /** The calendar app: Google's calendars as its own store keeps them (packages/calendar/src/space.ts). Absent where the store is not bound. */
  calendar?: CalendarForSpace | undefined
  /** The Clients part: the one list of Clients, as Settings reads and changes it (the inbox reads the same store through its own face, handed in by `inboxEnvOf`). Absent where its store is not bound. */
  clients?: ClientsForSpace | undefined
  /** The Clients part's face for the Clients door: what the one declared source may push (src/clients-door.ts). Absent where the store is not bound or the install declares no source. */
  clientsDoor?: ClientsForSource | undefined
  /** Meet's chat, calls and phone: its methods in-process, and `fetch` for the live socket and the dial pad (packages/meet/src/space-part.ts). Absent where its stores are not bound. */
  meet?: MeetPart | undefined
  /** Forms' operator API and its clients' logos, as the Forms tab's two prefixes ask for them (src/forms.ts). */
  formsApi?: ((req: Request, who: SignedIn, wait?: WaitUntil) => Promise<Response>) | undefined
}

export type PartsFor = (env: PartsEnv) => Parts

/** The parts as the deployed Worker holds them. Called once per `createApp`; the forms app inside it is built on first use and kept. */
export function createParts(deps: { fetch: Http; now: () => number; install: Install }): PartsFor {
  const named = new WeakMap<Request, Operator>()
  let formsApp: ReturnType<typeof createFormsApp> | undefined
  const forms = () => (formsApp ??= createFormsApp({ fetch: deps.fetch, now: deps.now, install: deps.install, named: (req) => named.get(req) ?? null }))
  const meetPart = createMeetPartFactory(deps.install)
  const inboxPart = createInboxPartFactory(deps.install)

  return (env) => {
    const inbox = env.INBOX ? inboxPart(inboxEnvOf(env, deps.install)) : undefined
    const door = deps.install.clientsDoor()
    return {
    knowledge: env.KNOWLEDGE ? createSpaceKnowledge({ store: storeFor({ KNOWLEDGE: env.KNOWLEDGE as never }), object: objectFor({ KNOWLEDGE: env.KNOWLEDGE as never }), install: deps.install }) : undefined,
    calendar: env.CALENDAR ? createSpaceCalendar({ engine: engineFor({ CALENDAR: env.CALENDAR as never }), install: deps.install }) : undefined,
    clients: env.CLIENTS_STORE ? createSpaceClients({ store: clientsStoreFor({ CLIENTS_STORE: env.CLIENTS_STORE as never }), object: clientsObjectFor({ CLIENTS_STORE: env.CLIENTS_STORE as never }), install: deps.install }) : undefined,
    clientsDoor: env.CLIENTS_STORE && door ? createSourceClients({ store: clientsStoreFor({ CLIENTS_STORE: env.CLIENTS_STORE as never }), source: door.source }) : undefined,
    forms: env.FORMS_DB ? createSpaceForms({ db: env.FORMS_DB as never, install: deps.install }) : undefined,
    formsNames: formsNamesFor(env, deps.now, deps.install),
    meet: env.WORKSPACE && env.ROOMS ? meetPart(meetEnvOf(env)) : undefined,
    inbox,
    claude: inbox?.claude,
    telegram: inbox?.telegram,
    formsApi:
      env.FORMS_DB && env.FORMS_FILES
        ? (req, who, wait) => {
            named.set(req, operatorOf(who.person, deps.install))
            return Promise.resolve(forms().fetch(req, formsEnvOf(env, wait)))
          }
        : undefined,
    }
  }
}

/**
 * Forms' environment: its own names for the bindings it was written against, and NONE of the Access audiences. Without `CF_ACCESS_AUD` its own sign-in check could
 * not pass if it ever ran, and with `named` given it never does; `ALLOW_UNAUTHENTICATED` is not passed on either, so forms' local-dev bypass cannot exist here.
 */
export function formsEnvOf(env: PartsEnv, wait?: WaitUntil): FormsEnv {
  return {
    DB: env.FORMS_DB as never,
    FILES: env.FORMS_FILES as never,
    ASSETS: env.ASSETS as never,
    EMAIL: env.EMAIL as never,
    ...(env.FORMS_DATA_KEY !== undefined && { FORMS_DATA_KEY: env.FORMS_DATA_KEY }),
    ...(env.FORMS_SEAL_KEY !== undefined && { FORMS_SEAL_KEY: env.FORMS_SEAL_KEY }),
    ...(env.FORMS_SEAL_CERT_CHAIN !== undefined && { FORMS_SEAL_CERT_CHAIN: env.FORMS_SEAL_CERT_CHAIN }),
    ...(env.PUBLIC_LIMIT !== undefined && { PUBLIC_LIMIT: env.PUBLIC_LIMIT }),
    ...(env.LIVE !== undefined && { LIVE: env.LIVE }),
    ...(wait !== undefined && { LIVE_WAIT: wait }),
    // The Clients part's inbox face, in-process and read only: where a Client's names come from when signing is set up for it or a row is linked to it. Fresh stubs for every request (src/inbox-clients.ts).
    ...(env.CLIENTS_STORE !== undefined && { CLIENTS_READ: clientsForInbox(env.CLIENTS_STORE) }),
  }
}

/** What the Clients part asks of Forms (the one writer of Forms' copy of a Client's names), over Forms' database. Absent where the database is not bound. */
export function formsNamesFor(env: PartsEnv, now: () => number, install?: Install): FormsClientNames | undefined {
  return env.FORMS_DB ? createFormsClientNames({ db: env.FORMS_DB as never, now, ...(install && { service: serviceWordsOf(install) }) }) : undefined
}

/**
 * Puts right any Forms client row whose copy of its Client's names differs from the Client's: the five-minute tick of the Worker's scheduled handler (src/worker.ts). A name changes in Settings with the copy written in the same request;
 * this catches a rename a source pushed in (the Clients door writes the Client alone), a write Forms was unreachable for, and a row linked while a name was being edited. Never throws: a failed pass is the next tick's.
 */
export async function runClientNamesRepair(env: PartsEnv, now: () => number = Date.now, install?: Install): Promise<void> {
  try {
    const out = await repairFormsNames(formsNamesFor(env, now, install), clientsForInbox(env.CLIENTS_STORE))
    if (out.fixed > 0 || out.failed > 0) console.log(`clients: Forms' copy of the names, ${out.checked} checked, ${out.fixed} put right, ${out.failed} not`)
  } catch (e) {
    console.error('clients: the repair of Forms’ copy of the names failed', e)
  }
}

/**
 * Meet's environment: its own names for the bindings it was written against (its links are on the install's space host, `appOriginOf`), and the realtime
 * and the guests' sign-in limit are not passed on to the TEAM'S part: they belong to the guest paths (`guestMeetEnvOf`, below), so the team's part cannot reach the SFU or mint a call's media.
 */
export function meetEnvOf(env: PartsEnv): MeetPartEnv {
  return {
    ROOMS: env.ROOMS as never,
    WORKSPACE: env.WORKSPACE as never,
    EMAIL: env.EMAIL as never,
    ...(env.TELNYX_API_KEY !== undefined && { TELNYX_API_KEY: env.TELNYX_API_KEY }),
    ...(env.TELNYX_PUBLIC_KEY !== undefined && { TELNYX_PUBLIC_KEY: env.TELNYX_PUBLIC_KEY }),
    ...(env.TELNYX_CONNECTION_ID !== undefined && { TELNYX_CONNECTION_ID: env.TELNYX_CONNECTION_ID }),
    ...(env.TELNYX_NUMBER !== undefined && { TELNYX_NUMBER: env.TELNYX_NUMBER }),
    ...(env.FAKE_TELNYX !== undefined && { FAKE_TELNYX: env.FAKE_TELNYX }),
    ...(env.ALLOW_UNAUTHENTICATED !== undefined && { ALLOW_UNAUTHENTICATED: env.ALLOW_UNAUTHENTICATED }),
  }
}

/**
 * Everything meet's guest side reads: the team's part's names, and the call API's SFU and TURN credentials, the guests' sign-in limit and the local-development switches. The one place the SFU's secrets are read;
 * the team's part (`meetEnvOf`) is handed none of them.
 */
export function guestMeetEnvOf(env: PartsEnv): MeetEnv {
  return {
    ...meetEnvOf(env),
    ASSETS: env.ASSETS as never,
    REALTIME_APP_ID: env.REALTIME_APP_ID ?? '',
    TURN_KEY_ID: env.TURN_KEY_ID ?? '',
    MEET_REALTIME_APP_SECRET: env.MEET_REALTIME_APP_SECRET ?? '',
    MEET_TURN_KEY_TOKEN: env.MEET_TURN_KEY_TOKEN ?? '',
    ...(env.AUTH_LIMIT !== undefined && { AUTH_LIMIT: env.AUTH_LIMIT as never }),
    ...(env.FAKE_REALTIME !== undefined && { FAKE_REALTIME: env.FAKE_REALTIME }),
  }
}

/**
 * The guests' and signers' side, made once per `createApp` (src/guests.ts answers the paths; this is the parts behind them): meet's call API, Telnyx's webhook and the channel guests' API, and forms' public API. Neither
 * app is handed a person: the guest side authenticates each request itself with the credential its path takes, and forms' app is made with `named` answering nobody, so its operator API is a 401 here whatever is asked.
 */
export function createGuestParts(deps: { fetch: Http; now: () => number; install: Install }): (env: PartsEnv) => GuestParts {
  const meet = createGuestApp<{ Bindings: MeetEnv }>((c) => depsFor(c.env, c.req.url, deps.install))
  let signer: ReturnType<typeof createFormsApp> | undefined
  const forms = () => (signer ??= createFormsApp({ fetch: deps.fetch, now: deps.now, install: deps.install, named: () => null }))
  return (env) => ({
    meet: env.WORKSPACE && env.ROOMS ? (req) => Promise.resolve(meet.fetch(req, guestMeetEnvOf(env))) : undefined,
    signer: env.FORMS_DB && env.FORMS_FILES ? (req, wait) => Promise.resolve(forms().fetch(req, formsEnvOf(env, wait))) : undefined,
  })
}

/**
 * Forms' hourly sweep, run by this Worker's `scheduled` handler (src/worker.ts), since forms has no Worker of its own to run a cron: expiry, the reminders that are due, sealing again whatever is stuck sealing, mail a request left pending
 * and the retention purge (packages/forms/src/scheduled.ts). Its emails link to the install's space host. Does nothing where forms' database and bucket are not bound.
 */
export async function runFormsSweep(env: PartsEnv, ctx: { waitUntil(p: Promise<unknown>): void }, install?: Install): Promise<void> {
  if (!env.FORMS_DB || !env.FORMS_FILES) return
  const forms = formsEnvOf(env, (p) => ctx.waitUntil(p))
  await formsSweep({ scheduledTime: Date.now() }, forms, ctx, formsCoreFor(forms, Date.now, install))
}

/**
 * The inbox's environment: the store, the Clients part's inbox face (in-process, over the Clients store), the two ids it reads, and the knowledge app asked in-process (Claude's `knowledge` and `propose-knowledge` are handed on to
 * it). Nothing else of this Worker's environment reaches the inbox's part: its sender, bucket, AI and secrets belong to the store's object, which has them from this Worker's bindings itself.
 */
export function inboxEnvOf(env: PartsEnv, install: Install): InboxPartEnv {
  const knowledge = knowledgeForInbox(env.KNOWLEDGE, install)
  const clients = clientsForInbox(env.CLIENTS_STORE)
  return {
    INBOX: env.INBOX as never,
    ...(clients && { clients }),
    ...(env.INBOX_GOOGLE_CLIENT_ID !== undefined && { INBOX_GOOGLE_CLIENT_ID: env.INBOX_GOOGLE_CLIENT_ID }),
    ...(env.INBOX_ACCESS_CLIENT_ID !== undefined && { INBOX_ACCESS_CLIENT_ID: env.INBOX_ACCESS_CLIENT_ID }),
    ...(env.TELEGRAM_ACCESS_CLIENT_ID !== undefined && { TELEGRAM_ACCESS_CLIENT_ID: env.TELEGRAM_ACCESS_CLIENT_ID }),
    ...(knowledge && { knowledge }),
  }
}

/**
 * Meet's five-minute sweep, run by this Worker's `scheduled` handler (src/index.ts) (the classes are this Worker's; the meet Worker has no cron). Tidies the
 * workspace, sends the direct-message nudges that are due and does the phone's chores (packages/meet/src/cron.ts). Does nothing where the stores are not bound.
 */
export async function runMeetSweep(env: PartsEnv, install?: Install): Promise<void> {
  if (!env.WORKSPACE || !env.ROOMS) return
  const meet = meetEnvOf(env)
  await runCron(partDepsFor(meet, appOriginOf(install ?? BUNDLED_INSTALL), install))
}
