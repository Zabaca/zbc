// The install file: what one install of the space is called in its own Cloudflare account, and which secrets it holds.
//
// The declaration (packages/workspace) says who the company is and which features it has; this file says what those features are made of where they are deployed: the account, the Worker, every
// bucket, database and queue, the Access applications and policies and the tokens they admit, the ids the call API gave, and the NAMES of the secrets in the environment's sops file. An install's file
// carries the names it has had since each was made (it sits beside the install's declaration, in the install's own environment); a new install takes names of its own once and keeps them, because a renamed store is a
// new, empty one. It is JSON, like the declaration, because zbc loads every .ts file in an environment's folder as an instance (a .json file is not looked at), and it holds no secret: only names.
//
// `parseInstallFile` reads it AGAINST the declaration, since each section is present exactly where a switch or a mailbox needs it: a feature on with no names for what it is made of is refused here, at
// the build and at the apply, and never found missing in the account. Every problem is reported at once. Pure and without I/O, so the build's config (packages/space/vite.config.ts) and the deploy read it alike.

import type { Install } from '../packages/workspace/src/install'

export class InstallFileError extends Error {
  constructor(readonly problems: string[]) {
    super(`The install file is not valid:\n- ${problems.join('\n- ')}`)
    this.name = 'InstallFileError'
  }
}

/** An Access application the kit makes, by the name the dashboard shows it under, and the policy it holds (a people application and a bypass have one; a machine's door finds its token by name instead). */
export interface ApplicationNames {
  application: string
  policy: string
}

/** A machine's door: the application on its path, and the name of the one service token it admits (made by the first apply that finds it absent, never rotated from here). */
export interface DoorNames {
  application: string
  token: string
}

export interface InstallFile {
  account: { id: string }
  /** The Worker's name in the account. A literal that other repos use (a site's own email Worker can route mail to the Worker by this name), so it is never derived. */
  worker: string
  stores: {
    /** Forms' bucket (every file a signer or an operator gives it, kept under the envelope's own key). */
    formsBucket: string
    /** Forms' database (envelopes, requests, the audit trail). */
    formsDatabase: string
    /** The inbox's raw-mail bucket and the delivery-report queue: present exactly where the declaration lists a business mailbox fed by Cloudflare Email Routing. */
    rawMailBucket?: string
    deliveryQueue?: string
  }
  /** The sending domains whose delivery reports the queue gets, one subscription each; one for every domain a business mailbox is on. Present exactly where the queue is. */
  deliveryReports?: { name: string; zoneId: string; domain: string }[]
  /** The two rate-limit namespaces, ids that belong to the account and are kept unique in it: forms' public API's and the guests' sign-in's. */
  rateLimits: { public: string; auth: string }
  /** The ids of the install's Realtime app and relay key (public; their secrets are in sops). Present exactly where the `calls` switch is on. */
  calls?: { realtimeAppId: string; turnKeyId: string }
  /** The service account Gmail's push subscription signs its tokens as. Present exactly where the `gmail` switch is on. */
  gmail?: { pushServiceAccount: string }
  access: {
    space: ApplicationNames
    forms: ApplicationNames
    /** Present exactly where the declaration gives the door: Claude's (`agent`), the Telegram bridge's (`telegram`), the Clients door's (`clientsDoor`). */
    agent?: DoorNames
    telegram?: DoorNames
    clients?: DoorNames
    /** The three open paths of the space: a call's guests (only where `calls` is on), a channel's guests and a document's signers. */
    guests: { calls?: ApplicationNames; chat: ApplicationNames; signing: ApplicationNames }
  }
  /** The NAMES of the secrets in the environment's sops file that the Worker is handed, grouped by what they are for. Never a value. */
  secrets: {
    forms: { dataKey: string; sealKey: string; sealCertChain: string }
    /** The Realtime app's secret and the relay key's token. Present exactly where `calls` is on. */
    calls?: { realtimeAppSecret: string; turnKeyToken: string }
    /** The key every notification is signed with. */
    notifications: { vapidKey: string }
    /** The OAuth client's secret half. Present exactly where `gmail` is on. */
    gmail?: { clientSecret: string }
    /** The assistant's pay-per-use model key. Present exactly where `assistant` is on. */
    assistant?: { anthropicKey: string }
    /** Present exactly where `hostedMailboxes` is on: the sops name each declared mailbox's key is held under (by the Worker secret name the declaration gives it), and the Access token that opens the mail server's door. */
    hostedMailboxes?: { keys: Record<string, string>; doorClientId: string; doorClientSecret: string }
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v) ? v.trim() : null)

const ACCOUNT_ID = /^[0-9a-f]{32}$/
const ZONE_ID = /^[0-9a-f]{32}$/
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const NAMESPACE_ID = /^[0-9]{1,12}$/
const SOPS_NAME = /^[A-Z][A-Z0-9_]{2,63}$/
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/

function knownKeys(where: string, o: Obj, allowed: readonly string[], problems: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where}: unknown field "${k}"`)
}

/** An object that must be there (or must not be), with its keys checked; null when it is absent or not an object (a problem is recorded where it is required). */
function section(where: string, v: unknown, wanted: boolean, why: string, keys: readonly string[], problems: string[]): Obj | null {
  if (v === undefined) {
    if (wanted) problems.push(`${where}: required ${why}`)
    return null
  }
  if (!wanted) {
    problems.push(`${where}: only ${why}`)
    return null
  }
  if (!isObj(v)) {
    problems.push(`${where}: an object`)
    return null
  }
  knownKeys(where, v, keys, problems)
  return v
}

function field(where: string, o: Obj, key: string, test: (s: string) => boolean, what: string, problems: string[]): string {
  const v = str(o[key])
  if (v === null || !test(v)) {
    problems.push(`${where}.${key}: ${what}`)
    return ''
  }
  return v
}

const anyLine = () => true
const sopsName = (where: string, o: Obj, key: string, problems: string[]) => field(where, o, key, (s) => SOPS_NAME.test(s), 'the name of a secret in the environment\'s sops file, upper case', problems)
const line = (where: string, o: Obj, key: string, problems: string[]) => field(where, o, key, anyLine, 'one line', problems)

/** The install file in `raw`, read against the install's declaration, or an InstallFileError naming everything wrong with it. */
export function parseInstallFile(raw: unknown, install: Install): InstallFile {
  const problems: string[] = []
  if (!isObj(raw)) throw new InstallFileError(['the install file is not an object'])
  knownKeys('install file', raw, ['account', 'worker', 'stores', 'deliveryReports', 'rateLimits', 'calls', 'gmail', 'access', 'secrets'], problems)
  const d = install.declaration
  const on = (sw: Parameters<Install['has']>[0]) => install.has(sw)
  const mailboxes = install.cloudflareMailboxes()
  const hasBusinessMail = mailboxes.length > 0

  // The account and the Worker
  const accountO = section('account', raw.account, true, 'for where the install is deployed', ['id'], problems)
  const account = { id: accountO ? field('account', accountO, 'id', (s) => ACCOUNT_ID.test(s), 'the Cloudflare account id, 32 lower-case hex characters', problems) : '' }
  const worker = str(raw.worker)
  if (worker === null || !WORKER_NAME.test(worker)) problems.push('worker: the Worker\'s name in the account, such as "space"')

  // Stores
  const storesO = section('stores', raw.stores, true, 'for what the install keeps its data in', ['formsBucket', 'formsDatabase', 'rawMailBucket', 'deliveryQueue'], problems)
  const stores: InstallFile['stores'] = { formsBucket: '', formsDatabase: '' }
  if (storesO) {
    stores.formsBucket = field('stores', storesO, 'formsBucket', (s) => BUCKET.test(s), 'an R2 bucket name', problems)
    stores.formsDatabase = field('stores', storesO, 'formsDatabase', (s) => BUCKET.test(s), 'a D1 database name', problems)
    if (hasBusinessMail) {
      stores.rawMailBucket = field('stores', storesO, 'rawMailBucket', (s) => BUCKET.test(s), 'an R2 bucket name (the declaration lists business mailboxes, whose raw mail is kept there)', problems)
      stores.deliveryQueue = field('stores', storesO, 'deliveryQueue', (s) => BUCKET.test(s), 'a queue name (the declaration lists business mailboxes, whose delivery reports arrive there)', problems)
    } else {
      if (storesO.rawMailBucket !== undefined) problems.push('stores.rawMailBucket: only where the declaration lists a business mailbox')
      if (storesO.deliveryQueue !== undefined) problems.push('stores.deliveryQueue: only where the declaration lists a business mailbox')
    }
  }

  // Delivery reports: one subscription for every domain a business mailbox is on
  let deliveryReports: InstallFile['deliveryReports']
  if (!hasBusinessMail) {
    if (raw.deliveryReports !== undefined) problems.push('deliveryReports: only where the declaration lists a business mailbox')
  } else if (!Array.isArray(raw.deliveryReports) || raw.deliveryReports.length === 0) {
    problems.push('deliveryReports: a list with one { name, zoneId, domain } for each domain a business mailbox is on')
  } else {
    deliveryReports = []
    for (const [n, entry] of raw.deliveryReports.entries()) {
      const where = `deliveryReports[${n}]`
      if (!isObj(entry)) {
        problems.push(`${where}: an object`)
        continue
      }
      knownKeys(where, entry, ['name', 'zoneId', 'domain'], problems)
      deliveryReports.push({
        name: line(where, entry, 'name', problems),
        zoneId: field(where, entry, 'zoneId', (s) => ZONE_ID.test(s), 'the zone id of the sending domain, 32 lower-case hex characters', problems),
        domain: line(where, entry, 'domain', problems),
      })
    }
    for (const m of mailboxes) {
      const domain = m.address.slice(m.address.indexOf('@') + 1)
      if (!deliveryReports.some((r) => r.domain === domain)) problems.push(`deliveryReports: ${m.address} sends from ${domain}, which has no subscription, so its delivery reports would never arrive`)
    }
    const names = deliveryReports.map((r) => r.name)
    if (new Set(names).size !== names.length) problems.push('deliveryReports: two subscriptions have the same name')
  }

  // Rate limits
  const rateO = section('rateLimits', raw.rateLimits, true, 'for the limits on forms\' public API and the guests\' sign-in', ['public', 'auth'], problems)
  const rateLimits = {
    public: rateO ? field('rateLimits', rateO, 'public', (s) => NAMESPACE_ID.test(s), 'a rate-limit namespace id, digits, unique in the account', problems) : '',
    auth: rateO ? field('rateLimits', rateO, 'auth', (s) => NAMESPACE_ID.test(s), 'a rate-limit namespace id, digits, unique in the account', problems) : '',
  }
  if (rateLimits.public !== '' && rateLimits.public === rateLimits.auth) problems.push('rateLimits: the two limits need two namespace ids')

  // Calls
  const callsO = section('calls', raw.calls, on('calls'), 'where the calls switch is on', ['realtimeAppId', 'turnKeyId'], problems)
  const calls = callsO
    ? { realtimeAppId: field('calls', callsO, 'realtimeAppId', (s) => /^[0-9a-f]{32}$/.test(s), 'the Realtime app\'s id, 32 lower-case hex characters', problems), turnKeyId: field('calls', callsO, 'turnKeyId', (s) => /^[0-9a-f]{32}$/.test(s), 'the relay key\'s id, 32 lower-case hex characters', problems) }
    : undefined

  // Gmail
  const gmailO = section('gmail', raw.gmail, on('gmail'), 'where the gmail switch is on', ['pushServiceAccount'], problems)
  const gmail = gmailO ? { pushServiceAccount: field('gmail', gmailO, 'pushServiceAccount', (s) => SERVICE_ACCOUNT.test(s), 'the service account Gmail\'s push signs its tokens as, "<name>@<project>.iam.gserviceaccount.com"', problems) } : undefined

  // Access
  const accessO = section('access', raw.access, true, 'for the Access applications', ['space', 'forms', 'agent', 'telegram', 'clients', 'guests'], problems)
  const people = (where: string, v: unknown): ApplicationNames => {
    const o = section(where, v, true, 'for this Access application', ['application', 'policy'], problems)
    return o ? { application: line(where, o, 'application', problems), policy: line(where, o, 'policy', problems) } : { application: '', policy: '' }
  }
  const door = (where: string, v: unknown, wanted: boolean, why: string): DoorNames | undefined => {
    const o = section(where, v, wanted, why, ['application', 'token'], problems)
    return o ? { application: line(where, o, 'application', problems), token: line(where, o, 'token', problems) } : undefined
  }
  const access: InstallFile['access'] = {
    space: people('access.space', accessO?.space),
    forms: people('access.forms', accessO?.forms),
    ...optional('agent', door('access.agent', accessO?.agent, d.agent !== undefined, 'where the declaration gives Claude\'s door (agent)')),
    ...optional('telegram', door('access.telegram', accessO?.telegram, d.telegram !== undefined, 'where the declaration gives the Telegram bridge\'s door (telegram)')),
    ...optional('clients', door('access.clients', accessO?.clients, d.clientsDoor !== undefined, 'where the declaration gives the Clients door (clientsDoor)')),
    guests: { chat: { application: '', policy: '' }, signing: { application: '', policy: '' } },
  }
  const guestsO = section('access.guests', accessO?.guests, true, 'for the three open paths', ['calls', 'chat', 'signing'], problems)
  if (guestsO) {
    access.guests = {
      ...(on('calls') ? { calls: people('access.guests.calls', guestsO.calls) } : {}),
      chat: people('access.guests.chat', guestsO.chat),
      signing: people('access.guests.signing', guestsO.signing),
    }
    if (!on('calls') && guestsO.calls !== undefined) problems.push('access.guests.calls: only where the calls switch is on')
  }
  // Each machine has a token of its own: one token on two doors is two doors with one key.
  const tokens = [access.agent, access.telegram, access.clients].filter((x): x is DoorNames => x !== undefined).map((x) => x.token)
  if (new Set(tokens).size !== tokens.length) problems.push('access: each machine door has a token of its own, not another door\'s')
  const applications = [access.space, access.forms, access.agent, access.telegram, access.clients, access.guests.calls, access.guests.chat, access.guests.signing].filter((x) => x !== undefined).map((x) => x.application)
  if (new Set(applications).size !== applications.length) problems.push('access: two applications have the same name')

  // Secrets
  const secretsO = section('secrets', raw.secrets, true, 'for the names of the Worker\'s secrets', ['forms', 'calls', 'notifications', 'gmail', 'assistant', 'hostedMailboxes'], problems)
  const group = (where: string, v: unknown, wanted: boolean, why: string, keys: readonly string[]): Obj | null => section(`secrets.${where}`, v, wanted, why, keys, problems)
  const formsO = group('forms', secretsO?.forms, true, 'for forms\' keys', ['dataKey', 'sealKey', 'sealCertChain'])
  const notifO = group('notifications', secretsO?.notifications, true, 'for the notifications key', ['vapidKey'])
  const callsS = group('calls', secretsO?.calls, on('calls'), 'where the calls switch is on', ['realtimeAppSecret', 'turnKeyToken'])
  const gmailS = group('gmail', secretsO?.gmail, on('gmail'), 'where the gmail switch is on', ['clientSecret'])
  const assistantS = group('assistant', secretsO?.assistant, on('assistant'), 'where the assistant switch is on', ['anthropicKey'])
  const hostedS = group('hostedMailboxes', secretsO?.hostedMailboxes, on('hostedMailboxes'), 'where the hostedMailboxes switch is on', ['keys', 'doorClientId', 'doorClientSecret'])
  let hostedKeys: Record<string, string> = {}
  if (hostedS) {
    if (!isObj(hostedS.keys)) problems.push('secrets.hostedMailboxes.keys: an object of sops names by the Worker secret name each declared mailbox gives')
    else {
      knownKeys('secrets.hostedMailboxes.keys', hostedS.keys, install.hostedMailboxes().map((m) => m.secret), problems)
      hostedKeys = {}
      for (const m of install.hostedMailboxes()) hostedKeys[m.secret] = sopsName('secrets.hostedMailboxes.keys', hostedS.keys, m.secret, problems)
    }
  }
  const secrets: InstallFile['secrets'] = {
    forms: formsO ? { dataKey: sopsName('secrets.forms', formsO, 'dataKey', problems), sealKey: sopsName('secrets.forms', formsO, 'sealKey', problems), sealCertChain: sopsName('secrets.forms', formsO, 'sealCertChain', problems) } : { dataKey: '', sealKey: '', sealCertChain: '' },
    notifications: { vapidKey: notifO ? sopsName('secrets.notifications', notifO, 'vapidKey', problems) : '' },
    ...(callsS ? { calls: { realtimeAppSecret: sopsName('secrets.calls', callsS, 'realtimeAppSecret', problems), turnKeyToken: sopsName('secrets.calls', callsS, 'turnKeyToken', problems) } } : {}),
    ...(gmailS ? { gmail: { clientSecret: sopsName('secrets.gmail', gmailS, 'clientSecret', problems) } } : {}),
    ...(assistantS ? { assistant: { anthropicKey: sopsName('secrets.assistant', assistantS, 'anthropicKey', problems) } } : {}),
    ...(hostedS ? { hostedMailboxes: { keys: hostedKeys, doorClientId: sopsName('secrets.hostedMailboxes', hostedS, 'doorClientId', problems), doorClientSecret: sopsName('secrets.hostedMailboxes', hostedS, 'doorClientSecret', problems) } } : {}),
  }

  if (problems.length > 0) throw new InstallFileError(problems)
  return {
    account,
    worker: worker as string,
    stores,
    ...(deliveryReports ? { deliveryReports } : {}),
    rateLimits,
    ...(calls ? { calls } : {}),
    ...(gmail ? { gmail } : {}),
    access,
    secrets,
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
