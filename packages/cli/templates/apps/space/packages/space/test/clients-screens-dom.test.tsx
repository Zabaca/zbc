// Settings › Clients and People's Link to a Client as a browser runs them, in a stand-in DOM, over the Worker's own functions (src/clients-settings.ts, src/views.ts) and the invented Clients of the local fixtures
// (src/stand-in-clients.ts): what Tessa sees in the list and on a Client's page, what a press does and what it does NOT do. New makes a Client; Edit names the revision it was shown and a stale screen is refused with what
// was typed still in the boxes; Archive and Put back move a Client between the list and its fold; a name that follows its source says so, and one Tessa edited says what the source calls it; a Client made from People is
// linked in the same press, and when the link fails the Client is still made and the sentence says so. The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { archiveClientView, editClientView, makeClientView, readClientScreen, readClientsScreen } from '../src/clients-settings'
import { fixtureApps } from '../src/stand-ins'
import { READ_NAMES, type ReadName, WRITE_NAMES, type WriteName, readView, writeView } from '../src/views'
import { OWNER_SIGNED_IN } from './signed-in'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

/** The Worker's Clients routes and the inbox's views over the local fixtures, as the page's `fetch` reaches them. */
function standInWorker() {
  const apps = fixtureApps(NOW, '1')
  const ask = { apps: { inbox: apps.inbox, meet: apps.meet, forms: apps.forms, formsNames: apps.formsNames, clients: apps.clients }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100, writeWithinMs: 300, now: () => NOW }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/clients/list') return json(await readClientsScreen(ask))
    if (url.pathname === '/api/clients/one') return json(await readClientScreen(ask, Number(url.searchParams.get('number'))))
    if (init?.method === 'POST' && url.pathname.startsWith('/api/clients/')) {
      const body = JSON.parse(String(init.body))
      const got =
        url.pathname === '/api/clients/make' ? await makeClientView(ask, body) : url.pathname === '/api/clients/edit' ? await editClientView(ask, body) : await archiveClientView(ask, body, url.pathname === '/api/clients/put-back')
      return got.ok ? json(got.value) : json({ error: got.message }, 400)
    }
    const name = url.pathname.replace('/api/inbox/', '')
    if (init?.method === 'POST') {
      const got = WRITE_NAMES.includes(name as WriteName) ? await writeView(ask, name as WriteName, JSON.parse(String(init.body)), null) : { ok: false as const, message: 'no' }
      return got.ok ? json(got.value) : json({ error: got.message }, 400)
    }
    const got = READ_NAMES.includes(name as ReadName) ? await readView(ask, name as ReadName, url.searchParams) : { ok: false as const, message: 'no' }
    return got.ok ? json(got.value) : json({ error: got.message }, 400)
  }) as typeof fetch
  return apps
}

async function mount(node: (h: typeof import('react').createElement, react: typeof import('react')) => React.ReactElement) {
  const react = await import('react')
  const { act, createElement } = react
  const { createRoot } = await import('react-dom/client')
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(node(createElement, react))
    await sleep(120)
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
  return { q, all, click, type, submit, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()) }
}

/** The numbers of the Clients drawn inside the list, fold or section that carries `testid`. */
const ids = (page: { q(testid: string): HTMLElement | null }, testid: string): string[] => [...(page.q(testid)?.querySelectorAll('[data-testid="client"]') ?? [])].map((e) => e.getAttribute('data-id') ?? '')

/** Settings at an address of its own: a press that moves the page changes `pathname`, as the app's router does. */
async function openSettings(path = '/settings/clients') {
  const { Settings } = await import('../src/client/Settings')
  const { meOf } = await import('../src/app')
  const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
  const went: string[] = []
  const page = await mount((h, { useState }) => {
    function Shell() {
      const [pathname, setPathname] = useState(path)
      return h(Settings, { me, pathname, go: (p: string) => void (went.push(p), setPathname(p)) })
    }
    return h(Shell) as never
  })
  return { page, went }
}

describe('the list', () => {
  test('the active Clients with their people and where each came from, a line for when the source last sent, and the archived in a fold of their own', async () => {
    standInWorker()
    const { page } = await openSettings()
    expect(ids(page, 'clients')).toEqual(['3', '6', '7', '9', '1001'])
    expect(ids(page, 'archived-clients')).toEqual(['5'])
    expect(ids(page, 'unlisted')).toEqual(['12'])
    expect(page.q('source-line')?.textContent).toContain('northfield.example last sent something')
    expect(page.q('source-line')?.textContent).toContain('the full set')
    const harbor = document.querySelector('[data-testid="clients"] [data-id="7"]')
    expect(harbor?.textContent).toContain('Harbor Dental')
    expect(harbor?.textContent).toContain('Harbor Dental Group, Inc.')
    expect(harbor?.textContent).toContain('2 people, 9 conversations, 3 open.')
    expect(harbor?.textContent).toContain('From northfield.example.')
    // The declaration marks the subscription as a field the list shows, under its label; a Client the source said no subscription of shows none.
    expect(harbor?.textContent).toContain('Subscription: active')
    expect(document.querySelector('[data-testid="clients"] [data-id="1001"]')?.textContent).not.toContain('Subscription')
    const row = (id: string) => document.querySelector(`[data-testid="clients"] [data-id="${id}"]`)
    expect(row('1001')?.textContent).toContain('Made here.')
    expect(row('6')?.textContent).toContain('northfield.example no longer lists it')
    // The archived Client is in the fold, not the list; a number only people hold is apart, by number.
    expect(page.q('archived-fold')?.textContent).toContain('Old Harbor Marine')
    expect(page.q('clients')?.textContent).not.toContain('Old Harbor Marine')
    expect(page.q('unlisted')?.textContent).toContain('Client 12')
    expect(page.q('new-client')?.textContent).toBe('New Client')
    await page.unmount()
  })

  test('an install with no Clients says so and offers New Client: no source line, no fold, no unlisted numbers', async () => {
    const apps = standInWorker()
    apps.clientsStandIn.state.clients.length = 0
    apps.clientsStandIn.state.source = null
    apps.inbox.views.state.clients.length = 0
    const { page } = await openSettings()
    expect(page.q('no-clients')?.textContent).toContain('There are no Clients yet. New Client makes one.')
    expect(page.q('new-client')?.textContent).toBe('New Client')
    expect(ids(page, 'clients')).toEqual([])
    expect(page.q('source-line')).toBeNull()
    expect(page.q('archived-fold')).toBeNull()
    expect(page.q('unlisted')).toBeNull()
    expect(page.q('directory-down')).toBeNull()
    await page.unmount()
  })

  test('with the inbox not counting the people, the Clients are still there, with a sentence, and the counts are not claimed', async () => {
    const apps = standInWorker()
    apps.inbox.views.script.push('throw')
    const { page } = await openSettings()
    expect(ids(page, 'clients')).toHaveLength(5)
    expect(page.q('directory-down')?.textContent).toContain('not counted')
    await page.unmount()
  })
})

describe('New Client', () => {
  test('a name is all it needs: it makes the Client from 1001 up, and the page then shows it', async () => {
    const apps = standInWorker()
    const { page, went } = await openSettings()
    await page.click(page.q('new-client'))
    expect(went).toEqual(['/settings/clients/new'])
    expect(page.q<HTMLButtonElement>('make-client')?.disabled).toBe(true)
    await page.type(page.q('field-name'), '  Sunrise   Plumbing ')
    expect(page.q<HTMLButtonElement>('make-client')?.disabled).toBe(false)
    await page.submit(page.q('new-client-form'))
    expect(apps.clientsStandIn.state.clients.map((c) => c.name)).toContain('Sunrise Plumbing')
    expect(went.at(-1)).toBe('/settings/clients/1002')
    expect(page.q('client-details')?.textContent).toContain('Sunrise Plumbing')
    expect(page.q('client-details')?.textContent).toContain('Made here')
    expect(page.q('from-source')).toBeNull()
    await page.unmount()
  })

  test('a Client the part could not make is said in its words, nothing is made, and what was typed is still in the boxes', async () => {
    const apps = standInWorker()
    const { page, went } = await openSettings('/settings/clients/new')
    const before = apps.clientsStandIn.state.clients.length
    await page.type(page.q('field-name'), 'Sunrise Plumbing')
    apps.clientsStandIn.script.push('broken')
    await page.submit(page.q('new-client-form'))
    expect(page.q('say')?.textContent).toContain('The Clients could not answer that. Nothing was changed.')
    expect(apps.clientsStandIn.state.clients.length).toBe(before)
    expect(page.q<HTMLInputElement>('field-name')?.value).toBe('Sunrise Plumbing')
    expect(went).toEqual([])
    await page.unmount()
  })
})

describe('a Client’s page', () => {
  test('a Client the source brought in: its fields under the declaration’s labels, the admin address, and that its names follow the source', async () => {
    standInWorker()
    const { page } = await openSettings('/settings/clients/7')
    expect(page.q('client-details')?.textContent).toContain('Harbor Dental')
    expect(page.q('follows')?.textContent).toContain('names follow northfield.example')
    expect(page.q('from-source')?.textContent).toContain('From northfield.example')
    const fields = page.all('source-field').map((f) => [f.getAttribute('data-key'), f.textContent])
    expect(fields.map(([k]) => k)).toEqual(['signInAddress', 'subscriptionStatus', 'subscriptionAt'])
    expect(fields[0]?.[1]).toBe('Client Portal sign-indana@harbordental.example')
    expect(fields[1]?.[1]).toBe('Subscriptionactive')
    expect(page.q('client-admin')?.textContent).toBe('Open in northfield.example’s admin')
    expect(page.q('client-admin')?.getAttribute('href')).toBe('https://admin.example.test/clients#client-7')
    expect(page.text()).toContain('Their people (2)')
    expect(page.q('suggestions')?.textContent).toContain('Priyanka Mehta')
    await page.unmount()
  })

  test('a name Tessa edited stands, and the page says what the source calls it; a Client the source stopped listing says since when', async () => {
    standInWorker()
    const { page } = await openSettings('/settings/clients/3')
    expect(page.q('edited-name')?.textContent).toContain('northfield.example calls it “Tamarack Print Supply Co”. Your name stands.')
    expect(page.q('follows')).toBeNull()
    await page.unmount()
    const gone = await openSettings('/settings/clients/6')
    expect(gone.page.q('gone')?.textContent).toContain('northfield.example no longer lists this Client, since')
    await gone.page.unmount()
  })

  test('a Client made here has no source part at all, and a number nobody holds is shown by number with its people', async () => {
    standInWorker()
    const here = await openSettings('/settings/clients/1001')
    expect(here.page.q('from-source')).toBeNull()
    expect(here.page.q('names-note')).toBeNull()
    expect(here.page.q('client-admin')).toBeNull()
    await here.page.unmount()
    const orphan = await openSettings('/settings/clients/12')
    expect(orphan.page.q('not-held')?.textContent).toContain('No Client has this number')
    expect(orphan.page.q('edit-client')).toBeNull()
    expect(orphan.page.text()).toContain('Walt Ibarra')
    await orphan.page.unmount()
  })

  test('Link on a suggestion links the person and they count as the Client’s people', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/7')
    await page.click(page.q('link-person'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'linkClient').map((c) => c.args)).toEqual([['c-hygienist', 7]])
    expect(page.q('done')?.textContent).toContain('Linked.')
    await page.unmount()
  })
})

describe('Edit', () => {
  test('Save is not offered until something changed; it names the revision shown and the page then shows the new name', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/7')
    await page.click(page.q('edit-client'))
    expect(page.q<HTMLButtonElement>('save-client')?.disabled).toBe(true)
    await page.type(page.q('field-name'), 'Harbor Dental Care')
    await page.submit(page.q('edit-client-form'))
    expect(apps.clientsStandIn.calls.filter((c) => c.method === 'editClient').map((c) => c.args)).toEqual([[7, 1, { name: 'Harbor Dental Care', legalName: 'Harbor Dental Group, Inc.' }]])
    expect(page.q('edit-client-form')).toBeNull()
    expect(page.q('client-details')?.textContent).toContain('Harbor Dental Care')
    // It was a name the source gave, and now it is Tessa's: the page says so.
    expect(page.q('edited-name')?.textContent).toContain('northfield.example calls it “Harbor Dental”')
    await page.unmount()
  })

  test('over a screen that is out of date nothing is saved, what was typed stays in the boxes beside the Client as it is now, and one press takes the newer', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/9')
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-name'), 'Lakeside Print & Sign')
    // Someone else (another tab of Tessa's) renames it first.
    await apps.clientsStandIn.methods.editClient(OWNER_SIGNED_IN, 9, 1, { name: 'Lakeside Printing' })
    await page.submit(page.q('edit-client-form'))
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 9)?.name).toBe('Lakeside Printing')
    expect(page.q('newer')?.textContent).toContain('nothing you typed was saved')
    expect(page.q('newer')?.textContent).toContain('name “Lakeside Printing”')
    expect(page.q<HTMLInputElement>('field-name')?.value).toBe('Lakeside Print & Sign')
    expect(page.q<HTMLButtonElement>('save-client')?.disabled).toBe(true)
    await page.click(page.q('take-newer'))
    expect(page.q<HTMLInputElement>('field-name')?.value).toBe('Lakeside Printing')
    expect(page.q('newer')).toBeNull()
    await page.unmount()
  })

  test('when the page cannot read the Client again after a refused save, the refusal is still said and what was typed stays', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/9')
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-name'), 'Lakeside Print & Sign')
    await apps.clientsStandIn.methods.editClient(OWNER_SIGNED_IN, 9, 1, { name: 'Lakeside Printing' })
    // The save is refused, and the page's read after it fails.
    const working = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/clients/one' && init?.method !== 'POST') throw new Error('offline')
      return working(input, init)
    }) as typeof fetch
    await page.submit(page.q('edit-client-form'))
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 9)?.name).toBe('Lakeside Printing')
    expect(page.all('say').map((e) => e.textContent).join(' ')).toContain('This Client was changed after it was shown, so nothing was changed')
    expect(page.q<HTMLInputElement>('field-name')?.value).toBe('Lakeside Print & Sign')
    await page.unmount()
  })

  test('a legal name emptied is cleared, and Cancel leaves the Client as it was', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/3')
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-legal-name'), '')
    await page.submit(page.q('edit-client-form'))
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 3)?.legalName).toBeNull()
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-name'), 'Nope')
    await page.click(document.querySelector('[data-testid="edit-client-form"] button[type="button"]'))
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 3)?.name).toBe('Tamarack Print Supply')
    await page.unmount()
  })

  test('the legal name of a Client Forms signs for cannot be emptied: the sentence says why, nothing changes, and the boxes keep what was typed', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/7')
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-legal-name'), '')
    await page.submit(page.q('edit-client-form'))
    expect(page.all('say').map((e) => e.textContent).join(' ')).toContain('legal name cannot be cleared')
    expect(page.q<HTMLInputElement>('field-legal-name')?.value).toBe('')
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 7)?.legalName).toBe('Harbor Dental Group, Inc.')
    expect(apps.formsNamesStandIn.rows[0]).toMatchObject({ legalName: 'Harbor Dental Group, Inc.' })
    await page.unmount()
  })
})

describe('Archive and Put back', () => {
  test('Archive takes the Client out of the list into the fold, says its people stay linked; Put back returns it', async () => {
    const apps = standInWorker()
    const { page, went } = await openSettings('/settings/clients/9')
    await page.click(page.q('archive-client'))
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 9)?.archivedAt).not.toBeNull()
    expect(page.q('done')?.textContent).toContain('Archived. Lakeside Print Supply is out of the lists and pickers; its people stay linked.')
    expect(page.q('archived-note')?.textContent).toContain('their mail is treated as before')
    expect(page.q('archive-client')).toBeNull()
    await page.click(document.querySelector('.s-back'))
    expect(went.at(-1)).toBe('/settings/clients')
    expect(ids(page, 'clients')).not.toContain('9')
    expect(ids(page, 'archived-clients')).toContain('9')
    expect(page.q('archived-fold')?.textContent).toContain('Lakeside Print Supply')
    await page.click(document.querySelector('[data-testid="archived-clients"] [data-id="9"]'))
    await page.click(page.q('put-back-client'))
    expect(page.q('done')?.textContent).toContain('Put back. Lakeside Print Supply is in the lists and pickers again.')
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 9)?.archivedAt).toBeNull()
    await page.unmount()
  })
})

describe('People: link to a Client, and New Client from there', () => {
  async function section(contactId: string) {
    const apps = standInWorker()
    const profile = await apps.inbox.contact(OWNER_SIGNED_IN, contactId)
    if (!profile.ok) throw new Error('no such contact')
    const { ClientSection } = await import('../src/client/People')
    const changed: number[] = []
    const went: string[] = []
    const page = await mount((h) => h(ClientSection, { profile: profile.value, onChanged: () => void changed.push(1), go: (p: string) => void went.push(p) }) as never)
    return { apps, page, changed, went }
  }

  test('the picker offers the active Clients and not an archived one, and Link links the person', async () => {
    const { apps, page, changed } = await section('c-lena')
    await page.click(page.q('choose-client'))
    const options = [...(page.q('client-select')?.querySelectorAll('option') ?? [])].map((o) => o.textContent)
    expect(options).toContain('Harbor Dental')
    expect(options).toContain('Fischer Bakery')
    expect(options).not.toContain('Old Harbor Marine')
    await page.type(page.q('client-select'), '1001')
    await page.click(page.q('link-client'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'linkClient').map((c) => c.args)).toEqual([['c-lena', 1001]])
    expect(changed.length).toBe(1)
    await page.unmount()
  })

  test('New Client from the picker makes the Client and links the person in one press', async () => {
    const { apps, page, changed } = await section('c-lena')
    await page.click(page.q('choose-client'))
    await page.click(page.q('new-client-here'))
    await page.type(page.q('field-name'), 'Fischer Bakery & Cafe')
    await page.submit(page.q('new-client-form'))
    expect(apps.clientsStandIn.state.clients.map((c) => c.name)).toContain('Fischer Bakery & Cafe')
    const made = apps.clientsStandIn.state.clients.find((c) => c.name === 'Fischer Bakery & Cafe')
    expect(apps.inbox.views.calls.filter((c) => c.method === 'linkClient').map((c) => c.args)).toEqual([['c-lena', made?.number]])
    expect(page.q('client-done')?.textContent).toContain('Made Fischer Bakery & Cafe and linked Lena Fischer to it.')
    expect(changed.length).toBe(1)
    await page.unmount()
  })

  test('when the link fails the Client is still made and the sentence says the person was not linked', async () => {
    const { apps, page, changed } = await section('c-lena')
    await page.click(page.q('choose-client'))
    await page.click(page.q('new-client-here'))
    await page.type(page.q('field-name'), 'Fischer Cafe')
    apps.inbox.views.script.push('broken')
    await page.submit(page.q('new-client-form'))
    expect(apps.clientsStandIn.state.clients.map((c) => c.name)).toContain('Fischer Cafe')
    expect(page.q('say')?.textContent).toContain('Fischer Cafe was made, but Lena Fischer was not linked to it')
    expect(changed.length).toBe(0)
    // The new Client is in the picker to link by hand.
    expect([...(page.q('client-select')?.querySelectorAll('option') ?? [])].map((o) => o.textContent)).toContain('Fischer Cafe')
    await page.unmount()
  })

  test('a linked person’s “Linked to” names the Client and opens its page', async () => {
    const { page, went } = await section('c-dana')
    expect(page.q('client-name')?.textContent).toContain('Linked to Harbor Dental.')
    await page.click(page.q('client-link'))
    expect(went).toEqual(['/settings/clients/7'])
    await page.unmount()
  })
})

describe('Signing, on a Client’s page', () => {
  test('a Client Forms signs for says so with the way into its signing settings in Forms; the names there are this page’s', async () => {
    const apps = standInWorker()
    const { page, went } = await openSettings('/settings/clients/7')
    expect(page.q('signing-set-up')?.textContent).toContain('Forms is set up to send for Harbor Dental')
    expect(page.q('signing-set-up')?.textContent).toContain('office@harbordental.example')
    expect(page.q('signing')?.textContent).toContain('Forms follows them')
    expect(page.q('set-up-signing')).toBeNull()
    const link = page.q<HTMLAnchorElement>('signing-settings')
    expect(link?.getAttribute('href')).toBe(`/forms/clients/${apps.formsNamesStandIn.rows[0]!.id}`)
    await page.click(link)
    expect(went).toEqual([`/forms/clients/${apps.formsNamesStandIn.rows[0]!.id}`])
    await page.unmount()
  })

  test('a Client Forms does not sign for offers Set up signing, which opens Forms with that Client chosen; an archived one offers nothing but says to put it back', async () => {
    standInWorker()
    const { page, went } = await openSettings('/settings/clients/9')
    expect(page.q('signing-not-set-up')?.textContent).toContain('Forms is not set up to send for Lakeside Print Supply')
    expect(page.q('set-up-signing')?.getAttribute('href')).toBe('/forms/clients/new?client=9')
    await page.click(page.q('set-up-signing'))
    expect(went).toEqual(['/forms/clients/new?client=9'])
    await page.unmount()
    const archived = await openSettings('/settings/clients/5')
    expect(archived.page.q('signing-not-set-up')?.textContent).toContain('put it back')
    expect(archived.page.q('set-up-signing')).toBeNull()
    await archived.page.unmount()
  })

  test('when Forms cannot be asked the section says so and offers nothing', async () => {
    const apps = standInWorker()
    apps.formsNamesStandIn.script.push('throw')
    const { page } = await openSettings('/settings/clients/9')
    expect(page.q('signing-unavailable')?.textContent).toContain('Forms could not be asked just now')
    expect(page.q('set-up-signing')).toBeNull()
    expect(page.q('signing-settings')).toBeNull()
    await page.unmount()
  })

  test('an edit of the name on this page changes the name Forms shows, in the same press', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/7')
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-name'), 'Harbor Dental Care')
    await page.click(page.q('save-client'))
    expect(apps.formsNamesStandIn.rows[0]).toMatchObject({ number: 7, name: 'Harbor Dental Care' })
    expect(page.q('client-details')?.textContent).toContain('Harbor Dental Care')
    await page.unmount()
  })

  test('a name Forms cannot send mail under is refused with the sentence for a Client Forms signs for, and the boxes keep what was typed', async () => {
    const apps = standInWorker()
    const { page } = await openSettings('/settings/clients/7')
    await page.click(page.q('edit-client'))
    await page.type(page.q('field-name'), 'Harbor, Dental')
    await page.click(page.q('save-client'))
    expect(page.q('say')?.textContent).toContain('Forms signs for this Client')
    expect(page.q<HTMLInputElement>('field-name')?.value).toBe('Harbor, Dental')
    expect(apps.formsNamesStandIn.rows[0]).toMatchObject({ name: 'Harbor Dental' })
    expect(apps.clientsStandIn.state.clients.find((c) => c.number === 7)?.name).toBe('Harbor Dental')
    await page.unmount()
  })

  test('when Forms signs under names that are not the Client’s the section says what Forms uses, why, and what to do; when they agree it says nothing of the kind', async () => {
    const apps = standInWorker()
    const agreed = await openSettings('/settings/clients/7')
    expect(agreed.page.q('signing-differs')).toBeNull()
    await agreed.page.unmount()
    // The source pushed a name with a comma in it: the Client has it, Forms refuses it and still signs under its old copy.
    apps.clientsStandIn.state.clients.find((c) => c.number === 7)!.name = 'Harbor, Dental'
    const { page } = await openSettings('/settings/clients/7')
    expect(page.q('signing-differs')?.textContent).toContain('Forms signs under “Harbor Dental” (legal name “Harbor Dental Group, Inc.”)')
    expect(page.q('signing-differs-why')?.textContent).toContain('The name may not contain')
    expect(page.q('signing-differs-todo')?.textContent).toContain('Change the name on this page')
    expect(page.q('signing')?.textContent).not.toContain('Forms follows them')
    await page.unmount()
  })

  test('Add a client in Forms comes to New Client with then=signing, and the Client made goes on to Set up signing for its number', async () => {
    ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('http://localhost/settings/clients/new?then=signing')
    const apps = standInWorker()
    const { page, went } = await openSettings('/settings/clients/new')
    await page.type(page.q('field-name'), 'Sunrise Plumbing')
    await page.type(page.q('field-legal-name'), 'Sunrise Plumbing LLC')
    await page.submit(page.q('new-client-form'))
    const made = apps.clientsStandIn.state.clients.find((c) => c.name === 'Sunrise Plumbing')
    expect(made).toBeTruthy()
    expect(went.at(-1)).toBe(`/forms/clients/new?client=${made?.number}`)
    await page.unmount()
    ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('http://localhost/')
  })
})
