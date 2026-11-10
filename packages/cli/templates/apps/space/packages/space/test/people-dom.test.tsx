// People as a browser runs it, in a stand-in DOM, over the Worker's own functions (src/people.ts, src/views.ts) and the invented people of the local fixtures: what a person sees in
// the directory and on a page, what a press does and what it does NOT do. The three fields are saved at a revision and a save over a person who has changed since is refused with
// what was typed still in the boxes; a Client is linked from the suggestion or the list; two entries are merged after a question and undone from the line that says so; a person nothing
// has been said with has no conversation to open; the same fields are drawn beside a conversation. The DOM is registered for this file only, so React is imported after it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { people, person } from '../src/people'
import { fixtureApps } from '../src/stand-ins'
import { READ_NAMES, type ReadName, WRITE_NAMES, type WriteName, readView, writeView } from '../src/views'
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

/** The Worker's People routes over the local fixtures, as the page's `fetch` reaches them. */
function standInWorker(mode: '1' | 'mail-down' = '1') {
  const apps = fixtureApps(NOW, mode)
  const ask = { apps: { inbox: apps.inbox, meet: apps.meet, forms: apps.forms }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100, writeWithinMs: 300, now: () => NOW }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/people') return json(await people(ask, { automated: url.searchParams.get('automated') === '1' }))
    if (url.pathname === '/api/person') {
      const found = await person(ask, url.searchParams.get('key') ?? '')
      return found.ok ? json(found.value) : json({ error: found.message }, found.status)
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
      await sleep(120)
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
      await sleep(150)
    })
  }
  const wait = (ms: number) => act(async () => void (await sleep(ms)))
  return { q, all, click, type, submit, wait, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()) }
}

/** The tab with an address of its own: a press that moves the page changes `pathname`, as the app's router does. */
async function openTab(path = '/people') {
  const { People } = await import('../src/client/People')
  const went: string[] = []
  const page = await mount((h, { useState }) => {
    function Shell() {
      const [pathname, setPathname] = useState(path)
      return h(People, { pathname, go: (p: string) => void (went.push(p), setPathname(p)) })
    }
    return h(Shell) as never
  })
  return { page, went }
}

const DANA = '/people/dana%40harbordental.example'
const DANA_R = '/people/dreyes.dental%40mail.example'

describe('the directory', () => {
  test('Clients, Outside and Team in that order, each with its count, no channel, and the automated senders counted in a line', async () => {
    standInWorker()
    const { page } = await openTab()
    expect(page.all('person').length).toBe(18)
    const groups = ['group-client', 'group-outside', 'group-team'].map((id) => page.q(id)?.querySelector('h2')?.textContent)
    expect(groups).toEqual(['Clients 3', 'Outside 12', 'Team 3'])
    expect(page.text()).not.toContain('launch')
    expect(page.q('automated')?.textContent).toContain('2 automated senders')
    expect(page.text()).not.toContain('Local Business Weekly')
    expect(page.q('count')?.textContent).toBe('18 people')
    await page.unmount()
  })

  test('Show automated lists them under their own heading and Hide takes them away again; the count of people is the same either way', async () => {
    standInWorker()
    const { page } = await openTab()
    expect(page.q('group-automated')).toBeNull()
    expect(page.q('toggle-automated')?.textContent).toBe('Show automated (2)')
    await page.click(page.q('toggle-automated'))
    expect(page.q('group-automated')?.textContent).toContain('Local Business Weekly')
    expect(page.q('group-automated')?.querySelector('h2')?.textContent).toBe('Automated 2')
    expect(page.q('count')?.textContent).toBe('18 people')
    expect(page.q('automated')?.textContent).toContain('listed above')
    expect(page.q('toggle-automated')?.textContent).toBe('Hide automated')
    await page.click(page.q('toggle-automated'))
    expect(page.q('group-automated')).toBeNull()
    await page.unmount()
  })

  test('each row says the business and role, or the address, and shows the Client or the one only suggested', async () => {
    standInWorker()
    const { page } = await openTab()
    const row = (name: string) => page.all('person').find((r) => r.textContent?.includes(name)) as HTMLElement
    expect(row('Dana Reyes').textContent).toContain('Harbor Dental, Office manager')
    expect(row('Dana Reyes').querySelector('[data-testid="client-pill"]')?.textContent).toBe('Harbor Dental')
    expect(row('Lena Fischer').querySelector('[data-testid="client-suggested"]')?.textContent).toContain('Tamarack Print Supply')
    expect(row('Tomas Alvarez').textContent).toContain('tomas.alvarez@mail.example')
    await page.unmount()
  })

  test('pressing a person goes to their page without reloading; the find box narrows the list and says when no one matches', async () => {
    standInWorker()
    const { page, went } = await openTab()
    await page.click(page.all('person').find((r) => r.textContent?.includes('Marcus Chen')) ?? null)
    expect(went).toEqual(['/people/marcus%40harbordental.example'])
    expect(page.q('person-name')?.textContent).toBe('Marcus Chen')
    await page.type(page.q('find'), 'fischer')
    expect(page.all('person').map((r) => r.getAttribute('data-key'))).toEqual(['lena@fischerbakery.example'])
    await page.type(page.q('find'), 'zzzz')
    expect(page.q('empty-people')?.textContent).toContain('No one matches')
    await page.unmount()
  })

  test('with the inbox down the team and chat guests are listed, and a line says what is missing', async () => {
    standInWorker('mail-down')
    const { page } = await openTab()
    expect(page.all('person').map((r) => r.querySelector('.row-title')?.textContent)).toEqual(['Dana Reyes', 'Priya Natarajan', 'Sam Ortiz', 'Tessa'])
    expect(page.q('group-team')).not.toBeNull()
    expect(document.querySelector('[data-notice="unreachable"][data-part="mail"]')?.textContent).toContain('missing from this list')
    expect(page.q('empty-people')).toBeNull()
    await page.unmount()
  })
})

describe('a person’s page', () => {
  test('their details, the button to their conversation, their documents with title and state only, and a teammate’s page with no boxes to fill', async () => {
    standInWorker()
    const { page } = await openTab(DANA)
    expect(page.q('person-name')?.textContent).toBe('Dana Reyes')
    expect((page.q('field-business') as HTMLInputElement).value).toBe('Harbor Dental')
    expect((page.q('field-notes') as HTMLTextAreaElement).value).toContain('Prefers a call before ten')
    expect(page.q<HTMLAnchorElement>('open-email')?.getAttribute('href')).toBe('/inbox/dana%40harbordental.example')
    expect(page.all('document').map((d) => d.querySelector('.s-item-title')?.textContent)).toEqual(['Photo release, Harbor Dental', 'Hosting renewal, Harbor Dental', 'Website agreement, Harbor Dental'])
    expect(page.all('document')[0]?.textContent).toContain('Out for signature, 0 of 2 signed')
    expect(page.all('document')[2]?.textContent).toContain('Signed and back')
    expect(page.all('document-open')[0]?.getAttribute('href')).toBe('/forms/envelopes/e-photo')
    // The names of those who have not signed are not on the page.
    expect(page.text()).not.toContain('Marcus Chen, Dana')
    await page.unmount()
  })

  test('the button goes to the right tab: email to the Inbox, a direct message to Meet, and a person with both has both', async () => {
    standInWorker()
    const marcus = await openTab('/people/marcus%40harbordental.example')
    expect(marcus.page.q<HTMLAnchorElement>('open-email')?.getAttribute('href')).toBe('/inbox/marcus%40harbordental.example')
    expect(marcus.page.q('open-chat')).toBeNull()
    await marcus.page.unmount()
    const dana = await openTab(DANA)
    expect(dana.page.q<HTMLAnchorElement>('open-email')?.getAttribute('href')).toBe('/inbox/dana%40harbordental.example')
    expect(dana.page.q<HTMLAnchorElement>('open-chat')?.getAttribute('href')).toBe('/meet/dana%40harbordental.example')
    await dana.page.click(dana.page.q('open-chat'))
    expect(dana.went.at(-1)).toBe('/meet/dana%40harbordental.example')
    await dana.page.unmount()
  })

  test('a teammate: the company layer’s facts, no boxes, no merge, no Client', async () => {
    standInWorker()
    const { page } = await openTab('/people/tessa%40northfield.example')
    expect(page.q('person-name')?.textContent).toBe('Tessa')
    expect(page.q('team-facts')?.textContent).toContain('Owner')
    expect(page.q('profile-fields')).toBeNull()
    expect(page.q('merge-section')).toBeNull()
    expect(page.q('client-section')).toBeNull()
    await page.unmount()
  })

  test('someone nothing has been said with has no conversation to open, and says so instead of a button', async () => {
    standInWorker()
    const { page } = await openTab(DANA_R)
    expect(page.q('person-name')?.textContent).toBe('Dana R.')
    expect(page.q('open-conversation')).toBeNull()
    expect(page.q('no-conversation')?.textContent).toContain('Nothing has been said with them yet')
    await page.unmount()
  })

  test('a person who is not there says so and offers the way back', async () => {
    standInWorker()
    const { page } = await openTab('/people/nobody%40nowhere.example')
    expect(page.q('person-problem')?.textContent).toContain('There is no such person')
    await page.unmount()
  })
})

describe('the three fields', () => {
  test('Save is off until something changes, then saves at the revision shown and says so; the next read has it', async () => {
    const apps = standInWorker()
    const { page } = await openTab(DANA)
    const save = () => page.q<HTMLButtonElement>('save-profile') as HTMLButtonElement
    expect(save().disabled).toBe(true)
    await page.type(page.q('field-role'), 'Practice manager')
    expect(save().disabled).toBe(false)
    await page.submit(page.q('field-role'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'saveContactProfile').map((c) => (c.args[0] as { rev: number; role: string }).rev)).toEqual([0])
    expect(page.q('saved')?.textContent).toBe('Saved.')
    expect(save().disabled).toBe(true)
    // The boxes keep what was saved while the page reads the person again: the older read that lands after the save does not put the old text back.
    await page.wait(200)
    expect((page.q('field-role') as HTMLInputElement).value).toBe('Practice manager')
    const row = page.all('person').find((r) => r.textContent?.includes('Dana Reyes')) as HTMLElement
    expect(row.textContent).toContain('Practice manager')
    // A second change goes in at the next revision.
    await page.type(page.q('field-business'), 'Harbor Dental Group')
    await page.submit(page.q('field-role'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'saveContactProfile').map((c) => (c.args[0] as { rev: number }).rev)).toEqual([0, 1])
    await page.unmount()
  })

  test('a save over a person who changed since is refused, what was typed stays in the boxes, the newer details are shown, and nothing newer is overwritten', async () => {
    const apps = standInWorker()
    const { page } = await openTab(DANA)
    await page.type(page.q('field-notes'), 'My version of the note.')
    // Someone else (another window, Claude's script) changes the same person first.
    await apps.inbox.saveContactProfile(OWNER_SIGNED_IN, { contactId: 'c-dana', rev: 0, business: 'Harbor Dental', role: 'Manager', notes: 'The other version.' })
    await page.submit(page.q('field-notes'))
    expect((page.q('field-notes') as HTMLTextAreaElement).value).toBe('My version of the note.')
    expect(page.q('newer')?.textContent).toContain('nothing you typed was saved')
    expect(page.q('newer')?.textContent).toContain('The other version.')
    expect(page.q<HTMLButtonElement>('save-profile')?.disabled).toBe(true)
    const contact = await apps.inbox.contact(OWNER_SIGNED_IN, 'c-dana')
    expect(contact.ok && contact.value.notes).toBe('The other version.')
    // Taking the newer details puts them in the boxes and turns Save off.
    await page.click(page.q('take-newer'))
    expect((page.q('field-notes') as HTMLTextAreaElement).value).toBe('The other version.')
    expect(page.q('newer')).toBeNull()
    await page.unmount()
  })
})

describe('linking a Client', () => {
  test('the inbox’s suggestion is a button, and linking it names the Client and shows it on the row', async () => {
    const apps = standInWorker()
    const { page } = await openTab('/people/lena%40fischerbakery.example')
    expect(page.q('suggestion')?.textContent).toContain('Tamarack Print Supply')
    await page.click(page.q('link-suggested'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'linkClient').map((c) => c.args)).toEqual([['c-lena', 3]])
    expect(page.q('client-name')?.textContent).toContain('Tamarack Print Supply')
    const row = page.all('person').find((r) => r.textContent?.includes('Lena Fischer')) as HTMLElement
    expect(row.getAttribute('data-side')).toBe('client')
    await page.unmount()
  })

  test('another Client is chosen from the site’s list, and a linked person can be taken out', async () => {
    const apps = standInWorker()
    const { page } = await openTab('/people/tomas.alvarez%40mail.example')
    await page.click(page.q('choose-client'))
    const select = page.q('client-select') as unknown as HTMLSelectElement
    expect(page.q<HTMLButtonElement>('link-client')?.disabled).toBe(true)
    const first = [...select.options].find((o) => o.value !== '')
    await page.type(select as unknown as Element, first?.value ?? '')
    await page.click(page.q('link-client'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'linkClient')).toHaveLength(1)
    expect(page.q('client-name')).not.toBeNull()
    await page.click(page.q('unlink-client'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'linkClient').map((c) => c.args[1])).toEqual([Number(first?.value), null])
    expect(page.q('client-name')).toBeNull()
    await page.unmount()
  })
})

describe('merging two entries, and undoing it', () => {
  test('the other entry is chosen, the question says what will happen, a no changes nothing, a yes merges and goes to the merged person', async () => {
    const apps = standInWorker()
    const { page, went } = await openTab(DANA_R)
    await page.click(page.q('open-merge'))
    const options = [...((page.q('merge-select') as HTMLSelectElement | null)?.options ?? [])].map((o) => o.textContent)
    expect(options).toContain('Dana Reyes (dana@harbordental.example)')
    expect(options.join(' ')).not.toContain('Tessa')
    expect(options.join(' ')).not.toContain('Dana R.')
    await page.type(page.q('merge-select'), 'c-dana')
    await page.click(page.q('merge-ask'))
    expect(page.q('ask')?.textContent).toContain('Merge Dana Reyes into Dana R.?')
    await page.click(page.q('ask-no'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'mergeContacts')).toHaveLength(0)
    await page.click(page.q('merge-ask'))
    await page.click(page.q('ask-yes'))
    const merge = apps.inbox.views.calls.find((c) => c.method === 'mergeContacts')
    expect(merge?.args[0]).toEqual({ survivorId: 'c-dana2', survivorRev: 0, absorbedId: 'c-dana', absorbedRev: 0 })
    expect(page.q('merged')?.textContent).toContain('Merged Dana Reyes into Dana R.')
    expect(went.at(-1)).toContain('/people/')
    // One entry is left of the two, with the business and role the survivor had left blank.
    const names = page.all('person').map((r) => r.querySelector('.row-title')?.textContent)
    expect(names).toContain('Dana R.')
    expect(names).not.toContain('Dana Reyes')
    expect(page.all('person').find((r) => r.textContent?.includes('Dana R.'))?.textContent).toContain('Harbor Dental, Office manager')
    await page.unmount()
  })

  test('Undo puts the other person back, with their details, and the line goes', async () => {
    const apps = standInWorker()
    const { page } = await openTab(DANA_R)
    await page.click(page.q('open-merge'))
    await page.type(page.q('merge-select'), 'c-dana')
    await page.click(page.q('merge-ask'))
    await page.click(page.q('ask-yes'))
    expect(page.all('person').length).toBe(17)
    await page.click(page.q('undo-merge'))
    expect(apps.inbox.views.calls.some((c) => c.method === 'undoContactMerge')).toBe(true)
    expect(page.q('merged')).toBeNull()
    expect(page.all('person').length).toBe(18)
    const dana = page.all('person').find((r) => r.textContent?.includes('Dana Reyes')) as HTMLElement
    expect(dana.textContent).toContain('Harbor Dental, Office manager')
    expect(page.q('undone')?.textContent).toContain('Undone')
    await page.unmount()
  })

  test('a merge over a person who changed since is refused in the inbox’s words and nothing is merged', async () => {
    const apps = standInWorker()
    const { page } = await openTab(DANA_R)
    await page.click(page.q('open-merge'))
    await page.type(page.q('merge-select'), 'c-dana')
    await page.click(page.q('merge-ask'))
    await apps.inbox.saveContactProfile(OWNER_SIGNED_IN, { contactId: 'c-dana', rev: 0, business: 'x', role: '', notes: '' })
    await page.click(page.q('ask-yes'))
    expect(page.q('say')?.textContent).toContain('nothing was merged')
    expect(page.q('merged')).toBeNull()
    expect(page.all('person').length).toBe(18)
    // The refusal said they are shown as they are now, so they are: the list was read again, and the same question, asked again, goes through at the revisions they have now.
    const asked = apps.inbox.views.calls.filter((c) => c.method === 'contacts').length
    expect(asked).toBeGreaterThan(1)
    await page.click(page.q('ask-yes'))
    expect(apps.inbox.views.calls.find((c) => c.method === 'mergeContacts' && (c.args[0] as { absorbedRev: number }).absorbedRev === 1)).toBeDefined()
    expect(page.q('merged')?.textContent).toContain('Merged Dana Reyes into Dana R.')
    await page.unmount()
  })
})

describe('beside a conversation', () => {
  test('the same three fields, saved from there; nothing is drawn for a teammate', async () => {
    const apps = standInWorker()
    const { ProfileFields } = await import('../src/client/People')
    const beside = await mount((h) => h(ProfileFields, { convKey: 'dana@harbordental.example' }) as never)
    expect((beside.q('field-role') as HTMLInputElement).value).toBe('Office manager')
    await beside.type(beside.q('field-role'), 'Owner')
    await beside.submit(beside.q('field-role'))
    expect(apps.inbox.views.calls.filter((c) => c.method === 'saveContactProfile')).toHaveLength(1)
    await beside.unmount()
    const team = await mount((h) => h(ProfileFields, { convKey: 'priya@northfield.example' }) as never)
    expect(team.q('profile-beside')).toBeNull()
    await team.unmount()
  })
})
