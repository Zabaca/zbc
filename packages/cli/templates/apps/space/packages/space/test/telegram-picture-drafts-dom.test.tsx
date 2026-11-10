// In a stand-in DOM over the local fixtures: a Telegram draft that carries a picture (Claude's, in the fixtures of the `telegram-pictures` mode) shows it on
// its card and says whose it is; in the card's Edit Tessa puts another picture on, takes it out, or leaves it and changes the words (the words may be none when a picture speaks for itself); and the card's Send sends it as it
// stands. Press-level: what is asked of the inbox and what the person sees. The DOM is registered for this file only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { type Called, mount, realFetch, sleep, standInWorker } from './compose-support'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const SAM = 'mail:c-tg-sam'
const MARIA = 'mail:c-tg-maria'
const LENA = 'lena@fischerbakery.example'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]
const picture = (name = 'Screenshot.png', bytes: number[] = PNG, type = 'image/png') => new File([new Uint8Array(bytes)], name, { type })

async function openConversation(key: string) {
  const { ConversationPane } = await import('../src/client/Conversation')
  const { meOf } = await import('../src/app')
  const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
  return mount((h) => h(ConversationPane, { me, scope: 'mail', convKey: key, refreshes: 0, fromClosed: false, onChanged: () => undefined, go: () => undefined }) as never)
}
const draftCalls = (calls: Called[], path: string) => calls.filter((c) => c.path === path)

describe('the card of a Telegram draft that carries a picture', () => {
  test('shows the picture from the owner’s own attachment route, at the draft’s revision, and says it is Claude’s; a draft of words only shows none; the card sends it as it stands', async () => {
    const worker = standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    const figure = page.q('draft-picture')
    expect(figure).not.toBeNull()
    expect(figure?.querySelector('img')?.getAttribute('src')).toBe('/api/attachment?m=d-tg-pic&n=0&how=view&v=1')
    expect(page.q('draft-picture-note')?.textContent).toContain('Claude attached this picture.')
    expect(page.q('draft-picture-note')?.textContent).toContain('It goes as a photo, with the words above as its caption')
    expect(page.q('draft')?.textContent).toContain('Here is the receipt you asked for.')
    expect(page.q('send-draft')?.textContent).toBe('Send as it stands')
    await page.unmount()

    const words = await openConversation(MARIA)
    expect(words.q('draft')).not.toBeNull()
    expect(words.q('draft-picture')).toBeNull()
    await words.unmount()

    // Sending it as it stands names the draft and its revision, as any draft's send does; the picture goes with it.
    const again = await openConversation(SAM)
    await again.click(again.q('send-draft'))
    const sends = draftCalls(worker.calls, '/api/email')
    expect(sends[0]?.body).toMatchObject({ draftId: 'd-tg-pic', rev: 1 })
    const heard = worker.apps.inbox.threads().find((t) => t.id === 't-tg-sam')?.messages ?? []
    const message = heard[heard.length - 1]
    expect(message?.files?.[0]?.name).toBe('Photo.png')
    expect(message?.text).toBe('Here is the receipt you asked for.')
    await again.unmount()
  })

  test('a draft on an email conversation has no picture in its card or in its editor', async () => {
    standInWorker('telegram-pictures')
    const page = await openConversation(LENA)
    expect(page.q('draft-picture')).toBeNull()
    await page.click(page.q('edit-draft'))
    expect(page.q('draft-editor')).not.toBeNull()
    expect(page.q('edit-picture')).toBeNull()
    await page.unmount()
  })
})

describe('Edit on a draft with a picture', () => {
  test('shows the picture with Take the picture out and a way to put another on, with the limits said; Save waits until something has changed', async () => {
    standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    expect(page.q('edit-picture')).not.toBeNull()
    expect(page.q('edit-picture')?.querySelector('[data-testid="draft-picture"] img')).not.toBeNull()
    expect(page.q('remove-picture')?.textContent).toBe('Take the picture out')
    expect(page.q('picture-button')?.textContent).toBe('Put another picture on')
    expect(page.q('picture-limits')?.textContent).toContain('One picture, PNG or JPEG, at most 10 MB')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.unmount()
  })

  test('another picture put on: one call to the draft’s picture route at the revision shown, then the card is read again and shows the new revision', async () => {
    const worker = standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    await page.attach(page.q('picture-input'), [picture('Receipt.png')])
    await page.wait(30)
    expect(page.q('picture-name')?.textContent).toContain('Receipt.png')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(false)
    await page.click(page.q('save-draft'))
    const put = draftCalls(worker.calls, '/api/draft-picture')
    expect(put).toHaveLength(1)
    expect(JSON.parse((put[0]?.body as { json: string }).json)).toEqual({ draftId: 'd-tg-pic', rev: 1 })
    expect((put[0]?.body as { file: string }).file).toBe('Receipt.png')
    expect(worker.apps.inbox.pictureWrites).toEqual([{ draftId: 'd-tg-pic', rev: 1, name: 'Receipt.png', size: PNG.length }])
    // The words did not change, so no second call: the picture's own edit raised the revision.
    expect(draftCalls(worker.calls, '/api/inbox/draft-edit')).toHaveLength(0)
    expect(page.q('draft-editor')).toBeNull()
    expect(page.q('draft-saved')).not.toBeNull()
    expect(page.q('draft-picture')?.querySelector('img')?.getAttribute('src')).toBe('/api/attachment?m=d-tg-pic&n=0&how=view&v=2')
    await page.unmount()
  })

  test('a picture and new words in one save: the picture first, then the words at the revision the picture’s call gave', async () => {
    const worker = standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    await page.type(page.q('edit-text'), 'Here is the receipt, and the invoice too.')
    await page.attach(page.q('picture-input'), [picture()])
    await page.wait(30)
    await page.click(page.q('save-draft'))
    expect(draftCalls(worker.calls, '/api/draft-picture')).toHaveLength(1)
    const edits = draftCalls(worker.calls, '/api/inbox/draft-edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.body).toMatchObject({ draftId: 'd-tg-pic', rev: 2, text: 'Here is the receipt, and the invoice too.' })
    expect((edits[0]?.body as Record<string, unknown>).takeOutPicture).toBeUndefined()
    await page.unmount()
  })

  test('taking the picture out is a field of the edit, in the same save as the words, and the card then shows none; it can be kept after all', async () => {
    const worker = standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    await page.click(page.q('remove-picture'))
    expect(page.q('picture-removed')?.textContent).toContain('The picture will be taken out when you save.')
    expect(page.q('edit-picture')?.querySelector('[data-testid="draft-picture"]')).toBeNull()
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(false)
    await page.click(page.q('keep-picture'))
    expect(page.q('remove-picture')).not.toBeNull()
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.click(page.q('remove-picture'))
    await page.click(page.q('save-draft'))
    const edits = draftCalls(worker.calls, '/api/inbox/draft-edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.body).toMatchObject({ draftId: 'd-tg-pic', rev: 1, takeOutPicture: true })
    expect(draftCalls(worker.calls, '/api/draft-picture')).toHaveLength(0)
    expect(page.q('draft-picture')).toBeNull()
    await page.unmount()
  })

  test('the words may be none while a picture will be there, and are needed again once it is taken out', async () => {
    standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    await page.type(page.q('edit-text'), '')
    expect(page.q('edit-blank')).toBeNull()
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(false)
    await page.click(page.q('remove-picture'))
    expect(page.q('edit-blank')?.textContent).toBe('A draft needs words.')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.unmount()
  })

  test('a picture that is not one, one that is too large and words too long under it are each said before Save, and Save waits', async () => {
    standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    await page.attach(page.q('picture-input'), [picture('cat.png', [...new TextEncoder().encode('<script>alert(1)</script>')])])
    await page.wait(30)
    expect(page.q('picture-why')?.textContent).toBe('cat.png is not a PNG or a JPEG, so Telegram would not take it as a picture.')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.click(page.q('picture-take-out'))
    expect(page.q('picture-why')).toBeNull()
    // Words past the caption's limit, under the picture the draft carries.
    await page.type(page.q('edit-text'), 'x'.repeat(1025))
    expect(page.q('picture-why')?.textContent).toContain('at most 1024 characters (these are 1025)')
    expect(page.q<HTMLButtonElement>('save-draft')?.disabled).toBe(true)
    await page.unmount()
  })

  test('a screenshot pasted into the draft’s words is the picture; a paste with words is the words', async () => {
    standInWorker('telegram-pictures')
    const { act } = await import('react')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    const paste = async (files: File[], words = '') => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { files, getData: (t: string) => (t === 'text/plain' ? words : '') } })
      await act(async () => {
        ;(page.q('edit-text') as HTMLElement).dispatchEvent(event)
        await sleep(30)
      })
      return event.defaultPrevented
    }
    expect(await paste([picture('image.png')], 'A1\tB1')).toBe(false)
    expect(page.q('picture-chosen')).toBeNull()
    expect(await paste([picture('image.png')])).toBe(true)
    expect(page.q('picture-name')?.textContent).toContain('image.png')
    await page.unmount()
  })

  test('what the inbox refuses is said in its words and nothing is saved over: a draft that moved on is a conflict', async () => {
    const worker = standInWorker('telegram-pictures')
    const page = await openConversation(SAM)
    await page.click(page.q('edit-draft'))
    // Claude changes the draft while the editor is open.
    const draft = worker.apps.inbox.threads()
    expect(draft.length).toBeGreaterThan(0)
    const inbox = worker.apps.inbox
    const listed = await inbox.drafts({ person: { address: 'tessa@northfield.example' } } as never)
    expect(listed.ok).toBe(true)
    await inbox.editDraft({ person: { address: 'tessa@northfield.example' } } as never, { draftId: 'd-tg-pic', rev: 1, text: 'Claude changed the words.' })
    await page.attach(page.q('picture-input'), [picture()])
    await page.wait(30)
    await page.click(page.q('save-draft'))
    expect(page.q('draft-editor')).not.toBeNull()
    expect(page.text()).toContain('changed')
    expect(worker.apps.inbox.pictureWrites.filter((w) => w.rev === 1)).toHaveLength(1)
    await page.unmount()
  })
})
