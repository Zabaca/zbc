import { describe, expect, test } from 'bun:test'
import { createInstall, HOME_TAB, mailNameOf, SWITCH_DEFAULTS, SWITCHES, TAB_IDS, TABS } from '../src'
import { lane, PINECREST_FILE, readJson, NORTHFIELD_FILE, northfield } from './helpers'

describe('the install, as the apps ask it', () => {
  test('a person of one company is not a person of the other', () => {
    const z = northfield()
    const l = lane()
    expect(z.personBySignIn('tessa@northfield.example')?.name).toBe('Tessa')
    expect(l.personBySignIn('tessa@northfield.example')).toBeNull()
    expect(l.personBySignIn('corin.private@example.com')?.address).toBe('corin@pinecrest.test')
    expect(z.personBySignIn('corin.private@example.com')).toBeNull()
    expect(z.person('lane@pinecrest.test')).toBeNull()
    expect(l.person('tessa@northfield.example')).toBeNull()
  })

  test('a lookup is by exact sign-in address, case aside, and by nothing else', () => {
    const l = lane()
    expect(l.personBySignIn(' Lane@Pinecrest.test ')?.role).toBe('owner')
    expect(l.personBySignIn('corin@pinecrest.test')).toBeNull() // Corin signs in at his Gmail, not the work address
    expect(l.personBySignIn('lane@pinecrest.test.evil.test')).toBeNull()
    expect(l.personBySignIn(null)).toBeNull()
    expect(l.personBySignIn('')).toBeNull()
  })

  test('an owner works every shared address; a member works theirs', () => {
    const l = lane()
    const sharedOf = (a: string) => l.sharedAddressesOf(l.person(a)!)
    expect(sharedOf('lane@pinecrest.test')).toEqual(['info@pinecrest.test', 'estimates@pinecrest.test'])
    expect(sharedOf('corin@pinecrest.test')).toEqual(['estimates@pinecrest.test'])
    expect(sharedOf('dana@pinecrest.test')).toEqual([])
  })

  test("the space is one address whose tabs are the install's, in order, the page you are on marked (Northfield's are all seven)", () => {
    expect(northfield().tabs('inbox').map((t) => [t.id, t.label, t.url, t.current])).toEqual([
      ['today', 'Today', 'https://space.northfield.example/today', false],
      ['inbox', 'Inbox', 'https://space.northfield.example/inbox', true],
      ['meet', 'Meet', 'https://space.northfield.example/meet', false],
      ['calendar', 'Calendar', 'https://space.northfield.example/calendar', false],
      ['forms', 'Forms', 'https://space.northfield.example/forms', false],
      ['people', 'People', 'https://space.northfield.example/people', false],
      ['knowledge', 'Knowledge', 'https://space.northfield.example/knowledge', false],
    ])
    expect(northfield().tabs().some((t) => t.current)).toBe(false)
    expect(HOME_TAB).toBe('today')
    // An install's tabs are on its own address, and every link the apps send is made from it.
    expect(lane().tabs('today')[0]?.url).toBe('https://space.pinecrest.test/today')
    expect(lane().url()).toBe('https://space.pinecrest.test/')
    expect(northfield().url()).toBe('https://space.northfield.example/')
    // Forms is the one tab Access asks a sign-in of its own for.
    expect(northfield().tabs().filter((t) => t.ownSignIn).map((t) => t.id)).toEqual(['forms'])
  })

  test("Access gets the space's whole host, a month's sign-in and every person's address, with no policy or token of an app's", () => {
    expect(northfield().accessApplication('space')).toEqual({ domain: 'space.northfield.example', allowedEmails: ['tessa@northfield.example'], sessionDuration: '730h' })
    expect(lane().accessApplication('space')).toEqual({
      domain: 'space.pinecrest.test',
      allowedEmails: ['lane@pinecrest.test', 'corin.private@example.com', 'dana@pinecrest.test'],
      sessionDuration: '730h',
    })
  })

  test('forms is in the Forms tab: its Access application is the Forms path of the space, with its own day', () => {
    expect(northfield().tabPath('forms')).toBe('/forms')
    expect(northfield().accessApplication('forms')).toEqual({ domain: 'space.northfield.example/forms', allowedEmails: ['tessa@northfield.example'], sessionDuration: '24h' })
    expect(lane().accessApplication('forms')).toEqual({
      domain: 'space.pinecrest.test/forms',
      allowedEmails: ['lane@pinecrest.test', 'corin.private@example.com', 'dana@pinecrest.test'],
      sessionDuration: '24h',
    })
    // The space's own application is longer and covers the host; the Forms one is a separate, narrower one.
    expect(northfield().accessApplication('space').sessionDuration).toBe('730h')
  })

  test('Gmail’s push host, and the Google app, are the install’s own where its Gmail switch is on, and nobody’s where it is off', () => {
    expect(northfield().gmailPushHost()).toBe('inbox-push.northfield.example')
    expect(lane().gmailPushHost()).toBeNull()
    expect(lane().googleApp()).toBeNull()
    expect(lane().hostedMailboxes()).toEqual([])
    expect(lane().phonePeople()).toEqual({})
  })

  test('a tab whose part is off is not shown: no Calendar tab without a Google account, no Inbox tab without a mailbox of any kind, and the rest of the order is as ever', () => {
    // An install that says nothing has Today, Meet, Forms, People and Knowledge.
    const quiet = lane()
    expect(quiet.tabs().map((t) => t.id)).toEqual(['today', 'meet', 'forms', 'people', 'knowledge'])
    expect(quiet.hasTab('calendar')).toBe(false)
    expect(quiet.hasTab('inbox')).toBe(false)
    expect(quiet.hasMailbox()).toBe(false)
    // The tabs it has are on its own address, in the layer's order, and Forms keeps its own sign-in.
    expect(quiet.tabs('meet').map((t) => [t.id, t.url, t.current])).toEqual([
      ['today', 'https://space.pinecrest.test/today', false],
      ['meet', 'https://space.pinecrest.test/meet', true],
      ['forms', 'https://space.pinecrest.test/forms', false],
      ['people', 'https://space.pinecrest.test/people', false],
      ['knowledge', 'https://space.pinecrest.test/knowledge', false],
    ])
    expect(quiet.tabs().filter((t) => t.ownSignIn).map((t) => t.id)).toEqual(['forms'])
    // Any mailbox gives the Inbox: Telegram, a business mailbox of the company's, a mailbox on its mail server, a Gmail account. Only a Google account gives the Calendar.
    const withRaw = (patch: (raw: Record<string, any>) => void) => {
      const raw = structuredClone(readJson(PINECREST_FILE)) as Record<string, any>
      patch(raw)
      return createInstall(raw)
    }
    const telegram = withRaw((r) => {
      r.switches = { telegram: true }
      r.telegram = { path: '/agent/telegram' }
    })
    expect(telegram.tabs().map((t) => t.id)).toEqual(['today', 'inbox', 'meet', 'forms', 'people', 'knowledge'])
    const business = withRaw((r) => {
      r.businesses = [{ id: 'lane', name: 'Lane', mailboxes: ['info@pinecrest.test'] }]
    })
    expect(business.hasTab('inbox')).toBe(true)
    expect(business.hasTab('calendar')).toBe(false)
    const hosted = withRaw((r) => {
      r.switches = { hostedMailboxes: true }
      r.hostedMailboxes = [{ address: 'desk@pinecrest.test', name: 'Desk', door: 'https://jmap.pinecrest.test', secret: 'INBOX_JMAP_DESK' }]
    })
    expect(hosted.hasTab('inbox')).toBe(true)
    const gmail = withRaw((r) => {
      r.switches = { gmail: true }
      r.gmailPush = { host: 'inbox-push.pinecrest.test' }
      r.googleApp = { clientId: '1-a.apps.googleusercontent.com', pushTopic: 'projects/abcdef/topics/abc' }
    })
    expect(gmail.tabs().map((t) => t.id)).toEqual(['today', 'inbox', 'meet', 'calendar', 'forms', 'people', 'knowledge'])
    // Calls, the phone, the assistant and Claude's script are not tabs: they change what a tab holds.
    const calls = withRaw((r) => {
      r.switches = { calls: true }
    })
    expect(calls.tabs().map((t) => t.id)).toEqual(quiet.tabs().map((t) => t.id))
  })

  test('a company that lists no businesses is its own one business, which no mailbox belongs to', () => {
    const l = lane()
    expect(l.businesses()).toEqual([{ id: 'pinecrest-test', name: 'Pinecrest Test', mailboxes: [] }])
    expect(l.businessOf('lane@pinecrest.test')).toBeNull()
  })

  test('the list an install answers is a copy: changing it changes nothing', () => {
    const z = northfield()
    z.businesses()[0]!.mailboxes.push('x@y.test')
    z.businessOf('tessa@northfield.example')!.mailboxes.length = 0
    expect(z.businessOf('x@y.test')).toBeNull()
    expect(z.businessOf('tessa@northfield.example')?.mailboxes).toEqual(['tessa@northfield.example'])
  })

  test('the tab ids a declaration may name are the layer’s seven', () => {
    expect([...TAB_IDS]).toEqual(TABS.map((t) => t.id))
  })

  test("every switch is on in Northfield's install, which declares what each needs, and off in an install that says nothing", () => {
    const z = northfield()
    const l = lane()
    for (const sw of ['gmail', 'hostedMailboxes', 'clientDirectory', 'claudeScript', 'assistant', 'phone', 'manyClients', 'calls', 'telegram'] as const) {
      expect([sw, z.has(sw), l.has(sw)]).toEqual([sw, true, false])
    }
    expect(z.switches()).toEqual(Object.fromEntries(SWITCHES.map((s) => [s, true])) as Record<(typeof SWITCHES)[number], boolean>)
    expect(l.switches()).toEqual(SWITCH_DEFAULTS)
  })
})

describe('the install’s owner', () => {
  test('is the first owner the declaration lists, and is mailed under the name it gives them, else their name', () => {
    const z = northfield()
    expect(z.owner()).toMatchObject({ address: 'tessa@northfield.example', name: 'Tessa', mailName: 'Tessa Marlow', role: 'owner' })
    expect(mailNameOf(z.owner())).toBe('Tessa Marlow')
    const l = lane()
    expect(l.owner().address).toBe('lane@pinecrest.test')
    expect(mailNameOf(l.owner())).toBe('Lane')
    // Another owner listed after the first is still an owner, and is not the install's.
    const raw = readJson(NORTHFIELD_FILE) as { people: Record<string, unknown>[] }
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'owner' })
    const two = createInstall(raw)
    expect(two.owner().address).toBe('tessa@northfield.example')
    expect(two.people.filter((p) => two.isOwner(p))).toHaveLength(2)
  })
})
