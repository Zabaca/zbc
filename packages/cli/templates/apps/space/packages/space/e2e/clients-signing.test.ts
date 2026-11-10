// Signing on the one Clients list, in a real browser over the space's production bundle and forms' real Worker (workerd, a local D1 and R2) side by side: a Client's page in
// Settings with its Signing part, Forms' Clients section (the Clients with signing set up, the ones without it, and a client made before Clients were one list), Set up signing for a Client with no legal name, Link, and Send. The two agree on which
// Clients exist because forms reads them from the space's preview (stack.ts), so a Client made in Settings is the one Forms sets up. What no bun test can show: that the screens' own CSS gives each of them room, and that nothing runs off the side of
// a phone.
//
//   bun test e2e/clients-signing.test.ts
//   CLIENTS_SHOTS=/tmp/shots bun test e2e/clients-signing.test.ts   also writes each screen at 1440px and 390px
//
// The fixtures keep their state for as long as the servers run, so the tests are in the order they change it in.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import type { Page } from 'playwright'
import { ROOT as FORMS_ROOT } from '@space/forms/e2e/server'
import { solidPng } from '@space/forms/test/png'
import { type Stack, startStack } from './stack'

let stack: Stack
beforeAll(async () => {
  stack = await startStack()
}, 300_000)
setDefaultTimeout(120_000)
afterEach(() => stack?.browser.closeContexts(), 60_000)
afterAll(() => stack?.stop(), 90_000)

const shots = process.env.CLIENTS_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const SIZES = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } } as const
const at = (path: string) => `${stack.space.base}${path}`

/** Nothing of the page runs off its side: the scrolling area of the space (`main`) and the window both fit their width. */
const fits = (page: Page) =>
  page.evaluate(() => (document.querySelector('main.main') as HTMLElement).scrollWidth <= (document.querySelector('main.main') as HTMLElement).clientWidth && document.documentElement.scrollWidth <= window.innerWidth)

async function openWindow(size: keyof typeof SIZES) {
  const { ctx, page, errors } = await stack.operator({ viewport: SIZES[size] })
  const shot = async (name: string) => {
    if (!shots) return
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${shots}/${name}-${size}.png` })
  }
  return { ctx, page, errors, shot }
}

/** SQL run against forms' local D1, for what no route makes any more: a client made before the Clients part existed. */
function sql(command: string) {
  const done = Bun.spawnSync(['bunx', 'wrangler', 'd1', 'execute', 'forms-records', '--local', '--config', 'dev/wrangler.jsonc', '--persist-to', '.wrangler/state', '--command', command], { cwd: FORMS_ROOT, stderr: 'pipe', stdout: 'pipe' })
  if (done.exitCode !== 0) throw new Error(`forms' database refused: ${done.stderr.toString()}`)
}

const LEGACY = '00000000-0000-4000-8000-00000000c551'
let harbor = ''
let tamarack = ''

describe('the data the screens read', () => {
  test('signing set up for two Clients of the space’s fixtures (Harbor Dental, 7, with a logo; Tamarack Print Supply, 3), and one client made before Clients were one list', async () => {
    const set = async (number: number, slug: string, settings: Record<string, unknown>) => {
      const res = await fetch(`${stack.forms.base}/admin/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_number: number, slug, ...settings }) })
      expect(res.status, await res.clone().text()).toBe(201)
      return ((await res.json()) as { id: string }).id
    }
    harbor = await set(7, 'harbor-dental', { reply_to: 'office@harbordental.example', accent_color: '#1f6f8b' })
    tamarack = await set(3, 'tamarack-print', { reply_to: 'orders@tamarackprint.example', accent_color: '#7a2e1d', retention_years: 10 })
    expect((await fetch(`${stack.forms.base}/admin/api/clients/${harbor}/logo`, { method: 'PUT', body: solidPng(160, 60, [210, 150, 60]) as BodyInit })).status).toBe(200)
    sql(`INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('${LEGACY}', 'legacy-cleaning', 'Legacy Cleaning', 'Legacy Cleaning Co', '#2f6b3a', 'office@legacycleaning.example', 'then', 'then')`)
    const rows = await stack.api<{ id: string; client_number: number | null; display_name: string }[]>('GET', '/clients')
    expect(rows.map((r) => [r.display_name, r.client_number])).toEqual(expect.arrayContaining([['Harbor Dental', 7], ['Tamarack Print Supply', 3], ['Legacy Cleaning', null]]))
  })
})

for (const size of ['1440', '390'] as const) {
  describe(`at ${size}px`, () => {
    test('a Client’s page in Settings: Signing says Forms sends for it and opens its signing settings; one without says Set up signing', async () => {
      const w = await openWindow(size)
      await w.page.goto(at('/settings/clients/7'))
      await w.page.waitForSelector('[data-testid="signing-set-up"]')
      expect(await w.page.locator('[data-testid="signing-set-up"]').textContent()).toContain('Forms is set up to send for Harbor Dental')
      expect(await w.page.locator('[data-testid="signing-settings"]').getAttribute('href')).toBe(`/forms/clients/${harbor}`)
      expect(await fits(w.page)).toBe(true)
      await w.shot('client-page-signing')
      await w.page.goto(at('/settings/clients/9'))
      await w.page.waitForSelector('[data-testid="set-up-signing"]')
      expect(await w.page.locator('[data-testid="set-up-signing"]').getAttribute('href')).toBe('/forms/clients/new?client=9')
      expect(await fits(w.page)).toBe(true)
      await w.shot('client-page-set-up-signing')
      expect(w.errors).toEqual([])
      await w.ctx.close()
    })

    test('Forms’ Clients section: the Clients with signing, the Clients without it, and the client not linked to a Client, each apart; archived Clients are not listed', async () => {
      const w = await openWindow(size)
      await w.page.goto(at('/forms'))
      await w.page.waitForSelector('[data-testid="forms-client"]')
      expect(await w.page.locator('[data-testid="forms-client"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-number')))).toEqual(['7', '3'])
      expect(await w.page.locator('[data-testid="forms-client-not-set-up"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-number')))).toEqual(expect.arrayContaining(['6', '9', '1001']))
      expect(await w.page.locator('[data-testid="forms-client-not-set-up"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-number')))).not.toContain('5')
      expect(await w.page.locator('[data-testid="forms-client-unlinked"]').count()).toBe(1)
      expect(await w.page.locator('[data-testid="forms-unlinked"]').textContent()).toContain('keep signing exactly as they did')
      await w.shot('forms-clients')
      expect(await fits(w.page)).toBe(true)
      // The part below the fold: the client not linked to a Client, with Link and Make a Client.
      await w.page.locator('[data-testid="forms-unlinked"]').evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await w.shot('forms-clients-not-linked')
      expect(await fits(w.page)).toBe(true)
      expect(w.errors).toEqual([])
      await w.ctx.close()
    })
  })
}

describe('Set up signing, Link and Send', () => {
  test('a Client with no legal name is asked for one, which is saved on the Client in Settings; the settings are then made with the Client’s own names', async () => {
    for (const size of ['1440', '390'] as const) {
      const w = await openWindow(size)
      if (size === '1440') {
        await w.page.goto(at('/forms'))
        await w.page.getByTestId('forms-client-not-set-up').filter({ hasText: 'Fischer Bakery' }).getByRole('link', { name: 'Set up signing' }).click()
        await w.page.waitForURL(/\/forms\/clients\/new\?client=1001$/)
      } else {
        await w.page.goto(at('/forms/clients/new?client=6'))
      }
      await w.page.getByTestId('field-legal').waitFor()
      expect(await w.page.getByTestId('client-names').textContent()).toContain('Change the name and legal name on the Client’s page in Settings')
      expect(await fits(w.page)).toBe(true)
      await w.shot('forms-set-up-signing')
      if (size === '1440') {
        await w.page.getByTestId('field-legal').fill('Fischer Bakery LLC')
        await w.page.getByLabel('Replies go to').fill('hello@fischerbakery.example')
        await w.page.getByRole('button', { name: 'Set up signing' }).click()
        await w.page.waitForURL(/\/forms\/clients\/[0-9a-f-]{36}$/)
        await w.page.getByTestId('client-legal-name').waitFor()
        expect(await w.page.getByTestId('client-legal-name').textContent()).toBe('Fischer Bakery LLC')
        // The legal name was saved on the Client, in Settings.
        await w.page.goto(at('/settings/clients/1001'))
        await w.page.waitForSelector('[data-testid="legal-name"]')
        expect(await w.page.locator('[data-testid="legal-name"]').textContent()).toBe('Fischer Bakery LLC')
        await w.page.waitForSelector('[data-testid="signing-set-up"]')
      }
      expect(w.errors).toEqual([])
      await w.ctx.close()
    }
  })

  test('Link joins the client made before Clients were one list to a Client picked from those without signing: it takes the Client’s names and leaves the unlinked section', async () => {
    const w = await openWindow('1440')
    await w.page.goto(at('/forms'))
    await w.page.waitForSelector('[data-testid="forms-client-unlinked"]')
    await w.page.getByTestId('link-pick').selectOption({ label: 'Lakeside Print Supply' })
    expect(await w.page.getByTestId('link-client').textContent()).toContain('Signers will see “Lakeside Print Supply” from now on.')
    await w.shot('forms-link')
    await w.page.getByTestId('link-button').click()
    await w.page.waitForSelector('[data-testid="forms-client"][data-number="9"]')
    expect(await w.page.locator('[data-testid="forms-client-unlinked"]').count()).toBe(0)
    expect(await w.page.locator('[data-testid="forms-client"][data-number="9"]').textContent()).toContain('Lakeside Print Supply')
    const row = (await stack.api<{ id: string; display_name: string; client_number: number }[]>('GET', '/clients')).find((r) => r.id === LEGACY)
    expect(row).toMatchObject({ display_name: 'Lakeside Print Supply', client_number: 9 })
    expect(w.errors).toEqual([])
    await w.ctx.close()
  })

  for (const size of ['1440', '390'] as const) {
    test(`Send offers the Clients with signing set up and not an archived Client, at ${size}px`, async () => {
      const w = await openWindow(size)
      await w.page.goto(at('/forms/send'))
      await w.page.waitForSelector('#client')
      const options = await w.page.locator('#client option').allTextContents()
      expect(options).toEqual(expect.arrayContaining(['Harbor Dental', 'Tamarack Print Supply', 'Fischer Bakery', 'Lakeside Print Supply']))
      expect(options).not.toContain('Old Harbor Marine')
      expect(await fits(w.page)).toBe(true)
      await w.shot('forms-send')
      expect(w.errors).toEqual([])
      await w.ctx.close()
    })
  }
})
