// Writing in a conversation, in a stand-in DOM over the local fixtures: the draft's card has Edit (and no link out to the inbox), and an email thread has the inbox's own Mark as spam and Move to
// the Inbox. Press-level: what is asked of the inbox, what the person is told, and what is read again afterwards. The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { type Called, mount, realFetch, standInWorker } from './compose-support'

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
  const changed: number[] = []
  const page = await mount((h) => h(ConversationPane, { me, scope: 'mail', convKey: key, refreshes: 0, fromClosed: false, onChanged: () => void changed.push(1), go: () => undefined }) as never)
  return { page, changed }
}

const LENA = 'lena@fischerbakery.example'
const spamCalls = (calls: Called[]) => calls.filter((c) => c.path === '/api/inbox/spam')

describe('the service worker is told which person is open, by the Inbox alone', () => {
  test('an email conversation registers the person’s addresses; the same person’s direct message in Meet registers none, so an email from them is not kept quiet', async () => {
    standInWorker()
    const { shownConversation } = await import('../src/client/notify')
    const { ConversationPane } = await import('../src/client/Conversation')
    const { meOf } = await import('../src/app')
    const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
    const open = (scope: 'mail' | 'chat') => mount((h) => h(ConversationPane, { me, scope, convKey: 'priya@northfield.example', refreshes: 0, fromClosed: false, onChanged: () => undefined, go: () => undefined }) as never)
    const meet = await open('chat')
    expect(meet.q('conversation')).not.toBeNull()
    expect(shownConversation()).toEqual([])
    await meet.unmount()
    const inbox = await open('mail')
    expect(inbox.q('conversation')).not.toBeNull()
    expect(shownConversation()).toContain('priya@northfield.example')
    await inbox.unmount()
    expect(shownConversation()).toEqual([])
  })
})

describe('the draft card in a conversation', () => {
  test('has Edit on the card and no link out to the inbox; saving shows the new words and says so, and the draft is sent at the new revision', async () => {
    const worker = standInWorker()
    const { page } = await openConversation(LENA)
    expect(page.q('edit-draft')?.textContent).toBe('Edit')
    expect(page.q('draft')?.querySelector('a[href*="inbox.northfield.example"]')).toBeNull()
    await page.click(page.q('edit-draft'))
    expect(page.q('draft-editor')).not.toBeNull()
    // The card's Send waits while words are being edited, so what is sent is never what the person has not saved.
    expect(page.q<HTMLButtonElement>('send-draft')?.disabled).toBe(true)
    await page.type(page.q('edit-text'), 'Hi Lena, I will fix it today and send you a link to check.')
    await page.click(page.q('save-draft'))
    expect(worker.calls.filter((c) => c.path === '/api/inbox/draft-edit')[0]?.body).toMatchObject({ draftId: 'd-lena-1', rev: 1, text: 'Hi Lena, I will fix it today and send you a link to check.' })
    expect(page.q('draft-editor')).toBeNull()
    expect(page.q('draft-saved')).not.toBeNull()
    expect(page.q('draft')?.textContent).toContain('and send you a link to check.')
    expect(page.q<HTMLButtonElement>('send-draft')?.disabled).toBe(false)
    await page.click(page.q('send-draft'))
    const sends = worker.calls.filter((c) => c.path === '/api/email')
    expect(sends[0]?.body).toMatchObject({ draftId: 'd-lena-1', rev: 2 })
    await page.unmount()
  })
})

describe('the draft card keeps its chat while editing, and a draft the space cannot send has a way out', () => {
  test('the assistant chat stays on the card while the editor is open', async () => {
    standInWorker()
    const { page } = await openConversation(LENA)
    expect(page.q('open-chat')).not.toBeNull()
    await page.click(page.q('edit-draft'))
    expect(page.q('draft-editor')).not.toBeNull()
    expect(page.q('open-chat')).not.toBeNull()
    await page.unmount()
  })

  test('a draft whose Cc the inbox did not say is not sent from here, and says so with no link to a page that is going', async () => {
    const worker = standInWorker()
    const real = worker.apps.inbox.drafts
    worker.apps.inbox.drafts = async (a) => {
      const got = await real.call(worker.apps.inbox, a)
      return got.ok ? { ok: true, value: got.value.map(({ cc: _cc, ...rest }) => rest as never) } : got
    }
    const { page } = await openConversation(LENA)
    expect(page.q('send-draft')).toBeNull()
    const notice = page.q('draft-notice')
    expect(notice?.textContent).toContain('The inbox did not say who this draft copies, so the space will not send it.')
    expect(notice?.querySelector('a')).toBeNull()
    expect(notice?.textContent).not.toContain('Open it in the inbox')
    await page.unmount()
  })
})

describe('the spam control over an email thread', () => {
  test('is on a thread of someone who is not a Client’s, calls it spam once, says where it went, and offers the way back', async () => {
    const worker = standInWorker()
    const { page, changed } = await openConversation(LENA)
    expect(page.q('spam')?.textContent).toBe('Mark as spam')
    await page.click(page.q('spam'))
    expect(spamCalls(worker.calls).map((c) => c.body)).toEqual([{ conversationId: 't-lena-1', spam: true }])
    expect(page.q('change-notice')?.textContent).toContain('is in Bulk now')
    expect(changed.length).toBeGreaterThan(0)
    expect(page.q('spam')?.textContent).toBe('Move to the Inbox')
    await page.click(page.q('spam'))
    expect(spamCalls(worker.calls).map((c) => c.body)).toEqual([
      { conversationId: 't-lena-1', spam: true },
      { conversationId: 't-lena-1', spam: false },
    ])
    expect(page.q('change-notice')?.textContent).toContain('back in the Inbox')
    expect(page.q('spam')?.textContent).toBe('Mark as spam')
    await page.unmount()
  })

  test('is not on a thread of a Client’s person that is in the Inbox, as the inbox’s own page draws none, and not on a text', async () => {
    standInWorker()
    const dana = await openConversation('dana@harbordental.example')
    expect(dana.page.all('spam')).toHaveLength(0)
    await dana.page.unmount()
    const text = await openConversation('mail:c-text')
    expect(text.page.all('spam')).toHaveLength(0)
    await text.page.unmount()
  })

  test('an inbox that refuses says so in its words and the thread stays where it was; one that does not answer says it may have been done', async () => {
    const worker = standInWorker()
    const { page } = await openConversation(LENA)
    worker.apps.inbox.setSpam = async () => ({ ok: false, kind: 'refused', reason: 'bad-request', message: 'Only a conversation in a mailbox can be moved to Bulk or back.' })
    await page.click(page.q('spam'))
    expect(page.q('change-notice')?.textContent).toContain('Only a conversation in a mailbox')
    expect(page.q('spam')?.textContent).toBe('Mark as spam')
    worker.apps.inbox.setSpam = async () => {
      throw new Error('gone')
    }
    await page.click(page.q('spam'))
    expect(page.q('change-notice')?.textContent).toContain('may have been done')
    await page.unmount()
  })
})
