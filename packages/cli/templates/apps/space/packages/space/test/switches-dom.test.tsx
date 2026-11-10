// What a person sees of an install's switches: the tabs the install has, the Settings sections whose part it has, Meet's menu with no Calls where
// calls are off, and no call button beside the reply box. Rendered to markup from the same `Me` the Worker sends (meOf). The Worker's own refusals are switches.test.ts; Northfield's install, where everything is on, is every other suite's.
import { createInstall, SWITCHES } from '@space/workspace'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { lane, PINECREST_FILE, readJson, T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { Space } from '../src/client/App'
import { useCallActions } from '../src/client/callActions'
import { meetTreeOf } from '../src/client/nav'
import { sectionHeld } from '../src/client/route'
import { EVERYTHING_ON, SwitchesContext, type SwitchesView } from '../src/client/switches'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { openConversation } from '../src/conversation'
import { OWNER_SIGNED_IN } from './signed-in'
import { ago, channel, contact, dm, person, thread } from './world'

const raw = () => structuredClone(readJson(PINECREST_FILE)) as Record<string, any>
const OFF_ME = meOf({ address: 'lane@pinecrest.test', name: 'Lane' }, lane())
const ON = createInstall({
  ...raw(),
  gmailPush: { host: 'inbox-push.pinecrest.test' },
  googleApp: { clientId: '123456789-abcdefghij.apps.googleusercontent.com', pushTopic: 'projects/pinecrest-mail/topics/gmail-push' },
  agent: { path: '/agent/inbox' },
  phone: { people: { 'lane@pinecrest.test': { emergencyNumber: 'line' } } },
  switches: { gmail: true, claudeScript: true, calls: true, phone: true },
})
const ON_ME = meOf({ address: 'lane@pinecrest.test', name: 'Lane' }, ON)
const view = (pathname: string, me = OFF_ME) => renderToStaticMarkup(<Space me={me} pathname={pathname} go={() => undefined} />)
const tabsIn = (html: string) => [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])
const sectionsIn = (html: string) => [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1])

describe('the tabs', () => {
  test('are the install’s own: no Inbox and no Calendar where there is no mailbox and no Google account', () => {
    expect(tabsIn(view('/today'))).toEqual(['today', 'meet', 'forms', 'people', 'knowledge'])
    expect(tabsIn(view('/today', ON_ME))).toEqual(['today', 'inbox', 'meet', 'calendar', 'forms', 'people', 'knowledge'])
  })

  test('a tab the install has not is not found at its address, with a way back to Today', () => {
    const html = view('/calendar')
    expect(html).toContain('Not found')
    expect(html).toContain('Go to Today')
    expect(tabsIn(html)).not.toContain('calendar')
  })
})

describe('Settings', () => {
  test('an install with nothing on has Notifications, Clients and Chat, and no section of a part it has not', () => {
    expect(sectionsIn(view('/settings'))).toEqual(['notifications', 'clients', 'chat'])
    // A section it has not is not found at its address either.
    for (const section of ['claude', 'mailboxes', 'calendars', 'calls', 'phone', 'restore']) {
      const html = view(`/settings/${section}`)
      expect([section, html.includes('data-testid="settings-not-found"')]).toEqual([section, true])
    }
  })

  test('with the switches on it has every section, in the order it always had', () => {
    expect(sectionsIn(view('/settings', ON_ME))).toEqual(['notifications', 'claude', 'mailboxes', 'calendars', 'clients', 'chat', 'calls', 'phone', 'restore'])
  })

  test('each section’s part is the switch or the tab it needs', () => {
    const none = Object.fromEntries(SWITCHES.map((s) => [s, false]))
    const held = (id: Parameters<typeof sectionHeld>[0], switches: Record<string, boolean>, inbox = false) => sectionHeld(id, switches, inbox ? [{ id: 'inbox' }] : [])
    expect(held('claude', { ...none, claudeScript: true })).toBe(true)
    expect(held('claude', none)).toBe(false)
    expect(held('calendars', { ...none, gmail: true })).toBe(true)
    expect(held('calendars', none)).toBe(false)
    expect(held('calls', { ...none, calls: true })).toBe(true)
    expect(held('phone', { ...none, phone: true })).toBe(true)
    expect(held('phone', none)).toBe(false)
    expect(held('mailboxes', none, true)).toBe(true)
    expect(held('restore', none, false)).toBe(false)
    expect(held('notifications', none)).toBe(true)
    expect(held('clients', none)).toBe(true)
  })
})

describe('Meet’s menu', () => {
  test('has Calls only where calls are on, and the Phone only for a person who has one', () => {
    expect(meetTreeOf('all', true, false, false, false).map((i) => i.label)).toEqual(['All', 'Chat', 'Channels'])
    expect(meetTreeOf('all', true, true, false, true).map((i) => i.label)).toEqual(['All', 'Chat', 'Channels', 'Calls', 'Phone'])
    // The default is the menu it always had.
    expect(meetTreeOf('all', true, false, false).map((i) => i.label)).toEqual(['All', 'Chat', 'Channels', 'Calls'])
  })

  test('the rail draws no Calls item where calls are off', () => {
    const html = view('/meet')
    expect(html).toContain('data-testid="meet-tree"')
    expect(html).not.toContain('view=calls')
    expect(view('/meet', ON_ME)).toContain('view=calls')
  })
})

describe('the buttons beside the reply box', () => {
  const install = northfield()
  async function open(key: string) {
    const inbox = standInInbox([contact('c-corin', 'Corin Pike', 'corin@client.test')], [thread('t-1', ago(50), ['c-corin'], { subject: 'Kickoff', direction: 'in' })])
    const meet = standInMeet({ direct: [dm(12, person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate'), ago(30))], channels: [channel(21, 'launch', ago(5), 2)] }, { history: { 12: [], 21: [] } })
    const opened = await openConversation({ apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
    if (!opened.ok) throw new Error(opened.message)
    return opened.value
  }
  function Probe({ answer, way }: { answer: Awaited<ReturnType<typeof open>>; way: 'chat' | 'email' }) {
    const a = useCallActions({ answer, way, threadId: null, zone: 'UTC', insert: () => undefined, made: () => undefined, now: () => T0 })
    return <i data-huddle={a.canHuddle} data-link={a.canLink} data-schedule={a.canSchedule} />
  }
  const flags = (html: string) => [...html.matchAll(/data-(huddle|link|schedule)="(true|false)"/g)].map((m) => `${m[1]}=${m[2]}`).join(' ')
  const off: SwitchesView = { ...EVERYTHING_ON, calls: false }

  test('a huddle, a call link and a meeting are offered where calls are on, and none where they are off', async () => {
    const chat = await open('chat:channel:21')
    const mail = await open('corin@client.test')
    expect(flags(renderToStaticMarkup(<Probe answer={chat} way="chat" />))).toBe('huddle=true link=false schedule=true')
    expect(flags(renderToStaticMarkup(<Probe answer={mail} way="email" />))).toBe('huddle=false link=true schedule=true')
    for (const [answer, way] of [[chat, 'chat'], [mail, 'email']] as const) {
      const html = renderToStaticMarkup(
        <SwitchesContext.Provider value={off}>
          <Probe answer={answer} way={way} />
        </SwitchesContext.Provider>,
      )
      expect(flags(html)).toBe('huddle=false link=false schedule=false')
    }
  })
})
