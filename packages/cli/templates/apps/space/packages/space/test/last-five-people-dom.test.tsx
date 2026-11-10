// People's last two jobs from the inbox's own page, as a browser runs them: a person renamed at the revision shown, and an address split off a person who has
// two. In a stand-in DOM over the Worker's own functions and the local fixtures. Press-level: what is asked of the inbox, the revision it names, what the person is told, and where the page goes.
// The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { OWNER_SIGNED_IN } from './signed-in'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mount, realFetch, standInWorker } from './compose-support'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

/** The tab with an address of its own: a press that moves the page changes `pathname`, as the app's router does. */
async function openTab(path: string) {
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

const TOMAS = '/people/tomas.alvarez%40mail.example'
const DANA = '/people/dana%40harbordental.example'
const writes = (calls: { path: string; body: unknown }[], name: string) => calls.filter((c) => c.path === `/api/inbox/${name}`).map((c) => c.body)

describe('renaming a person', () => {
  test('Rename opens a box with the name as it is, Save names the revision shown, the page shows the new name and the box closes', async () => {
    const worker = standInWorker()
    const { page } = await openTab(DANA)
    expect(page.q('person-name')?.textContent).toBe('Dana Reyes')
    await page.click(page.q('rename'))
    expect((page.q('rename-name') as HTMLInputElement).value).toBe('Dana Reyes')
    await page.type(page.q('rename-name'), 'Dana Reyes-Chen')
    await page.click(page.q('rename-save'))
    expect(writes(worker.calls, 'contact-rename')).toEqual([{ contactId: 'c-dana', rev: 0, name: 'Dana Reyes-Chen' }])
    expect(page.q('rename-form')).toBeNull()
    expect(page.q('person-name')?.textContent).toBe('Dana Reyes-Chen')
    await page.unmount()
  })

  test('an empty name is refused in the inbox’s words, the box stays open with what was typed, and nothing is renamed', async () => {
    const worker = standInWorker()
    const { page } = await openTab(DANA)
    await page.click(page.q('rename'))
    await page.type(page.q('rename-name'), '   ')
    await page.click(page.q('rename-save'))
    expect(page.q('say')?.textContent).toContain('A contact needs a name.')
    expect(page.q('rename-form')).not.toBeNull()
    expect(page.q('person-name')?.textContent).toBe('Dana Reyes')
    expect(writes(worker.calls, 'contact-rename')).toHaveLength(1)
    await page.click(page.q('rename-cancel'))
    expect(page.q('rename-form')).toBeNull()
    await page.unmount()
  })

  test('a person who changed since they were shown is not renamed; the page reads them again and says so', async () => {
    const worker = standInWorker()
    const { page } = await openTab(DANA)
    await page.click(page.q('rename'))
    await page.type(page.q('rename-name'), 'Someone Else')
    // Another tab changes their note meanwhile.
    await worker.apps.inbox.saveContactProfile(OWNER_SIGNED_IN, { contactId: 'c-dana', rev: 0, business: 'Harbor Dental', role: 'Office manager', notes: 'Changed elsewhere.' })
    await page.click(page.q('rename-save'))
    expect(page.q('say')?.textContent).toContain('This person changed since you opened them, so nothing was renamed.')
    expect(page.q('person-name')?.textContent).toBe('Dana Reyes')
    // Read again, the next try names the revision they have now.
    await page.click(page.q('rename-save'))
    expect(writes(worker.calls, 'contact-rename').map((b) => (b as { rev: number }).rev)).toEqual([0, 1])
    expect(page.q('person-name')?.textContent).toBe('Someone Else')
    await page.unmount()
  })

  test('a teammate has no Rename: they are the company layer’s person, not the inbox’s contact', async () => {
    standInWorker()
    const { page } = await openTab('/people/priya%40northfield.example')
    expect(page.q('person-page')).not.toBeNull()
    expect(page.q('rename')).toBeNull()
    await page.unmount()
  })
})

describe('splitting an address off a person', () => {
  test('a person with two addresses has Split off beside each, a person with one has none', async () => {
    standInWorker()
    const tomas = await openTab(TOMAS)
    expect(tomas.page.all('split-off')).toHaveLength(2)
    expect(tomas.page.all('split-off')[0]?.getAttribute('aria-label')).toBe('Split tomas.alvarez@mail.example off into its own contact')
    await tomas.page.unmount()
    const dana = await openTab(DANA)
    expect(dana.page.all('split-off')).toHaveLength(0)
    await dana.page.unmount()
  })

  test('pressing it names the person, the revision shown and the address, and opens the new contact; the person keeps the other address', async () => {
    const worker = standInWorker()
    const { page, went } = await openTab(TOMAS)
    await page.click(page.all('split-off')[1] as HTMLElement)
    const [sent] = writes(worker.calls, 'contact-split') as { contactId: string; rev: number; identityId: string }[]
    expect(sent).toEqual({ contactId: 'c-lead', rev: 0, identityId: 'c-lead-i1' })
    expect(went).toEqual(['/people/tomas.alvarez%40oldmail.example'])
    expect(page.q('person-name')?.textContent).toBe('tomas.alvarez@oldmail.example')
    expect(page.all('split-off')).toHaveLength(0)
    await page.unmount()
  })

  test('a person who changed since they were shown is not split; the page reads them again, says so, and stays', async () => {
    const worker = standInWorker()
    const { page, went } = await openTab(TOMAS)
    await worker.apps.inbox.renameContact(OWNER_SIGNED_IN, { contactId: 'c-lead', rev: 0, name: 'Tomas A.' })
    await page.click(page.all('split-off')[1] as HTMLElement)
    expect(page.q('say')?.textContent).toContain('This person changed since you opened them, so nothing was split.')
    expect(went).toEqual([])
    expect(page.q('person-name')?.textContent).toBe('Tomas A.')
    expect(page.all('split-off')).toHaveLength(2)
    await page.unmount()
  })
})
