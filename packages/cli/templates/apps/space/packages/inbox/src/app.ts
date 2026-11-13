/**
 * The inbox's API for Claude's script, as a function: the gate and the JSON API.
 *
 * Importable without the Workers runtime, so `bun test` drives real requests
 * through the real router, the real verifier and the real store (over a real
 * SQLite) with only the outside world injected: the Durable Object and
 * Cloudflare's signing keys. the space's Worker (packages/space/src/worker.ts) is the thin shell that supplies the
 * real ones. The shape is a Hono app over a store slice.
 */

import {
  assertionFrom,
  type ClientsForInbox,
  type Identity,
  type KnowledgeForInbox,
  type LiveBinding,
  safeSummaryLine,
} from '@space/workspace'
import { type Context, Hono } from 'hono'
import type { Assistant } from './assistant/assistant'
import {
  type ClientsRead,
  checkLink,
  clientLabel,
  clientsById,
  clientView,
  readClients,
  suggestClients,
} from './clients'
import type { Arrivals } from './cloudflare/arrivals'
import type { Mailroom } from './gmail/mailroom'
import type { PushEnv } from './gmail/push'
import type { JmapRoom } from './jmap/room'
import { type Asked, ask, KNOWLEDGE_UNREACHED, type KnowledgePort } from './knowledge'
import type { Notifications } from './notify/deliver'
import { inboxOwnerOf } from './owner'
import { canSee, type MailScope, planQueue, queueRows } from './queue'
import type { Restores } from './restore'
import { searchTerms } from './search'
import type { MailStore } from './store/mail'
import type { SpaceStore } from './store/space'
import { type Result, text } from './store/store'
import type { TelegramStore } from './store/telegram'
import type { TelegramMediaKeeper } from './telegram/media'
import { TELEGRAM_PICTURE_MAX_BYTES } from './telegram/wire'
import {
  type ClientLabel,
  type ClientList,
  type ClientListEntry,
  type ClientPage,
  type ContactPage,
  type ConversationChange,
  type ConversationPage,
  clientIdFromText,
  type DraftInput,
  type DraftPatch,
  isClientId,
  isWhole,
  type ListedClient,
  type MessageRow,
  type Queue,
  SEND_FIELDS,
  SEND_NAMES_NO_TEXT,
  type SearchResult,
} from './types'
import { bundledInstall, type Install, roleFor, type Who } from './workspace'

export interface Env extends PushEnv {
  INBOX: DurableObjectNamespace
  /** The company's live object (the space's `LIVE`): told that mail moved after a change is stored (src/live.ts). Absent where none is bound; nothing is then told. */
  LIVE?: LiveBinding
  /**
   * The Clients part (packages/clients): its inbox face (`createInboxClients`), called in-process in the space's Worker, which can read the list and one Client and nothing else. Optional because a test or a
   * Worker without the store bound has none, and then Clients show by number and assignment is refused (src/clients.ts).
   */
  CLIENT_LIST?: ClientsForInbox
  /**
   * The knowledge app (packages/knowledge): the knowledge app's inbox face (`createInboxKnowledge`), called in-process in the space's Worker, which can read and propose and nothing else. The
   * assistant asks it before it drafts (src/assistant) and Claude's script is handed on to it (the knowledge routes below). Absent in a Worker deployed
   * without it, a test, and `vite dev`: a draft is then refused with a sentence. The assistant waits at most four seconds for it (src/assistant), and a draft is refused rather than written without the knowledge.
   */
  KNOWLEDGE?: KnowledgeForInbox
  /**
   * The inbox's own Google OAuth web client, Worker secrets that zbc pushes from
   * this repo's production secrets file. On their own they cannot read or send
   * mail: they only let a person who signs in to Google hand the inbox a grant.
   */
  INBOX_GOOGLE_CLIENT_ID?: string
  INBOX_GOOGLE_CLIENT_SECRET?: string
  /** `projects/<id>/topics/<name>`, set at deploy time from the Google module. */
  GMAIL_TOPIC_NAME?: string
  /**
   * The VAPID key notifications are signed with (src/notify/webpush.ts): a P-256 JSON Web Key holding both halves, a
   * Worker secret that zbc pushes from this repo's production secrets file. Without it notifications fail closed.
   */
  INBOX_VAPID_KEY?: string
  /**
   * The Access client id of the service token Claude's script signs in as, a
   * Worker var (an id is not a credential). An agent's assertion carries it as
   * `common_name`, and exactly this one token is admitted as the agent. The
   * secret half never reaches the Worker.
   */
  INBOX_ACCESS_CLIENT_ID?: string
  /**
   * The Access client id of the Telegram bridge's service token, a Worker var (an id is not a credential): the bridge's door admits exactly this one token and Claude's door
   * refuses it (src/telegram/app.ts). Read by that router, never by Claude's.
   */
  TELEGRAM_ACCESS_CLIENT_ID?: string
  /**
   * The bucket holding the exact copy of every message that arrives through Cloudflare (an R2 binding, wired by the install kit
   * to the install's raw-mail bucket). Unset in a Worker deployed without it, which then accepts no Cloudflare mail.
   */
  RAW?: R2Bucket
  /**
   * Cloudflare's sending binding (`send_email` in the Worker's settings (kit/worker-settings.ts)), which a reply on a Cloudflare mailbox's conversation goes out
   * through, as that mailbox's own address (src/cloudflare/send.ts). Unset in a Worker deployed without it: a send from a business mailbox is
   * then refused 503 before anything is claimed. The zone it sends on must be onboarded for sending in the install's mail declaration.
   */
  EMAIL?: SendEmail
  /**
   * The Cloudflare mailboxes this deployment serves, `[{ "address": ..., "name": ... }]` (src/cloudflare/declared.ts): a var in
   * the Worker's settings, so adding a mailbox is a reviewed change. Unset or invalid, none is declared and every arrival is refused.
   */
  INBOX_MAILBOXES?: unknown
  /**
   * The mailboxes on the install's own mail server that the space reads and sends through over JMAP, `[{ "address", "name", "door", "secret" }]` (src/jmap/declared.ts): a var in the Worker's settings, so adding one is a reviewed
   * change. `secret` names the Worker secret that holds the mailbox's key. Unset or invalid, none is declared, and says why once.
   */
  INBOX_JMAP_MAILBOXES?: unknown
  /** The service token the mail server's door is behind (Cloudflare Access): both halves are Worker secrets pushed from sops (MAIL_SPACE_ACCESS_CLIENT_ID and _SECRET). */
  JMAP_ACCESS_CLIENT_ID?: string
  JMAP_ACCESS_CLIENT_SECRET?: string
  // The key of each mailbox on the mail server is a Worker secret named by its entry in INBOX_JMAP_MAILBOXES, read from the environment by that name (src/durable.ts), so no name of one is written here.
  /**
   * Workers AI (`ai` in the Worker's settings), which the spam check asks Cloudflare's spam classifier through when a business mailbox's message
   * arrives (src/cloudflare/spam-check.ts). It authenticates itself like EMAIL does, so there is no key. Unbound, nothing is judged:
   * mail arrives, is in the Inbox and notifies, as a message nothing judged always is.
   */
  AI?: Ai
  /**
   * The assistant's key: a pay-per-use Anthropic API key used by the inbox alone, a Worker secret that the install's deploy pushes from
   * its secrets file (src/assistant/model.ts). Never a subscription token and never a key shared with other tools, so that
   * one leaking costs only this. Used only by the draft chat, when the owner asks the assistant for a reply. Unset, a chat turn is refused and nothing
   * else changes: no part of arrival calls a model of Anthropic's.
   */
  ANTHROPIC_API_KEY?: string
}

/**
 * The store as the Worker sees it: these public methods of `MailStore`,
 * asynchronous. The Durable Object's `call` runs ONLY names on this list and on
 * MAIL_METHODS, so the RPC surface is a list someone wrote rather than whatever
 * the classes happen to have. `mailboxRow` (which returns the refresh token) is
 * deliberately not on it.
 */
export const STORE_METHODS = [
  'listContacts',
  'getContact',
  'renameContact',
  'assignClient',
  'mergeContacts',
  'splitIdentity',
  'suggestionContacts',
  'clientCard',
  'clientUsage',
  'listConversations',
  'listQueueFacts',
  'bulkReport',
  'searchConversations',
  'getConversation',
  'listDrafts',
  'messageById',
  'updateDraft',
  'deleteDraft',
  'markSent',
  'unmarkSent',
  'importOutbox',
  'listAudit',
  'mailScope',
  'mailboxPeopleList',
  'contactIdOfIdentity',
  'mailboxOfConversation',
  'mailboxOfMessage',
  'mailboxStatus',
  'mailboxStatuses',
  'cloudflareMailboxes',
  'cloudflareMailboxMarks',
  'claudeSending',
  'setClaudeSending',
  'listClaudeSends',
] as const satisfies readonly (keyof MailStore)[]

/**
 * What the Worker may ask the Mailroom, which does the work that takes more than
 * a store call. `runAlarm` is not here: only the Durable Object's own alarm runs
 * it. `runDaily` is: the cron trigger reaches it through the same door.
 */
export const MAIL_METHODS = [
  'calendarAccess',
  'calendarGrants',
  'changeConversation',
  'connectMailbox',
  'createDraft',
  'disconnectMailbox',
  'prepareReply',
  'readAttachment',
  'receivePush',
  'requestSync',
  'resolveSend',
  'runDaily',
  'sendDraft',
  'putDraftPicture',
] as const satisfies readonly (keyof Mailroom)[]

/**
 * What the Worker may ask of notifications (src/notify/deliver.ts): Settings' four. `deliverOwed` is not here: only
 * the alarm's run delivers.
 */
/**
 * What the Worker may ask the JMAP room (src/jmap/room.ts): the push door's one call, Settings' Sync now and its status, and the daily pass. `runAlarm` is the Durable Object's alone, and the two it calls on the
 * Mailroom's behalf (`changeJmapConversation`, `sendJmap`) are reached only through the Mailroom's own `changeConversation` and `sendDraft`, which hand a JMAP conversation or draft over.
 */
export const JMAP_METHODS = [
  'jmapMailboxes',
  'receiveJmapPush',
  'requestJmapSync',
  'runJmapDaily',
] as const satisfies readonly (keyof JmapRoom)[]

export const NOTIFY_METHODS = [
  'addDevice',
  'notificationSettings',
  'removeDevice',
  'sendTestNotification',
] as const satisfies readonly (keyof Notifications)[]

/**
 * What the Worker's email entrance may ask of the Durable Object (src/cloudflare/arrivals.ts): to file a raw copy it has
 * kept, and to keep the delivery reports the queue handler is handed. Not a route: Cloudflare's own calls reach it, never a request, and `runOwed` is the alarm's alone.
 */
export const ARRIVAL_METHODS = [
  'fileArrival',
  'deliverNotifications',
  'keepDeliveryEvents',
] as const satisfies readonly (keyof Arrivals)[]

/**
 * What the Worker may ask the assistant (src/assistant/assistant.ts): move a Cloudflare conversation to Bulk or back, the owner's
 * switch for the spam check, what its calls cost, and the owner's chat about a draft.
 */
export const ASSISTANT_METHODS = [
  'setSpam',
  'setAssistant',
  'assistantUsage',
  'chat',
] as const satisfies readonly (keyof Assistant)[]

/**
 * What the Worker may ask of the restore step (src/restore.ts). `restartIfArmed` and `armed` are the object's own.
 * `restartForRestore` is here because the abort it makes throws in the call that makes it, so the route that confirms a
 * restore asks for it in a call of its own, after the confirmation's answer is in hand.
 */
export const RESTORE_METHODS = [
  'restoreBookmarks',
  'prepareRestore',
  'confirmRestore',
  'restartForRestore',
] as const satisfies readonly (keyof Restores)[]

/**
 * What the space's part may ask of the store (src/space.ts, src/store/space.ts): the reads no page of the inbox asks for and
 * the compose keys that make a send go out at most once. Not routes: only the inbox's part in the space's Worker (src/space-part.ts), after
 * the space's one sign-in check has named the owner, calls them.
 */
export const SPACE_METHODS = [
  'claimCompose',
  'createComposeDraft',
  'noteCompose',
  'finishCompose',
  'releaseCompose',
  'composeOutcome',
  'discardComposed',
  'spaceContact',
  'spaceContactsWith',
  'spaceConversations',
  'spaceRowCounts',
  'spaceSearch',
  'spaceMessages',
  'spaceContacts',
  'spaceContactProfile',
  'saveContactProfile',
  'undoMerge',
] as const satisfies readonly (keyof SpaceStore)[]

/**
 * What the Telegram bridge's door may ask of the store (src/store/telegram.ts, src/telegram/app.ts): its five calls. Only that router, behind the bridge's own token, calls the first
 * five; `telegramMailboxes` is also read by Claude's script (`GET /api/telegram`).
 */
export const TELEGRAM_METHODS = [
  'pushTelegram',
  'telegramEvents',
  'telegramWork',
  'telegramOutcomes',
  'telegramStatus',
  'telegramMailboxes',
] as const satisfies readonly (keyof TelegramStore)[]

/**
 * What the bridge's door may ask of the keeper of Telegram's files (src/telegram/media.ts): to keep one photo or voice note it was asked for. `sweepTelegramMedia` is not here: the Durable Object runs it
 * after a call that may have left a file to delete.
 */
export const TELEGRAM_MEDIA_METHODS = [
  'keepTelegramMedia',
  'readTelegramPicture',
] as const satisfies readonly (keyof TelegramMediaKeeper)[]

export type StoreMethod = (typeof STORE_METHODS)[number]
export type MailMethod = (typeof MAIL_METHODS)[number]
export type NotifyMethod = (typeof NOTIFY_METHODS)[number]
export type JmapMethod = (typeof JMAP_METHODS)[number]
export type ArrivalMethod = (typeof ARRIVAL_METHODS)[number]
export type AssistantMethod = (typeof ASSISTANT_METHODS)[number]
export type RestoreMethod = (typeof RESTORE_METHODS)[number]
export type SpaceMethod = (typeof SPACE_METHODS)[number]
export type TelegramMethod = (typeof TELEGRAM_METHODS)[number]
export type TelegramMediaMethod = (typeof TELEGRAM_MEDIA_METHODS)[number]

/** Everything the Worker can call in the Durable Object, by name. */
export type Surface = Pick<MailStore, StoreMethod> &
  Pick<SpaceStore, SpaceMethod> &
  Pick<TelegramStore, TelegramMethod> &
  Pick<TelegramMediaKeeper, TelegramMediaMethod> &
  Pick<Mailroom, MailMethod> &
  Pick<JmapRoom, JmapMethod> &
  Pick<Notifications, NotifyMethod> &
  Pick<Arrivals, ArrivalMethod> &
  Pick<Assistant, AssistantMethod> &
  Pick<Restores, RestoreMethod>

export type StoreApi = {
  call<K extends keyof Surface>(method: K, ...args: Parameters<Surface[K]>): Promise<Awaited<ReturnType<Surface[K]>>>
}

export interface Deps {
  /** The store for this request. The Durable Object in production, a SQLite in tests. */
  store: (env: Env) => StoreApi
  /** The company this Worker serves: whose people may come in, and whether Claude's script is admitted. */
  install?: Install
  /**
   * The Clients for this request: the Clients part in production (the default, `env.CLIENT_LIST`), the real part over a SQLite in tests. Asked afresh by every request
   * that needs Clients and never cached, so a Client made in Settings shows on the next load.
   */
  clients?: (env: Env) => ClientsForInbox | null | undefined
  /** The knowledge app for this request: the service binding in production (the default, `env.KNOWLEDGE`), a stand-in in tests. */
  knowledge?: (env: Env) => KnowledgePort
  /**
   * The dev agent's actor (a test seam; nothing in a deployed Worker gives it), given only under `import.meta.env.DEV`: a BUILD-TIME constant that is `false` in everything `vite build` produces, so the
   * name never reaches a built Worker (test/build.test.ts reads the bundle for it). With it set, in `vite dev`, a request on localhost with no assertion is that
   * agent, so the script works against a local run with no token. Absent, there is no such identity.
   */
  devActor?: string
  /**
   * Given by the space's Worker (src/space-part.ts), which runs this router IN-PROCESS for Claude's door: the identity
   * the space's own check already verified for this very request (the assertion against the agent application's audience, a service token only), put in a WeakMap keyed by the Request the app is
   * handed. The router verifies nothing and reads no assertion: it asks this, answers 401 to a request the map does not hold (or when this is absent), and applies its own rule to what it names
   * (`roleFor` admits Claude's token by its id and nobody else).
   */
  named?: (req: Request) => ServiceIdentity | null
}

/** A service token the space's check has verified: what the in-process router is handed in place of an assertion. */
export type ServiceIdentity = Extract<Identity, { kind: 'service' }>

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

type App = { Bindings: Env; Variables: { who: Who; scope: MailScope } }

const ID = /^[A-Za-z0-9-]{1,64}$/

/** What an edit or a delete of a draft without its revision is told: the revision is how it knows the draft is the one it was shown. */
const NEEDS_REV = 'Say which version of the draft you were shown: the rev `drafts` printed for it. Nothing was changed.'

/** A contact's Client by name, or null for a contact with none. */
const labelOrNull = (clientId: number | null, names: Map<number, ListedClient>): ClientLabel | null =>
  clientId === null ? null : clientLabel(clientId, names)

/**
 * Who is asking Claude's door. The sign-in check is the space's, made ONCE for the request (packages/space/src/agent.ts: the header alone, never the cookie, the agent application's audience, a service
 * token only); what is left here is the inbox's own rule, on the identity the space handed in (`deps.named`): only Claude's token, by its id, is the agent. No identity is a 401; a named one that is not
 * the agent, a person's (the space refuses one before it gets here) or another token, is a 403.
 */
function whoIsAsking(
  req: Request,
  env: Env,
  deps: Deps,
  install: Install,
): { who: Who } | { refused: string; status: 401 | 403 } {
  const identity = deps.named?.(req) ?? null
  if (identity === null) return { refused: 'Present the service token.', status: 401 }
  const known = roleFor(identity, install, env)
  if (known?.role !== 'agent') {
    console.warn('access: named but not the agent')
    return { refused: 'This account has no access to the inbox.', status: 403 }
  }
  return { who: known }
}

/**
 * THE INBOX'S API, AS CLAUDE'S SCRIPT USES IT (`InboxPart.claude` in src/space-part.ts, in the space's Worker). The space hands it the
 * requests that arrive on its agent path, at the inbox's own `/api/` path, without the cookie. It admits Claude's service token and nobody else, serves `/api/`
 * and nothing else (no page, no file: the inbox has none), and has no hostname: Gmail's push is `createPushApp` (push-door.ts). Every route below is one the
 * script calls; what only the owner does (the page, Settings, the Gmail connection, notifications, restore, the chat) is the space's, through the inbox's part (src/space.ts).
 */
export function createApp(deps: Deps) {
  const app = new Hono<App>()
  const install = deps.install ?? bundledInstall
  const owner = inboxOwnerOf(install)

  // Nothing of ours may be framed, and no answer may be kept by anything on the way (a phone, a laptop, a proxy): every response says `no-store`. On EVERY
  // response, the refusals included, which is why this is the first middleware and sets them after the rest has answered. The response is copied
  // because one can have immutable headers. Decided by who answered, not by the path, because the router decodes a path (`/%61pi/queue` is the queue).
  app.use('*', async (c, next) => {
    await next()
    const res = new Response(c.res.body, c.res)
    if (!res.headers.has('Content-Security-Policy'))
      res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
    res.headers.set('X-Frame-Options', 'DENY')
    res.headers.set('Cache-Control', 'no-store')
    c.res = res
  })

  // EVERY request is checked. In `vite dev` (and only there: `deps.devActor` is given only under the build-time constant `import.meta.env.DEV`), a request on localhost with no assertion at
  // all is the dev agent, so the script works against a local run with no token.
  app.use('*', async (c, next) => {
    let who: Who
    if (
      deps.devActor !== undefined &&
      assertionFrom(c.req.raw.headers) === null &&
      LOCAL_HOSTS.has(new URL(c.req.url).hostname)
    ) {
      who = { role: 'agent', actor: deps.devActor }
    } else {
      const signedIn = whoIsAsking(c.req.raw, c.env, deps, install)
      if ('refused' in signedIn) return c.json({ error: signedIn.refused }, signedIn.status)
      who = signedIn.who
    }
    c.set('who', who)
    // The API and nothing else: there is no page and no file to serve.
    if (!new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ error: 'Not found.' }, 404)
    // Claude acts for the owner, and reads what the owner may read (the mailboxes the owner is on, and what is in none): every read below is cut to it, and a conversation or message the owner may not see is not told apart from
    // one that is not there. Where the owner is on every mailbox, Claude reads all of them (the inbox's ADR 0004).
    c.set('scope', await deps.store(c.env).call('mailScope', who.actor))

    // A write from a page on another site is refused, for the dev identity as much as for a verified one: a dev server on localhost is exactly where a
    // stray page in another tab could post to it. Browsers send Origin on every non-GET request and Sec-Fetch-Site on all of them; the script sends neither.
    const read = c.req.method === 'GET' || c.req.method === 'HEAD'
    if (!read) {
      const origin = c.req.header('origin')
      if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(c.req.url).origin)) {
        return c.json({ error: 'Cross-site write refused.' }, 403)
      }
    }
    return next()
  })

  const store = (c: { env: Env }) => deps.store(c.env)

  /** The conversations and messages Claude names by id are checked first: one in a mailbox the owner is not on answers 404, as one that does not exist. */
  const mayName = (what: 'conversation' | 'message') => async (c: Context<App>, next: () => Promise<void>) => {
    const id = c.req.param('id') ?? ''
    if (ID.test(id)) {
      const held = await store(c).call(what === 'conversation' ? 'mailboxOfConversation' : 'mailboxOfMessage', id)
      if (held !== null && !canSee(c.get('scope'), held.mailboxId)) {
        return c.json({ error: what === 'conversation' ? 'No such conversation.' : 'No such message.' }, 404)
      }
    }
    return next()
  }
  for (const path of ['/api/conversations/:id', '/api/conversations/:id/*']) app.use(path, mayName('conversation'))
  // A contact named by its id is checked the same way: one whose mail is not the owner's is not found, to read or to change.
  const mayNameContact = async (c: Context<App>, next: () => Promise<void>) => {
    const id = c.req.param('id') ?? ''
    if (ID.test(id) && !(await store(c).call('getContact', id, c.get('scope'))).ok)
      return c.json({ error: 'No such contact.' }, 404)
    return next()
  }
  for (const path of ['/api/contacts/:id', '/api/contacts/:id/*']) app.use(path, mayNameContact)
  app.use('/api/identities/:id/*', async (c, next) => {
    const id = c.req.param('id') ?? ''
    const contact = ID.test(id) ? await store(c).call('contactIdOfIdentity', id) : null
    if (contact !== null && !(await store(c).call('getContact', contact, c.get('scope'))).ok)
      return c.json({ error: 'No such address.' }, 404)
    return next()
  })
  for (const path of ['/api/drafts/:id', '/api/drafts/:id/*', '/api/messages/:id/*']) app.use(path, mayName('message'))

  /** Answer a store result: the value, or the refusal with its status. */
  const answer = (c: Context<App>, r: Result<unknown>) =>
    r.ok ? c.json(r.value) : c.json({ error: r.error }, r.status)

  /**
   * The Clients, asked of the part now. Never throws and caches nothing: an outage is the
   * `available: false` of the answer, and everything that is not a Client's name goes on.
   */
  const directory = (c: { env: Env }): Promise<ClientsRead> =>
    readClients(deps.clients ? deps.clients(c.env) : c.env.CLIENT_LIST, install)
  const statusOf = ({ available, error }: ClientsRead) => ({ available, error })

  app.get('/api/queue', async (c) => {
    // The counts cover every conversation; the rows are the first screen of the filter asked for.
    const [facts, drafts, dir, mailboxes] = await Promise.all([
      store(c).call('listQueueFacts', c.get('scope')),
      store(c).call('listDrafts', c.get('scope')),
      directory(c),
      store(c).call('cloudflareMailboxMarks'),
    ])
    const names = clientsById(dir.clients)
    // Drafts that sit on no conversation are in no fact: the Drafts view lists them and counts them.
    const looseDrafts = drafts.filter((d) => d.conversationId === null)
    const plan = planQueue(
      facts,
      c.req.query('filter'),
      names,
      looseDrafts.length,
      mailboxes.filter((m) => canSee(c.get('scope'), m.id)),
    )
    const rows = queueRows(await store(c).call('listConversations', plan.ids), names)
    const queue: Queue = { filter: plan.filter, filters: plan.filters, rows, looseDrafts, directory: statusOf(dir) }
    return c.json(queue)
  })

  /**
   * Search: every conversation, open or closed, that has every word of `q` on it (src/search.ts), newest first, at
   * most a screen. A GET like every read here, so it writes nothing and marks nothing read, and the store it asks has
   * no way to reach Gmail. Open to the agent as the other reads are (the script's `search`). A query with no words
   * is an empty answer, not an error, so a box being cleared never shows one.
   */
  app.get('/api/search', async (c) => {
    const query = c.req.query('q') ?? ''
    const terms = searchTerms(query)
    if (terms.length === 0) {
      const result: SearchResult = { query, terms, rows: [], more: false, directory: { available: true, error: null } }
      return c.json(result)
    }
    const [found, dir] = await Promise.all([store(c).call('searchConversations', terms, c.get('scope')), directory(c)])
    const matches = new Map(found.hits.map((h) => [h.conversation.id, h.match]))
    const rows = queueRows(
      found.hits.map((h) => h.conversation),
      clientsById(dir.clients),
    )
    const result: SearchResult = {
      query,
      terms,
      rows: rows.map((row) => ({ ...row, match: matches.get(row.id) ?? null })),
      more: found.more,
      directory: statusOf(dir),
    }
    return c.json(result)
  })

  app.get('/api/conversations/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such conversation.' }, 404)
    const found = await store(c).call('getConversation', id)
    if (!found.ok) return answer(c, found)
    const clientIds = [...new Set(found.value.contacts.flatMap((p) => (p.clientId === null ? [] : [p.clientId])))]
    // Only asked when somebody on it has a Client: a conversation of strangers needs no list.
    const names = clientsById(clientIds.length > 0 ? (await directory(c)).clients : [])
    // A message with no words of its own and a calendar summary says what the summary says in one line, on the company's clock, so Claude never has to guess who accepted from a subject.
    const withCalendarLine = (m: MessageRow): MessageRow => {
      if (m.calendar === undefined || m.body.trim() !== '') return m
      const calendarLine = safeSummaryLine(m.calendar, install.company.timeZone, 160, m.from)
      return calendarLine === '' ? m : { ...m, calendarLine }
    }
    const page: ConversationPage = {
      ...found.value,
      messages: found.value.messages.map(withCalendarLine),
      clients: clientIds.map((clientId) => clientLabel(clientId, names)),
    }
    return c.json(page)
  })

  /**
   * Close and reopen a conversation, kept in step with Gmail (the Mailroom asks Gmail
   * first). These are POSTs and the GET above is not one of them, so reading a
   * conversation, which is all Claude's script does, can never change what is read.
   *
   * THERE IS NO "READ" HERE, AND THERE MUST NOT BE. Marking a conversation read is a
   * person's, through the space (the part's `markRead`): "unread" has to keep meaning
   * that nobody has looked. Closing and reopening are open to the agent, because both
   * can be undone.
   *
   * Close carries `through` (see Inbox.newestPosition): the conversation is
   * changed only if nothing inbound has arrived beyond what the sender was shown.
   */
  const changeOf = (change: Exclude<ConversationChange, 'read'>) => async (c: Context<App>) => {
    const who = c.get('who')
    const id = c.req.param('id') ?? ''
    if (!ID.test(id)) return c.json({ error: 'No such conversation.' }, 404)
    // How far into the conversation the sender reached, so that a message which arrived
    // after it was shown is never archived unseen. Optional here, required by the Mailroom for email.
    const body = await json(c.req.raw, true)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const through = Number.isInteger(body.value.through) ? (body.value.through as number) : null
    return answer(c, await store(c).call('changeConversation', id, change, who.actor, through))
  }
  /**
   * Move a conversation, Gmail's or a business mailbox's, to Bulk or back to the Inbox, `{ "spam": true | false }`: the owner or Claude, for a
   * conversation a rule got wrong (or one nothing caught). It decides over every rule but a Client's people and sticks: nothing is
   * asked of the spam classifier again and a later message in the conversation does not undo it. For Gmail it is the inbox's view and nothing
   * is changed in Gmail. A boolean is required, so an empty body can never mean either. 422 for a conversation in no mailbox.
   */
  app.put('/api/conversations/:id/spam', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such conversation.' }, 404)
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    if (typeof body.value.spam !== 'boolean')
      return c.json({ error: 'Say which: {"spam": true} or {"spam": false}.' }, 422)
    return answer(c, await store(c).call('setSpam', id, body.value.spam, c.get('who').actor))
  })
  app.post('/api/conversations/:id/close', changeOf('close'))
  app.post('/api/conversations/:id/reopen', changeOf('reopen'))

  app.get('/api/contacts', async (c) => {
    const [contacts, dir] = await Promise.all([store(c).call('listContacts', c.get('scope')), directory(c)])
    const names = clientsById(dir.clients)
    return c.json(contacts.map((p) => ({ ...p, client: labelOrNull(p.clientId, names) })))
  })

  app.get('/api/contacts/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such contact.' }, 404)
    const found = await store(c).call('getContact', id, c.get('scope'))
    if (!found.ok) return answer(c, found)
    const dir = await directory(c)
    const page: ContactPage = {
      ...found.value,
      client: labelOrNull(found.value.clientId, clientsById(dir.clients)),
      directory: statusOf(dir),
      // Offered, never applied: a suggestion takes effect only when it is accepted (PUT .../client).
      suggestions: suggestClients(
        await store(c).call('suggestionContacts', c.get('scope')),
        dir.clients,
        owner.domain,
      ).filter((s) => s.contactId === id),
    }
    return c.json(page)
  })

  app.patch('/api/contacts/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such contact.' }, 404)
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    return answer(c, await store(c).call('renameContact', id, text(body.value.name), c.get('who').actor))
  })

  /**
   * Put a contact under a Client, or take it out (`{"clientId": null}`). Owner or agent: the
   * only two roles there are, and each is audited with its actor. An id the Clients part
   * does not hold, or holds archived, is 422 and nothing is written; with the part not answering
   * it is 503, because a contact must never point at a Client the part has not confirmed (mail and
   * everything else carry on). It never waits on a Client's outside source: that source is nothing to it.
   * Taking a contact out needs no answer, since nothing is being attached.
   */
  app.put('/api/contacts/:id/client', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such contact.' }, 404)
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const wanted = body.value.clientId
    if (wanted !== null && !isClientId(wanted)) {
      return c.json({ error: 'Say which Client: {"clientId": 7}, or {"clientId": null} to take the contact out.' }, 422)
    }
    let names = clientsById([])
    if (wanted !== null) {
      const dir = await directory(c)
      const checked = checkLink(dir, wanted)
      if (!checked.ok) return c.json({ error: checked.error }, checked.why === 'down' ? 503 : 422)
      names = clientsById(dir.clients)
    }
    const done = await store(c).call('assignClient', id, wanted, c.get('who').actor)
    return done.ok ? c.json({ ...done.value, client: labelOrNull(done.value.clientId, names) }) : answer(c, done)
  })

  /**
   * Merge two contacts who are the same person: the contact in the path survives and
   * absorbs the one named, `{"absorb": "<contact id>"}`. Every address moves; the audit keeps both.
   * Owner or agent. Undone, if it was wrong, by splitting an address back off.
   */
  app.post('/api/contacts/:id/merge', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such contact.' }, 404)
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const absorb = text(body.value.absorb)
    if (!ID.test(absorb)) return c.json({ error: 'Say which contact to merge in: {"absorb": "<contact id>"}.' }, 422)
    if (!(await store(c).call('getContact', absorb, c.get('scope'))).ok)
      return c.json({ error: 'No such contact.' }, 404)
    return answer(c, await store(c).call('mergeContacts', id, absorb, c.get('who').actor))
  })

  /** Split one address off its contact onto a new contact of its own. Owner or agent. */
  app.post('/api/identities/:id/split', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such address.' }, 404)
    return answer(c, await store(c).call('splitIdentity', id, c.get('who').actor))
  })

  // ─── Clients: read from the Clients part, never copied ────────

  /**
   * Every Client the Clients part holds, with how many of their people the inbox holds and how many
   * conversations. A Client some contact holds that the part does not hold (it is down, or the id
   * is unknown) is still here, by number, so nobody's grouping vanishes with the part.
   */
  app.get('/api/clients', async (c) => {
    const [usage, dir] = await Promise.all([store(c).call('clientUsage', c.get('scope')), directory(c)])
    const byId = clientsById(dir.clients)
    const used = new Map(usage.map((u) => [u.clientId, u]))
    const ids = new Set([...dir.clients.map((k) => k.id), ...usage.map((u) => u.clientId)])
    const clients: ClientListEntry[] = [...ids].map((id) => {
      const u = used.get(id)
      return {
        ...clientView(id, byId),
        contacts: u?.contacts ?? 0,
        conversations: u?.conversations ?? 0,
        open: u?.open ?? 0,
      }
    })
    clients.sort((a, b) => Number(b.listed) - Number(a.listed) || a.name.localeCompare(b.name) || a.id - b.id)
    const list: ClientList = { directory: statusOf(dir), clients }
    return c.json(list)
  })

  /** A Client's page: who they are as the part says, their contacts and every conversation with any of them. */
  app.get('/api/clients/:id', async (c) => {
    const raw = c.req.param('id')
    const id = clientIdFromText(raw)
    if (id === null) return c.json({ error: 'No such Client.' }, 404)
    const [card, dir] = await Promise.all([store(c).call('clientCard', id, c.get('scope')), directory(c)])
    const byId = clientsById(dir.clients)
    // A Client the part holds, or one the inbox holds people under (whatever the part says now).
    if (dir.available && !byId.has(id) && card.contacts.length === 0) return c.json({ error: 'No such Client.' }, 404)
    const page: ClientPage = {
      directory: statusOf(dir),
      client: clientView(id, byId),
      contacts: card.contacts.map((p) => ({ ...p, client: clientLabel(id, byId) })),
      conversations: queueRows(card.conversations, byId),
      conversationsTotal: card.conversationsTotal,
    }
    return c.json(page)
  })

  /**
   * The Clients the inbox suggests for contacts that have none (`?contact=<id>` for one),
   * and why. COMPUTED, never applied: it takes effect only when somebody accepts, which
   * is an ordinary assignment (PUT /api/contacts/:id/client) by the owner or the agent. With the
   * part down there are none, because nothing can vouch for a Client.
   */
  app.get('/api/suggestions', async (c) => {
    const [contacts, dir] = await Promise.all([store(c).call('suggestionContacts', c.get('scope')), directory(c)])
    const only = c.req.query('contact')
    const suggestions = suggestClients(contacts, dir.clients, owner.domain).filter(
      (s) => only === undefined || s.contactId === only,
    )
    return c.json({ directory: statusOf(dir), suggestions })
  })

  app.get('/api/drafts', async (c) => c.json(await store(c).call('listDrafts', c.get('scope'))))

  app.post('/api/drafts', async (c) => {
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const b = body.value
    const input: DraftInput = {
      ...(b.copyEveryone === true && { copyEveryone: true }),
      // An explicit Cc, as a list of addresses; the store refuses (422) anything that is not one, and a Cc on a draft that is not an email.
      ...(b.cc !== undefined && { cc: b.cc as string[] }),
      body: text(b.body),
      subject: text(b.subject),
      why: text(b.why),
      name: text(b.name),
      ...(text(b.conversationId) && { conversationId: text(b.conversationId) }),
      ...(text(b.contactId) && { contactId: text(b.contactId) }),
      ...(text(b.address) && { address: text(b.address) }),
      // Claude may choose which of the owner's mailboxes a new email goes out from; the store resolves the name and refuses what it cannot.
      ...(b.from !== undefined && { chooseFrom: text(b.from) }),
    }
    const r = await store(c).call('createDraft', input, c.get('who').actor)
    return r.ok ? c.json(r.value, 201) : c.json({ error: r.error }, r.status)
  })

  /**
   * Edit a draft. The body names `rev`, the revision its author was shown, for EVERYONE (an edit without it is 422, as a
   * send without it is): a draft changed since is refused (409) and shown as it is now, so nobody's words, the owner's or
   * Claude's, are ever saved over a change they have not seen. The script's `drafts` prints the number.
   */
  app.patch('/api/drafts/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    if (!isWhole(body.value.rev)) return c.json({ error: NEEDS_REV }, 422)
    const patch: DraftPatch = { rev: body.value.rev }
    for (const key of ['subject', 'body', 'why'] as const) {
      if (key in body.value) patch[key] = text(body.value[key])
    }
    if (typeof body.value.copyEveryone === 'boolean') patch.copyEveryone = body.value.copyEveryone
    if (body.value.cc !== undefined) patch.cc = body.value.cc as string[]
    return answer(c, await store(c).call('updateDraft', id, patch, c.get('who').actor))
  })

  /**
   * The owner presses Send, or Claude sends on their instruction: ONE route and one path under
   * it, with the same checks for both. The body names what the sender was shown: `rev`,
   * the draft's revision, so a draft edited since is refused (409), and `through`, for a
   * reply, how far into the conversation the sender reached, so a reply cannot go out over
   * a message nobody has read. Both are required by the Mailroom where they apply, and
   * neither can be left out to skip the check; Claude's script passes back the numbers
   * `drafts` and `conversation` printed and looks nothing up.
   *
   * CLAUDE'S SEND also carries `instruction` (the owner's words, where they said them, when),
   * and is refused (403) without it and while the switch is off; the store decides both,
   * so this route cannot forget. A send names a stored draft by its id and never carries
   * text, so a body with any field beyond SEND_FIELDS (rev, through, instruction) is
   * refused (422): the exact words are on record before they leave.    */
  app.post('/api/drafts/:id/send', async (c) => {
    const who = c.get('who')
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    // Claude's send is JSON and carries no files: a person chooses files in the space, which sends them through the inbox's part.
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    // An allowlist, shared with Claude's script: the words and recipients are the stored draft's,
    // so nothing but what SEND_FIELDS names can arrive with the press.
    if (Object.keys(body.value).some((field) => !(SEND_FIELDS as readonly string[]).includes(field))) {
      return c.json({ error: SEND_NAMES_NO_TEXT }, 422)
    }
    const whole = (v: unknown) => (isWhole(v) ? v : null)
    return answer(
      c,
      await store(c).call(
        'sendDraft',
        id,
        {
          rev: whole(body.value.rev),
          through: whole(body.value.through),
          instruction: body.value.instruction,
          // Claude's send of a draft that carries a picture names it by its fingerprint (a check, not content).
          ...(body.value.picture !== undefined && { picture: body.value.picture }),
        },
        who.actor,
      ),
    )
  })

  /**
   * Whether Claude may send, which Claude's script reads before it tries, and the switch.
   * The switch is OWNER ONLY, here and in the store (a default-deny on the actor), and
   * `{ "enabled": true | false }` must be a boolean so an empty body can never mean either.
   * It stops Claude's SENDING and nothing else: drafting is untouched.
   */
  app.get('/api/settings/claude-sending', async (c) => c.json(await store(c).call('claudeSending')))

  /**
   * Every message Claude sent, newest first, each with the instruction it went out on: the read behind the
   * script's `sent-by-claude`. No page lists them (each send is marked in its own conversation), and a
   * send the owner confirmed by hand is here too, read back from the audit.
   */
  app.get('/api/claude-sends', async (c) => c.json(await store(c).call('listClaudeSends')))

  /**
   * Put a picture on a Telegram draft, or replace the one it has: the body is the picture (a PNG or a JPEG, by its own first bytes; at most `TELEGRAM_PICTURE_MAX_BYTES`, read with that ceiling),
   * `?rev=` the revision the caller was shown, as an edit names it. An edit of the draft like any other: it raises the revision and is audited as Claude's, so Claude's own picture does not stop a send the owner told it to make (it names the fingerprint of what it sends, its own check),
   * while a picture changed by anyone but Claude after the owner spoke does stop it. Refused for a draft that is not a Telegram draft on a chat that takes a picture, one that is not a draft, and one at another revision. The answer is the draft with its picture's type, length
   * and fingerprint (`picture`): Claude names the fingerprint when it sends, and is never handed the bytes back.
   */
  app.put('/api/drafts/:id/picture', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    const given = c.req.query('rev') ?? ''
    if (!/^\d+$/.test(given)) return c.json({ error: NEEDS_REV }, 422)
    const bytes = await bytesUpTo(c.req.raw, TELEGRAM_PICTURE_MAX_BYTES)
    if (bytes === null) {
      return c.json(
        {
          error: `A picture goes on Telegram up to ${TELEGRAM_PICTURE_MAX_BYTES / (1024 * 1024)} MB. Nothing was changed.`,
        },
        413,
      )
    }
    return answer(c, await store(c).call('putDraftPicture', id, Number(given), bytes, c.get('who').actor))
  })

  /** Take a draft's picture out, at the revision shown: a change of the draft like an edit (the revision rises, the audit says who), and the picture's object is deleted. */
  app.delete('/api/drafts/:id/picture', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    const given = c.req.query('rev') ?? ''
    if (!/^\d+$/.test(given)) return c.json({ error: NEEDS_REV }, 422)
    return answer(
      c,
      await store(c).call('updateDraft', id, { rev: Number(given), takeOutPicture: true }, c.get('who').actor),
    )
  })

  app.delete('/api/drafts/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    // `?rev=` names the revision the sender was shown, for everyone, as an edit does: absent or anything but whole digits is 422.
    const given = c.req.query('rev') ?? ''
    if (!/^\d+$/.test(given)) return c.json({ error: NEEDS_REV }, 422)
    return answer(c, await store(c).call('deleteDraft', id, c.get('who').actor, Number(given)))
  })

  app.post('/api/messages/:id/mark-sent', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    const body = await json(c.req.raw, true)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const sentAt = typeof body.value.sentAt === 'string' && body.value.sentAt !== '' ? body.value.sentAt : undefined
    return answer(c, await store(c).call('markSent', id, sentAt, c.get('who').actor))
  })

  app.post('/api/messages/:id/unmark-sent', async (c) => {
    const id = c.req.param('id')
    if (!ID.test(id)) return c.json({ error: 'No such message.' }, 404)
    return answer(c, await store(c).call('unmarkSent', id, c.get('who').actor))
  })

  app.post('/api/import/outbox', async (c) => {
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const entries = body.value.entries
    if (!Array.isArray(entries)) return c.json({ error: 'Send {"entries": [...]}, the Outbox list.' }, 422)
    return c.json(await store(c).call('importOutbox', entries, c.get('who').actor))
  })

  app.get('/api/audit', async (c) => c.json(await store(c).call('listAudit', 100, c.get('scope'))))

  // ─── the knowledge base: the knowledge app's, reached for Claude's script only ───
  //
  // The knowledge base is not kept here. Claude's script still reaches it at this address with its own
  // token, and these two routes hand its reads and proposals on to the knowledge app over the service binding, naming Claude as the proposer. They
  // reach no way to edit, remove or approve anything: the app's entrypoint for the inbox has none. The owner changes entries in the space's Knowledge tab.

  /** The id of a business a route takes; a path-shaped or enormous string never reaches the app. */
  const BUSINESS = /^[a-z0-9][a-z0-9-]{0,60}$/

  /** The knowledge app's answer as this API says it: its value, or its refusal or fault in words with the status that fits. */
  const knowledgeAnswer = <T>(c: Context<App>, got: Asked<T>, success: 200 | 201 = 200) => {
    if (got.ok) return c.json(got.value, success)
    if (got.kind === 'refused') {
      const status = {
        'not-signed-in': 401,
        'not-admitted': 403,
        'not-found': 404,
        'bad-request': 422,
        conflict: 409,
        limit: 429,
      } as const
      return c.json({ error: got.message }, status[got.reason])
    }
    if (got.kind === 'unreached') console.warn(`the knowledge app was not reached: ${got.why}`)
    return c.json({ error: got.kind === 'failed' ? got.message : KNOWLEDGE_UNREACHED }, 502)
  }

  const knowledgePort = (c: { env: Env }): KnowledgePort => (deps.knowledge ? deps.knowledge(c.env) : c.env.KNOWLEDGE)

  /** Claude's read: the businesses and the entries, every status, each with every version. `?business=<id>` names one business (all of it when left out). */
  app.get('/api/knowledge', async (c) => {
    const business = c.req.query('business')
    if (business !== undefined && !BUSINESS.test(business))
      return c.json({ error: 'Name a business by its id: lower-case letters, digits and hyphens.' }, 422)
    return knowledgeAnswer(c, await ask(knowledgePort(c), (k) => k.readBase(business)))
  })

  /**
   * Claude proposes an entry or a change to one: `{ "title", "body", "businesses" }` for a new entry, or `{ "replaces": <id>, ...what changes }`.
   * CLAUDE ONLY (the owner adds in the tab), and nothing reads a proposal until the owner approves it.
   */
  app.post('/api/knowledge/propose', async (c) => {
    const who = c.get('who')
    const body = await json(c.req.raw)
    if (!body.ok) return c.json({ error: body.error }, 400)
    const b = body.value
    return knowledgeAnswer(
      c,
      await ask(knowledgePort(c), (k) =>
        k.propose(who.actor, {
          ...(typeof b.title === 'string' && { title: b.title }),
          ...(typeof b.body === 'string' && { body: b.body }),
          ...(Array.isArray(b.businesses) && { businesses: b.businesses as string[] }),
          ...(typeof b.replaces === 'string' && { replaces: b.replaces }),
        }),
      ),
      201,
    )
  })

  // ─── restoring the store (src/restore.ts) ───

  /**
   * The store's current bookmark, the bookmark for `?time=` (an ISO time with its zone) if one is asked about, and the latest
   * records of restores. A read, open to the agent so Claude can capture a bookmark before a risky deploy, and it changes nothing.
   */
  app.get('/api/restore', async (c) => answer(c, await store(c).call('restoreBookmarks', c.req.query('time') ?? null)))

  // ─── Gmail ───────────────────────────────────────────────────────────

  /**
   * The owner's Gmail accounts as the header shows them, one object each, oldest first, in an object so that "no account was ever
   * connected" (`accounts: []`) cannot be mistaken for a response that has not arrived. A lapsed grant is `state: 'lapsed'`.
   */
  app.get('/api/mailbox', async (c) =>
    c.json({ accounts: (await store(c).call('mailboxStatuses')).filter((m) => canSee(c.get('scope'), m.id)) }),
  )

  /**
   * The Cloudflare mailboxes (the business mailboxes): when mail last arrived for each, whether filing a message has failed, how many kept
   * messages are owed a filing, and the counts. A read, open to the agent like the others; `/api/mailbox` above stays the Gmail
   * connection alone, so its answer is what it always was.
   */
  app.get('/api/mailboxes', async (c) =>
    c.json({ mailboxes: (await store(c).call('cloudflareMailboxes')).filter((m) => canSee(c.get('scope'), m.id)) }),
  )

  /**
   * The Telegram mailbox, as the script shows it: whether the Telegram bridge is talking (live, catching up, signed out, not checked in), when it last pushed, and the
   * counts. A read, like the others: Telegram's conversations are in the queue, a conversation and search already, and reading marks nothing read.
   */
  app.get('/api/telegram', async (c) =>
    c.json({ mailboxes: (await store(c).call('telegramMailboxes')).filter((m) => canSee(c.get('scope'), m.id)) }),
  )

  /**
   * The mailboxes on the install's own mail server (JMAP), as the script shows them: whether each is live, filling, refused, unreachable or no longer declared, when it last synced and was pushed to, the push
   * subscription, and the counts. A read, like the others: such a mailbox's conversations are in the queue, a conversation and search already (their `mailbox` carries its pill and `mailboxKind` is `jmap`), and
   * reading marks nothing read. Never a key.
   */
  /** Who is on each mailbox the owner may see (the inbox's ADR 0004): address, kind, name and the people, never mail. A read, for the sitting that checks a deploy of the people. */
  app.get('/api/mailbox-people', async (c) =>
    c.json({ mailboxes: await store(c).call('mailboxPeopleList', c.get('scope')) }),
  )

  app.get('/api/jmap', async (c) =>
    c.json({ mailboxes: (await store(c).call('jmapMailboxes')).filter((m) => canSee(c.get('scope'), m.id)) }),
  )

  /**
   * What the queue's one Bulk rule does to the open conversations now, per kind of mailbox, and how many open Gmail conversations
   * are Bulk only because their sender is automated (what the one Bulk rule moved out of the Gmail Inbox), with who sends them. A read,
   * open to Claude: it carries sender names and addresses and no text.
   */
  app.get('/api/bulk-report', async (c) => c.json(await store(c).call('bulkReport', c.get('scope'))))

  /**
   * What the assistant's calls to the model came to, `?since=` and `?until=` full ISO timestamps (the last seven days when
   * left out): calls, tokens and an estimated cost, and whether the Worker has a key. A read, open to Claude, who reports the
   * first week to the owner; it carries no mail text.
   */
  app.get('/api/assistant/usage', async (c) =>
    answer(c, await store(c).call('assistantUsage', c.req.query('since') ?? null, c.req.query('until') ?? null)),
  )

  /** Ask for a sync now, of every account with a working grant. Owner or agent: it only asks Gmail what changed, and changes nothing else. */
  app.post('/api/mailbox/sync', async (c) => answer(c, await store(c).call('requestSync')))

  app.all('*', (c) => c.json({ error: 'Not found.' }, 404))

  return app
}

/**
 * The JSON object in a request body. An empty body is `{}` when `optional`, and
 * a body that is not an object is refused, so a handler never indexes into a
 * string or null.
 */
/** A body read to its end as bytes, or null as soon as it passes `max` (the rest is not read): a picture comes as the body, with a ceiling, and is never read past it. */
async function bytesUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

async function json(
  req: Request,
  optional = false,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const raw = await req.text()
  if (raw.trim() === '' && optional) return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
  } catch {
    // fall through to the one message
  }
  return { ok: false, error: 'Expected a JSON object body.' }
}
