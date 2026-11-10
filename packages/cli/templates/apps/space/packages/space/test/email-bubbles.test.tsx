// An email in the conversation as the inbox's page draws it: a bubble each, a line over it, the quoted rest folded behind a button. The folding is the
// inbox's (its answer carries `read`, made by the code its own page uses: packages/inbox/test/space.test.ts proves that half); what these prove is what the
// space does with it, in a stand-in DOM so the button can be pressed: the quoted rest is hidden until it is, a message with no quote shows whole, and an answer
// from an inbox that predates the field is drawn as it was.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { newCompose } from '../src/client/compose'
import { openConversation } from '../src/conversation'
import { standInInbox, standInMeet, type StandInMessage } from '../src/stand-ins'
import { ago, contact, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const LINK =
  'https://links.example.net/app?from=signature&client=ios&next=https%3A%2F%2Fstore.example.net%2Fapps'
const ROSA = 'Rosa Whitfield <rosa_whitfield@yahoo.example>'
const TESSA = 'Tessa Marlow <tessa@northfield.example>'
const NEW_TEXT = ['Hi Tessa, a day later is no good, we are shut for stocktaking.', '', 'Sent from Yahoo Mail for iPhone'].join('\n')
const QUOTED = ['On Tuesday, March 10, 2026, 9:48 AM, Tessa Marlow <tessa@northfield.example> wrote:', '', '> Thursday afternoon is open for me too.', '>', `>> Is the walkthrough still happening this week? <${LINK}>`].join('\n')

// The stand-in reads a message whole and says who ours went to, as an inbox that has the fields does; the one with a quote is told its fold.
const messages: StandInMessage[] = [
  { id: 'm1', at: ago(600), direction: 'in', from: ROSA, text: 'Is the walkthrough still happening this week?' },
  { id: 'm2', at: ago(500), direction: 'out', from: TESSA, text: 'Thursday afternoon is open for me too.' },
  { id: 'm3', at: ago(400), direction: 'in', from: ROSA, text: `${NEW_TEXT}\n\n${QUOTED}`, read: { visible: NEW_TEXT, quoted: QUOTED } },
]
const old: StandInMessage[] = [{ id: 'o1', at: ago(300), direction: 'in', from: 'Gus Fry <gus@example.net>', text: `Wednesday is fine.\n\n> Can you come Wednesday?` }]

/** `withReading` off is an inbox that predates `read` and `to`: it answers without them. */
async function open(key: string, withReading = true) {
  const inbox = standInInbox(
    [contact('c-ro', 'Rosa Whitfield', 'rosa_whitfield@yahoo.example'), contact('c-gus', 'Gus Fry', 'gus@example.net')],
    [thread('t-ro', ago(400), ['c-ro'], { subject: 'Sign proofs', messages }), thread('t-gus', ago(300), ['c-gus'], { subject: 'Visit', messages: old })],
    { withReading },
  )
  const meet = standInMeet({ direct: [], channels: [] }, { history: {} })
  const opened = await openConversation({ apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
  if (!opened.ok) throw new Error(opened.message)
  return opened.value
}

async function draw(key: string, withReading = true) {
  const answer = await open(key, withReading)
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationView } = await import('../src/client/Conversation')
  document.body.innerHTML = '<div id="root"></div>'
  const host = document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  const props = {
    me: ME,
    now: T0,
    answer,
    sources: answer.sources,
    loadingEarlier: false,
    onEarlier: () => undefined,
    way: 'email' as const,
    onWay: () => undefined,
    threadId: null,
    onThread: () => undefined,
    compose: newCompose(),
    onText: () => undefined,
    onSend: () => undefined,
  onSendAndClose: () => undefined,
  onClose: () => undefined,
  onReopen: () => undefined,
  reopen: null,
  changing: false,
  changed: null,
    onDismiss: () => undefined,
    drafts: {},
    onSendDraft: () => undefined,
    onDismissDraft: () => undefined,
    onDraftChanged: () => undefined,
    profileOpen: false,
    onProfile: () => undefined,
    onBack: () => undefined,
    timeZone: 'UTC',
  }
  await act(async () => {
    root.render(createElement(ConversationView, props))
    await sleep(10)
  })
  return { host, act, done: () => act(async () => root.unmount()) }
}

const entries = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="entry"]')] as HTMLElement[]

describe('an email in the conversation', () => {
  test('is a bubble with who it is from and when; ours says who it went to, theirs the address it came from', async () => {
    const { host, done } = await draw('rosa_whitfield@yahoo.example')
    const [first, mine] = entries(host)
    expect(first?.className).toBe('msg email')
    expect(first?.querySelector('.msg-head')?.textContent).toContain('Rosa Whitfield')
    expect(first?.querySelector('.msg-head')?.textContent).toContain('rosa_whitfield@yahoo.example')
    expect(mine?.className).toBe('msg email mine')
    expect(mine?.querySelector('.msg-head')?.textContent).toContain('You')
    expect(mine?.querySelector('.msg-head')?.textContent).toContain('to rosa_whitfield@yahoo.example')
    // The runs keep their subject heading.
    expect(host.querySelector('[data-testid="heading"]')?.textContent).toContain('Email: Sign proofs')
    await done()
  })

  test('with no quote shows whole, with no fold button', async () => {
    const { host, done } = await draw('rosa_whitfield@yahoo.example')
    const [first, mine] = entries(host)
    expect(first?.querySelector('.msg-text')?.textContent).toBe('Is the walkthrough still happening this week?')
    expect(mine?.querySelector('[data-testid="fold"]')).toBeNull()
    await done()
  })

  test('with a quote shows what was said now and folds the rest behind a button that opens it', async () => {
    const { host, act, done } = await draw('rosa_whitfield@yahoo.example')
    const reply = entries(host)[2] as HTMLElement
    // Folded: the tracking link and every ">" line are out of the page.
    expect(reply.textContent).toContain('a day later is no good')
    expect(reply.textContent).not.toContain('links.example.net')
    expect(reply.textContent).not.toContain('> Thursday afternoon is open')
    expect(reply.querySelector('[data-testid="quoted"]')).toBeNull()
    const button = reply.querySelector('[data-testid="fold"]') as HTMLButtonElement
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      button.click()
    })
    expect(reply.querySelector('[data-testid="quoted"]')?.textContent).toBe(QUOTED)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      button.click()
    })
    expect(reply.querySelector('[data-testid="quoted"]')).toBeNull()
    await done()
  })

  test('from an inbox that predates the field is drawn whole, as it was', async () => {
    const { host, done } = await draw('gus@example.net', false)
    const [only] = entries(host)
    expect(only?.className).toBe('msg')
    expect(only?.querySelector('.msg-text')?.textContent).toBe('Wednesday is fine.\n\n> Can you come Wednesday?')
    expect(only?.querySelector('[data-testid="fold"]')).toBeNull()
    await done()
  })
})
