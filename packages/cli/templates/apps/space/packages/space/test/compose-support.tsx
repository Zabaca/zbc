// What the DOM tests of writing share: the Worker's routes over the local fixtures as the page's `fetch` reaches them, and a way to mount a component in a stand-in DOM and press things.
// The DOM itself is registered by each test file (beforeAll), so React is imported after it, here and there.
import { expect } from 'bun:test'
import { northfield } from '../../workspace/test/helpers'
import { openConversation, parseEmail, sendEmail } from '../src/conversation'
import { openDraft } from '../src/drafts'
import { readFiles } from '../src/files'
import { search } from '../src/list'
import { people, person } from '../src/people'
import { type FixtureMode, fixtureApps } from '../src/stand-ins'
import { READ_NAMES, type ReadName, WRITE_NAMES, type WriteName, putDraftPictureView, readView, writeView } from '../src/views'
import { OWNER_SIGNED_IN } from './signed-in'

export const realFetch = globalThis.fetch
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)

export interface Called {
  method: string
  path: string
  body: unknown
}

/** The Worker's routes for these screens over the local fixtures, as the page's `fetch` reaches them. Every call is kept. */
export function standInWorker(mode: FixtureMode = '1') {
  const apps = fixtureApps(NOW, mode)
  const calls: Called[] = []
  const ask = { apps: { inbox: apps.inbox, meet: apps.meet, forms: apps.forms }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100, writeWithinMs: 300, now: () => NOW }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    const raw = init?.body
    calls.push({ method, path: url.pathname + url.search, body: typeof raw === 'string' ? JSON.parse(raw) : raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name])) : undefined })
    if (url.pathname === '/api/people') return json(await people(ask, { automated: false }))
    if (url.pathname === '/api/search') return json(await search(ask, url.searchParams.get('q') ?? ''))
    if (url.pathname === '/api/person') {
      const found = await person(ask, url.searchParams.get('key') ?? '')
      return found.ok ? json(found.value) : json({ error: found.message }, found.status)
    }
    if (url.pathname === '/api/conversation') {
      const opened = await openConversation(ask, url.searchParams.get('key') ?? '')
      return opened.ok ? json(opened.value) : json({ error: opened.message }, opened.status)
    }
    if (url.pathname === '/api/draft') {
      const opened = await openDraft(ask, url.searchParams.get('id') ?? '')
      return opened.ok ? json(opened.value) : json({ error: opened.message }, opened.status)
    }
    if (url.pathname === '/api/read') return json({ mail: { state: 'skipped' }, chat: { state: 'skipped' } })
    // A picture put on a Telegram draft: the form the card's Edit posts.
    if (url.pathname === '/api/draft-picture' && raw instanceof FormData) {
      const files = await readFiles(raw)
      if (!files.ok || files.files.length !== 1) return json({ error: 'A draft carries one picture.' }, 400)
      const put = await putDraftPictureView(ask, JSON.parse(String(raw.get('json'))), files.files[0] as never)
      return put.ok ? json(put.value) : json({ error: put.message }, 400)
    }
    if (url.pathname === '/api/email' || url.pathname === '/api/email/files') {
      let body: unknown
      let attachments: Awaited<ReturnType<typeof readFiles>> | null = null
      if (raw instanceof FormData) {
        body = JSON.parse(String(raw.get('json')))
        attachments = await readFiles(raw)
      } else body = JSON.parse(String(raw))
      const parsed = parseEmail(body, { wordsMayBeEmpty: raw instanceof FormData })
      if (!parsed.ok) return json({ error: parsed.message }, 400)
      if (attachments && !attachments.ok) return json({ error: attachments.message }, 400)
      return json(await sendEmail(ask, attachments?.ok ? { ...parsed.value, attachments: attachments.files } : parsed.value))
    }
    const name = url.pathname.replace('/api/inbox/', '')
    if (method === 'POST') {
      const got = WRITE_NAMES.includes(name as WriteName) ? await writeView(ask, name as WriteName, JSON.parse(String(raw)), null) : { ok: false as const, message: 'no' }
      return got.ok ? json(got.value) : json({ error: got.message }, 400)
    }
    const got = READ_NAMES.includes(name as ReadName) ? await readView(ask, name as ReadName, url.searchParams) : { ok: false as const, message: 'no' }
    return got.ok ? json(got.value) : json({ error: got.message }, 400)
  }) as typeof fetch
  return { apps, calls }
}

export async function mount(node: (h: typeof import('react').createElement, react: typeof import('react')) => React.ReactElement) {
  const react = await import('react')
  const { act, createElement } = react
  const { createRoot } = await import('react-dom/client')
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(node(createElement, react))
    await sleep(150)
  })
  const q = <T extends Element = HTMLElement>(testid: string) => document.querySelector(`[data-testid="${testid}"]`) as T | null
  const all = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  const click = async (el: Element | null) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      ;(el as HTMLElement).click()
      await sleep(150)
    })
  }
  const type = async (el: Element | null, value: string) => {
    if (!el) throw new Error('nothing to type in')
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
      await sleep(10)
    })
  }
  const submit = async (el: Element | null) => {
    await act(async () => {
      el?.closest('form')?.requestSubmit()
      await sleep(200)
    })
  }
  const attach = async (el: Element | null, files: File[]) => {
    await act(async () => {
      Object.defineProperty(el, 'files', { value: files, configurable: true })
      el?.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(10)
    })
  }
  const wait = (ms: number) => act(async () => void (await sleep(ms)))
  return { q, all, click, type, submit, attach, wait, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()) }
}

