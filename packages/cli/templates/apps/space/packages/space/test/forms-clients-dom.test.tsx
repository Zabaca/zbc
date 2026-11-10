// Forms' Clients section, Set up signing, a client's page and Send over the one list of Clients, as a browser runs them against a scripted forms API and Worker.
// What a person sees: the Clients with signing set up (logo, colour, replies), the Clients without it with Set up signing, and, apart, the clients made before Clients were one list with Link and Make a Client; what a press sends
// (never a name: the names are the Client's); that Send offers the Clients with signing and not an archived one. The DOM is registered for this file only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const realFetch = globalThis.fetch
beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://space.northfield.example/forms' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const row = (over: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000000',
  slug: 'x',
  client_number: 7,
  client_archived: false,
  display_name: 'Harbor Dental',
  legal_name: 'Harbor Dental Group, Inc.',
  accent_color: '#1f6f8b',
  reply_to: 'office@harbordental.example',
  copy_addresses: [],
  time_zone: 'America/Los_Angeles',
  retention_years: 7,
  has_logo: false,
  logo_type: null,
  logo_sha256: null,
  created_at: '2026-11-02T10:00:00Z',
  updated_at: '2026-11-02T10:00:00Z',
  ...over,
})
const HARBOR = row({ id: '77777777-7777-4777-8777-777777777777' })
const SHELVED = row({ id: '55555555-5555-4555-8555-555555555555', client_number: 5, client_archived: true, display_name: 'Old Harbor Marine' })
const LEGACY = row({ id: '11111111-1111-4111-8111-111111111111', client_number: null, client_archived: null, display_name: 'Legacy Cleaning', legal_name: 'Legacy Cleaning Co' })

interface World {
  rows: Record<string, unknown>[]
  open: { number: number; name: string; legalName: string | null }[]
  available: boolean
  calls: { method: string; path: string; body: unknown }[]
  /** The answer for a space view (`/api/clients/...`), by its path. */
  views: Record<string, unknown>
  fail: Record<string, string>
}

function scripted(over: Partial<World> = {}): World {
  const world: World = { rows: [HARBOR, SHELVED, LEGACY], open: [{ number: 9, name: 'Lakeside Print Supply', legalName: 'Lakeside Print Supply Co.' }, { number: 12, name: 'Fischer Bakery', legalName: null }], available: true, calls: [], views: {}, fail: {}, ...over }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://space.northfield.example')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    world.calls.push({ method, path: url.pathname + url.search, body })
    const key = `${method} ${url.pathname}`
    if (world.fail[key]) return Response.json({ error: world.fail[key] }, { status: 409 })
    if (method === 'PATCH') return Response.json(world.rows[0])
    if (key === 'GET /forms/api/clients') return Response.json(world.rows)
    const one = /^\/forms\/api\/clients\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (method === 'GET' && one) return Response.json(world.rows.find((r) => r.id === one[1]))
    if (key === 'GET /forms/api/clients-not-set-up') return Response.json({ available: world.available, clients: world.available ? world.open : [] })
    if (method === 'PUT' && /^\/forms\/api\/clients\/[^/]+\/link$/.test(url.pathname)) return Response.json({ ...LEGACY, client_number: body.client_number })
    if (key === 'POST /forms/api/clients') return Response.json({ ...HARBOR, id: '99999999-9999-4999-8999-999999999999', client_number: body.client_number }, { status: 201 })
    if (key === 'POST /api/clients/make') return Response.json({ result: 'ok', value: { number: 1002, name: body.name, legalName: body.legalName, revision: 1 } })
    if (url.pathname === '/api/clients/one') return Response.json(world.views['one'] ?? { result: 'ok', value: { number: 12, client: { number: 12, name: 'Fischer Bakery', legalName: null, revision: 3 } } })
    if (key === 'POST /api/clients/edit') return Response.json({ result: 'ok', value: { number: 12, name: 'Fischer Bakery', legalName: body.legalName, revision: 4 } })
    return Response.json([])
  }) as typeof fetch
  return world
}

let unmount: (() => Promise<void>) | null = null
afterEach(async () => {
  await unmount?.()
  unmount = null
  globalThis.fetch = realFetch
})

async function open(pathname: string, search = '', go: (path: string) => void = () => undefined) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { FormsTab } = await import('../src/client/forms/FormsTab')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  unmount = () => act(async () => root.unmount())
  await act(async () => root.render(<FormsTab pathname={pathname} search={search} go={go} />))
  await act(async () => sleep(40))
  const q = <T extends Element = HTMLElement>(testid: string) => host.querySelector(`[data-testid="${testid}"]`) as T | null
  const all = (testid: string) => [...host.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  const click = async (el: Element | null) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      ;(el as HTMLElement).click()
      await sleep(60)
    })
  }
  const choose = async (el: Element | null, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value)
      el?.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(10)
    })
  }
  const type = async (el: Element | null, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
      el?.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(10)
    })
  }
  const submit = async (form: Element | null) => {
    await act(async () => {
      form?.closest('form')?.requestSubmit()
      await sleep(80)
    })
  }
  return { host, q, all, click, choose, type, submit }
}

describe('Forms’ Clients section', () => {
  test('the Clients with signing set up, the Clients without it (Set up signing), and the clients not linked to a Client, each apart; an archived Client is not listed', async () => {
    scripted()
    const page = await open('/forms')
    expect(page.all('forms-client').map((e) => e.getAttribute('data-number'))).toEqual(['7'])
    expect(page.q('forms-client')?.textContent).toContain('replies to office@harbordental.example')
    expect(page.host.textContent).not.toContain('Old Harbor Marine')
    expect(page.all('forms-client-not-set-up').map((e) => e.getAttribute('data-number'))).toEqual(['9', '12'])
    const setUp = page.all('forms-client-not-set-up')[0]!.querySelector('a') as HTMLAnchorElement
    expect(setUp.textContent).toBe('Set up signing')
    expect(setUp.getAttribute('href')).toBe('/forms/clients/new?client=9')
    expect(page.all('forms-client-unlinked').map((e) => e.getAttribute('data-id'))).toEqual([LEGACY.id])
    expect(page.q('forms-unlinked')?.textContent).toContain('keep signing exactly as they did')
  })

  test('Add a client goes to New Client in Settings, which comes back to Set up signing', async () => {
    scripted()
    const page = await open('/forms')
    const add = [...page.host.querySelectorAll('a')].find((a) => a.textContent === 'Add a client')
    expect(add?.getAttribute('href')).toBe('/settings/clients/new?then=signing')
  })

  test('with no Clients at all it says so; with the Clients list unreadable it says only the clients with signing are shown', async () => {
    scripted({ rows: [], open: [] })
    const none = await open('/forms')
    expect(none.host.textContent).toContain('No Clients yet.')
    await unmount?.()
    scripted({ rows: [HARBOR], available: false })
    const down = await open('/forms')
    expect(down.host.textContent).toContain('could not be read just now')
    expect(down.all('forms-client')).toHaveLength(1)
    expect(down.q('forms-clients-not-set-up')).toBeNull()
  })

  test('Link sends the number of the Client picked and nothing else; it says the signer will see the Client’s name', async () => {
    const world = scripted()
    const page = await open('/forms')
    const pick = page.q('link-pick')
    expect(page.q<HTMLButtonElement>('link-button')?.disabled).toBe(true)
    await page.choose(pick, '9')
    expect(page.q('link-client')?.textContent).toContain('Signers will see “Lakeside Print Supply” from now on.')
    await page.click(page.q('link-button'))
    expect(world.calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `/forms/api/clients/${LEGACY.id}/link`, body: { client_number: 9 } })
  })

  test('Make a Client makes the Client from the row’s names in Settings’ list, then links the row to its number', async () => {
    const world = scripted()
    const page = await open('/forms')
    await page.click(page.q('make-client-button'))
    const sent = world.calls.filter((c) => c.method !== 'GET')
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/clients/make', `PUT /forms/api/clients/${LEGACY.id}/link`])
    expect(sent[0]!.body).toEqual({ name: 'Legacy Cleaning', legalName: 'Legacy Cleaning Co' })
    expect(sent[1]!.body).toEqual({ client_number: 1002 })
  })

  test('when linking fails after the Client was made, the sentence says the Client exists and the row is not linked', async () => {
    scripted({ fail: { [`PUT /forms/api/clients/${LEGACY.id}/link`]: 'Fischer Bakery already has signing settings' } })
    const page = await open('/forms')
    await page.click(page.q('make-client-button'))
    expect(page.q('link-client')?.textContent).toContain('was made as a Client (number 1002) but this client could not be linked to it')
  })
})

describe('Set up signing', () => {
  test('a Client with a legal name: no name box, the Client’s names shown with the way to change them in Settings, and the request names a number and no name', async () => {
    const world = scripted()
    const page = await open('/forms/clients/new', '?client=9')
    expect(page.host.textContent).toContain('Set up signing for Lakeside Print Supply')
    expect(page.q('client-name')?.textContent).toBe('Lakeside Print Supply')
    expect(page.q('client-legal-name')?.textContent).toBe('Lakeside Print Supply Co.')
    expect(page.q('names-in-settings')?.getAttribute('href')).toBe('/settings/clients/9')
    expect(page.q('field-legal')).toBeNull()
    expect(page.host.querySelector('#display')).toBeNull()
    await page.type(page.host.querySelector('#reply'), 'office@lakeside.example')
    await page.submit(page.host.querySelector('#reply'))
    const created = world.calls.find((c) => c.method === 'POST' && c.path === '/forms/api/clients')
    expect(created?.body).toMatchObject({ client_number: 9, slug: 'lakeside-print-supply', reply_to: 'office@lakeside.example' })
    expect(Object.keys(created?.body as object)).not.toContain('display_name')
    expect(Object.keys(created?.body as object)).not.toContain('legal_name')
    // The screen moves to the new row's page (`go` writes the address).
    expect(window.location.pathname).toBe('/forms/clients/99999999-9999-4999-8999-999999999999')
  })

  test('a Client with no legal name is asked for one, which is saved on the Client first, naming the revision read; then the settings are made', async () => {
    const world = scripted()
    const page = await open('/forms/clients/new', '?client=12')
    expect(page.q('field-legal')).toBeTruthy()
    await page.type(page.q('field-legal'), 'Fischer Bakery LLC')
    await page.type(page.host.querySelector('#reply'), 'hello@fischer.example')
    await page.submit(page.host.querySelector('#reply'))
    const sent = world.calls.filter((c) => c.method === 'POST')
    expect(sent.map((c) => c.path)).toEqual(['/api/clients/edit', '/forms/api/clients'])
    expect(sent[0]!.body).toEqual({ number: 12, revision: 3, legalName: 'Fischer Bakery LLC' })
    expect(sent[1]!.body).toMatchObject({ client_number: 12 })
  })

  test('when the legal name cannot be saved nothing is set up and the sentence says so', async () => {
    const world = scripted({ views: { one: { result: 'unreachable', message: 'The Clients did not answer.' } } })
    const page = await open('/forms/clients/new', '?client=12')
    await page.type(page.q('field-legal'), 'Fischer Bakery LLC')
    await page.type(page.host.querySelector('#reply'), 'hello@fischer.example')
    await page.submit(page.host.querySelector('#reply'))
    expect(page.host.textContent).toContain('Nothing was set up.')
    expect(world.calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  test('a Client that already has signing says so and links to it; an archived or unknown number says what to do; no Client chosen lists those without signing', async () => {
    scripted()
    const has = await open('/forms/clients/new', '?client=7')
    expect(has.host.textContent).toContain('Signing is already set up for Harbor Dental.')
    await unmount?.()
    scripted()
    const archived = await open('/forms/clients/new', '?client=3')
    expect(archived.host.textContent).toContain('No active Client has the number 3')
    await unmount?.()
    scripted()
    const none = await open('/forms/clients/new')
    expect([...none.q('pick-a-client')!.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Lakeside Print Supply', 'Fischer Bakery'])
  })
})

describe('a client’s page', () => {
  test('names are read only and changed in Settings; saving the settings sends no name', async () => {
    const world = scripted()
    const page = await open(`/forms/clients/${HARBOR.id}`)
    world.calls.length = 0
    expect(page.q('client-name')?.textContent).toBe('Harbor Dental')
    expect(page.q('names-in-settings')?.getAttribute('href')).toBe('/settings/clients/7')
    expect(page.q('not-linked')).toBeNull()
    await page.submit(page.host.querySelector('#reply'))
    const saved = world.calls.find((c) => c.method === 'PATCH')
    expect(Object.keys(saved?.body as object).sort()).toEqual(['accent_color', 'copy_addresses', 'reply_to', 'retention_years', 'time_zone'])
  })

  test('a client not linked to a Client says so and offers Link and Make a Client', async () => {
    scripted()
    const page = await open(`/forms/clients/${LEGACY.id}`)
    expect(page.q('not-linked')?.textContent).toContain('Not linked to a Client')
    expect(page.q('link-pick')).toBeTruthy()
    expect(page.q('make-client-button')).toBeTruthy()
    expect(page.q('names-in-settings')).toBeNull()
  })
})

describe('Send', () => {
  test('offers the Clients with signing set up and the clients not yet linked, and not an archived Client', async () => {
    scripted()
    const page = await open('/forms/send')
    const options = [...page.host.querySelectorAll('#client option')].map((o) => o.textContent)
    expect(options).toEqual(['Harbor Dental', 'Legacy Cleaning (not linked to a Client)'])
  })

  test('leaves out a linked Client whose archive status Forms could not give, and says so; a client not linked has no status to give and is still offered', async () => {
    const UNKNOWN = row({ id: '66666666-6666-4666-8666-666666666666', client_number: 6, client_archived: null, display_name: 'Maybe Shelved Co' })
    scripted({ rows: [HARBOR, UNKNOWN, LEGACY] })
    const page = await open('/forms/send')
    const options = [...page.host.querySelectorAll('#client option')].map((o) => o.textContent)
    expect(options).toEqual(['Harbor Dental', 'Legacy Cleaning (not linked to a Client)'])
    expect(page.host.textContent).toContain('Forms could not tell whether Maybe Shelved Co is archived, so it is not offered below')
    expect(page.host.textContent).not.toContain('No Client is set up for signing yet')
  })

  test('with no Client set up it says so and points to Clients', async () => {
    scripted({ rows: [SHELVED] })
    const page = await open('/forms/send')
    expect(page.host.textContent).toContain('No Client is set up for signing yet')
    expect(page.host.querySelectorAll('#client option').length).toBe(0)
  })
})
