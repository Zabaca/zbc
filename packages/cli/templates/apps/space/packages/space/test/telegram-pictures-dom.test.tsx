// In a stand-in DOM over the local fixtures: Tessa attaches or pastes ONE picture into a Telegram reply box, sees it small with Take out before anything is
// sent, is told the limits (one picture, PNG or JPEG, 10 MB, 1,024 characters of words under it) before Send, and sends it. Press-level: what is asked of the inbox and what the person sees. The DOM is registered for this
// file only. What no stand-in shows is Telegram, and the real inbox's own checks (its tests).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { INBOX_CAPTION_MAX, INBOX_PICTURE_MAX_BYTES } from '@space/workspace'
import { sniffPicture } from '../../inbox/src/telegram/wire'
import { northfield } from '../../workspace/test/helpers'
import { newCompose, pastedPicture } from '../src/client/compose'
import { mount, realFetch, sleep, standInWorker } from './compose-support'

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const MARIA = 'mail:c-tg-maria'
const LENA = 'lena@fischerbakery.example'
const GARDEN = 'mail:c-tg-garden'
const STATUS = 'mail:c-tg-status'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]
const picture = (name = 'Screenshot.png', bytes: number[] = PNG, type = 'image/png') => new File([new Uint8Array(bytes)], name, { type })

async function openConversation(key: string, scope: 'mail' | 'chat' = 'mail') {
  const { ConversationPane } = await import('../src/client/Conversation')
  const { meOf } = await import('../src/app')
  const me = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
  return mount((h) => h(ConversationPane, { me, scope, convKey: key, refreshes: 0, fromClosed: false, onChanged: () => undefined, go: () => undefined }) as never)
}

/** A paste whose clipboard holds these files and this plain text, as the browser hands it to the box. Answers whether the page took the paste over (preventDefault). */
async function paste(page: Awaited<ReturnType<typeof mount>>, files: File[], words = ''): Promise<boolean> {
  const { act } = await import('react')
  const box = page.q('compose-text') as HTMLElement
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: (type: string) => (type === 'text/plain' ? words : '') } })
  await act(async () => {
    box.dispatchEvent(event)
    await sleep(30)
  })
  return event.defaultPrevented
}

describe('what the reply box offers', () => {
  test('a Telegram chat with a person has Attach picture with the limits said, a group too, and a channel, an email thread and an inbox that predates it have none', async () => {
    standInWorker()
    const person = await openConversation(MARIA)
    expect(person.q('picture-button')?.textContent).toBe('Attach picture')
    const limits = person.q('picture-limits')?.textContent ?? ''
    expect(limits).toContain('One picture, PNG or JPEG, at most 10 MB')
    expect(limits).toContain(`at most ${INBOX_CAPTION_MAX} characters`)
    expect(limits).toContain('paste a screenshot')
    // It takes one picture of the two kinds, and the picker is limited to them.
    expect(person.q<HTMLInputElement>('picture-input')?.accept).toBe('image/png,image/jpeg')
    expect(person.q<HTMLInputElement>('picture-input')?.multiple).toBe(false)
    await person.unmount()

    const group = await openConversation(GARDEN)
    expect(group.q('picture-button')).not.toBeNull()
    await group.unmount()

    const channel = await openConversation(STATUS)
    expect(channel.q('composer')).toBeNull()
    expect(channel.q('attach-picture')).toBeNull()
    await channel.unmount()

    const email = await openConversation(LENA)
    expect(email.q('attach-picture')).toBeNull()
    await email.unmount()
  })
})

describe('choosing a picture', () => {
  test('is shown small with its name and size and a Take out, Send is on with no words at all, and taking it out puts the box back', async () => {
    standInWorker()
    const page = await openConversation(MARIA)
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    await page.attach(page.q('picture-input'), [picture('Screenshot 2026-11-06.png')])
    await page.wait(30)
    expect(page.q('picture-name')?.textContent).toContain('Screenshot 2026-11-06.png (12 B)')
    expect(page.q('picture-button')).toBeNull()
    expect(page.q('picture-why')).toBeNull()
    // Send speaks for the picture alone.
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.click(page.q('picture-take-out'))
    expect(page.q('picture-chosen')).toBeNull()
    expect(page.q('picture-button')).not.toBeNull()
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    await page.unmount()
  })

  test('is refused in words before Send when its first bytes are not a PNG or a JPEG, whatever its name and type say; an empty one; one over ten megabytes', async () => {
    standInWorker()
    const page = await openConversation(MARIA)
    await page.attach(page.q('picture-input'), [picture('cat.png', [...new TextEncoder().encode('<script>alert(1)</script>')])])
    await page.wait(30)
    expect(page.q('picture-why')?.textContent).toBe('cat.png is not a PNG or a JPEG, so Telegram would not take it as a picture.')
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    expect(page.q('picture-preview')).toBeNull()
    await page.click(page.q('picture-take-out'))

    await page.attach(page.q('picture-input'), [picture('empty.png', [])])
    await page.wait(30)
    expect(page.q('picture-why')?.textContent).toBe('empty.png is empty.')
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    await page.click(page.q('picture-take-out'))

    const big = new Uint8Array(INBOX_PICTURE_MAX_BYTES + 1)
    big.set(PNG)
    await page.attach(page.q('picture-input'), [new File([big], 'huge.png', { type: 'image/png' })])
    await page.wait(30)
    expect(page.q('picture-why')?.textContent).toBe('huge.png is over 10 MB, the most Telegram takes in a picture.')
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    await page.click(page.q('picture-take-out'))

    // And a picture of exactly ten megabytes goes.
    const exact = new Uint8Array(INBOX_PICTURE_MAX_BYTES)
    exact.set(JPEG)
    await page.attach(page.q('picture-input'), [new File([exact], 'photo.jpg', { type: 'image/jpeg' })])
    await page.wait(30)
    expect(page.q('picture-why')).toBeNull()
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.unmount()
  })

  test('words under a picture are at most 1,024 characters, said before Send; words alone are not held to it', async () => {
    standInWorker()
    const page = await openConversation(MARIA)
    await page.type(page.q('compose-text'), 'x'.repeat(INBOX_CAPTION_MAX + 1))
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.attach(page.q('picture-input'), [picture()])
    await page.wait(30)
    expect(page.q('picture-why')?.textContent).toContain(`at most ${INBOX_CAPTION_MAX} characters (these are ${INBOX_CAPTION_MAX + 1})`)
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(true)
    await page.type(page.q('compose-text'), 'x'.repeat(INBOX_CAPTION_MAX))
    expect(page.q('picture-why')).toBeNull()
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.unmount()
  })
})

describe('pasting a screenshot', () => {
  test('a clipboard that holds a picture and no plain words attaches it; one that holds words pastes the words, even with a picture riding along (a spreadsheet’s cells)', async () => {
    standInWorker()
    const page = await openConversation(MARIA)
    expect(await paste(page, [picture('image.png')], 'A1\tB1\n')).toBe(false)
    expect(page.q('picture-chosen')).toBeNull()
    expect(await paste(page, [], '')).toBe(false)
    expect(await paste(page, [new File(['x'], 'notes.txt', { type: 'text/plain' })], '')).toBe(false)
    expect(page.q('picture-chosen')).toBeNull()

    expect(await paste(page, [picture('image.png')])).toBe(true)
    expect(page.q('picture-name')?.textContent).toContain('image.png')
    expect(page.q<HTMLButtonElement>('send')?.disabled).toBe(false)
    await page.unmount()
  })

  test('a second picture does not replace the first: the box says one picture per message', async () => {
    standInWorker()
    const page = await openConversation(MARIA)
    await paste(page, [picture('first.png')])
    await paste(page, [picture('second.png')])
    expect(page.q('picture-name')?.textContent).toContain('first.png')
    expect(page.text()).toContain('A message carries one picture. Take the first out to use another.')
    await page.click(page.q('picture-take-out'))
    await paste(page, [picture('second.png')])
    expect(page.q('picture-name')?.textContent).toContain('second.png')
    await page.unmount()
  })

  test('paste is the browser’s own where the thread takes no picture (an email reply)', async () => {
    standInWorker()
    const page = await openConversation(LENA)
    expect(await paste(page, [picture('image.png')])).toBe(false)
    expect(page.q('picture-chosen')).toBeNull()
    await page.unmount()
  })
})

describe('pressing Send', () => {
  test('posts the words and the one picture to the form the space takes files on, says it is sending on Telegram, and clears the box for the next message', async () => {
    const worker = standInWorker()
    const page = await openConversation(MARIA)
    await page.type(page.q('compose-text'), 'The red box is the bug.')
    await page.attach(page.q('picture-input'), [picture('Screenshot.png')])
    await page.wait(30)
    await page.submit(page.q('compose-text'))
    const sends = worker.calls.filter((c) => c.path === '/api/email/files')
    expect(sends).toHaveLength(1)
    const form = sends[0]?.body as { json: string; file: string }
    expect(form.file).toBe('Screenshot.png')
    expect(JSON.parse(form.json)).toMatchObject({ text: 'The red box is the bug.', conversationId: 't-tg-maria' })
    expect(page.q('compose-notice')?.textContent).toContain('Sending on Telegram. It shows in the conversation when Telegram has it.')
    expect(page.q('picture-chosen')).toBeNull()
    expect(page.q<HTMLTextAreaElement>('compose-text')?.value).toBe('')
    // The stand-in inbox received ONE picture, byte for byte, and the words as its caption.
    const sent = worker.apps.inbox.asked.sends.at(-1) as { attachments?: { bytes: Uint8Array }[]; text: string }
    expect(sent.text).toBe('The red box is the bug.')
    expect(sent.attachments).toHaveLength(1)
    expect([...(sent.attachments?.[0]?.bytes ?? [])]).toEqual(PNG)
    await page.unmount()
  })

  test('a picture alone goes with no words', async () => {
    const worker = standInWorker()
    const page = await openConversation(MARIA)
    await paste(page, [picture('image.png')])
    await page.submit(page.q('compose-text'))
    const form = worker.calls.filter((c) => c.path === '/api/email/files')[0]?.body as { json: string }
    expect(JSON.parse(form.json)).toMatchObject({ text: '' })
    expect(page.q('compose-notice')?.textContent).toContain('Sending on Telegram')
    await page.unmount()
  })

  test('what the inbox refuses comes back in its words, and the picture stays in the box so Send can be pressed again', async () => {
    const worker = standInWorker()
    const page = await openConversation(MARIA)
    // The first press is refused as a new message arrived, and the box keeps the picture and the words.
    worker.apps.inbox.script.send.push('conflict')
    await page.type(page.q('compose-text'), 'see this')
    await page.attach(page.q('picture-input'), [picture()])
    await page.wait(30)
    await page.submit(page.q('compose-text'))
    expect(page.q('compose-notice')?.textContent).toBeTruthy()
    expect(page.q('picture-chosen')).not.toBeNull()
    expect(page.q<HTMLTextAreaElement>('compose-text')?.value).toBe('see this')
    await page.unmount()
  })
})

describe('the rules the page keeps in step with the inbox', () => {
  test('the one sniffPicture reads PNG and JPEG by their first bytes and nothing else', () => {
    expect(sniffPicture(new Uint8Array(PNG))).toBe('image/png')
    expect(sniffPicture(new Uint8Array(JPEG))).toBe('image/jpeg')
    for (const bytes of [[], [0x89, 0x50], [0x47, 0x49, 0x46, 0x38], [0xff, 0xd8], [0x3c, 0x73, 0x76, 0x67]]) expect(sniffPicture(new Uint8Array(bytes)), bytes.join(',')).toBeNull()
  })

  test('only a paste with a PNG or a JPEG and no plain words is a picture', () => {
    const data = (files: File[], words = '') => ({ files, getData: (t: string) => (t === 'text/plain' ? words : '') }) as unknown as DataTransfer
    expect(pastedPicture(data([picture()]))?.name).toBe('Screenshot.png')
    expect(pastedPicture(data([picture('p.jpg', JPEG, 'image/jpeg')]))?.name).toBe('p.jpg')
    expect(pastedPicture(data([picture()], 'words'))).toBeNull()
    expect(pastedPicture(data([picture('p.gif', [0x47], 'image/gif')]))).toBeNull()
    expect(pastedPicture(data([]))).toBeNull()
    expect(pastedPicture(null)).toBeNull()
  })

  test('a compose that is waiting on an answer keeps the picture it has', () => {
    const waiting = { ...newCompose(), phase: 'sending' as const, text: 'x' }
    expect(waiting.picture).toBeUndefined()
  })
})
