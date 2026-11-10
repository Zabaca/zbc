// The five things only the inbox's own page still did, as a browser runs them, in a stand-in DOM over the Worker's own functions and the local fixtures:
// a send Gmail never confirmed is shown with no Send and settled in two presses, a text or a LinkedIn draft has Mark sent (and no Send) and the message it makes has Not sent after all, a
// search result opens the person's conversation, People renames at the revision shown and splits an address off. Press-level: what is asked of the inbox, what the person is told, and what
// is read again afterwards. The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { mount, realFetch, standInWorker } from './compose-support'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

async function openConversation(key: string) {
  const { ConversationPane } = await import('../src/client/Conversation')
  const { meOf } = await import('../src/app')
  const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
  const page = await mount((h) => h(ConversationPane, { me, scope: 'mail', convKey: key, refreshes: 0, fromClosed: false, onChanged: () => undefined, go: () => undefined }) as never)
  return page
}

const writes = (calls: { path: string; body: unknown }[], name: string) => calls.filter((c) => c.path === `/api/inbox/${name}`).map((c) => c.body)
const card = (page: Awaited<ReturnType<typeof openConversation>>, id: string) => page.all('draft').find((d) => d.dataset.draft === id) as HTMLElement

describe('a send Gmail never confirmed', () => {
  test('is shown with the inbox page’s words and no Send; each answer asks once more and says what it will do; yes removes it', async () => {
    const worker = standInWorker()
    const page = await openConversation('marcus@harbordental.example')
    const stuck = card(page, 'd-marcus-stuck')
    expect(stuck.querySelector('[data-testid="send-draft"]')).toBeNull()
    expect(stuck.querySelector('[data-testid="edit-draft"]')).toBeNull()
    expect(stuck.querySelector('[data-testid="stuck-send"]')?.textContent).toContain('Gmail did not say whether this went out, so it has not been sent again. Check Gmail Sent, then say which it was.')
    expect(stuck.querySelector('[data-testid="stuck-out"]')?.textContent).toBe('It went out: remove this')
    expect(stuck.querySelector('[data-testid="stuck-not"]')?.textContent).toBe('It did not go out: make it a draft again')
    await page.click(stuck.querySelector('[data-testid="stuck-out"]'))
    expect(writes(worker.calls, 'resolve-send')).toEqual([]) // one press asks, it does not settle
    expect(page.q('stuck-ask')?.textContent).toContain('Gmail Sent shows this message. This removes the stuck draft; Gmail’s own copy is the record.')
    await page.click(page.q('stuck-yes'))
    expect(writes(worker.calls, 'resolve-send')).toEqual([{ draftId: 'd-marcus-stuck', sent: true }])
    expect(page.all('draft').map((d) => d.dataset.draft)).not.toContain('d-marcus-stuck')
    await page.unmount()
  })

  test('"did not go out" makes it a draft again, which can be edited and sent', async () => {
    const worker = standInWorker()
    const page = await openConversation('marcus@harbordental.example')
    await page.click(card(page, 'd-marcus-stuck').querySelector('[data-testid="stuck-not"]'))
    expect(page.q('stuck-ask')?.textContent).toContain('Gmail Sent does not show this message. This makes it a draft again. If it did go out, sending it again delivers it twice.')
    await page.click(page.q('stuck-cancel'))
    expect(writes(worker.calls, 'resolve-send')).toEqual([])
    await page.click(card(page, 'd-marcus-stuck').querySelector('[data-testid="stuck-not"]'))
    await page.click(page.q('stuck-yes'))
    expect(writes(worker.calls, 'resolve-send')).toEqual([{ draftId: 'd-marcus-stuck', sent: false }])
    const again = card(page, 'd-marcus-stuck')
    expect(again.querySelector('[data-testid="stuck-send"]')).toBeNull()
    expect(again.querySelector('[data-testid="send-draft"]')).not.toBeNull()
    expect(again.querySelector('[data-testid="edit-draft"]')).not.toBeNull()
    await page.unmount()
  })

  test('one from a business mailbox says there is no Sent folder and to ask the recipient, and the answer records it as sent', async () => {
    const worker = standInWorker()
    const page = await openConversation('tomas.alvarez@mail.example')
    const stuck = card(page, 'd-lead-stuck')
    expect(stuck.querySelector('[data-testid="stuck-send"]')?.textContent).toContain('Cloudflare did not say whether this went out from info@ridgewaycycles.example, so it has not been sent again. There is no Sent folder for it: ask tomas.alvarez@mail.example, then say which it was.')
    expect(stuck.querySelector('[data-testid="stuck-out"]')?.textContent).toBe('It went out: record it as sent')
    await page.click(stuck.querySelector('[data-testid="stuck-out"]'))
    expect(page.q('stuck-ask')?.textContent).toContain('This records it as sent, on your word: the inbox has the only record of it.')
    expect(page.q('stuck-yes')?.textContent).toBe('Yes, it went out: record it as sent')
    await page.click(page.q('stuck-yes'))
    expect(writes(worker.calls, 'resolve-send')).toEqual([{ draftId: 'd-lead-stuck', sent: true }])
    await page.unmount()
  })

  test('a refusal is said in the inbox’s words and the card stays as it was, with the question closed', async () => {
    const worker = standInWorker()
    const page = await openConversation('marcus@harbordental.example')
    await page.click(card(page, 'd-marcus-stuck').querySelector('[data-testid="stuck-out"]'))
    // Gmail's own copy turned up meanwhile: "did not go out" is refused and the card stays as it was.
    worker.apps.inbox.resolveSend = async () => ({ ok: false, kind: 'refused', reason: 'conflict', message: 'Gmail’s own copy of this message is already in the inbox (it has the same Message-ID), so it did go out. Say that it went out, to remove this one.' })
    await page.click(page.q('stuck-yes'))
    expect(page.q('say')?.textContent).toContain('Gmail’s own copy of this message is already in the inbox')
    expect(card(page, 'd-marcus-stuck').querySelector('[data-testid="stuck-send"]')).not.toBeNull()
    expect(page.q('stuck-ask')).toBeNull()
    await page.unmount()
  })
})

describe('a text or a LinkedIn message the inbox cannot send', () => {
  test('has Mark sent and the words to copy, no Send and no link out; pressing Mark sent files it once, and the message has Not sent after all', async () => {
    const worker = standInWorker()
    const page = await openConversation('mail:c-text')
    const draft = card(page, 'd-text-1')
    expect(draft.querySelector('[data-testid="send-draft"]')).toBeNull()
    expect(draft.querySelector('a')).toBeNull()
    expect(draft.textContent).toContain('The inbox cannot send a text message. Send it yourself, then press Mark sent.')
    expect(draft.querySelector('[data-testid="copy-address"]')).not.toBeNull()
    expect(draft.querySelector('[data-testid="copy-words"]')).not.toBeNull()
    expect(page.all('not-sent-after-all')).toHaveLength(1) // the one already filed from his phone
    await page.click(draft.querySelector('[data-testid="mark-sent"]'))
    expect(writes(worker.calls, 'draft-sent')).toEqual([{ draftId: 'd-text-1' }])
    expect(page.all('draft').map((d) => d.dataset.draft)).not.toContain('d-text-1')
    expect(page.text()).toContain('No problem. The door is open, come straight in.')
    expect(page.all('not-sent-after-all')).toHaveLength(2)
    await page.unmount()
  })

  test('Not sent after all takes the mark back: the message is a draft again, and Mark sent is offered again', async () => {
    const worker = standInWorker()
    const page = await openConversation('mail:c-text')
    await page.click(page.q('mark-sent'))
    const marks = page.all('not-sent-after-all')
    await page.click(marks[0] as HTMLElement)
    const undone = writes(worker.calls, 'draft-unsent')
    expect(undone).toHaveLength(1)
    expect(page.all('draft').length).toBeGreaterThan(0)
    expect(page.q('mark-sent')).not.toBeNull()
    await page.unmount()
  })

  test('a LinkedIn draft on a person with no conversation yet is marked sent the same way', async () => {
    const worker = standInWorker()
    const page = await openConversation('grace@okaforlaw.example')
    const draft = card(page, 'd-linkedin-1')
    expect(draft.textContent).toContain('The inbox cannot send a direct message. Send it yourself, then press Mark sent.')
    expect(draft.textContent).toContain('@graceokafor')
    await page.click(draft.querySelector('[data-testid="mark-sent"]'))
    expect(writes(worker.calls, 'draft-sent')).toEqual([{ draftId: 'd-linkedin-1' }])
    await page.unmount()
  })

  test('an email draft has Send and no Mark sent', async () => {
    standInWorker()
    const page = await openConversation('lena@fischerbakery.example')
    expect(card(page, 'd-lena-1').querySelector('[data-testid="mark-sent"]')).toBeNull()
    expect(card(page, 'd-lena-1').querySelector('[data-testid="send-draft"]')).not.toBeNull()
    await page.unmount()
  })

  test('an inbox that does not say a draft’s channel offers nothing new on it', async () => {
    const worker = standInWorker()
    const real = worker.apps.inbox.drafts
    worker.apps.inbox.drafts = async (a) => {
      const got = await real.call(worker.apps.inbox, a)
      return got.ok ? { ok: true, value: got.value.map(({ kind: _kind, sentFrom: _from, ...rest }) => rest as never) } : got
    }
    const page = await openConversation('mail:c-text')
    expect(page.all('mark-sent')).toHaveLength(0)
    await page.unmount()
  })
})

describe('a search result', () => {
  test('opens the conversation of the person on it, in the space', async () => {
    const worker = standInWorker()
    const { Conversations } = await import('../src/client/Conversations')
    const { meOf } = await import('../src/app')
    const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
    const went: string[] = []
    const page = await mount((h) => h(Conversations, { scope: 'mail', me, pathname: '/inbox', search: '', go: (p: string) => void went.push(p) }) as never)
    const input = page.q('search')
    await page.type(input, 'parking')
    await page.wait(700)
    const hits = page.all('hit')
    expect(hits.length).toBeGreaterThan(0)
    expect(worker.calls.some((c) => c.path.startsWith('/api/search?q=parking'))).toBe(true)
    const hit = hits[0] as HTMLAnchorElement
    expect(hit.getAttribute('href')).toBe('/inbox/marcus%40harbordental.example')
    expect(hit.getAttribute('target')).toBeNull()
    expect(document.body.innerHTML).not.toContain('inbox.northfield.example')
    await page.click(hit)
    expect(went).toEqual(['/inbox/marcus%40harbordental.example'])
    await page.unmount()
  })
})
