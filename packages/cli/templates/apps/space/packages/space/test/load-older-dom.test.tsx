// Load older, as a browser runs it, in a stand-in DOM: the Inbox's list is the newest screen of its view, and at the foot of a list that has more there is one control that reads the next screen of the same
// view and puts it below the rows shown. The inbox here cuts at THREE conversations (the stand-in's `page`, as the real one cuts at 200), over eight, so every press is visible. What the tests pin is what a person
// sees and what the page asks the Worker for: the foot says what the list is and has the control; a press asks for the next screen from where the list ends and shows it; once everything is shown the control is gone; and
// a list read again (the page shown again, a live message, a send) keeps every row that was loaded and is not doubled, with mail that arrived since on top. The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { ConversationsScreen } from '../src/client/Conversations'
import { type ConversationsAnswer, parseReading, parseView } from '../src/conversations'
import { conversations } from '../src/list'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { OWNER_SIGNED_IN } from './signed-in'
import { ago, contact, thread } from './world'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const SCREEN = 3
const COUNT = 8

/** Eight people with one open conversation each, ten minutes apart, newest first (Person 0 is the newest). */
function eight() {
  // `c-new` has no conversation yet: it is the person whose mail arrives in one of the tests.
  const people = [...Array.from({ length: COUNT }, (_, n) => contact(`c-${n}`, `Person ${n}`, `p${n}@example.com`)), contact('c-new', 'New Person', 'new@example.com')]
  const threads = Array.from({ length: COUNT }, (_, n) => thread(`t-${n}`, ago(10 * (n + 1)), [`c-${n}`], { subject: `Matter ${n}` }))
  return standInInbox(people, threads, { page: SCREEN })
}

/** The page's `fetch`, routed to the Worker's own list function as `/api/conversations` is, and every list request kept. */
function route(inbox: ReturnType<typeof standInInbox>) {
  const asked: string[] = []
  const ask = { apps: { inbox, meet: standInMeet({ direct: [], channels: [] }) }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100 }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname !== '/api/conversations') return json({ error: 'nothing here' }, 403)
    asked.push(url.pathname + url.search)
    const view = parseView(url.searchParams.get('view') ?? undefined, url.searchParams.get('mailbox') ?? undefined, url.searchParams.get('client') ?? undefined)
    const reading = parseReading(url.searchParams.get('through') ?? undefined, url.searchParams.get('older') ?? undefined)
    if (view === null || reading === null) return json({ error: 'no' }, 400)
    return json(await conversations(ask, view, 'mail', reading))
  }) as typeof fetch
  return asked
}

async function open(inbox = eight(), search = '') {
  const asked = route(inbox)
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { Conversations } = await import('../src/client/Conversations')
  document.body.innerHTML = '<div id="root"></div>'
  const host = document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  const draw = (to: string) => root.render(createElement(Conversations, { scope: 'mail', me: ME, pathname: '/inbox', search: to, go: () => undefined }))
  await act(async () => {
    draw(search)
    await sleep(80)
  })
  const keys = () => [...host.querySelectorAll('[data-testid="row"]')].map((r) => r.getAttribute('data-key'))
  const control = () => host.querySelector<HTMLButtonElement>('[data-testid="load-older"]')
  const press = async () => {
    await act(async () => {
      control()?.click()
      await sleep(80)
    })
  }
  const again = async () =>
    act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await sleep(80)
    })
  const go = (to: string) =>
    act(async () => {
      draw(to)
      await sleep(80)
    })
  return { host, asked, keys, control, press, again, go, inbox, unmount: () => act(async () => root.unmount()) }
}

const ALL = Array.from({ length: COUNT }, (_, n) => `p${n}@example.com`)

describe('Load older at the foot of the Inbox', () => {
  test('a list that has more says what it is and offers the control; the old dead-end line is gone', async () => {
    const page = await open()
    expect(page.keys()).toEqual(ALL.slice(0, SCREEN))
    expect(page.control()?.textContent).toBe('Load older')
    expect(page.host.querySelector('[data-testid="load-older-row"]')?.textContent).toContain('These are the newest email conversations.')
    expect(page.host.textContent).not.toContain('Showing the newest email conversations only.')
    // The control is below the rows, inside the list.
    const list = page.host.querySelector('.list') as HTMLElement
    expect(list.contains(page.control())).toBe(true)
    expect(page.host.querySelector('[data-testid="rows"]')?.nextElementSibling?.getAttribute('data-testid')).toBe('load-older-row')
    await page.unmount()
  })

  test('a press asks for the next screen from where the list ends and shows it below; the last one takes the control away', async () => {
    const page = await open()
    await page.press()
    expect(page.keys()).toEqual(ALL.slice(0, 2 * SCREEN))
    const asked = page.asked.at(-1) as string
    expect(asked).toMatch(/^\/api\/conversations\?scope=mail&through=[^&]+&older=1$/)
    expect(page.control()).not.toBeNull()
    await page.press()
    expect(page.keys()).toEqual(ALL)
    expect(page.control()).toBeNull()
    expect(page.host.textContent).not.toContain('These are the newest email conversations.')
    await page.unmount()
  })

  test('a list read again keeps what was loaded, and is not doubled: the same rows once each, asked down to the same place without older', async () => {
    const page = await open()
    await page.press()
    // The press asked from the end of the first screen (the third conversation); the list now ends at the sixth, and that is where a read again goes down to.
    expect(new URL(`http://x${page.asked.at(-1)}`).searchParams.get('through')).toBe(`${new Date(ago(10 * SCREEN)).toISOString()}|${SCREEN}`)
    expect(page.keys()).toHaveLength(2 * SCREEN)
    await page.again()
    const refreshed = page.asked.at(-1) as string
    expect(new URL(`http://x${refreshed}`).searchParams.get('through')).toBe(`${new Date(ago(10 * 2 * SCREEN)).toISOString()}|${2 * SCREEN}`)
    expect(refreshed).not.toContain('older')
    expect(page.keys()).toEqual(ALL.slice(0, 2 * SCREEN))
    expect(new Set(page.keys()).size).toBe(page.keys().length)
    // Again, and again: it does not grow by itself.
    await page.again()
    expect(page.keys()).toEqual(ALL.slice(0, 2 * SCREEN))
    await page.unmount()
  })

  test('mail that arrived since is on top of what was loaded, and nothing below it moves or repeats', async () => {
    const page = await open()
    await page.press()
    expect(page.keys()).toEqual(ALL.slice(0, 2 * SCREEN))
    const threads = page.inbox.threads()
    threads.push({ ...thread('t-new', ago(1), ['c-new']), messages: [{ id: 't-new-m1', at: ago(1), direction: 'in', from: 'New Person', text: 'Hi' }] } as never)
    await page.again()
    const keys = page.keys()
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.slice(1)).toEqual(ALL.slice(0, 2 * SCREEN))
    expect(keys[0]).toBe('new@example.com')
    await page.unmount()
  })

  test('another list starts again from its newest screen: what was loaded in one is not asked for in the next', async () => {
    const page = await open()
    await page.press()
    await page.go('?view=bulk')
    expect(page.asked.at(-1)).toBe('/api/conversations?scope=mail&view=bulk')
    await page.go('')
    expect(page.asked.at(-1)).toBe('/api/conversations?scope=mail')
    expect(page.keys()).toEqual(ALL.slice(0, SCREEN))
    await page.unmount()
  })
})

describe('the foot as the screen draws it', () => {
  const answer = (over: Partial<ConversationsAnswer> = {}): ConversationsAnswer => ({ view: { kind: 'main' }, rows: [], parts: [{ part: 'mail', state: 'ok' }], mailboxes: [], more: true, floor: '2026-10-20T12:00:00.000Z|5', looseDrafts: [], ...over })
  const draw = (a: ConversationsAnswer | null, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<ConversationsScreen me={ME} now={Date.now()} answer={a} loading={false} problem={null} view="all" who="all" onWho={() => undefined} query="" onQuery={() => undefined} results={null} live="off" selected={null} go={() => undefined} onLoadOlder={() => undefined} {...over} />)

  test('it is there even when the person’s cut of the list shows nothing of what was loaded, so the rest can be asked for', () => {
    const html = draw(answer(), { who: 'team' })
    expect(html).toContain('data-testid="empty-conversations"')
    expect(html).toContain('data-testid="load-older"')
  })

  test('it says it is reading while it is, and holds the control', () => {
    const html = draw(answer(), { loadingOlder: true })
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="load-older"/)
    expect(html).toContain('Loading')
  })

  test('there is none where the list has no more, where the inbox gave no position, in a search and in Meet', () => {
    expect(draw(answer({ more: false }))).not.toContain('load-older')
    expect(draw(answer({ floor: null }))).not.toContain('load-older')
    expect(draw(answer(), { onLoadOlder: undefined })).not.toContain('load-older')
    expect(draw(answer(), { scope: 'chat' })).not.toContain('load-older')
  })
})
