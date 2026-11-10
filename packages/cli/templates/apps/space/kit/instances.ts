// The install kit: one function from an install's declaration and install file to what zbc applies for the space.
//
// `buildSpaceInstall` makes the zbc instances of one install of the space (packages/space): the Access applications for the whole host, for Forms and for the three open guest paths, the doors a
// machine uses where the install has them (Claude's script, the Telegram bridge, the Clients door), Forms' bucket and database, the raw-mail bucket and the delivery-report queue where the install has business mailboxes, and the
// Worker itself with its secrets and vars. The Worker's own settings (hostnames, bindings, senders, mailboxes, crons) are `spaceWorkerSettings` (worker-settings.ts), which the space's build writes for the
// install; this file is the half zbc applies. An environment's instance files are one line each, exporting what this returns (the install's own file in its environment), so that
// a new company is a new pair of files in a new environment and not new code.
//
// AN EXISTING INSTALL'S OUTPUT IS ITS INSTANCES AS THEY WERE: every name, id and list is the one it had when it was written by hand, and the project that holds the install pins it value for value beside its files.
// Instance names are zbc's state keys and never derived from anything in an install (`space`, `space-access`, ...): another environment's apply keeps its own state under the same names.
//
// THE KIT IS GIVEN WHAT IT BUILDS WITH. It imports no zbc module and no file of the project's: the project hands it its own zbc modules (`modules`) and says where the space's code and the install's
// declaration are, from the project's root (`paths`). So the same kit serves every project that holds an install, whatever version of each module it has.
//
// WHAT EACH INSTANCE OWNS. Everything an install needs to be reached is applied BEFORE the Worker is served, which is what `imports` orders: the applications for the host and its paths, the buckets (a bucket
// a binding names must exist, and Cloudflare creates a missing one rather than refusing, so the order matters), Forms' database, MIGRATED by its own instance before the Worker that reads it is deployed, and the
// queue the Worker is attached to as its one consumer. Nothing here makes a store the Worker owns: its Durable Object classes are declared in its settings and never deployed anywhere else.
//
// WHAT IS NEVER DESTROYED. The Worker (its Durable Objects are the install's mail, conversations, Clients, knowledge and calendar), Forms' bucket and database (signed records and their files) and the raw-mail
// bucket (the only exact copy of what arrived) are marked `retain`: a destroy of the environment leaves them standing and a destroy of one of them is refused.
//
// NOT IN CI. The space is deployed by hand: it is the single door to everything (a bad deploy takes the whole space down), a hand deploy lets a person look at the address after it, and every ship of any
// part restarts all of it. The cost: a change to the code of any app reaches the space only when someone applies it, and a change to a declaration (a person added OR removed) must be applied by hand. Removing
// is the one that fails open: the space keeps the person in its Access policy and its bundled list until someone applies it.
//
// Teardown: delete the environment's files for the install and packages/space in one change, so the Custom Domain does not outlive its Worker. An Access application is never removed on teardown; delete it in Zero Trust.

import { posix } from 'node:path'
import { guestAccessDomain, type GuestPrefix } from '../packages/workspace/src/guests'
import { createInstall, type Install } from '../packages/workspace/src/install'
import { phoneSecretsToPush } from '../packages/meet/src/phone-line'
import { type InstallFile, parseInstallFile } from './install-file'
import { GMAIL_PUSH_PATH, spaceWorkerSettings, type WorkerSettings } from './worker-settings'

/** The names zbc keeps each instance of an install under. Fixed: an environment's state is keyed by them, and no install's content is ever one. */
export const INSTANCE_NAMES = {
  space: 'space',
  spaceAccess: 'space-access',
  formsAccess: 'space-forms-access',
  agentAccess: 'space-agent-access',
  telegramAccess: 'space-telegram-access',
  clientsAccess: 'space-clients-access',
  guestCalls: 'space-guest-calls',
  guestChat: 'space-guest-chat',
  guestSigning: 'space-guest-signing',
  formsBucket: 'forms-bucket',
  formsDatabase: 'forms-database',
  rawMail: 'inbox-raw',
  deliveryReports: 'inbox-delivery',
} as const

/** The sending events a business domain's delivery-report subscription asks for. */
const DELIVERY_EVENTS = ['message.delivered', 'message.deferred', 'message.bounced', 'message.failed', 'message.rejected', 'message.complained']

/** The token that applies every instance of the account, from the environment's own secrets: Cloudflare's deploy token. */
const API_TOKEN = { secret: 'CLOUDFLARE_API_TOKEN' }

/** As much of a zbc instance as the kit reads. A project's own instance type is richer; the kit hands back whatever its modules made. */
export interface KitInstance {
  name: string
}

/** A zbc module, as much of one as the kit uses: something that makes an instance from a name, a config, the instances it imports and whether it may ever be destroyed. */
export interface KitModule {
  instance: (options: never) => unknown
}

/**
 * The project's zbc modules the kit builds from. `worker` is the module that builds and deploys a Cloudflare Worker (zbc's `cloudflare`, or the project's own version of it); the rest are zbc's
 * `cloudflare-access`, `queue`, `r2` and `d1`.
 */
export interface SpaceKitModules {
  worker: KitModule
  access: KitModule
  queue: KitModule
  bucket: KitModule
  database: KitModule
}

/** Where things are in the project, each from the project's root. */
export interface SpaceKitPaths {
  /** The space's Worker package (`packages/space` of the space's folder): the Worker module builds and deploys from there. */
  worker: string
  /** Forms' migrations folder, which the database's instance applies. */
  formsMigrations: string
  /** The install's declaration (`workspace.json`). Its install file and content file are beside it. */
  declaration: string
}

export interface SpaceInstances<Instance extends KitInstance = KitInstance> {
  space: Instance
  spaceAccess: Instance
  formsAccess: Instance
  /** The doors a machine uses, only where the declaration gives them (Claude's, the Telegram bridge's, the Clients door's). */
  agentAccess?: Instance
  telegramAccess?: Instance
  clientsAccess?: Instance
  guestCalls?: Instance
  guestChat: Instance
  guestSigning: Instance
  /** Forms' bucket (every file a signer or an operator gives it) and database (envelopes, requests, the audit trail). Never destroyed. */
  formsBucket: Instance
  formsDatabase: Instance
  /** The raw-mail bucket and the delivery-report queue, only where the install has business mailboxes. */
  rawMail?: Instance
  deliveryReports?: Instance
}

export interface SpaceInstall<Instance extends KitInstance = KitInstance> {
  install: Install
  file: InstallFile
  /** The Worker's settings, which the space's build writes for this install. */
  settings: WorkerSettings
  instances: SpaceInstances<Instance>
  /** Every instance of the install, in an order that puts what the Worker needs before it. */
  all: Instance[]
}

export interface SpaceInstallInput {
  /** The company's declaration, as parsed JSON. */
  declaration: unknown
  /** The install file, as parsed JSON. */
  installFile: unknown
  /** The names (never the values) the environment's sops file holds: the phone's four secrets are pushed only when all are held. */
  sopsNames: readonly string[]
  /** The project's zbc modules. */
  modules: SpaceKitModules
  /** Where the space's code and the install's declaration are, from the project's root. */
  paths: SpaceKitPaths
}

/**
 * Every instance of one install of the space, from its declaration and install file. Throws, naming every problem, when either is not whole or they disagree. `Instance` is the project's own instance type
 * (what its modules' `instance` returns), so the instances come back as the project's engine knows them.
 */
export function buildSpaceInstall<Instance extends KitInstance = KitInstance>(input: SpaceInstallInput): SpaceInstall<Instance> {
  const install = createInstall(input.declaration)
  const file = parseInstallFile(input.installFile, install)
  const d = install.declaration
  const host = d.space.host
  const accountId = file.account.id
  const { modules, paths } = input
  /** One instance of a module. `retain` marks a resource whose loss is a loss of records: a destroy leaves it standing. */
  const make = (module: KitModule, options: { name: string; config: Record<string, unknown>; imports?: Instance[]; retain?: boolean }): Instance =>
    (module.instance as (options: unknown) => unknown)(options) as Instance

  // A people application: the module finds it by its domain (adopting the live one) and its policy by name.
  const peopleApplication = (instance: string, place: 'space' | 'forms', names: { application: string; policy: string }, extra: Record<string, unknown>) => {
    const app = install.accessApplication(place)
    return make(modules.access, {
      name: instance,
      config: {
        name: names.application,
        accountId,
        apiToken: API_TOKEN,
        // The team's Zero Trust organisation, COMPARED and never written by an apply: the Worker derives the issuer it checks every assertion against from this string, so an apply that could rewrite it would be a silent lockout.
        teamDomain: install.teamDomain,
        domain: app.domain,
        policyName: names.policy,
        emails: app.allowedEmails,
        ...extra,
        sessionDuration: app.sessionDuration,
      },
    })
  }

  const spaceAccess = peopleApplication(INSTANCE_NAMES.spaceAccess, 'space', file.access.space, {
    identityProviders: ['onetimepin'],
    // Lax: nothing on this host is used from another site, and the space accepts writes (a reply, a post, a mark read). A cookie that a cross-site POST would carry is then not sent. The Forms application is left
    // alone: its silent renewal crosses sites inside the frame (the space's ADR 0002). A cookie already issued keeps SameSite=None until it ends.
    sameSiteCookieAttribute: 'lax',
  })
  const formsAccess = peopleApplication(INSTANCE_NAMES.formsAccess, 'forms', file.access.forms, {
    // Its cookie is Path=/forms, so signing in here leaves the space's month alone (and the reverse). Off, the two applications would share one cookie on the host and each sign-in would replace the other's.
    pathCookieAttribute: true,
  })

  // A machine's door: no people, a token found by name and never rotated from here (the consumer holds the secret out of band), no cookie.
  const machineDoor = (instance: string, door: { domain: string } | null, names: { application: string; token: string } | undefined): Instance | undefined => {
    if (door === null || names === undefined) return undefined
    return make(modules.access, {
      name: instance,
      config: {
        name: names.application,
        accountId,
        apiToken: API_TOKEN,
        teamDomain: install.teamDomain,
        domain: door.domain,
        emails: [],
        serviceTokenName: names.token,
        rotate: false,
        sessionDuration: '0s',
      },
    })
  }
  const agentAccess = machineDoor(INSTANCE_NAMES.agentAccess, install.agentDoor(), file.access.agent)
  const telegramAccess = machineDoor(INSTANCE_NAMES.telegramAccess, install.telegramDoor(), file.access.telegram)
  const clientsAccess = machineDoor(INSTANCE_NAMES.clientsAccess, install.clientsDoor(), file.access.clients)

  // ONE OF THE SPACE'S OPEN PATHS, as an Access application (the space's ADR 0018). The whole host is behind the sign-in; a call's guests, a
  // channel's guests and a document's signers have no account, so three paths are taken out of that gate by a more specific application with Cloudflare's Bypass policy for everyone, and Access serves a request with the
  // most specific application it has. `GUEST_PREFIXES` (packages/workspace/src/guests.ts) is the list, and the Worker's router and the build read the same one, so the edge cannot open a path the Worker does not
  // answer as a guest's, or the other way round. Each is an instance of its own (the module converges one application), named for what it lets in.
  //
  // WHAT A BYPASS MEANS HERE. The edge passes the request through with no assertion and the Worker answers it before its person check (packages/space/src/guests.ts), with the credential that path takes and nothing
  // else; a team assertion would be ignored there, and a guest path never reads the Access cookie. The domain is the prefix's subtree (`<host>/r/*`), never the bare prefix, so it can match nothing of the team's own
  // (`/sw.js`, `/recover`). NOTHING IS MINTED and no secret is involved: the module's `bypass` mode admits no person and no token. The credential it applies with is the environment's deploy token.
  //
  // Teardown: the module has no `destroy` on purpose. To close a path, delete the application in Zero Trust (the path then asks for the sign-in like the rest of the host).
  const guestPath = (instance: string, prefix: GuestPrefix, names: { application: string; policy: string }): Instance => {
    return make(modules.access, {
      name: instance,
      config: {
        name: names.application,
        accountId,
        apiToken: API_TOKEN,
        teamDomain: install.teamDomain,
        domain: guestAccessDomain(host, prefix),
        bypass: true,
        emails: [],
        policyName: names.policy,
        // Nobody signs in on a bypass; the value only has to be one Cloudflare takes.
        sessionDuration: '24h',
        // A tile in the App Launcher for a path nobody signs in to is noise.
        appLauncherVisible: false,
      },
    })
  }
  const guestCalls = file.access.guests.calls ? guestPath(INSTANCE_NAMES.guestCalls, '/r', file.access.guests.calls) : undefined
  const guestChat = guestPath(INSTANCE_NAMES.guestChat, '/w', file.access.guests.chat)
  const guestSigning = guestPath(INSTANCE_NAMES.guestSigning, '/s', file.access.guests.signing)

  // Forms' bucket and database, each an instance of its own. The database's instance applies forms' migrations (wrangler's own format and ledger) before the Worker that reads it is deployed. Both hold signed
  // records, so neither is ever destroyed.
  const formsBucket = make(modules.bucket, { name: INSTANCE_NAMES.formsBucket, config: { accountId, bucketName: file.stores.formsBucket }, retain: true })
  const formsDatabase = make(modules.database, {
    name: INSTANCE_NAMES.formsDatabase,
    config: { accountId, databaseName: file.stores.formsDatabase, migrationsDir: paths.formsMigrations },
    retain: true,
  })

  // The raw-mail bucket and the delivery-report queue, only where there are business mailboxes (the install file has them exactly then). The bucket is the only exact copy of what arrived: never destroyed.
  const rawMail =
    file.stores.rawMailBucket !== undefined ? make(modules.bucket, { name: INSTANCE_NAMES.rawMail, config: { accountId, bucketName: file.stores.rawMailBucket }, retain: true }) : undefined
  const deliveryReports =
    file.stores.deliveryQueue !== undefined && file.deliveryReports !== undefined
      ? make(modules.queue, {
          name: INSTANCE_NAMES.deliveryReports,
          config: {
            accountId,
            // Named in the Worker's settings (queues.consumers) from this same install file, so the consumer and the queue cannot disagree.
            queueName: file.stores.deliveryQueue,
            subscriptions: file.deliveryReports.map((s) => ({ name: s.name, zoneId: s.zoneId, domain: s.domain, events: DELIVERY_EVENTS })),
          },
        })
      : undefined

  // The Worker's secrets, from the sops names the install file gives. A secret whose sops name is the name the code reads is pushed by that name alone; otherwise as { name, secret }.
  const secret = (name: string, sops: string) => (name === sops ? name : { name, secret: sops })
  const googleApp = install.googleApp()
  const pushHost = install.gmailPushHost()
  const workerSecrets = [
    secret('FORMS_DATA_KEY', file.secrets.forms.dataKey),
    secret('FORMS_SEAL_KEY', file.secrets.forms.sealKey),
    secret('FORMS_SEAL_CERT_CHAIN', file.secrets.forms.sealCertChain),
    // The guests' side of meet: the call API's two Cloudflare credentials.
    ...(file.secrets.calls ? [secret('MEET_REALTIME_APP_SECRET', file.secrets.calls.realtimeAppSecret), secret('MEET_TURN_KEY_TOKEN', file.secrets.calls.turnKeyToken)] : []),
    // The phone's four Telnyx secrets, pushed only when sops holds all of them (a half-set account fails the load, before anything is deployed).
    ...(install.has('phone') ? phoneSecretsToPush(input.sopsNames) : []),
    // The inbox's, read by the store's OBJECT, which runs with this Worker's environment: the Google client's secret half (which only lets whoever signs in to Google hand the inbox a grant), the key every
    // notification is signed with, and the assistant's pay-per-use key under the name the code reads. The Gmail refresh token is NOT a Worker secret: it lives in the inbox's store only.
    ...(file.secrets.gmail ? [secret('INBOX_GOOGLE_CLIENT_SECRET', file.secrets.gmail.clientSecret)] : []),
    secret('INBOX_VAPID_KEY', file.secrets.notifications.vapidKey),
    ...(file.secrets.assistant ? [secret('ANTHROPIC_API_KEY', file.secrets.assistant.anthropicKey)] : []),
    // The mailboxes on the install's own mail server: each mailbox's own JMAP-only key (the secret NAME the declaration gives it) and the Access token that opens the door to the server (the superuser is never here).
    ...(file.secrets.hostedMailboxes
      ? [
          ...Object.entries(file.secrets.hostedMailboxes.keys).map(([name, sops]) => secret(name, sops)),
          secret('JMAP_ACCESS_CLIENT_ID', file.secrets.hostedMailboxes.doorClientId),
          secret('JMAP_ACCESS_CLIENT_SECRET', file.secrets.hostedMailboxes.doorClientSecret),
        ]
      : []),
  ]

  // The audiences come out of the Access instances, resolved at apply time: a renamed instance or a dropped output fails the deploy here, and an application that came back with no well-formed (64 hex) audience
  // fails the Access instance's apply first, so an empty audience, which the Worker reads as "refuse everyone", is never deployed. The token ids are the machine doors' own.
  const workerVars = [
    { name: 'CF_ACCESS_AUD', from: INSTANCE_NAMES.spaceAccess, output: 'aud' },
    { name: 'CF_ACCESS_AUD_FORMS', from: INSTANCE_NAMES.formsAccess, output: 'aud' },
    ...(agentAccess
      ? [
          // Claude's door (src/agent.ts): the audience of the application on the agent path, which only its token passes, and that token's id, which the inbox's router admits as the agent by its id alone.
          { name: 'CF_ACCESS_AUD_AGENT', from: INSTANCE_NAMES.agentAccess, output: 'aud' },
          { name: 'INBOX_ACCESS_CLIENT_ID', from: INSTANCE_NAMES.agentAccess, output: 'clientId' },
        ]
      : []),
    ...(telegramAccess
      ? [
          // The Telegram bridge's door (src/telegram.ts): its own audience and its token's id.
          { name: 'CF_ACCESS_AUD_TELEGRAM', from: INSTANCE_NAMES.telegramAccess, output: 'aud' },
          { name: 'TELEGRAM_ACCESS_CLIENT_ID', from: INSTANCE_NAMES.telegramAccess, output: 'clientId' },
        ]
      : []),
    ...(clientsAccess
      ? [
          // The Clients door (src/clients-door.ts): the audience of the application on its path and the token's id, which the Worker checks the assertion against.
          { name: 'CF_ACCESS_AUD_CLIENTS', from: INSTANCE_NAMES.clientsAccess, output: 'aud' },
          { name: 'CLIENTS_ACCESS_CLIENT_ID', from: INSTANCE_NAMES.clientsAccess, output: 'clientId' },
        ]
      : []),
    ...(googleApp !== null && pushHost !== null && file.gmail
      ? [
          // The Google app's client id (public: it is in the sign-in address Connect Gmail sends the browser to) and the topic Gmail's watch publishes to are the declaration's; the push endpoint is the push URL and the
          // audience of Google's token, and the account is the one the subscription signs its tokens as. Literals, so applying never contacts Google (the project that holds the install checks them against what its Google setup made).
          { name: 'INBOX_GOOGLE_CLIENT_ID', value: googleApp.clientId },
          { name: 'GMAIL_TOPIC_NAME', value: googleApp.pushTopic },
          { name: 'GMAIL_PUSH_ENDPOINT', value: `https://${pushHost}${GMAIL_PUSH_PATH}` },
          { name: 'GMAIL_PUSH_SERVICE_ACCOUNT', value: file.gmail.pushServiceAccount },
        ]
      : []),
  ]

  const space = make(modules.worker, {
    name: INSTANCE_NAMES.space,
    config: {
      workdir: paths.worker,
      accountId,
      // Runs in the Worker package (the workdir). The build is for the declaration it bundles, which `SPACE_DECLARATION` names (its install file and its content file are beside it): the command sets it, so a
      // shell that still has the variable exported for another company never changes which install is bundled, and a build with none named refuses. The path is given from the project's root and handed to the
      // build from where it runs.
      build: { command: `env SPACE_DECLARATION='${posix.relative(paths.worker, paths.declaration)}' bun run build` },
      workerSecrets,
      workerVars,
    },
    // A real dependency AND the thing that orders the apply: the gates go up before the door is served. The buckets are imports so each exists before this Worker binds it, the database so it is migrated before
    // this Worker reads it, and the delivery-report queue so it exists before this Worker is attached as its consumer.
    imports: [formsBucket, formsDatabase, rawMail, deliveryReports, spaceAccess, formsAccess, agentAccess, telegramAccess, clientsAccess, guestCalls, guestChat, guestSigning].filter((i): i is Instance => i !== undefined),
    // Its Durable Objects are the install's stores: a destroy of this Worker would delete every one.
    retain: true,
  })

  const instances: SpaceInstances<Instance> = {
    space,
    spaceAccess,
    formsAccess,
    ...(agentAccess ? { agentAccess } : {}),
    ...(telegramAccess ? { telegramAccess } : {}),
    ...(clientsAccess ? { clientsAccess } : {}),
    ...(guestCalls ? { guestCalls } : {}),
    guestChat,
    guestSigning,
    formsBucket,
    formsDatabase,
    ...(rawMail ? { rawMail } : {}),
    ...(deliveryReports ? { deliveryReports } : {}),
  }
  const all = [formsBucket, formsDatabase, rawMail, deliveryReports, spaceAccess, formsAccess, agentAccess, telegramAccess, clientsAccess, guestCalls, guestChat, guestSigning, space].filter((i): i is Instance => i !== undefined)
  return { install, file, settings: spaceWorkerSettings(install, file), instances, all }
}
