// Each screen that draws live data, as a browser runs it, under a hub the test drives: when the part it draws moves it reads again, when another part
// moves it does not, when the connection comes back it does, and when the page is shown again it does. What the screens do with the answer is their own tests; here the answer is a refusal (503), which each draws
// as its own "could not be read" state, so what is counted is the reads and nothing about the data. The DOM is registered for this file only (as refresh.test.tsx does).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { LivePart } from '@space/workspace'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'

const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://space.northfield.example/' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const CLIENT = { id: '11111111-1111-4111-8111-111111111111', slug: 'lane', client_number: 1001, client_archived: false, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', accent_color: '#7a2e1d', reply_to: 'office@lane.example', copy_addresses: [], time_zone: 'America/Los_Angeles', retention_years: 7, has_logo: false, logo_type: null, logo_sha256: null, created_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:00:00Z' }

let unmount: (() => Promise<void>) | null = null
afterEach(async () => {
  await unmount?.()
  unmount = null
  globalThis.fetch = realFetch
})

/** Mount `screen` under a hub of the test's own; reads are counted by path (and query) in `reads`. */
async function mount(screen: (react: typeof import('react')) => import('react').ReactElement) {
  const reads: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://space.northfield.example')
    reads.push(url.pathname + url.search)
    if (url.pathname === `/forms/api/clients/${CLIENT.id}`) return Response.json(CLIENT)
    return Response.json({ error: 'not here' }, { status: 503 })
  }) as typeof fetch
  const react = await import('react')
  const { act, createElement } = react
  const { createRoot } = await import('react-dom/client')
  const { LiveContext } = await import('../src/client/liveHub')
  const { LiveHub } = await import('../src/client/live')
  const hub = new LiveHub({ setTimer: (fn) => setTimeout(fn, 0), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) })
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  unmount = () => act(async () => root.unmount())
  await act(async () => {
    root.render(createElement(LiveContext.Provider, { value: hub }, screen(react)))
    await sleep(60)
  })
  const count = (path: string) => reads.filter((r) => r === path || r.startsWith(`${path}?`)).length
  const told = async (part: LivePart) => {
    await act(async () => {
      hub.told({ part })
      await sleep(40)
    })
  }
  const everything = async () => {
    await act(async () => {
      hub.everything()
      await sleep(40)
    })
  }
  const shown = async () => {
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      await sleep(40)
    })
  }
  return { reads, count, told, everything, shown }
}

/** What every screen does: reads again for the parts it draws, for nothing else, when the connection comes back and when the page is shown again. */
async function behaves(path: string, draws: LivePart[], screen: Parameters<typeof mount>[0]) {
  const s = await mount(screen)
  const first = s.count(path)
  expect(first).toBeGreaterThanOrEqual(1)
  const others = (['mail', 'chat', 'calls', 'documents', 'knowledge', 'clients'] as LivePart[]).filter((p) => !draws.includes(p))
  for (const part of others) await s.told(part)
  expect([path, 'other parts', s.count(path)]).toEqual([path, 'other parts', first])
  let expected = first
  for (const part of draws) {
    await s.told(part)
    expected += 1
    expect([path, part, s.count(path)]).toEqual([path, part, expected])
  }
  await s.everything()
  expect([path, 'reconnected', s.count(path)]).toEqual([path, 'reconnected', expected + 1])
  await s.shown()
  expect([path, 'shown again', s.count(path)]).toEqual([path, 'shown again', expected + 2])
}

describe('the screens that draw live data read again for the parts they draw', () => {
  test('Today: mail, chat, calls and documents', async () => {
    await behaves('/api/today', ['mail', 'chat', 'calls', 'documents'], ({ createElement }) => {
      const { Today } = require('../src/client/Today') as typeof import('../src/client/Today')
      return createElement(Today, { me: ME, pathname: '/today', search: '', go: () => undefined })
    })
  })

  test('People: mail, chat and the Clients’ names on the pills', async () => {
    await behaves('/api/people', ['mail', 'chat', 'clients'], ({ createElement }) => {
      const { People } = require('../src/client/People') as typeof import('../src/client/People')
      return createElement(People, { pathname: '/people', go: () => undefined })
    })
  })

  test('a person’s page: mail, chat, documents and the Client’s name, and when the page is shown again', async () => {
    await behaves('/api/person', ['mail', 'chat', 'documents', 'clients'], ({ createElement }) => {
      const { People } = require('../src/client/People') as typeof import('../src/client/People')
      return createElement(People, { pathname: '/people/dana%40harbor.example', go: () => undefined })
    })
  })

  test('Settings, Clients: the Clients and the mail that holds their people', async () => {
    await behaves('/api/clients/list', ['clients', 'mail'], ({ createElement }) => {
      const { Settings } = require('../src/client/Settings') as typeof import('../src/client/Settings')
      return createElement(Settings, { me: ME, pathname: '/settings/clients', go: () => undefined })
    })
  })

  test('a Client’s page: the same two', async () => {
    await behaves('/api/clients/one', ['clients', 'mail'], ({ createElement }) => {
      const { Settings } = require('../src/client/Settings') as typeof import('../src/client/Settings')
      return createElement(Settings, { me: ME, pathname: '/settings/clients/7', go: () => undefined })
    })
  })

  test('Knowledge: knowledge', async () => {
    await behaves('/api/knowledge', ['knowledge'], ({ createElement }) => {
      const { Knowledge } = require('../src/client/Knowledge') as typeof import('../src/client/Knowledge')
      return createElement(Knowledge, { business: null, onPick: () => undefined })
    })
  })

  test('the menu’s counts and Clients: mail and clients', async () => {
    await behaves('/api/inbox/navigation', ['mail', 'clients'], ({ createElement }) => {
      const { useNavData } = require('../src/client/nav') as typeof import('../src/client/nav')
      const Probe = () => (useNavData(), null)
      return createElement(Probe)
    })
  })

  test('the unread count in the tab’s title: chat', async () => {
    await behaves('/api/meet/unread', ['chat'], ({ createElement }) => {
      const { useChatUnread } = require('../src/client/unread') as typeof import('../src/client/unread')
      const Probe = () => (useChatUnread(), null)
      return createElement(Probe)
    })
  })
})

describe('the Forms pages read again when documents move', () => {
  test('the Envelopes list', async () => {
    const { FormsTab } = await import('../src/client/forms/FormsTab')
    await behaves('/forms/api/envelopes', ['documents'], ({ createElement }) => createElement(FormsTab, { pathname: '/forms/envelopes', search: '', go: () => undefined }))
  })

  test('an envelope’s own page', async () => {
    const { FormsTab } = await import('../src/client/forms/FormsTab')
    await behaves('/forms/api/envelopes/0b1c2d3e-0000-4000-8000-000000000001', ['documents'], ({ createElement }) => createElement(FormsTab, { pathname: '/forms/envelopes/0b1c2d3e-0000-4000-8000-000000000001', search: '', go: () => undefined }))
  })

  test('a client’s page, with its recent envelopes', async () => {
    const { FormsTab } = await import('../src/client/forms/FormsTab')
    await behaves('/forms/api/envelopes', ['documents'], ({ createElement }) => createElement(FormsTab, { pathname: `/forms/clients/${CLIENT.id}`, search: '', go: () => undefined }))
  })
})

describe('the safety net', () => {
  test('is ten minutes, and nothing reads on its own sooner', async () => {
    const { SAFETY_NET_MS } = await import('../src/client/notify')
    expect(SAFETY_NET_MS).toBe(600_000)
    const s = await mount(({ createElement }) => {
      const { Knowledge } = require('../src/client/Knowledge') as typeof import('../src/client/Knowledge')
      return createElement(Knowledge, { business: null, onPick: () => undefined })
    })
    const first = s.count('/api/knowledge')
    await sleep(120)
    expect(s.count('/api/knowledge')).toBe(first)
  })
})
