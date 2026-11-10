// Settings as a browser runs it, in a stand-in DOM, over the real views of the Worker (src/views.ts) and a stand-in inbox: what a press does, and, more to the point, what it does
// NOT do until it is asked twice. Claude's sending asks before it turns on; restore prepares, then asks, then restores once with the token and the bookmark; a removal asks; a draft chat turn over a revision that moved on is refused and shows it. The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { fixtureViews } from '../src/fixture-views'
import { standInInbox } from '../src/stand-ins'
import { type ReadName, type WriteName, readView, writeView } from '../src/views'
import { OWNER_SIGNED_IN } from './signed-in'

const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
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

/** The Worker's two view routes over a stand-in inbox, as the page's `fetch` reaches them. */
function standInWorker() {
  const inbox = standInInbox([], [], {
    drafts: [{ id: 'd-1', conversationId: 't-1', contactId: 'c-1', subject: 'Re: hi', text: 'Hi.\n\nTalk soon.', author: 'claude', at: Date.now() }],
    views: fixtureViews(Date.now()),
  })
  const ask = { apps: { inbox, meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50, writeWithinMs: 200 }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const name = url.pathname.replace('/api/inbox/', '')
    if (init?.method === 'POST') {
      const got = await writeView(ask, name as WriteName, JSON.parse(String(init.body)), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0 Safari/537.36')
      return got.ok ? json(got.value) : json({ error: got.message }, 400)
    }
    const got = await readView(ask, name as ReadName, url.searchParams)
    return got.ok ? json(got.value) : json({ error: got.message }, 400)
  }) as typeof fetch
  return inbox
}

async function mount(node: (h: typeof import('react').createElement) => React.ReactElement) {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(node(createElement))
    await sleep(80)
  })
  const q = <T extends Element = HTMLElement>(testid: string) => document.querySelector(`[data-testid="${testid}"]`) as T | null
  const all = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  const click = async (el: Element | null) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      ;(el as HTMLElement).click()
      await sleep(80)
    })
  }
  const type = async (el: Element | null, value: string) => {
    if (!el) throw new Error('nothing to type in')
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(10)
    })
  }
  const submit = async (el: Element | null) => {
    await act(async () => {
      el?.closest('form')?.requestSubmit()
      await sleep(80)
    })
  }
  return { q, all, click, type, submit, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()), createElement }
}

describe('Claude’s sending, pressed', () => {
  test('turning it on asks first and changes nothing until yes; cancelling leaves it off; turning it off does not ask', async () => {
    const inbox = standInWorker()
    const { Settings } = await import('../src/client/Settings')
    const page = await mount((h) => h(Settings, { me: ME, pathname: '/settings/claude', go: () => undefined }) as never)
    expect(page.q('claude-sending')?.getAttribute('data-on')).toBe('false')
    await page.click(page.q('claude-switch'))
    expect(page.q('ask')).not.toBeNull()
    expect(inbox.views.calls.filter((c) => c.method === 'setClaudeSending')).toEqual([])
    await page.click(page.q('ask-no'))
    expect(page.q('ask')).toBeNull()
    expect(inbox.views.state.claudeSending.enabled).toBe(false)
    await page.click(page.q('claude-switch'))
    await page.click(page.q('ask-yes'))
    expect(inbox.views.calls.filter((c) => c.method === 'setClaudeSending').map((c) => c.args)).toEqual([[true]])
    expect(page.q('claude-sending')?.getAttribute('data-on')).toBe('true')
    expect(page.text()).toContain('Claude may now send on your instruction.')
    await page.click(page.q('claude-switch'))
    expect(page.q('ask')).toBeNull()
    expect(inbox.views.calls.filter((c) => c.method === 'setClaudeSending').map((c) => c.args)).toEqual([[true], [false]])
    expect(page.q('claude-sending')?.getAttribute('data-on')).toBe('false')
    await page.unmount()
  })
})

describe('restore, pressed', () => {
  test('RESTORE ASKS BEFORE IT ACTS: prepare shows the plan and restores nothing; cancel restores nothing; yes restores once with the token and the bookmark', async () => {
    const inbox = standInWorker()
    const { Settings } = await import('../src/client/Settings')
    const page = await mount((h) => h(Settings, { me: ME, pathname: '/settings/restore', go: () => undefined }) as never)
    expect(page.q('restore-confirm')).toBeNull()
    await page.type(page.q('restore-bookmark'), 'bookmark-0001-earlier')
    await page.click(page.q('restore-prepare'))
    expect(page.q('restore-ask')).not.toBeNull()
    expect(page.text()).toContain('Messages sent since then will show as unsent drafts again.')
    expect(inbox.views.calls.map((c) => c.method)).not.toContain('confirmRestore')
    expect(inbox.views.state.restores).toHaveLength(1)
    // Changing its mind restores nothing, and the plan is gone.
    await page.click(page.q('restore-cancel'))
    expect(page.q('restore-ask')).toBeNull()
    expect(inbox.views.calls.map((c) => c.method)).not.toContain('confirmRestore')
    // Again, and this time yes: one restore, naming the token the preparation gave and the bookmark it named.
    await page.type(page.q('restore-bookmark'), 'bookmark-0001-earlier')
    await page.click(page.q('restore-prepare'))
    await page.click(page.q('restore-confirm'))
    const confirms = inbox.views.calls.filter((c) => c.method === 'confirmRestore')
    expect(confirms).toHaveLength(1)
    expect(confirms[0]?.args).toEqual([{ token: expect.stringMatching(/^token-/), bookmark: 'bookmark-0001-earlier' }])
    expect(page.q('restore-done')).not.toBeNull()
    expect(page.text()).toContain('bookmark-0002-undo')
    expect(page.q('restore-confirm')).toBeNull() // no second restore from this screen
    expect(inbox.views.state.restores).toHaveLength(2)
    await page.unmount()
  })
})

describe('notifications, pressed', () => {
  test('a Remove asks first; yes removes that device alone, from the inbox’s list, and no is a no', async () => {
    const inbox = standInWorker()
    const { Settings } = await import('../src/client/Settings')
    const page = await mount((h) => h(Settings, { me: ME, pathname: '/settings/notifications', go: () => undefined }) as never)
    expect(page.all('device')).toHaveLength(3)
    expect(page.q('moving')).not.toBeNull()
    const old = page.all('device').find((d) => d.getAttribute('data-origin') === 'inbox') as HTMLElement
    await page.click(old.querySelector('[data-testid="remove-device"]'))
    expect(inbox.views.calls.map((c) => c.method)).not.toContain('removeDevice')
    await page.click(old.querySelector('[data-testid="ask-no"]'))
    expect(page.all('device')).toHaveLength(3)
    await page.click((page.all('device').find((d) => d.getAttribute('data-origin') === 'inbox') as HTMLElement).querySelector('[data-testid="remove-device"]'))
    await page.click(page.q('ask-yes'))
    expect(inbox.views.calls.filter((c) => c.method === 'removeDevice').map((c) => c.args)).toEqual([['device-inbox']])
    expect(page.all('device')).toHaveLength(2)
    // The other inbox device, then, and the "moving over" note goes when the last is gone.
    await page.click((page.all('device').find((d) => d.getAttribute('data-origin') === 'inbox') as HTMLElement).querySelector('[data-testid="remove-device"]'))
    await page.click(page.q('ask-yes'))
    expect(page.all('device').map((d) => d.getAttribute('data-origin'))).toEqual(['space'])
    expect(page.q('moving')).toBeNull()
    await page.unmount()
  })
})

describe('the draft chat, pressed', () => {
  const draft = { id: 'd-1', conversationId: 't-1', subject: 'Re: hi', text: 'Hi.\n\nTalk soon.', rev: 1, author: 'claude', stuck: false, at: 0, to: 'a@x.example', toName: 'A', cc: [], through: 1, sendable: true } as const

  test('it opens on the draft, a turn revises it at the revision shown, and a second press over that revision is refused and said', async () => {
    const inbox = standInWorker()
    const { DraftChat } = await import('../src/client/DraftChat')
    let changed = 0
    const page = await mount((h) => h(DraftChat, { draft: draft as never, onChanged: () => void changed++ }) as never)
    expect(page.q('draft-chat')).toBeNull()
    await page.click(page.q('open-chat'))
    expect(page.q('draft-chat')).not.toBeNull()
    await page.type(page.q('chat-words'), 'Shorter, please')
    await page.submit(page.q('chat-words'))
    expect(inbox.views.calls.filter((c) => c.method === 'chat').map((c) => c.args)).toEqual([[{ conversationId: 't-1', draftId: 'd-1', rev: 1, instruction: 'Shorter, please' }]])
    expect(changed).toBe(1) // the card is told to read the draft again
    expect(page.all('turn')).toHaveLength(1)
    expect(page.text()).toContain('Cut it to the first paragraph.')
    // The card has not read the new revision yet (this test never hands it one): asking again names the old, and is refused, not applied twice.
    await page.type(page.q('chat-words'), 'Even shorter')
    await page.submit(page.q('chat-words'))
    expect(page.q('say')?.textContent).toContain('changed since you saw it')
    expect(page.all('turn')).toHaveLength(1)
    expect(inbox.sent).toEqual([])
    await page.unmount()
  })

  test('a draft on no conversation, or one Gmail never confirmed, is not chatted about from here', async () => {
    standInWorker()
    const { DraftChat } = await import('../src/client/DraftChat')
    for (const d of [{ ...draft, conversationId: null }, { ...draft, stuck: true }]) {
      const page = await mount((h) => h(DraftChat, { draft: d as never, onChanged: () => undefined }) as never)
      expect(page.q('open-chat')).toBeNull()
      await page.unmount()
    }
  })
})
