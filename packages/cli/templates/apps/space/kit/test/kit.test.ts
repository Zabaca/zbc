import { describe, expect, test } from 'bun:test'
import { createInstall } from '../../packages/workspace/src'
import { InstallFileError, parseInstallFile } from '../install-file'
import { buildSpaceInstall, type KitInstance } from '../instances'
import { northfieldInstall, northfieldInstallFile } from '../northfield'
import { NORTHFIELD_DECLARATION, NORTHFIELD_INSTALL_FILE } from '../../packages/workspace/northfield'

/**
 * THE INSTALL KIT'S PROOF. One function, `buildSpaceInstall`, turns an install's declaration and install file into the zbc instances of the space and the Worker's settings. What is held here is what a deploy
 * would APPLY for an invented company, never how the kit is arranged: a whole install, with a name of its own on every store and token; and an install file that does not fit its declaration refused, with
 * everything wrong named at once. A project that holds a real install pins its own output beside it.
 *
 * The kit is handed a project's zbc modules; these stand-ins make an instance that records what it was given.
 */
interface Made extends KitInstance {
  moduleName: string
  config: Record<string, unknown>
  imports: Made[]
  retain: boolean
}
const standIn = (moduleName: string) => ({
  instance: (options: { name: string; config: Record<string, unknown>; imports?: Made[]; retain?: boolean }): Made => ({ name: options.name, moduleName, config: options.config, imports: options.imports ?? [], retain: options.retain === true }),
})
const SPACE_MODULES = { worker: standIn('worker'), access: standIn('access'), queue: standIn('queue'), bucket: standIn('bucket'), database: standIn('database') }
/** Where an invented company's project keeps the space's code and its declaration, from its root. */
const BRIGHTWATER_PATHS = { worker: 'vendor/space/packages/space', formsMigrations: 'vendor/space/packages/forms/migrations', declaration: 'installs/brightwater/workspace.json' }
type SpaceInstance = Made

/** An invented company, sized like a client's: Brightwater Builders, an owner, one business and one shared address, with the switches given. */
function brightwater(over: Record<string, unknown> = {}) {
  return {
    company: { id: 'brightwater', name: 'Brightwater Builders', legalName: 'Brightwater Builders Inc.', domain: 'brightwater.test', timeZone: 'America/Chicago' },
    access: { teamDomain: 'brightwater.cloudflareaccess.com' },
    space: { host: 'space.brightwater.test', sessionDuration: '730h' },
    formsService: { contact: 'office@brightwater.test' },
    people: [{ address: 'sam@brightwater.test', name: 'Sam', role: 'owner' }],
    sharedAddresses: [],
    switches: { calls: true },
    ...over,
  }
}

const DOORS = { calls: { application: 'space.brightwater.test/r/*', policy: 'space.brightwater.test/r/* anyone (calls)' }, chat: { application: 'space.brightwater.test/w/*', policy: 'space.brightwater.test/w/* anyone (chat)' }, signing: { application: 'space.brightwater.test/s/*', policy: 'space.brightwater.test/s/* anyone (signers)' } }

function brightwaterFile(over: Record<string, unknown> = {}) {
  return {
    account: { id: '0000000000000000000000000000e001' },
    worker: 'brightwater-space',
    stores: { formsBucket: 'brightwater-forms-files', formsDatabase: 'brightwater-forms-records' },
    rateLimits: { public: '8101', auth: '8102' },
    calls: { realtimeAppId: '0123456789abcdef0123456789abcdef', turnKeyId: 'fedcba9876543210fedcba9876543210' },
    access: {
      space: { application: 'space.brightwater.test', policy: 'space.brightwater.test allowed people' },
      forms: { application: 'space.brightwater.test/forms', policy: 'space.brightwater.test/forms allowed people' },
      guests: DOORS,
    },
    secrets: {
      forms: { dataKey: 'BRIGHTWATER_FORMS_DATA_KEY', sealKey: 'BRIGHTWATER_FORMS_SEAL_KEY', sealCertChain: 'BRIGHTWATER_FORMS_SEAL_CERT_CHAIN' },
      calls: { realtimeAppSecret: 'BRIGHTWATER_REALTIME_SECRET', turnKeyToken: 'BRIGHTWATER_TURN_TOKEN' },
      notifications: { vapidKey: 'BRIGHTWATER_VAPID_KEY' },
    },
    ...over,
  }
}

/** The same company with everything on: Gmail, Claude's script, a business mailbox, the Clients door, the assistant, a mailbox on its own mail server, Telegram. */
function brightwaterEverything() {
  return {
    declaration: brightwater({
      gmailPush: { host: 'inbox-push.brightwater.test' },
      googleApp: { clientId: '123456789-abcdefghij.apps.googleusercontent.com', pushTopic: 'projects/brightwater-mail-1/topics/gmail-push' },
      hostedMailboxes: [{ address: 'desk@brightwater.test', name: 'Desk', door: 'https://jmap.brightwater.test', secret: 'INBOX_JMAP_DESK' }],
      cloudflareMailboxes: [{ address: 'hello@brightwaterco.test', name: 'Brightwater Co', spamCheck: true }],
      agent: { path: '/agent/inbox' },
      telegram: { path: '/agent/telegram' },
      clientsDoor: { path: '/agent/clients', source: 'brightwater.test' },
      businesses: [{ id: 'brightwater', name: 'Brightwater', mailboxes: ['hello@brightwaterco.test'] }],
      switches: { gmail: true, hostedMailboxes: true, clientDirectory: true, claudeScript: true, assistant: true, manyClients: true, calls: true, telegram: true },
    }),
    installFile: brightwaterFile({
      stores: { formsBucket: 'brightwater-forms-files', formsDatabase: 'brightwater-forms-records', rawMailBucket: 'brightwater-raw-mail', deliveryQueue: 'brightwater-delivery' },
      deliveryReports: [{ name: 'brightwaterco-sending', zoneId: '0000000000000000000000000000e002', domain: 'brightwaterco.test' }],
      gmail: { pushServiceAccount: 'inbox-push@brightwater-mail-1.iam.gserviceaccount.com' },
      access: {
        space: { application: 'space.brightwater.test', policy: 'space.brightwater.test allowed people' },
        forms: { application: 'space.brightwater.test/forms', policy: 'space.brightwater.test/forms allowed people' },
        agent: { application: 'space.brightwater.test/agent/inbox', token: 'brightwater inbox agent' },
        telegram: { application: 'space.brightwater.test/agent/telegram', token: 'brightwater bridge' },
        clients: { application: 'space.brightwater.test/agent/clients', token: 'brightwater clients' },
        guests: DOORS,
      },
      secrets: {
        forms: { dataKey: 'BRIGHTWATER_FORMS_DATA_KEY', sealKey: 'BRIGHTWATER_FORMS_SEAL_KEY', sealCertChain: 'BRIGHTWATER_FORMS_SEAL_CERT_CHAIN' },
        calls: { realtimeAppSecret: 'BRIGHTWATER_REALTIME_SECRET', turnKeyToken: 'BRIGHTWATER_TURN_TOKEN' },
        notifications: { vapidKey: 'BRIGHTWATER_VAPID_KEY' },
        gmail: { clientSecret: 'BRIGHTWATER_GOOGLE_SECRET' },
        assistant: { anthropicKey: 'BRIGHTWATER_ANTHROPIC_KEY' },
        hostedMailboxes: { keys: { INBOX_JMAP_DESK: 'BRIGHTWATER_JMAP_DESK' }, doorClientId: 'BRIGHTWATER_MAIL_DOOR_ID', doorClientSecret: 'BRIGHTWATER_MAIL_DOOR_SECRET' },
      },
    }),
  }
}

const problems = (raw: unknown, decl: unknown = brightwater()): string => {
  try {
    parseInstallFile(raw, createInstall(decl))
    return ''
  } catch (e) {
    if (e instanceof InstallFileError) return e.problems.join('\n')
    throw e
  }
}

describe('an invented company’s pair makes a whole install', () => {
  const sops: string[] = []

  test('a small one (the shape of a client with chat, Forms and Clients and no mail): the three Access applications for guests, the two for people, the Worker, and nothing for mail', () => {
    const made = buildSpaceInstall<SpaceInstance>({ declaration: brightwater(), installFile: brightwaterFile(), sopsNames: sops, modules: SPACE_MODULES, paths: BRIGHTWATER_PATHS })
    expect(made.all.map((i) => i.name)).toEqual(['forms-bucket', 'forms-database', 'space-access', 'space-forms-access', 'space-guest-calls', 'space-guest-chat', 'space-guest-signing', 'space'])
    expect(made.instances.rawMail).toBeUndefined()
    expect(made.instances.deliveryReports).toBeUndefined()
    expect(made.instances.agentAccess).toBeUndefined()
    const s = made.settings as Record<string, any>
    expect(s.name).toBe('brightwater-space')
    expect(s.routes).toEqual([{ pattern: 'space.brightwater.test', custom_domain: true }])
    expect(s.d1_databases).toEqual([{ binding: 'FORMS_DB', database_name: 'brightwater-forms-records', migrations_dir: '../forms/migrations' }])
    expect(s.r2_buckets).toEqual([{ binding: 'FORMS_FILES', bucket_name: 'brightwater-forms-files' }])
    expect(s.send_email).toEqual([{ name: 'EMAIL', allowed_sender_addresses: ['forms@brightwater.test', 'meet@brightwater.test'] }])
    expect(s.queues).toBeUndefined()
    expect(s.ai).toBeUndefined()
    expect(s.vars).toEqual({ REALTIME_APP_ID: '0123456789abcdef0123456789abcdef', TURN_KEY_ID: 'fedcba9876543210fedcba9876543210' })
    expect(s.ratelimits.map((r: { namespace_id: string }) => r.namespace_id)).toEqual(['8101', '8102'])
    // The stores are the code's, the same seven in every install, so no install holds another's.
    expect(s.exports && Object.keys(s.exports)).toEqual(['KnowledgeDO', 'RoomDO', 'WorkspaceDO', 'InboxDO', 'LiveDO', 'CalendarDO', 'ClientsDO'])
    expect(s.triggers).toEqual({ crons: ['*/5 * * * *', '47 9 * * *', '0 * * * *'] })
    const config = made.instances.space.config as { accountId: string; workerSecrets: unknown[]; workerVars: { name: string }[]; r2Buckets?: string[]; d1Databases?: unknown[] }
    expect(config.accountId).toBe('0000000000000000000000000000e001')
    // Each secret is pushed under the name the code reads, from the sops name the install file gives.
    expect(config.workerSecrets).toEqual([
      { name: 'FORMS_DATA_KEY', secret: 'BRIGHTWATER_FORMS_DATA_KEY' },
      { name: 'FORMS_SEAL_KEY', secret: 'BRIGHTWATER_FORMS_SEAL_KEY' },
      { name: 'FORMS_SEAL_CERT_CHAIN', secret: 'BRIGHTWATER_FORMS_SEAL_CERT_CHAIN' },
      { name: 'MEET_REALTIME_APP_SECRET', secret: 'BRIGHTWATER_REALTIME_SECRET' },
      { name: 'MEET_TURN_KEY_TOKEN', secret: 'BRIGHTWATER_TURN_TOKEN' },
      { name: 'INBOX_VAPID_KEY', secret: 'BRIGHTWATER_VAPID_KEY' },
    ])
    expect(config.workerVars.map((v) => v.name)).toEqual(['CF_ACCESS_AUD', 'CF_ACCESS_AUD_FORMS'])
    // Forms' bucket and database are instances of their own, which the Worker imports: the Worker's instance names neither.
    expect([config.r2Buckets, config.d1Databases]).toEqual([undefined, undefined])
    expect(made.instances.formsBucket.config).toEqual({ accountId: '0000000000000000000000000000e001', bucketName: 'brightwater-forms-files' })
    expect(made.instances.formsDatabase.config).toEqual({ accountId: '0000000000000000000000000000e001', databaseName: 'brightwater-forms-records', migrationsDir: 'vendor/space/packages/forms/migrations' })
    expect(made.instances.space.imports.map((i) => i.name).slice(0, 2)).toEqual(['forms-bucket', 'forms-database'])
  })

  test('one with everything on: every door, the raw-mail bucket and queue, the push host, the senders, the mailboxes and the secrets', () => {
    const { declaration, installFile } = brightwaterEverything()
    const made = buildSpaceInstall<SpaceInstance>({ declaration, installFile, sopsNames: sops, modules: SPACE_MODULES, paths: BRIGHTWATER_PATHS })
    expect(made.all.map((i) => i.name)).toEqual(['forms-bucket', 'forms-database', 'inbox-raw', 'inbox-delivery', 'space-access', 'space-forms-access', 'space-agent-access', 'space-telegram-access', 'space-clients-access', 'space-guest-calls', 'space-guest-chat', 'space-guest-signing', 'space'])
    const s = made.settings as Record<string, any>
    expect(s.routes).toEqual([
      { pattern: 'space.brightwater.test', custom_domain: true },
      { pattern: 'inbox-push.brightwater.test', custom_domain: true },
    ])
    expect(s.send_email[0].allowed_sender_addresses).toEqual(['forms@brightwater.test', 'meet@brightwater.test', 'hello@brightwaterco.test'])
    expect(s.queues).toEqual({ consumers: [{ queue: 'brightwater-delivery', max_batch_size: 10, max_batch_timeout: 5, max_retries: 3 }] })
    expect(s.r2_buckets).toEqual([
      { binding: 'FORMS_FILES', bucket_name: 'brightwater-forms-files' },
      { binding: 'RAW', bucket_name: 'brightwater-raw-mail' },
    ])
    expect(s.ai).toEqual({ binding: 'AI' })
    // The mailboxes the code reads as lists are the declaration's, with no copy to keep equal; and the calendar's push address is the push host and the calendar's own path.
    expect(s.vars.INBOX_MAILBOXES).toEqual([{ address: 'hello@brightwaterco.test', name: 'Brightwater Co', assistant: true }])
    expect(s.vars.INBOX_JMAP_MAILBOXES).toEqual([{ address: 'desk@brightwater.test', name: 'Desk', door: 'https://jmap.brightwater.test', secret: 'INBOX_JMAP_DESK' }])
    expect(s.vars.CALENDAR_PUSH_URL).toBe('https://inbox-push.brightwater.test/calendar/push')
    const space = made.instances.space.config as { workerSecrets: (string | { name: string; secret: string })[]; workerVars: { name: string; value?: string; from?: string }[] }
    expect(space.workerSecrets).toContainEqual({ name: 'INBOX_GOOGLE_CLIENT_SECRET', secret: 'BRIGHTWATER_GOOGLE_SECRET' })
    expect(space.workerSecrets).toContainEqual({ name: 'ANTHROPIC_API_KEY', secret: 'BRIGHTWATER_ANTHROPIC_KEY' })
    expect(space.workerSecrets).toContainEqual({ name: 'INBOX_JMAP_DESK', secret: 'BRIGHTWATER_JMAP_DESK' })
    expect(space.workerSecrets).toContainEqual({ name: 'JMAP_ACCESS_CLIENT_ID', secret: 'BRIGHTWATER_MAIL_DOOR_ID' })
    expect(space.workerVars).toContainEqual({ name: 'GMAIL_PUSH_ENDPOINT', value: 'https://inbox-push.brightwater.test/api/gmail/push' })
    expect(space.workerVars).toContainEqual({ name: 'GMAIL_PUSH_SERVICE_ACCOUNT', value: 'inbox-push@brightwater-mail-1.iam.gserviceaccount.com' })
    expect(space.workerVars).toContainEqual({ name: 'GMAIL_TOPIC_NAME', value: 'projects/brightwater-mail-1/topics/gmail-push' })
    // The doors' token names are the install file's, each machine its own, found by name and never rotated from here.
    for (const [instance, token] of [['agentAccess', 'brightwater inbox agent'], ['telegramAccess', 'brightwater bridge'], ['clientsAccess', 'brightwater clients']] as const) {
      const c = made.instances[instance]?.config as { serviceTokenName: string; rotate: boolean; emails: string[]; sessionDuration: string }
      expect([c.serviceTokenName, c.rotate, c.emails, c.sessionDuration]).toEqual([token, false, [], '0s'])
    }
    // The queue and its consumer are one name, from one file, and its subscriptions are on the mailboxes' sending domains.
    expect((made.instances.deliveryReports?.config as { queueName: string }).queueName).toBe('brightwater-delivery')
    expect((made.instances.rawMail?.config as { bucketName: string }).bucketName).toBe('brightwater-raw-mail')
  })

  test('nothing of the bundled invented company’s is in either: no name, no address, no id, no account', () => {
    for (const pair of [
      { declaration: brightwater(), installFile: brightwaterFile() },
      brightwaterEverything(),
    ]) {
      const made = buildSpaceInstall<SpaceInstance>({ ...pair, sopsNames: sops, modules: SPACE_MODULES, paths: BRIGHTWATER_PATHS })
      const everything = JSON.stringify({ settings: made.settings, instances: made.all.map((i) => ({ name: i.name, config: i.config })) })
      expect(everything).not.toMatch(/northfield|tessa|ridgeway|shiftlantern|quill|harborline/i)
      expect(everything).not.toContain(northfieldInstallFile.account.id)
    }
  })

  test('the phone’s four secrets are pushed when the phone is on and sops holds all four, and never otherwise', () => {
    const phone = brightwater({ phone: { people: { 'sam@brightwater.test': { emergencyNumber: 'line' } } }, switches: { calls: true, phone: true } })
    const four = ['TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_NUMBER']
    const pushed = (names: string[], d: unknown) => (buildSpaceInstall<SpaceInstance>({ declaration: d, installFile: brightwaterFile(), sopsNames: names, modules: SPACE_MODULES, paths: BRIGHTWATER_PATHS }).instances.space.config as { workerSecrets: string[] }).workerSecrets.filter((s) => typeof s === 'string' && s.startsWith('TELNYX_'))
    expect(pushed(four, phone)).toEqual(four)
    expect(pushed([], phone)).toEqual([])
    expect(pushed(four, brightwater())).toEqual([])
    expect(() => pushed(['TELNYX_API_KEY'], phone)).toThrow(/some of the phone's Telnyx secrets/)
  })

  test('a build is for the declaration its project names and for no other: the deploy’s build command says which, as a path from where the build runs', () => {
    const own = buildSpaceInstall<SpaceInstance>({ declaration: brightwater(), installFile: brightwaterFile(), sopsNames: sops, modules: SPACE_MODULES, paths: BRIGHTWATER_PATHS })
    expect((own.instances.space.config as { workdir: string; build: { command: string } }).workdir).toBe('vendor/space/packages/space')
    expect((own.instances.space.config as { build: { command: string } }).build.command).toBe("env SPACE_DECLARATION='../../../../installs/brightwater/workspace.json' bun run build")
    const beside = buildSpaceInstall<SpaceInstance>({ declaration: brightwater(), installFile: brightwaterFile(), sopsNames: sops, modules: SPACE_MODULES, paths: { ...BRIGHTWATER_PATHS, worker: 'space/packages/space', declaration: 'space/workspace.json' } })
    expect((beside.instances.space.config as { build: { command: string } }).build.command).toBe("env SPACE_DECLARATION='../../workspace.json' bun run build")
  })
})

describe('an install file that does not fit its declaration is refused, with everything wrong named at once', () => {
  test('whole, it is accepted: the bundled invented company’s and the ones made up here', () => {
    expect(problems(NORTHFIELD_INSTALL_FILE, NORTHFIELD_DECLARATION)).toBe('')
    expect(northfieldInstall.company.name).toBe('Northfield Works')
    expect(problems(brightwaterFile())).toBe('')
    const { declaration: d, installFile: f } = brightwaterEverything()
    expect(problems(f, d)).toBe('')
  })

  test('a feature that is on with no names for what it is made of is refused: calls, Gmail, the assistant, the mail server, the doors and business mail', () => {
    const { declaration: d, installFile: f } = brightwaterEverything()
    const bare = structuredClone(f) as Record<string, any>
    delete bare.calls
    delete bare.gmail
    delete bare.secrets.calls
    delete bare.secrets.gmail
    delete bare.secrets.assistant
    delete bare.secrets.hostedMailboxes
    delete bare.access.agent
    delete bare.access.telegram
    delete bare.access.clients
    delete bare.access.guests.calls
    delete bare.deliveryReports
    delete bare.stores.rawMailBucket
    delete bare.stores.deliveryQueue
    const said = problems(bare, d)
    for (const want of ['calls: required', 'gmail: required', 'secrets.calls: required', 'secrets.gmail: required', 'secrets.assistant: required', 'secrets.hostedMailboxes: required', 'access.agent: required', 'access.telegram: required', 'access.clients: required', 'access.guests.calls: required', 'deliveryReports: a list', 'stores.rawMailBucket', 'stores.deliveryQueue']) {
      expect(said, want).toContain(want)
    }
  })

  test('and a part for a feature that is off is refused, so a stale name never lingers', () => {
    const f = brightwaterFile({ gmail: { pushServiceAccount: 'inbox-push@brightwater-mail-1.iam.gserviceaccount.com' }, deliveryReports: [], access: { ...brightwaterFile().access, agent: { application: 'a', token: 't' } } })
    const said = problems(f)
    expect(said).toContain('gmail: only where the gmail switch is on')
    expect(said).toContain('deliveryReports: only where the declaration lists a business mailbox')
    expect(said).toContain('access.agent: only where the declaration gives Claude')
  })

  test('each machine door has a token of its own, no two applications share a name, and the two rate limits are two', () => {
    const { declaration: d, installFile: f } = brightwaterEverything()
    const shared = structuredClone(f) as Record<string, any>
    shared.access.telegram.token = shared.access.agent.token
    shared.access.telegram.application = shared.access.agent.application
    shared.rateLimits.auth = shared.rateLimits.public
    const said = problems(shared, d)
    expect(said).toContain('each machine door has a token of its own')
    expect(said).toContain('two applications have the same name')
    expect(said).toContain('the two limits need two namespace ids')
  })

  test('every business mailbox’s sending domain has a delivery-report subscription, or its reports would never arrive', () => {
    const { declaration: d, installFile: f } = brightwaterEverything()
    const wrong = structuredClone(f) as Record<string, any>
    wrong.deliveryReports[0].domain = 'elsewhere.test'
    expect(problems(wrong, d)).toContain('hello@brightwaterco.test sends from brightwaterco.test, which has no subscription')
  })

  test('shapes are checked: an account id, a Worker name, a bucket, a namespace, a service account, a sops name, an unknown field and a missing key', () => {
    const { declaration: d, installFile: f } = brightwaterEverything()
    const bad = structuredClone(f) as Record<string, any>
    bad.account.id = 'nope'
    bad.worker = 'Bad Name'
    bad.stores.formsBucket = 'X'
    bad.rateLimits.public = 'abc'
    bad.gmail.pushServiceAccount = 'someone@example.com'
    bad.secrets.forms.dataKey = 'lower_case'
    bad.extra = 1
    delete bad.secrets.notifications.vapidKey
    const said = problems(bad, d)
    for (const want of ['account.id:', 'worker:', 'stores.formsBucket', 'rateLimits.public', 'gmail.pushServiceAccount', 'secrets.forms.dataKey', 'unknown field "extra"', 'secrets.notifications.vapidKey']) expect(said, want).toContain(want)
    expect(() => parseInstallFile('x', createInstall(brightwater()))).toThrow('not an object')
  })

  test('the keys held for the mail server are the declared mailboxes’ secrets and no others', () => {
    const { declaration: d, installFile: f } = brightwaterEverything()
    const wrong = structuredClone(f) as Record<string, any>
    wrong.secrets.hostedMailboxes.keys = { OTHER_NAME: 'BRIGHTWATER_JMAP_DESK' }
    const said = problems(wrong, d)
    expect(said).toContain('unknown field "OTHER_NAME"')
    expect(said).toContain('INBOX_JMAP_DESK')
  })
})
