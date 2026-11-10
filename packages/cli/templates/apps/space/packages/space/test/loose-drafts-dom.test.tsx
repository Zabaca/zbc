// A draft that sits on no conversation, as a browser runs it, in a stand-in DOM over the Worker's own functions and the local fixtures: the page at `/inbox/draft/<id>` has the card of a draft in a
// conversation and every action on it (Edit, Send as it stands, Copy address, Copy words and Mark sent), sends once however often Send is pressed, names the revision shown and no position, and moves
// to the person's conversation (replacing its own address) once the draft is one. Press-level: what is asked of the inbox, what the person is told, and what is read again afterwards. The DOM is
// registered for this file only. The list's rows are drawn in the second part.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { T0, northfield } from '../../workspace/test/helpers'
import { type Called, mount, realFetch, standInWorker } from './compose-support'
import { OWNER_SIGNED_IN } from './signed-in'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

async function openDraft(id: string) {
  const { DraftPane } = await import('../src/client/DraftPane')
  const changed: number[] = []
  const went: string[] = []
  const replaced: string[] = []
  const page = await mount((h) => h(DraftPane, { draftId: id, refreshes: 0, onChanged: () => void changed.push(1), go: (p: string) => void went.push(p), replace: (p: string) => void replaced.push(p) }) as never)
  return { page, changed, went, replaced }
}

const FIRST = 'd-first-email'
const LINKEDIN = 'd-linkedin-1'
const calls = (all: Called[], path: string) => all.filter((c) => c.path === path)

describe('a first email to a new address', () => {
  test('opens as the card of a draft: who it is to, the words, Send as it stands and Edit, and nothing that is for a text', async () => {
    standInWorker()
    const { page } = await openDraft(FIRST)
    expect(page.q('draft-title')?.textContent).toBe('Draft to Nadia Hussain')
    expect(page.q('draft-to')?.textContent).toBe('To Nadia Hussain <nadia@hussaincatering.example>')
    expect(page.q('draft')?.textContent).toContain('Websites for caterers')
    expect(page.q('draft')?.textContent).toContain('I build simple websites for local caterers')
    expect(page.q('send-draft')?.textContent).toBe('Send as it stands')
    expect(page.q('edit-draft')?.textContent).toBe('Edit')
    expect(page.q('mark-sent')).toBeNull()
    expect(page.q('copy-address')).toBeNull()
    expect(page.q('open-in-inbox')).toBeNull()
    await page.unmount()
  })

  test('Send names the draft, its revision and no position, then says it went and where to read it; there is no card left to press again', async () => {
    const worker = standInWorker()
    const { page, changed } = await openDraft(FIRST)
    await page.click(page.q('send-draft'))
    const sends = calls(worker.calls, '/api/email')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.body).toMatchObject({ draftId: FIRST, rev: 1, through: null })
    expect(page.q('draft-sent-notice')?.textContent).toBe('Sent.')
    expect(page.q('draft-sent-notice')?.getAttribute('data-tone')).toBe('ok')
    expect(page.q('draft')).toBeNull()
    expect(page.q('draft-done')?.textContent).toBe('Open their conversation')
    expect(page.q('open-conversation')?.getAttribute('href')).toBe('/inbox/mail%3Ac-new')
    expect(changed.length).toBeGreaterThan(0)
    expect(worker.apps.inbox.reached).toEqual([{ draftId: FIRST, to: 'nadia@hussaincatering.example', cc: [] }])
    await page.unmount()
  })

  test('Edit saves the words at the revision shown, the card shows them, and the draft is then sent at the new revision', async () => {
    const worker = standInWorker()
    const { page } = await openDraft(FIRST)
    await page.click(page.q('edit-draft'))
    expect(page.q<HTMLButtonElement>('send-draft')?.disabled).toBe(true)
    await page.type(page.q('edit-text'), 'Hello Nadia, would a call this week suit you?')
    await page.click(page.q('save-draft'))
    expect(calls(worker.calls, '/api/inbox/draft-edit')[0]?.body).toMatchObject({ draftId: FIRST, rev: 1, text: 'Hello Nadia, would a call this week suit you?' })
    expect(page.q('draft-editor')).toBeNull()
    expect(page.q('draft-saved')).not.toBeNull()
    expect(page.q('draft')?.textContent).toContain('would a call this week suit you?')
    await page.click(page.q('send-draft'))
    expect(calls(worker.calls, '/api/email')[0]?.body).toMatchObject({ draftId: FIRST, rev: 2, through: null })
    await page.unmount()
  })

  test('a draft changed since it was shown is refused in the inbox’s words, nothing is sent, and the card is read again as it now is', async () => {
    const worker = standInWorker()
    const { page } = await openDraft(FIRST)
    // Claude (or another tab) edited it after it was shown.
    await worker.apps.inbox.editDraft(OWNER_SIGNED_IN, { draftId: FIRST, rev: 1, text: 'Claude changed the words.' })
    await page.click(page.q('send-draft'))
    expect(page.q('draft-notice')?.textContent).toBe('This draft was changed since you saw it.')
    expect(worker.apps.inbox.sent).toEqual([])
    expect(page.q('draft')?.textContent).toContain('Claude changed the words.')
    // Pressing Send again sends the revision now shown, under the same key.
    await page.click(page.q('send-draft'))
    expect(worker.apps.inbox.sent).toHaveLength(1)
    const [first, second] = calls(worker.calls, '/api/email')
    expect((first?.body as { key: string }).key).toBe((second?.body as { key: string }).key)
    expect(second?.body).toMatchObject({ rev: 2 })
    await page.unmount()
  })
})

describe('a first LinkedIn message to a new contact', () => {
  test('has the words and the address to copy and Mark sent, and no Send; Mark sent files it and the page moves to the person’s conversation', async () => {
    const worker = standInWorker()
    const { page, replaced } = await openDraft(LINKEDIN)
    expect(page.q('send-draft')).toBeNull()
    expect(page.q('draft')?.textContent).toContain('The inbox cannot send a direct message. Send it yourself, then press Mark sent.')
    expect(page.q('copy-address')).not.toBeNull()
    expect(page.q('copy-words')).not.toBeNull()
    expect(page.q('edit-draft')).not.toBeNull()
    await page.click(page.q('mark-sent'))
    expect(calls(worker.calls, '/api/inbox/draft-sent').map((c) => c.body)).toEqual([{ draftId: LINKEDIN }])
    expect(calls(worker.calls, '/api/email')).toEqual([])
    expect(replaced).toEqual(['/inbox/mail%3Ac-old'])
    await page.unmount()
  })
})

describe('the address of a draft that has a conversation, or is gone', () => {
  test('a draft on a conversation moves to that person’s conversation, replacing this address', async () => {
    standInWorker()
    const { page, replaced } = await openDraft('d-lena-1')
    expect(replaced).toEqual(['/inbox/mail%3Ac-lena'])
    expect(page.q('draft')).toBeNull()
    await page.unmount()
  })

  test('a draft that is gone says so in words and goes back to the Drafts view', async () => {
    standInWorker()
    const { page, went } = await openDraft('d-nothing')
    expect(page.q('draft-failed')?.textContent).toContain('That draft is gone: it was deleted, it never was one, or it was sent from Gmail and the email itself, in the person’s conversation, is now the record.')
    await page.click(page.q('draft-failed')?.querySelector('a') ?? null)
    expect(went).toEqual(['/inbox?view=drafts'])
    await page.unmount()
  })

  test('a draft sent from somewhere else while it is on screen is refused when sent again, and the page moves to the conversation it made', async () => {
    const worker = standInWorker()
    const { page, replaced } = await openDraft(FIRST)
    await worker.apps.inbox.send(OWNER_SIGNED_IN, { key: 'sent-in-gmail-0000', draftId: FIRST, rev: 1, through: null })
    await page.click(page.q('send-draft'))
    expect(worker.apps.inbox.sent).toHaveLength(1) // the one from elsewhere; this press sent nothing
    expect(replaced).toEqual(['/inbox/mail%3Ac-new'])
    await page.unmount()
  })

  test('a draft deleted while it is on screen says it is no longer waiting and offers the person’s conversation', async () => {
    const worker = standInWorker()
    const { page, replaced } = await openDraft(FIRST)
    await worker.apps.inbox.send(OWNER_SIGNED_IN, { key: 'sent-in-gmail-0001', draftId: FIRST, rev: 1, through: null })
    worker.apps.inbox.draftAt = async () => ({ ok: false, kind: 'refused', reason: 'not-found', message: 'No such message.' })
    await page.click(page.q('send-draft'))
    expect(replaced).toEqual([])
    expect(page.q('draft-done')?.textContent).toContain('This draft to Nadia Hussain is no longer waiting')
    expect(page.q('open-conversation')?.getAttribute('href')).toBe('/inbox/mail%3Ac-new')
    await page.unmount()
  })
})

describe('the Drafts view lists them', () => {
  async function screenFor(view: 'drafts' | 'all', who: 'all' | 'team' = 'all', selectedDraft: string | null = null) {
    const { ConversationsScreen } = await import('../src/client/Conversations')
    const { meOf } = await import('../src/app')
    const { MAIN } = await import('../src/conversations')
    const { fixtureApps } = await import('../src/stand-ins')
    const { conversations } = await import('../src/list')
    const apps = fixtureApps(T0, '1')
    const kind = view === 'drafts' ? ({ kind: 'drafts' } as const) : MAIN
    const answer = await conversations({ apps: { inbox: apps.inbox, meet: apps.meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100 }, kind)
    const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
    return renderToStaticMarkup(
      <ConversationsScreen me={me} now={T0} answer={answer} loading={false} problem={null} view={view} who={who} onWho={() => undefined} query="" onQuery={() => undefined} results={null} live="off" selected={null} selectedDraft={selectedDraft} go={() => undefined} />,
    )
  }

  test('under "Not on a conversation yet", each a row that opens its own page, with who it is to, the subject, the words and what it is', async () => {
    const html = await screenFor('drafts')
    expect(html).toContain('Not on a conversation yet')
    const rows = [...html.matchAll(/<a class="row[^"]*" href="([^"]+)"[^>]*data-testid="loose-draft" data-draft="([^"]+)".*?<\/a>/gs)]
    expect(rows.map((m) => [m[1], m[2]])).toEqual([
      ['/inbox/draft/d-first-email', 'd-first-email'],
      ['/inbox/draft/d-linkedin-1', 'd-linkedin-1'],
    ])
    expect(rows[0]?.[0]).toContain('To Nadia Hussain')
    expect(rows[0]?.[0]).toContain('Websites for caterers')
    expect(rows[0]?.[0]).toContain('Email draft')
    expect(rows[0]?.[0]).toContain('Draft from Claude')
    expect(rows[1]?.[0]).toContain('Direct message draft')
    // The people with a draft on a conversation are rows below them, as before.
    expect(html.indexOf('data-testid="loose-drafts"')).toBeLessThan(html.indexOf('data-testid="rows"'))
    expect(html).toContain('data-testid="drafts-tag"')
  })

  test('the one that is open is marked, and a phone gives the screen to its page', async () => {
    const html = await screenFor('drafts', 'all', 'd-first-email')
    expect(html).toMatch(/<div class="split open"/)
    expect(html).toMatch(/aria-current="true"[^>]*data-testid="loose-draft" data-draft="d-first-email"|class="row on" href="\/inbox\/draft\/d-first-email"/)
  })

  test('no other view lists them, and the Team cut leaves them out', async () => {
    expect(await screenFor('all')).not.toContain('data-testid="loose-draft"')
    expect(await screenFor('drafts', 'team')).not.toContain('data-testid="loose-draft"')
  })
})
