// The space Worker's settings for one install: what wrangler.jsonc was, written by code from the install's declaration and install file.
//
// Pure and without I/O: `spaceWorkerSettings(install, file)` returns the settings object, and nothing else writes it. The space's build writes it to packages/space/wrangler.json (gitignored: packages/space/vite.config.ts), where wrangler
// finds it as the user config for every command the zbc Worker module runs there (the build, `d1 migrations apply`, the deploy, `secret put`), and the Cloudflare plugin reads that file and writes the Worker's
// deployable settings into dist/space/wrangler.json, the file `wrangler deploy` ships. The hand-kept packages/space/wrangler.jsonc is gone, with no second copy: an existing install's settings are this function's output for its pair, pinned value for value by the project that holds it.
//
// WHAT IS THE INSTALL'S AND WHAT IS THE CODE'S. The install's: the Worker's name, the hostnames (the space's host, and Gmail's push host where Gmail is on), the bucket, database and queue names, the allowed
// senders (the two apps' own senders and each business mailbox's address), the mailboxes as vars (the declaration's lists, so there is no copy to keep equal), the Realtime app's ids and the rate-limit
// namespaces. The code's, the same in every install: the entry module, the compatibility date, the binding names the code reads (`FORMS_DB`, `FORMS_FILES`, `RAW`, `EMAIL`, `AI`, `ASSETS`), the
// Durable Object classes (every install has all seven), the three crons and the limits. Each store's object NAME (meet's, the inbox's `inbox`) is a constant in its part and never an
// install's: a store is found by its Worker, its class and that name, so no install's store is ever renamed.
//
// The notes below are the ones the wrangler file carried that are still true; each store was moved here by Cloudflare's transfer (the space's ADRs 0015, 0016 and 0017).

import { CALENDAR_PUSH_PATH } from '../packages/workspace/src/calendar'
import type { Install } from '../packages/workspace/src/install'
import type { InstallFile } from './install-file'

/** The path Gmail's push is delivered to on the push host (packages/inbox/src/gmail/push.ts `PUSH_PATH`, which kit/test/kit.test.ts pins this to). */
export const GMAIL_PUSH_PATH = '/api/gmail/push'

/** The Durable Object classes of the Worker, in the order they are bound. Every install has all seven: a store's identity is (this Worker, class) and its object's name is a constant of its part. */
const STORES = [
  { binding: 'KNOWLEDGE', class: 'KnowledgeDO' },
  { binding: 'ROOMS', class: 'RoomDO' },
  { binding: 'WORKSPACE', class: 'WorkspaceDO' },
  { binding: 'INBOX', class: 'InboxDO' },
  { binding: 'LIVE', class: 'LiveDO' },
  { binding: 'CALENDAR', class: 'CalendarDO' },
  { binding: 'CLIENTS_STORE', class: 'ClientsDO' },
] as const

/** The three crons (src/worker.ts `scheduled` tells them apart by expression), each in exactly one Worker: this one. */
export const CRONS = ['*/5 * * * *', '47 9 * * *', '0 * * * *'] as const

export type WorkerSettings = Record<string, unknown>

/** What the Worker's `INBOX_MAILBOXES` var holds: the declaration's Cloudflare mailboxes as the inbox's own list reads them (packages/inbox/src/cloudflare/declared.ts), `assistant` being the spam check's switch. */
export function inboxMailboxesVar(install: Install): { address: string; name: string; assistant?: true }[] {
  return install.cloudflareMailboxes().map(({ address, name, spamCheck }) => ({ address, name, ...(spamCheck === true && { assistant: true as const }) }))
}

/**
 * What the Worker's `INBOX_JMAP_MAILBOXES` var holds: the four things the inbox's parser reads of each mailbox (packages/inbox/src/jmap/declared.ts). A mailbox's `people` (who is on it) is not here: the inbox reads it from the declaration it
 * was built with, and adding a person to a mailbox is not a change to the Worker's settings.
 */
export function inboxJmapMailboxesVar(install: Install): { address: string; name: string; door: string; secret: string }[] {
  return install.hostedMailboxes().map(({ address, name, door, secret }) => ({ address, name, door, secret }))
}

/** The Worker's settings for an install whose declaration is `declaration` (parsed, so a declaration that is not whole fails here) and whose install file is `file` (already read against it). */
export function spaceWorkerSettings(install: Install, file: InstallFile): WorkerSettings {
  const host = install.declaration.space.host
  const pushHost = install.gmailPushHost()
  const mailboxes = install.cloudflareMailboxes()
  const hosted = install.hostedMailboxes()
  const hasBusinessMail = mailboxes.length > 0

  return {
    name: file.worker,
    main: 'src/index.ts',
    compatibility_date: '2026-06-01',
    // Off, both of them. Access binds to a HOSTNAME, and a workers.dev or preview hostname is a second door it does not cover. The Worker verifies every request's assertion itself (the company layer's
    // identify, src/app.ts), so a stray hostname would refuse rather than leak, but one door is easier to reason about than three.
    workers_dev: false,
    preview_urls: false,
    // custom_domain, never a route pattern (a Custom Domain cannot create wildcard DNS records and gets its own certificate for the exact hostname, where a hand-added wildcard route once captured another hostname of its zone unseen). TWO HOSTNAMES where Gmail is on, told apart first in every request (src/worker.ts): the space's host, behind the whole-host Access
    // application, and the machine address Google's Pub/Sub delivers Gmail's push to. Pub/Sub cannot sign in to Access, so NO Access application covers that name, and on it the Worker answers ONE path
    // (a POST to the push path, for a Google-signed token: packages/inbox/src/gmail/push.ts) and the calendar's (a POST to /calendar/push, accepted only for a channel the calendar made, with the secret
    // it chose: packages/calendar/src/sync.ts); every other request there is a 404, and no team route can be reached from it. First-level (inbox-push, not push.inbox) so the zone's ordinary certificate covers it.
    // wrangler moves a Custom Domain from the Worker that has it to the one that deploys it, and replaces a Worker's list on every deploy.
    routes: [{ pattern: host, custom_domain: true }, ...(pushHost !== null ? [{ pattern: pushHost, custom_domain: true }] : [])],
    // EVERY request runs the Worker first, pages and files included. With the default, the asset router answers a page or a file before any code runs, so the Worker's own sign-in check would cover only the
    // API: a request that got past the Access edge without its assertion (a cookie alone once did) would read the whole page. Nothing on the host is public but the three guest paths.
    assets: { directory: './dist/client', not_found_handling: 'single-page-application', run_worker_first: true, binding: 'ASSETS' },
    // NO SERVICE BINDINGS: the inbox, meet, forms, the knowledge app and the Clients part run IN this Worker, reached by a call with no second sign-in check, and it depends on no other Worker and no site.
    //
    // THE STORES (a store's identity is this Worker, its class and the object's name; changing any is a new, empty store). Never deploy a file that declares a class live anywhere else, and never before the Worker that
    // has it has handed it over: a class declared live with no transfer provisions an empty store (the transfers are done). KnowledgeDO, RoomDO and
    // WorkspaceDO, InboxDO were handed here by Cloudflare's transfer; LiveDO (the company's one hibernating object holding every open page's connection, the space's ADR 0019), CalendarDO (Google's calendars synced into
    // a store of its own, ADR 0020) and ClientsDO (the company's one list of Clients, made and kept in the space, ADR 0021) are NEW classes: listed under `exports` with no `state`, which creates them and transfers
    // nothing. A moved object runs with THIS Worker's environment, which is why the bucket, the sender, Workers AI, the secrets and the vars below are here.
    durable_objects: { bindings: STORES.map((s) => ({ name: s.binding, class_name: s.class })) },
    exports: Object.fromEntries(STORES.map((s) => [s.class, { type: 'durable-object', storage: 'sqlite' }])),
    // The three crons: meet's five-minute sweep (packages/meet/src/cron.ts), the inbox's daily pass (09:47 UTC, packages/inbox/src/entrances.ts `DAILY_CRON`: renew Gmail's watch and run one sync from the cursor as
    // a net for a dropped push) and forms' hourly sweep (src/worker.ts `FORMS_CRON`: expire, remind only between 9:00 and 17:00 in the client's own time zone, seal again, send pending mail, purge).
    triggers: { crons: [...CRONS] },
    // THE DELIVERY REPORTS: Cloudflare's Email Sending publishes an event for each recipient of each message a business mailbox's domain sends to this queue (the `inbox-delivery` instance's subscriptions), and the
    // `queue()` handler (src/worker.ts) keeps the ones about mail the inbox sent (packages/inbox/src/delivery.ts). wrangler attaches a consumer by name and does not make the queue, which the instance imports so it
    // exists first. A queue has ONE consumer. A batch is at most 10 reports or 5 seconds, retried 3 times, and then dropped (no dead-letter queue).
    ...(file.stores.deliveryQueue !== undefined ? { queues: { consumers: [{ queue: file.stores.deliveryQueue, max_batch_size: 10, max_batch_timeout: 5, max_retries: 3 }] } } : {}),
    // FORMS: NAME ONLY, no ids; wrangler resolves both by name at deploy, and the instance creates the bucket and the database if missing. THIS Worker's instance applies forms' migrations
    // (`migrations_dir` names forms' folder), before every deploy. Every object is written with the envelope's own key (SSE-C).
    d1_databases: [{ binding: 'FORMS_DB', database_name: file.stores.formsDatabase, migrations_dir: '../forms/migrations' }],
    // THE INBOX'S RAW-MAIL BUCKET (`RAW`): the exact copy of every message that arrives through Cloudflare, bound by name (made by the `inbox-raw` instance, imported by the Worker's so it exists before it is bound).
    // Nothing prunes it.
    r2_buckets: [{ binding: 'FORMS_FILES', bucket_name: file.stores.formsBucket }, ...(file.stores.rawMailBucket !== undefined ? [{ binding: 'RAW', bucket_name: file.stores.rawMailBucket }] : [])],
    // Outbound email (Cloudflare Email Service), one binding with the senders of the apps that run here: Forms' (the operator's Send and Remind), Meet's (a channel guest's invitation, the direct-message nudges,
    // the phone's notices) and each business mailbox's own address (a reply goes out as the mailbox's address, packages/inbox/src/cloudflare/send.ts). Each app picks its own From; the binding allows exactly these.
    // IF A REAL SEND IS REFUSED FOR ITS SENDER, this list is the first suspect.
    send_email: [{ name: 'EMAIL', allowed_sender_addresses: [install.sender('forms'), install.sender('meet'), ...mailboxes.map((m) => m.address)] }],
    // WORKERS AI, for the spam check (packages/inbox/src/cloudflare/spam-check.ts): the inbox's store asks Cloudflare's spam-classifying model about a business mailbox's message after the raw copy is kept and the message filed.
    // A REMOTE binding: `vite dev` has none unless logged in (`SPACE_DEV_LOCAL=1 vite dev` leaves remote bindings off). Only an install with a business mailbox has one.
    ...(hasBusinessMail ? { ai: { binding: 'AI' } } : {}),
    // CPU, per request or alarm: 30 s, a guard and not a budget. A Durable Object's CPU limit is its owning Worker's, and the inbox's store runs here (a 10 MB parse, a Gmail sync batch, a search over the whole store).
    limits: { cpu_ms: 30000 },
    // A flood of guesses or uploads on forms' public API is refused before it costs a database read, and the guests' emailed-code sign-in is limited per caller before it costs the workspace object a request: 120 and
    // 10 a minute. A namespace id belongs to the account and is kept unique in it.
    ratelimits: [
      { name: 'PUBLIC_LIMIT', namespace_id: file.rateLimits.public, simple: { limit: 120, period: 60 } },
      { name: 'AUTH_LIMIT', namespace_id: file.rateLimits.auth, simple: { limit: 10, period: 60 } },
    ],
    // The address the apps' emails and call links are made from is not a var: it is the install's space host (the declaration's `space.host`), which forms' signing core and meet's wiring read from the install, so no var
    // can disagree with the host the Worker is served at. The Realtime app's ids are not secret (the call API's; its two secrets are Worker secrets pushed by the instance). Gmail's push endpoint and account are
    // vars the INSTANCE writes (the kit's instances.ts), since they are not settings of the build. CF_ACCESS_AUD and its sisters are deployed by the zbc module as --var from the Access instances' outputs.
    // The mailboxes are the declaration's, written down for the code that reads them as lists: the Cloudflare mailboxes ([{ address, name, assistant? }], packages/inbox/src/cloudflare/declared.ts; a list here
    // and not a setting on the page, so a new mailbox is a reviewed change deployed with the routing rule that points at it; mail for a domain not named is refused; `assistant: true` is whether the spam check
    // runs on the mailbox to begin with) and the mailboxes on the install's own mail server ([{ address, name, door, secret }], packages/inbox/src/jmap/declared.ts, `secret` the NAME of the Worker secret).
    vars: {
      ...(file.calls ? { REALTIME_APP_ID: file.calls.realtimeAppId, TURN_KEY_ID: file.calls.turnKeyId } : {}),
      // Where Google sends the calendar's push notifications: the push host's second path (src/worker.ts). Unset: no channel is made and the safety resync alone keeps the calendar current.
      ...(pushHost !== null ? { CALENDAR_PUSH_URL: `https://${pushHost}${CALENDAR_PUSH_PATH}` } : {}),
      ...(hasBusinessMail ? { INBOX_MAILBOXES: inboxMailboxesVar(install) } : {}),
      ...(hosted.length > 0 ? { INBOX_JMAP_MAILBOXES: inboxJmapMailboxesVar(install) } : {}),
    },
  }
}
