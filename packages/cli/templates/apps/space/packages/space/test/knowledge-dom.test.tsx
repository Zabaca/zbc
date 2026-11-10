// The knowledge base as a browser runs it, in a stand-in DOM, over the real routes of the Worker (src/knowledge.ts) and a stand-in knowledge app: what a press does, and
// what it does NOT do. An entry needs a business before it can be added, and "Every business" ticks the three; one added twice is added once and says so; an edit over an
// entry that moved on is refused and cannot wipe the newer version; a proposal gone out of date can only be rejected; a change of businesses is kept in the history. The
// DOM is registered for this file only, so React is imported after it (as settings-dom.test.tsx does).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { changeKnowledge, readKnowledge } from '../src/knowledge'
import { fixtureKnowledge } from '../src/fixture-knowledge'
import { standInKnowledge } from '../src/stand-in-knowledge'
import { OWNER_SIGNED_IN } from './signed-in'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

/** The Worker's two knowledge routes over a stand-in knowledge app, as the page's `fetch` reaches them. */
function standInWorker() {
  const knowledge = standInKnowledge(fixtureKnowledge(NOW), { now: () => NOW })
  const ask = { apps: { inbox: undefined, meet: undefined, knowledge: knowledge.methods }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50, writeWithinMs: 200 }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const got = init?.method === 'POST' ? await changeKnowledge(ask, JSON.parse(String(init.body))) : await readKnowledge(ask, url.searchParams.get('business'))
    return got.ok ? json(got.value) : json({ error: got.message }, 400)
  }) as typeof fetch
  return knowledge
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

/** The knowledge base with the choice held in a variable, as the address holds it on the page. */
async function openPage(business: string | null = null) {
  const { Knowledge } = await import('../src/client/Knowledge')
  let chosen = business
  const picks: (string | null)[] = []
  const page = await mount((h) => h(Knowledge, { business: chosen, onPick: (id: string | null) => void (chosen = id, picks.push(id)) }) as never)
  return { page, picks }
}

describe('adding an entry, pressed', () => {
  test('it waits for a business, "Every business" ticks the three, and the entry is added for those', async () => {
    const app = standInWorker()
    const { page } = await openPage()
    await page.click(page.q('add-entry'))
    await page.type(page.q('new-title'), 'Parking')
    await page.type(page.q('new-body'), 'Free in the back lot.')
    expect(page.q<HTMLButtonElement>('submit-entry')?.disabled).toBe(true)
    expect(page.q('pick-one')).not.toBeNull()
    await page.click(page.q('pick-every'))
    expect(page.q<HTMLButtonElement>('submit-entry')?.disabled).toBe(false)
    expect(page.q('pick-one')).toBeNull()
    await page.submit(page.q('new-title'))
    const added = app.state.entries.find((e) => e.title === 'Parking')
    expect(added?.businesses).toEqual(['northfield', 'ridgeway-cycles', 'shiftlantern']) // stored as the three, not as "every"
    expect(page.all('entry').some((e) => e.textContent?.includes('Parking'))).toBe(true)
    await page.unmount()
  })

  test('the same entry again is the app’s refusal, said, and one entry is there', async () => {
    const app = standInWorker()
    const { page } = await openPage('northfield')
    const add = async () => {
      if (!page.q('new-title')) await page.click(page.q('add-entry'))
      await page.type(page.q('new-title'), 'Parking')
      await page.type(page.q('new-body'), 'Free in the back lot.')
      await page.submit(page.q('new-title'))
    }
    // In Northfield's list the form begins with Northfield Works ticked.
    await page.click(page.q('add-entry'))
    expect(page.q<HTMLInputElement>('pick-northfield')?.checked).toBe(true)
    const before = app.state.entries.length
    await add()
    expect(app.state.entries).toHaveLength(before + 1)
    await add()
    expect(app.state.entries).toHaveLength(before + 1)
    expect(page.q('say')?.textContent).toContain('already there')
    await page.unmount()
  })
})

describe('the row of choices, pressed', () => {
  test('picking a business tells the page, which holds the choice in its address', async () => {
    standInWorker()
    const { page, picks } = await openPage()
    await page.click(page.q('kb-ridgeway-cycles'))
    await page.click(page.q('kb-all'))
    expect(picks).toEqual(['ridgeway-cycles', null])
    await page.unmount()
  })

  test('a choice the base does not list is shown as All, not as an empty page', async () => {
    standInWorker()
    const { page } = await openPage('atlantis')
    expect(page.q('reads-line')).toBeNull()
    expect(page.all('entry').length).toBeGreaterThan(5)
    await page.unmount()
  })
})

describe('editing, pressed', () => {
  test('AN EDIT OVER AN ENTRY THAT MOVED ON IS REFUSED, THE CARD LEAVES EDITING TO SHOW IT AS IT IS NOW, AND A SECOND SAVE CANNOT WIPE THE NEWER VERSION', async () => {
    const app = standInWorker()
    const { page } = await openPage()
    const card = () => page.all('entry').find((e) => e.getAttribute('data-id') === 'k-pricing') as HTMLElement
    const stored = () => app.state.entries.find((e) => e.id === 'k-pricing') as { version: number; body: string }
    const edits = () => app.calls.filter((c) => c.method === 'changeKnowledge').map((c) => c.args[0] as { version: number; body: string })
    expect(stored().version).toBe(2)
    await page.click(card().querySelector('[data-testid="edit-entry"]'))
    // Somewhere else the entry moved on to v3 (a version the page was not shown).
    stored().version = 3
    stored().body = 'A fitting is $259, changed elsewhere.'
    await page.type(card().querySelector('[data-testid="edit-body"]'), 'A fitting is $1.')
    await page.click(card().querySelector('[data-testid="save-entry"]'))
    expect(edits().map((e) => e.version)).toEqual([2])
    expect(stored().body).toBe('A fitting is $259, changed elsewhere.')
    expect(card().querySelector('[data-testid="edit-body"]')).toBeNull()
    expect(card().textContent).toContain('A fitting is $259, changed elsewhere.')
    expect(card().querySelector('[data-testid="lost-words"]')?.textContent).toContain('A fitting is $1.')
    expect(page.q('say')?.textContent).toContain('changed since you saw it')
    await page.click(card().querySelector('[data-testid="edit-entry"]'))
    expect((card().querySelector('[data-testid="edit-body"]') as HTMLTextAreaElement).value).toBe('A fitting is $259, changed elsewhere.')
    await page.type(card().querySelector('[data-testid="edit-body"]'), 'A fitting is $299.')
    await page.click(card().querySelector('[data-testid="save-entry"]'))
    expect(edits().map((e) => e.version)).toEqual([2, 3])
    expect(stored()).toMatchObject({ version: 4, body: 'A fitting is $299.' })
    await page.unmount()
  })

  test('a change of businesses alone is a version, and the history says whom the entry is now told to', async () => {
    const app = standInWorker()
    const { page } = await openPage()
    const card = () => page.all('entry').find((e) => e.getAttribute('data-id') === 'k-hours') as HTMLElement
    await page.click(card().querySelector('[data-testid="edit-entry"]'))
    // Hours was for Ridgeway alone; tick Northfield Works as well and leave the words as they are.
    await page.click(card().querySelector('[data-testid="pick-northfield"]'))
    await page.click(card().querySelector('[data-testid="save-entry"]'))
    expect(app.state.entries.find((e) => e.id === 'k-hours')).toMatchObject({ version: 2, businesses: ['northfield', 'ridgeway-cycles'] })
    await page.click(card().querySelector('[data-testid="history-entry"]'))
    expect(card().querySelector('[data-testid="history"]')?.textContent).toContain('Now for Northfield Works and Ridgeway Cycles (was Ridgeway Cycles).')
    await page.unmount()
  })

  test('an entry cannot be left with no business: Save waits', async () => {
    standInWorker()
    const { page } = await openPage()
    const card = () => page.all('entry').find((e) => e.getAttribute('data-id') === 'k-hours') as HTMLElement
    await page.click(card().querySelector('[data-testid="edit-entry"]'))
    await page.click(card().querySelector('[data-testid="pick-ridgeway-cycles"]'))
    expect((card().querySelector('[data-testid="save-entry"]') as HTMLButtonElement).disabled).toBe(true)
    await page.unmount()
  })
})

describe('what waits for Tessa, pressed', () => {
  test('a proposal gone out of date can only be rejected, and rejecting it keeps it under Removed', async () => {
    const app = standInWorker()
    const { page } = await openPage()
    const card = () => page.all('entry').find((e) => e.getAttribute('data-id') === 'k-pricing-change') as HTMLElement
    expect(card().querySelector('[data-testid="approve-entry"]')).toBeNull()
    await page.click(card().querySelector('[data-testid="reject-entry"]'))
    expect(app.state.entries.find((e) => e.id === 'k-pricing-change')?.status).toBe('removed')
    expect(app.state.entries.find((e) => e.id === 'k-pricing')?.version).toBe(2) // the price he corrected stands
    expect(page.q('removed')?.textContent).toContain('Removed (2)')
    await page.unmount()
  })

  test('approving a current change applies its words as his edit, and the entry shows them', async () => {
    const app = standInWorker()
    const { page } = await openPage()
    const waiting = () => page.all('entry').find((e) => e.getAttribute('data-id') === 'k-hours-change') as HTMLElement
    await page.click(waiting().querySelector('[data-testid="approve-entry"]'))
    expect(app.state.entries.find((e) => e.id === 'k-hours')).toMatchObject({ version: 2, body: 'Open Monday to Friday 9 to 6, and Saturday 9 to 1. Closed Sunday.' })
    expect(page.all('entry').some((e) => e.getAttribute('data-id') === 'k-hours' && e.textContent?.includes('9 to 6'))).toBe(true)
    await page.unmount()
  })

  test('a removal asks first, and a removed entry is put back', async () => {
    const app = standInWorker()
    const { page } = await openPage()
    const card = (id: string) => page.all('entry').find((e) => e.getAttribute('data-id') === id) as HTMLElement
    await page.click(card('k-reply').querySelector('[data-testid="remove-entry"]'))
    expect(page.q('ask')).not.toBeNull()
    expect(app.state.entries.find((e) => e.id === 'k-reply')?.status).toBe('active')
    await page.click(page.q('ask-yes'))
    expect(app.state.entries.find((e) => e.id === 'k-reply')?.status).toBe('removed')
    await page.click(card('k-old').querySelector('[data-testid="restore-entry"]'))
    expect(app.state.entries.find((e) => e.id === 'k-old')?.status).toBe('active')
    await page.unmount()
  })
})

describe('when the knowledge app cannot be reached', () => {
  test('the page says so, with a way to try again, and shows no entries it did not read', async () => {
    const app = standInWorker()
    app.script.push('throw')
    const { page } = await openPage()
    expect(page.q('say')?.textContent).toContain('Knowledge could not be reached')
    expect(page.all('entry')).toHaveLength(0)
    await page.click(page.q('say')?.querySelector('button') ?? null)
    expect(page.all('entry').length).toBeGreaterThan(5)
    await page.unmount()
  })
})
