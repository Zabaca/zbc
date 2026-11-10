import { describe, expect, test } from 'bun:test'
import { createInstall, DeclarationError, parseDeclaration, SWITCH_DEFAULTS, SWITCHES } from '../src'
import { PINECREST_FILE, readJson, NORTHFIELD_FILE } from './helpers'

const lane = () => structuredClone(readJson(PINECREST_FILE)) as Record<string, any>

function problems(raw: unknown): string[] {
  try {
    parseDeclaration(raw)
  } catch (e) {
    if (e instanceof DeclarationError) return e.problems
    throw e
  }
  return []
}

describe('a declaration', () => {
  test('a whole one parses, with every switch off unless named', () => {
    const d = parseDeclaration(lane())
    expect(d.company.name).toBe('Pinecrest Test')
    expect(d.switches).toEqual(SWITCH_DEFAULTS)
    expect(Object.values(d.switches).every((v) => v === false)).toBe(true)
  })

  test('a person has a mail name only when one is declared: one plain line, nothing that could end a header', () => {
    const raw = lane()
    expect(parseDeclaration(raw).people[0]).not.toHaveProperty('mailName')
    raw.people[0].mailName = '  Lane Fong  '
    expect(parseDeclaration(raw).people[0]?.mailName).toBe('Lane Fong')
    for (const bad of ['', '   ', 'Lane <lane@x.test>', 'Lane "the boss"', 'Lane\r\nBcc: x@y.test', 'x'.repeat(81), 7]) {
      const r = lane()
      r.people[0].mailName = bad
      expect(problems(r), String(bad)).toEqual([expect.stringContaining('people[0].mailName')])
    }
  })

  test('a person signs in at the work address unless another is declared', () => {
    const d = parseDeclaration(lane())
    expect(d.people.map((p) => [p.address, p.signIn])).toEqual([
      ['lane@pinecrest.test', 'lane@pinecrest.test'],
      ['corin@pinecrest.test', 'corin.private@example.com'],
      ['dana@pinecrest.test', 'dana@pinecrest.test'],
    ])
  })

  test('addresses are lowercased', () => {
    const raw = lane()
    raw.people[0].address = 'Lane@Pinecrest.test'
    expect(parseDeclaration(raw).people[0]?.address).toBe('lane@pinecrest.test')
  })

  test('every problem is named at once', () => {
    const raw = lane()
    raw.company.domain = 'not a domain'
    raw.access.teamDomain = 'northfield.example'
    raw.forms = { sessionDuration: 'a day' }
    raw.people = [{ address: 'x', name: 'X', role: 'boss' }]
    raw.bogus = 1
    const found = problems(raw)
    expect(found.length).toBeGreaterThanOrEqual(5)
    expect(found.join('\n')).toContain('company.domain')
    expect(found.join('\n')).toContain('access.teamDomain')
    expect(found.join('\n')).toContain('forms.sessionDuration')
    expect(found.join('\n')).toContain('unknown field "bogus"')
  })

  test('there must be an owner', () => {
    const raw = lane()
    raw.people = raw.people.filter((p: any) => p.role !== 'owner')
    expect(problems(raw).join()).toContain('at least one owner')
  })

  test('two people cannot share a sign-in address, nor be listed twice', () => {
    const raw = lane()
    raw.people[2].signIn = 'corin.private@example.com'
    expect(problems(raw).join()).toContain('belongs to two people')
    const twice = lane()
    twice.people.push({ ...twice.people[0] })
    expect(problems(twice).join()).toContain('listed twice')
  })

  test('the push address must be under the company domain and a name of its own, apart from the space’s', () => {
    const northfieldRaw = () => structuredClone(readJson(NORTHFIELD_FILE)) as Record<string, any>
    const raw = northfieldRaw()
    raw.gmailPush.host = 'inbox.example.com'
    expect(problems(raw).join()).toContain('is not under northfield.example')
    const same = northfieldRaw()
    same.gmailPush.host = same.space.host
    expect(problems(same).join()).toContain('apart from the space')
  })

  test('the space has an address under the company domain, a sign-in length, and a host of its own', () => {
    const gone = lane()
    delete gone.space
    expect(problems(gone).join()).toContain('space: missing')
    const outside = lane()
    outside.space.host = 'space.northfield.example'
    expect(problems(outside).join()).toContain('is not under pinecrest.test')
    for (const sessionDuration of [undefined, '', 'a month', '0h', 730]) {
      const raw = lane()
      raw.space.sessionDuration = sessionDuration
      expect([sessionDuration, problems(raw).join().includes('space.sessionDuration')]).toEqual([sessionDuration, true])
    }
    // The space has no door to declare: the whole host is behind the sign-in, and nothing on it is public.
    const door = lane()
    door.space.door = '/start'
    expect(problems(door).join()).toContain('unknown field "door"')
  })

  test('Forms’ sign-in is a day unless declared, and is a duration', () => {
    expect(parseDeclaration(lane()).forms).toEqual({ sessionDuration: '24h' })
    const week = lane()
    week.forms = { sessionDuration: '168h' }
    expect(parseDeclaration(week).forms).toEqual({ sessionDuration: '168h' })
    for (const sessionDuration of ['a day', '0h', 24, '']) {
      const raw = lane()
      raw.forms = { sessionDuration }
      expect([sessionDuration, problems(raw).join().includes('forms.sessionDuration')]).toEqual([sessionDuration, true])
    }
    const extra = lane()
    extra.forms = { host: 'forms.pinecrest.test' }
    expect(problems(extra).join()).toContain('forms: unknown field "host"')
  })

  test('the senders are the company’s forms@ and meet@ unless declared, on the company’s own domain, and one address each', () => {
    expect(parseDeclaration(lane()).senders).toEqual({ forms: 'forms@pinecrest.test', meet: 'meet@pinecrest.test' })
    const own = lane()
    own.senders = { forms: 'Signing@Pinecrest.test' }
    expect(parseDeclaration(own).senders).toEqual({ forms: 'signing@pinecrest.test', meet: 'meet@pinecrest.test' })
    const bad = (senders: unknown) => {
      const raw = lane()
      raw.senders = senders
      return problems(raw).join()
    }
    expect(bad({ forms: 'forms@northfield.example' })).toContain('senders.forms: forms@northfield.example is not on pinecrest.test')
    expect(bad({ meet: 'not an address' })).toContain('senders.meet: an address is required')
    expect(bad({ forms: 'one@pinecrest.test', meet: 'one@pinecrest.test' })).toContain('each send from an address of their own')
    expect(bad({ mail: 'x@pinecrest.test' })).toContain('senders: unknown field "mail"')
    expect(bad('forms@pinecrest.test')).toContain('senders: an object')
    const install = createInstall(own)
    expect([install.sender('forms'), install.sender('meet')]).toEqual(['signing@pinecrest.test', 'meet@pinecrest.test'])
  })

  test('a company may declare the name the law knows it by, one plain line, which a legal record names it as', () => {
    expect(parseDeclaration(lane()).company).not.toHaveProperty('legalName')
    const raw = lane()
    raw.company.legalName = '  Pinecrest Test LLC  '
    expect(parseDeclaration(raw).company.legalName).toBe('Pinecrest Test LLC')
    for (const bad of ['', '  ', 'Two\nLines', 7]) {
      const r = lane()
      r.company.legalName = bad
      expect(problems(r).join(), String(bad)).toContain('company.legalName')
    }
  })

  test('the signing service is "<company> Forms", run by the company unless declared, and always names the address a person writes to; a company whose Forms another company runs declares who, and where', () => {
    const quiet = createInstall(lane()).formsService()
    expect(quiet).toEqual({ name: 'Pinecrest Test Forms', contact: 'info@pinecrest.test', runBy: { name: 'Pinecrest Test', legalName: 'Pinecrest Test', mailingLine: '', site: 'pinecrest.test' } })
    const raw = lane()
    raw.formsService = { name: 'Acme Forms', contact: 'Help@Acme.test', runBy: { name: 'Acme', legalName: 'Acme LLC', mailingLine: 'Alder Bend, Oregon', site: 'acme.test' } }
    expect(createInstall(raw).formsService()).toEqual({ name: 'Acme Forms', contact: 'help@acme.test', runBy: { name: 'Acme', legalName: 'Acme LLC', mailingLine: 'Alder Bend, Oregon', site: 'acme.test' } })
    // The legal name defaults to the short one, and the short one to the company.
    const named = lane()
    named.formsService = { contact: 'info@pinecrest.test', runBy: { name: 'Acme' } }
    expect(createInstall(named).formsService().runBy).toEqual({ name: 'Acme', legalName: 'Acme', mailingLine: '', site: 'pinecrest.test' })
    const bad = (formsService: unknown) => {
      const r = lane()
      r.formsService = formsService
      return problems(r).join()
    }
    // The contact is published and is a decision of the install: never taken from the owner's own address, so a declaration without one is refused, whether it says nothing of the service or only part of it.
    const noContact = lane()
    delete noContact.formsService
    expect(problems(noContact).join()).toContain('formsService.contact: required')
    expect(bad({ name: 'Acme Forms' })).toContain('formsService.contact: required')
    expect(bad({ name: 'Two\nLines' })).toContain('formsService.name')
    expect(bad({ name: 'x'.repeat(81) })).toContain('formsService.name')
    expect(bad({ contact: 'nope' })).toContain('formsService.contact')
    expect(bad({ runBy: { site: 'not a domain' } })).toContain('formsService.runBy.site')
    expect(bad({ runBy: { legalName: '' } })).toContain('formsService.runBy.legalName')
    // A parsed declaration parses again (an empty mailing line is none).
    expect(createInstall(createInstall(lane()).declaration).formsService()).toEqual(quiet)
    expect(bad({ runBy: { phone: '1' } })).toContain('formsService.runBy: unknown field "phone"')
    expect(bad({ owner: 'x' })).toContain('formsService: unknown field "owner"')
    expect(bad('Acme Forms')).toContain('formsService: an object')
  })

  test('a service that sends only for its own company says so with `ownCompanyOnly`, which is absent unless true, is run by the company, and parses again', () => {
    const declared = (formsService: Record<string, unknown>) => {
      const r = lane()
      r.formsService = { contact: 'info@pinecrest.test', ...formsService }
      return r
    }
    // Absent, false and left-out are the same service, with no key in what a declaration reads back (every pinned install's words stay as they were).
    const quiet = createInstall(lane()).formsService()
    expect('ownCompanyOnly' in quiet).toBe(false)
    expect('ownCompanyOnly' in createInstall(declared({ ownCompanyOnly: false })).formsService()).toBe(false)
    const own = createInstall(declared({ ownCompanyOnly: true })).formsService()
    expect(own).toEqual({ ...quiet, ownCompanyOnly: true })
    expect(createInstall(createInstall(declared({ ownCompanyOnly: true })).declaration).formsService()).toEqual(own)
    // The company runs it, by its name and by its legal name: left out (or named without a legal name) it is the company in full, and either name being another's is refused.
    expect(problems(declared({ ownCompanyOnly: true, runBy: { name: 'Pinecrest Test', legalName: 'Pinecrest Test' } }))).toEqual([])
    expect(problems(declared({ ownCompanyOnly: true, runBy: { name: 'Pinecrest Test' } }))).toEqual([])
    const refused = 'formsService.ownCompanyOnly: the company must be who runs the service'
    expect(problems(declared({ ownCompanyOnly: true, runBy: { name: 'Acme', legalName: 'Acme LLC' } })).join()).toContain(refused)
    expect(problems(declared({ ownCompanyOnly: true, runBy: { name: 'Pinecrest Test', legalName: 'Northfield Works LLC' } })).join()).toContain(refused)
    expect(problems(declared({ ownCompanyOnly: true, runBy: { name: 'Northfield Works', legalName: 'Pinecrest Test' } })).join()).toContain(refused)
    // With a legal name of its own, the company's legal name is the runner's, left out or said; Northfield's name on it is refused.
    const inc = (formsService: Record<string, unknown>) => {
      const r = declared(formsService)
      ;(r.company as Record<string, unknown>).legalName = 'Pinecrest Roofing Inc.'
      return r
    }
    expect(createInstall(inc({ ownCompanyOnly: true })).formsService().runBy.legalName).toBe('Pinecrest Roofing Inc.')
    expect(problems(inc({ ownCompanyOnly: true, runBy: { name: 'Pinecrest Test', legalName: 'Pinecrest Roofing Inc.' } }))).toEqual([])
    expect(problems(inc({ ownCompanyOnly: true, runBy: { legalName: 'Northfield Works LLC' } })).join()).toContain(refused)
    expect(problems(inc({ ownCompanyOnly: true, runBy: { name: 'Pinecrest Test', legalName: 'Northfield Works LLC' } })).join()).toContain(refused)
    // Its site is the company's domain, said or left out; another company's site is refused.
    expect(problems(declared({ ownCompanyOnly: true, runBy: { site: 'pinecrest.test' } }))).toEqual([])
    expect(problems(declared({ ownCompanyOnly: true, runBy: { site: 'northfield.example' } })).join()).toContain(refused)
    // Another company running it with the flag left false is a service that has a second party, as before.
    expect(problems(declared({ runBy: { name: 'Acme', legalName: 'Acme LLC' } }))).toEqual([])
    for (const v of ['yes', 1, null]) expect(problems(declared({ ownCompanyOnly: v })).join(), String(v)).toContain('formsService.ownCompanyOnly: true or false')
  })

  test('the declaration has no apps: the four of them are the one Worker', () => {
    const raw = lane()
    raw.apps = { meet: { host: 'meet.pinecrest.test' } }
    expect(problems(raw).join()).toContain('unknown field "apps"')
  })

  test('a declaration that lists no businesses has one, the company itself, with no mailboxes', () => {
    expect(parseDeclaration(lane()).businesses).toEqual([{ id: 'pinecrest-test', name: 'Pinecrest Test', mailboxes: [] }])
    const empty = lane()
    empty.businesses = []
    expect(parseDeclaration(empty).businesses.map((b) => b.id)).toEqual(['pinecrest-test'])
  })

  test('businesses carry an id, a name and the mailbox addresses that draft for them, lowercased', () => {
    const raw = lane()
    raw.businesses = [
      { id: 'main', name: 'Main', mailboxes: ['Info@Brand.test'] },
      { id: 'side', name: 'Side' },
    ]
    expect(parseDeclaration(raw).businesses).toEqual([
      { id: 'main', name: 'Main', mailboxes: ['info@brand.test'] },
      { id: 'side', name: 'Side', mailboxes: [] },
    ])
  })

  test('every problem with the businesses is named: ids, names, addresses, and an address in two businesses', () => {
    const raw = lane()
    raw.businesses = [
      { id: 'a', name: 'A', mailboxes: ['x@brand.test', 'x@brand.test', 'not an address'] },
      { id: 'a', name: '  ' },
      { id: 'Bad Id', name: 'B', mailboxes: ['x@brand.test'], extra: 1 },
      'text',
    ]
    const found = problems(raw).join('\n')
    expect(found).toContain('businesses[0].mailboxes: x@brand.test is listed twice')
    expect(found).toContain('businesses[0].mailboxes: "not an address" is not an address')
    expect(found).toContain('businesses[1].id: "a" is listed twice')
    expect(found).toContain('businesses[1].name: required')
    expect(found).toContain('businesses[2].id: a lowercase slug')
    expect(found).toContain("businesses[2].mailboxes: x@brand.test is already another business's mailbox")
    expect(found).toContain('businesses[2]: unknown field "extra"')
    expect(found).toContain('businesses[3]: an object is required')
    const notAList = lane()
    notAList.businesses = { a: 1 }
    expect(problems(notAList).join()).toContain('businesses: a list')
  })

  test('a person can only be on a declared shared address', () => {
    const raw = lane()
    raw.people[1].sharedAddresses = ['sales@pinecrest.test']
    expect(problems(raw).join()).toContain('not a declared shared address')
  })

  test("a sign-in address cannot be another person's work address", () => {
    const raw = lane()
    raw.people[1].signIn = 'dana@pinecrest.test' // Corin signs in as Dana's address
    expect(problems(raw).join()).toContain("another person's")
    const reverse = lane()
    reverse.people[2].address = 'corin.private@example.com' // Dana's name collides with Corin's sign-in
    expect(problems(reverse).join()).toContain("another person's sign-in address")
    // A person who signs in at their own work address is still fine.
    const own = lane()
    own.people[1].signIn = 'corin@pinecrest.test'
    expect(problems(own)).toEqual([])
  })

  test('an unknown switch is refused', () => {
    const raw = lane()
    raw.switches = { teleport: true }
    expect(problems(raw).join()).toContain('unknown field "teleport"')
  })

  test('a mail name has no comma or semicolon either: it goes into a header that a list separator would split', () => {
    for (const bad of ['Lane, Fong', 'Lane; Fong', 'Fong, Lane <x@y.test>']) {
      const raw = lane()
      raw.people[0].mailName = bad
      expect(problems(raw), bad).toEqual([expect.stringContaining('people[0].mailName')])
    }
  })
})

/**
 * Every feature is a switch any install may turn on: no company is the operator's, no switch is anyone's alone, and a switch is allowed exactly
 * where the declaration gives the settings it needs. These run on an invented company, which is not Northfield Works and says nothing of Northfield's.
 */
describe('a switch is allowed to any install that declares what it needs, and refused without it', () => {
  /** An invented company with every switch on and every setting a switch needs, none of it Northfield's. */
  const everything = () => {
    const raw = lane()
    raw.gmailPush = { host: 'inbox-push.pinecrest.test' }
    raw.googleApp = { clientId: '123456789-abcdefghij.apps.googleusercontent.com', pushTopic: 'projects/pinecrest-mail-1/topics/gmail-push' }
    raw.hostedMailboxes = [{ address: 'desk@pinecrest.test', name: 'Desk', door: 'https://jmap.pinecrest.test', secret: 'INBOX_JMAP_DESK' }]
    raw.phone = { people: { 'lane@pinecrest.test': { emergencyNumber: 'line' }, 'dana@pinecrest.test': { emergencyNumber: '+16265550123' } } }
    raw.agent = { path: '/agent/inbox' }
    raw.telegram = { path: '/agent/telegram' }
    raw.clientsDoor = { path: '/agent/clients', source: 'pinecrest.test' }
    raw.businesses = [{ id: 'lane', name: 'Pinecrest', mailboxes: ['info@pinecrest.test'] }]
    raw.switches = Object.fromEntries(SWITCHES.map((s) => [s, true]))
    return raw
  }

  test('an invented company may turn every switch on, with no claim to be anyone’s own company', () => {
    const install = createInstall(everything())
    for (const sw of SWITCHES) expect([sw, install.has(sw)]).toEqual([sw, true])
    expect(install.company).not.toHaveProperty('own')
    expect(install.googleApp()).toEqual({ clientId: '123456789-abcdefghij.apps.googleusercontent.com', pushTopic: 'projects/pinecrest-mail-1/topics/gmail-push' })
    expect(install.hostedMailboxes().map((m) => m.address)).toEqual(['desk@pinecrest.test'])
    expect(Object.keys(install.phonePeople())).toEqual(['lane@pinecrest.test', 'dana@pinecrest.test'])
  })

  test('the old claim is refused for what it is: company.own is not a field any more', () => {
    const raw = lane()
    raw.company.own = true
    expect(problems(raw).join()).toContain('unknown field "own"')
  })

  test('each switch is refused without the settings it needs, and names what is missing', () => {
    const needs: Record<string, [string[], string]> = {
      gmail: [['gmailPush', 'googleApp'], 'gmailPush: the gmail switch is on'],
      hostedMailboxes: [['hostedMailboxes'], 'hostedMailboxes: the hostedMailboxes switch is on'],
      phone: [['phone'], 'phone: the phone switch is on'],
      claudeScript: [['agent'], 'agent: the claudeScript switch is on'],
      telegram: [['telegram'], 'telegram: the telegram switch is on'],
      clientDirectory: [['clientsDoor'], 'clientsDoor: the clientDirectory switch is on'],
    }
    for (const [sw, [settings, say]] of Object.entries(needs)) {
      const raw = everything()
      for (const key of settings) delete raw[key]
      expect([sw, problems(raw).join('\n').includes(say)]).toEqual([sw, true])
    }
    // Gmail without its own Google app is refused even with a push host, and the other way round.
    const noApp = everything()
    delete noApp.googleApp
    expect(problems(noApp).join()).toContain('googleApp: the gmail switch is on')
    const noHost = everything()
    delete noHost.gmailPush
    expect(problems(noHost).join()).toContain('gmailPush: the gmail switch is on')
    // The assistant drafts for a business's mailbox, so it needs one.
    const noMailbox = everything()
    noMailbox.businesses = [{ id: 'lane', name: 'Pinecrest', mailboxes: [] }]
    expect(problems(noMailbox).join()).toContain('switches.assistant')
  })

  test('calls and manyClients need nothing of the declaration: on in an install that says nothing else', () => {
    const raw = lane()
    raw.switches = { calls: true, manyClients: true }
    expect(problems(raw)).toEqual([])
    expect(createInstall(raw).has('calls')).toBe(true)
  })

  test('a setting is refused where its switch is off, so a declaration says exactly what it runs', () => {
    for (const [key, say] of [
      ['gmailPush', 'gmailPush: only where the gmail switch is on'],
      ['googleApp', 'googleApp: only where the gmail switch is on'],
      ['hostedMailboxes', 'hostedMailboxes: only where the hostedMailboxes switch is on'],
      ['phone', 'phone: only where the phone switch is on'],
    ] as const) {
      const raw = everything()
      raw.switches = {}
      raw.businesses = []
      expect([key, problems(raw).join('\n').includes(say)]).toEqual([key, true])
    }
  })

  test('the settings are checked, not only present: a Google app that is not one, a door that is not https, a phone person who is nobody here', () => {
    const app = everything()
    app.googleApp = { clientId: 'client-id', pushTopic: 'inbox-gmail' }
    expect(problems(app).join('\n')).toContain('googleApp.clientId')
    expect(problems(app).join('\n')).toContain('googleApp.pushTopic')
    const door = everything()
    door.hostedMailboxes[0].door = 'http://jmap.pinecrest.test/path'
    expect(problems(door).join()).toContain('hostedMailboxes[0].door')
    const secret = everything()
    secret.hostedMailboxes[0].secret = 'the-actual-key'
    expect(problems(secret).join()).toContain('hostedMailboxes[0].secret')
    const twice = everything()
    twice.hostedMailboxes.push({ ...twice.hostedMailboxes[0] })
    expect(problems(twice).join()).toContain('listed twice')
    const nobody = everything()
    nobody.phone.people['ghost@pinecrest.test'] = { emergencyNumber: '+16265550199' }
    expect(problems(nobody).join()).toContain('not a person of this install')
    const two = everything()
    two.phone.people['dana@pinecrest.test'] = { emergencyNumber: 'line' }
    expect(problems(two).join()).toContain('one person only may use "line"')
    const bad = everything()
    bad.phone.people['dana@pinecrest.test'] = { emergencyNumber: '626-555-0123' }
    expect(problems(bad).join()).toContain('emergencyNumber')
    const empty = everything()
    empty.phone = { people: {} }
    expect(problems(empty).join()).toContain('phone.people')
  })

  test('the settings are copies: changing what an install answers changes nothing', () => {
    const install = createInstall(everything())
    install.hostedMailboxes()[0]!.door = 'https://elsewhere.test'
    install.phonePeople()['lane@pinecrest.test']!.emergencyNumber = '+16265550190'
    ;(install.googleApp() as { clientId: string }).clientId = 'x'
    expect(install.hostedMailboxes()[0]?.door).toBe('https://jmap.pinecrest.test')
    expect(install.phonePeople()['lane@pinecrest.test']?.emergencyNumber).toBe('line')
    expect(install.googleApp()?.clientId).toBe('123456789-abcdefghij.apps.googleusercontent.com')
  })
})

describe('Gmail’s push address and Claude’s door', () => {
  const northfieldRaw = () => structuredClone(readJson(NORTHFIELD_FILE)) as Record<string, any>

  test('Northfield Works has both: the machine host Google delivers to, and the path Claude is let in on', () => {
    const d = parseDeclaration(northfieldRaw())
    expect(d.gmailPush).toEqual({ host: 'inbox-push.northfield.example' })
    expect(d.agent).toEqual({ path: '/agent/inbox' })
  })

  test('a client has neither, and cannot be given them without the switch', () => {
    const d = parseDeclaration(lane())
    expect(d).not.toHaveProperty('gmailPush')
    expect(d).not.toHaveProperty('agent')
    const push = lane()
    push.gmailPush = { host: 'inbox-push.pinecrest.test' }
    expect(problems(push).join()).toContain('gmailPush: only where the gmail switch is on')
    const app = lane()
    app.googleApp = { clientId: '1-a.apps.googleusercontent.com', pushTopic: 'projects/abcdef/topics/abc' }
    expect(problems(app).join()).toContain('googleApp: only where the gmail switch is on')
    const agent = lane()
    agent.agent = { path: '/agent/inbox' }
    expect(problems(agent).join()).toContain('agent: the claudeScript switch must be on')
  })

  test('the gmail switch needs the address Google delivers to, and the push address needs a hostname', () => {
    const none = northfieldRaw()
    delete none.gmailPush
    expect(problems(none).join()).toContain('gmailPush: the gmail switch is on')
    for (const host of ['', 7, 'not a host']) {
      const raw = northfieldRaw()
      raw.gmailPush = { host }
      expect([host, problems(raw).join().includes('gmailPush.host')]).toEqual([host, true])
    }
  })

  test('the agent needs a path of the space; the name of its token is the install file’s, so a declaration that still carries one is refused', () => {
    const raw = northfieldRaw()
    raw.agent.serviceToken = 'northfield-web inbox agent'
    expect(problems(raw).join()).toContain('unknown field "serviceToken"')
    const noPath = northfieldRaw()
    delete noPath.agent.path
    expect(problems(noPath).join()).toContain('agent.path')
  })

  test('a token needs the claudeScript switch', () => {
    const raw = northfieldRaw()
    raw.switches.claudeScript = false
    expect(problems(raw).join()).toContain('agent: the claudeScript switch must be on')
  })
})

describe('the Clients door', () => {
  const northfieldRaw = () => structuredClone(readJson(NORTHFIELD_FILE)) as Record<string, any>

  test('Northfield Works has one: a path and the source its Clients are from', () => {
    expect(parseDeclaration(northfieldRaw()).clientsDoor).toMatchObject({ path: '/agent/clients', source: 'northfield.example' })
  })

  test('how a source’s extra fields are drawn is optional: a door with neither suggests by domain alone and shows every key made readable', () => {
    const raw = northfieldRaw()
    raw.clientsDoor = { path: '/agent/clients', source: 'northfield.example' }
    const door = createInstall(parseDeclaration(raw)).clientsDoor()
    expect(door).toMatchObject({ suggestByAddressKey: null, fields: [] })
  })

  test('the key to suggest by and the labels are checked: a key an extra field may have, a one-line label, a known kind, a boolean', () => {
    const bad = (patch: Record<string, unknown>) => {
      const raw = northfieldRaw()
      raw.clientsDoor = { ...raw.clientsDoor, ...patch }
      return problems(raw).join()
    }
    expect(bad({ suggestByAddressKey: 'Not a key' })).toContain('clientsDoor.suggestByAddressKey')
    expect(bad({ suggestByAddressKey: 3 })).toContain('clientsDoor.suggestByAddressKey')
    expect(bad({ fields: [] })).toContain('clientsDoor.fields')
    expect(bad({ fields: { 'Bad Key': { label: 'x' } } })).toContain('clientsDoor.fields.Bad Key')
    expect(bad({ fields: { plan: 'Plan' } })).toContain('clientsDoor.fields.plan: an object with a label')
    expect(bad({ fields: { plan: { label: '' } } })).toContain('clientsDoor.fields.plan.label')
    expect(bad({ fields: { plan: { label: 'two\nlines' } } })).toContain('clientsDoor.fields.plan.label')
    expect(bad({ fields: { plan: { label: 'Plan', kind: 'date' } } })).toContain('clientsDoor.fields.plan.kind')
    expect(bad({ fields: { plan: { label: 'Plan', list: 'yes' } } })).toContain('clientsDoor.fields.plan.list')
    expect(bad({ fields: { plan: { label: 'Plan', colour: 'red' } } })).toContain('unknown field "colour"')
    expect(bad({ fields: { plan: { label: 'Plan', kind: 'time', list: true } }, suggestByAddressKey: 'contactAddress' })).toBe('')
  })

  test('a client has none, and cannot be given one without the switch: its Clients are made in its own space', () => {
    expect(parseDeclaration(lane())).not.toHaveProperty('clientsDoor')
    const raw = lane()
    raw.clientsDoor = { path: '/agent/clients', source: 'somewhere' }
    expect(problems(raw).join()).toContain('clientsDoor: only where the clientDirectory switch is on')
  })

  test('the switch needs the door declared', () => {
    const raw = northfieldRaw()
    delete raw.clientsDoor
    expect(problems(raw).join()).toContain('clientsDoor: the clientDirectory switch is on')
  })

  test('the path is a path of the space and its own, and the source is one short line', () => {
    const bad = (patch: Record<string, unknown>) => {
      const raw = northfieldRaw()
      raw.clientsDoor = { ...raw.clientsDoor, ...patch }
      return problems(raw).join()
    }
    expect(bad({ path: 'agent/clients' })).toContain('clientsDoor.path')
    expect(bad({ path: '/api/clients' })).toContain('is the space\'s own')
    expect(bad({ path: '/forms/clients' })).toContain('is the space\'s own')
    expect(bad({ path: '/agent/inbox/clients' })).toContain('another machine\'s door')
    expect(bad({ path: '/agent' })).toContain('another machine\'s door')
    expect(bad({ path: '/agent/telegram' })).toContain('another machine\'s door')
    expect(bad({ serviceToken: 'northfield-web clients' })).toContain('unknown field "serviceToken"')
    expect(bad({ source: '' })).toContain('clientsDoor.source')
    expect(bad({ source: 'x'.repeat(41) })).toContain('clientsDoor.source')
    expect(bad({ source: 'two\nlines' })).toContain('clientsDoor.source')
    expect(bad({ other: 1 })).toContain('unknown field "other"')
  })
})

/** The mailboxes a company's mail lands in are declared (kind, name, whether the spam check begins on); their persona and questions are the install's content files, not here. */
describe('the business mailboxes fed by Cloudflare Email Routing', () => {
  const withMailboxes = () => {
    const raw = lane()
    raw.businesses = [{ id: 'lane', name: 'Pinecrest', mailboxes: ['info@pinecrest.test', 'hello@shop.test'] }]
    raw.cloudflareMailboxes = [
      { address: 'Info@Pinecrest.test', name: 'Pinecrest', short: 'Lane', spamCheck: true },
      { address: 'hello@shop.test', name: 'Shop' },
    ]
    return raw
  }

  test('none are declared unless the declaration lists some', () => {
    expect(createInstall(lane()).cloudflareMailboxes()).toEqual([])
    expect(createInstall(lane()).cloudflareMailbox('info@pinecrest.test')).toBeNull()
  })

  test('each has an address, a name, an optional short name and whether its spam check begins on', () => {
    const install = createInstall(withMailboxes())
    expect(install.cloudflareMailboxes()).toEqual([
      { address: 'info@pinecrest.test', name: 'Pinecrest', short: 'Lane', spamCheck: true },
      { address: 'hello@shop.test', name: 'Shop' },
    ])
    expect(install.cloudflareMailbox(' HELLO@shop.test ')).toEqual({ address: 'hello@shop.test', name: 'Shop' })
    expect(install.cloudflareMailbox('someone@else.test')).toBeNull()
    expect(install.cloudflareMailbox(null)).toBeNull()
  })

  test('a mailbox is one of a business’s, not the owner’s own address, and one per domain', () => {
    const orphan = withMailboxes()
    orphan.businesses = [{ id: 'lane', name: 'Pinecrest', mailboxes: ['info@pinecrest.test'] }]
    expect(problems(orphan).join()).toContain('cloudflareMailboxes[1].address: hello@shop.test is not a mailbox of any business')
    const own = withMailboxes()
    own.businesses[0].mailboxes.push('lane@pinecrest.test')
    own.cloudflareMailboxes.push({ address: 'lane@pinecrest.test', name: 'Lane' })
    expect(problems(own).join()).toContain("is the owner's own address")
    const twoOnOneDomain = withMailboxes()
    twoOnOneDomain.businesses[0].mailboxes.push('sales@shop.test')
    twoOnOneDomain.cloudflareMailboxes.push({ address: 'sales@shop.test', name: 'Sales' })
    expect(problems(twoOnOneDomain).join()).toContain("a domain's mail has one mailbox")
    const twice = withMailboxes()
    twice.cloudflareMailboxes.push({ ...twice.cloudflareMailboxes[1] })
    expect(problems(twice).join()).toContain('listed twice')
  })

  test('the entries are checked: a name, one line, true or false, and no field the layer does not know', () => {
    for (const [change, say] of [
      [{ name: '' }, 'cloudflareMailboxes[0].name'],
      [{ name: 'Lane\nCo' }, 'cloudflareMailboxes[0].name'],
      [{ short: '' }, 'cloudflareMailboxes[0].short'],
      [{ spamCheck: 'yes' }, 'cloudflareMailboxes[0].spamCheck'],
      [{ persona: 'x' }, 'unknown field "persona"'],
      [{ address: 'not-an-address' }, 'cloudflareMailboxes[0].address'],
    ] as const) {
      const raw = withMailboxes()
      Object.assign(raw.cloudflareMailboxes[0], change)
      expect([JSON.stringify(change), problems(raw).join('\n').includes(say)]).toEqual([JSON.stringify(change), true])
    }
    const notAList = withMailboxes()
    notAList.cloudflareMailboxes = { address: 'x@y.test' }
    expect(problems(notAList).join()).toContain('cloudflareMailboxes: a list')
  })

  /** Who is on a mailbox is declared with it, and every name must be a person of the install. */
  describe('who is on each', () => {
    test('left out, the owner alone is on it, which is what Northfield’s are', () => {
      const install = createInstall(withMailboxes())
      expect(install.mailboxPeople('info@pinecrest.test')).toEqual(['lane@pinecrest.test'])
      expect(install.mailboxPeople(' HELLO@shop.test ')).toEqual(['lane@pinecrest.test'])
      expect(install.mailboxPeople('someone@else.test')).toBeNull()
      expect(install.mailboxPeople(null)).toBeNull()
      // And the parsed declaration says nothing: nothing was written that was not given.
      expect(install.cloudflareMailboxes()[1]).toEqual({ address: 'hello@shop.test', name: 'Shop' })
    })

    test('declared, the list is the people named, by their work address, each once', () => {
      const raw = withMailboxes()
      raw.cloudflareMailboxes[1].people = ['Corin@Pinecrest.test', 'lane@pinecrest.test']
      const install = createInstall(raw)
      expect(install.mailboxPeople('hello@shop.test')).toEqual(['corin@pinecrest.test', 'lane@pinecrest.test'])
      expect(install.cloudflareMailbox('hello@shop.test')?.people).toEqual(['corin@pinecrest.test', 'lane@pinecrest.test'])
    })

    test('every person named must be a person of the install, once, and a list is not empty', () => {
      for (const [people, say] of [
        [['stranger@example.com'], 'cloudflareMailboxes[1].people: stranger@example.com is not a person of this install'],
        [['corin@pinecrest.test', 'corin@pinecrest.test'], 'cloudflareMailboxes[1].people: corin@pinecrest.test is listed twice'],
        [[], 'cloudflareMailboxes[1].people: a list of the work addresses'],
        ['corin@pinecrest.test', 'cloudflareMailboxes[1].people: a list of the work addresses'],
        [[7], 'is not a person of this install'],
      ] as const) {
        const raw = withMailboxes()
        raw.cloudflareMailboxes[1].people = people
        expect([JSON.stringify(people), problems(raw).join('\n').includes(say)]).toEqual([JSON.stringify(people), true])
      }
    })

    test('a person is named by the work address, not by the address they sign in with', () => {
      const raw = withMailboxes()
      raw.people[0].signIn = 'lane.private@mail.example'
      raw.cloudflareMailboxes[1].people = ['lane.private@mail.example']
      expect(problems(raw).join()).toContain('is not a person of this install')
    })

    test('a mailbox on the install’s mail server names its people the same way', () => {
      const raw = lane()
      raw.switches = { hostedMailboxes: true }
      raw.hostedMailboxes = [{ address: 'desk@pinecrest.test', name: 'Desk', door: 'https://jmap.pinecrest.test', secret: 'INBOX_JMAP_DESK', people: ['corin@pinecrest.test'] }]
      const install = createInstall(raw)
      expect(install.mailboxPeople('desk@pinecrest.test')).toEqual(['corin@pinecrest.test'])
      raw.hostedMailboxes[0].people = ['nobody@example.com']
      expect(problems(raw).join()).toContain('hostedMailboxes[0].people: nobody@example.com is not a person of this install')
    })

    test('what an install answers is a copy, the list too', () => {
      const raw = withMailboxes()
      raw.cloudflareMailboxes[1].people = ['corin@pinecrest.test']
      const install = createInstall(raw)
      install.mailboxPeople('hello@shop.test')!.push('changed')
      install.cloudflareMailbox('hello@shop.test')!.people!.push('changed')
      install.cloudflareMailboxes()[1]!.people!.push('changed')
      expect(install.mailboxPeople('hello@shop.test')).toEqual(['corin@pinecrest.test'])
    })
  })

  test('what an install answers is a copy', () => {
    const install = createInstall(withMailboxes())
    install.cloudflareMailboxes()[0]!.name = 'changed'
    install.cloudflareMailbox('info@pinecrest.test')!.name = 'changed'
    expect(install.cloudflareMailbox('info@pinecrest.test')?.name).toBe('Pinecrest')
  })
})
