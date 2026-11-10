// The Inbox and Meet tabs as a browser runs them, in a stand-in DOM: when the list is read again (the page is shown again, ten minutes pass, the live connection says
// a part moved) the open conversation is read again with it, and a read the page makes itself (after it marked something read) is the list alone. The last block drives the screens
// under a hub of their own: which parts read the list, which read the open conversation, and what a reconnect reads.
// The DOM is registered for this file only and taken away after it: the other tests drive the Worker with the runtime's own Request and Response.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { openConversation } from '../src/conversation'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { ago, contact, dm, person, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

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

describe('the open conversation and the list', () => {
  test('a refresh of the list reads the open conversation again; the list read after a mark read does not', async () => {
    const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [thread('t1', ago(10), ['c-dana'], { subject: 'Hours', unread: true })])
    const meet = standInMeet({ direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(5), 0)], channels: [] }, { history: { 11: [{ id: 1, at: ago(5), authorId: 'p-dana', authorName: 'Dana', text: 'Hello' }] } })
    const ask = { apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }
    const calls = { conversation: 0, list: 0, read: 0, live: 0 }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.pathname === '/api/conversation') {
        calls.conversation++
        const opened = await openConversation(ask, url.searchParams.get('key') ?? '', (url.searchParams.get('scope') as 'mail' | 'chat' | null) ?? undefined)
        return opened.ok ? json(opened.value) : json({ error: opened.message }, opened.status)
      }
      if (url.pathname === '/api/conversations') {
        calls.list++
        return json({ view: { kind: 'main' }, rows: [], parts: [{ part: 'mail', state: 'ok' }, { part: 'chat', state: 'ok' }], mailboxes: [], more: false })
      }
      if (url.pathname === '/api/read') {
        calls.read++
        return json({ mail: { state: 'skipped' }, chat: { state: 'skipped' } })
      }
      if (url.pathname === '/api/live') calls.live++
      return json({ error: 'no live chat here' }, 403) // /api/live: no socket
    }) as typeof fetch

    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Conversations } = await import('../src/client/Conversations')
    document.body.innerHTML = '<div id="root"></div>'
    const host = document.getElementById('root') as HTMLElement
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(Conversations, { scope: 'mail', me: ME, pathname: '/inbox/dana%40harbor.example', go: () => undefined }))
      await sleep(60)
    })

    // Opened: the conversation was read once, and the page marked it read (the thread was unread), which re-read the LIST alone.
    expect(host.querySelector('[data-testid="conversation"]')).not.toBeNull()
    expect(calls.conversation).toBe(1)
    expect(calls.read).toBe(1)
    expect(calls.list).toBeGreaterThanOrEqual(2)
    const listReads = calls.list

    // The page is shown again: the list is read again, and the open conversation with it.
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await sleep(60)
    })
    expect(calls.list).toBe(listReads + 1)
    expect(calls.conversation).toBe(2)

    // And nothing reads it more often than that.
    await act(async () => {
      await sleep(60)
    })
    expect(calls.conversation).toBe(2)

    // The Inbox is email: it never asks for meet's live connection.
    expect(calls.live).toBe(0)

    await act(async () => root.unmount())
  })

  test('Meet reads meet’s list alone and opens no connection of its own: the page holds the one', async () => {
    const asked: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      asked.push(url.pathname + url.search)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.pathname === '/api/conversations') return json({ view: { kind: 'main' }, rows: [], parts: [{ part: 'chat', state: 'ok' }], mailboxes: [], more: false, looseDrafts: [] })
      return json({ error: 'nothing here' }, 403)
    }) as typeof fetch
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Conversations } = await import('../src/client/Conversations')
    document.body.innerHTML = '<div id="root"></div>'
    const host = document.getElementById('root') as HTMLElement
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(Conversations, { scope: 'chat', me: ME, pathname: '/meet', search: '', go: () => undefined }))
      await sleep(60)
    })
    expect(asked).toContain('/api/conversations?scope=chat')
    expect(asked.some((a) => a.startsWith('/api/live'))).toBe(false)
    expect(host.querySelector('h1')?.textContent).toBe('Meet')
    expect(host.querySelector('[data-testid="search"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('what the live connection reads again', () => {
  /** The Inbox with Dana's conversation open, under a hub the test drives; counts every read the page makes. */
  async function open(scope: 'mail' | 'chat') {
    const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [thread('t1', ago(10), ['c-dana'], { subject: 'Hours' })])
    const meet = standInMeet({ direct: [dm(11, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), ago(5), 0)], channels: [] }, { history: { 11: [{ id: 1, at: ago(5), authorId: 'p-dana', authorName: 'Dana', text: 'Hello' }] } })
    const ask = { apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }
    const calls = { conversation: 0, list: 0, other: [] as string[] }
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (url.pathname === '/api/conversation') {
        calls.conversation++
        const opened = await openConversation(ask, url.searchParams.get('key') ?? '', (url.searchParams.get('scope') as 'mail' | 'chat' | null) ?? undefined)
        return opened.ok ? json(opened.value) : json({ error: opened.message }, opened.status)
      }
      if (url.pathname === '/api/conversations') {
        calls.list++
        return json({ view: { kind: 'main' }, rows: [], parts: [{ part: 'mail', state: 'ok' }, { part: 'chat', state: 'ok' }], mailboxes: [], more: false, looseDrafts: [] })
      }
      if (url.pathname === '/api/read') return json({ mail: { state: 'skipped' }, chat: { state: 'skipped' } })
      calls.other.push(url.pathname)
      return json({ error: 'nothing here' }, 403)
    }) as typeof fetch

    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Conversations } = await import('../src/client/Conversations')
    const { LiveContext } = await import('../src/client/liveHub')
    const { LiveHub } = await import('../src/client/live')
    const hub = new LiveHub({ setTimer: (fn) => setTimeout(fn, 0), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) })
    document.body.innerHTML = '<div id="root"></div>'
    const host = document.getElementById('root') as HTMLElement
    const root = createRoot(host)
    const pathname = scope === 'mail' ? '/inbox/dana%40harbor.example' : '/meet'
    await act(async () => {
      root.render(createElement(LiveContext.Provider, { value: hub }, createElement(Conversations, { scope, me: ME, pathname, go: () => undefined })))
      await sleep(60)
    })
    return { act, hub, calls, host, root }
  }
  const tell = async (t: Awaited<ReturnType<typeof open>>, frame: Parameters<Awaited<ReturnType<typeof open>>['hub']['told']>[0]) => {
    await t.act(async () => {
      t.hub.told(frame)
      await sleep(40)
    })
  }

  test('mail moving reads the Inbox’s list and its open conversation, once for a burst; chat or knowledge moving reads nothing in it', async () => {
    const t = await open('mail')
    const before = { list: t.calls.list, conversation: t.calls.conversation }
    await tell(t, { part: 'chat' })
    await tell(t, { part: 'knowledge' })
    expect({ list: t.calls.list, conversation: t.calls.conversation }).toEqual(before)
    await t.act(async () => {
      t.hub.told({ part: 'mail' })
      t.hub.told({ part: 'mail' })
      t.hub.told({ part: 'mail' })
      await sleep(40)
    })
    expect(t.calls.list).toBe(before.list + 1)
    expect(t.calls.conversation).toBe(before.conversation + 1)
    await t.act(async () => t.root.unmount())
  })

  test('documents moving reads the open conversation (its document cards) and not the list; calls moving reads the open conversation too', async () => {
    const t = await open('mail')
    const before = { list: t.calls.list, conversation: t.calls.conversation }
    await tell(t, { part: 'documents' })
    expect({ list: t.calls.list, conversation: t.calls.conversation }).toEqual({ list: before.list, conversation: before.conversation + 1 })
    await tell(t, { part: 'calls' })
    expect({ list: t.calls.list, conversation: t.calls.conversation }).toEqual({ list: before.list, conversation: before.conversation + 2 })
    await t.act(async () => t.root.unmount())
  })

  test('the connection coming back reads the list and the open conversation, whatever moved while it was down', async () => {
    const t = await open('mail')
    const before = { list: t.calls.list, conversation: t.calls.conversation }
    await t.act(async () => {
      t.hub.everything()
      await sleep(40)
    })
    expect({ list: t.calls.list, conversation: t.calls.conversation }).toEqual({ list: before.list + 1, conversation: before.conversation + 1 })
    await t.act(async () => t.root.unmount())
  })

  test('Meet’s list is read again for chat and for calls, and not for mail; a conversation named that is not the open one is not read (none is open here)', async () => {
    const t = await open('chat')
    const before = t.calls.list
    await tell(t, { part: 'mail' })
    expect(t.calls.list).toBe(before)
    await tell(t, { part: 'chat', conversation: 'chat:channel:9' })
    expect(t.calls.list).toBe(before + 1)
    await tell(t, { part: 'calls' })
    expect(t.calls.list).toBe(before + 2)
    expect(t.calls.conversation).toBe(0)
    await t.act(async () => t.root.unmount())
  })
})

