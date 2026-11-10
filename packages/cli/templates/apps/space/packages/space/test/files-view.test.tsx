// Files and delivery reports as the conversation draws them: a picture is a thumbnail asked of the Worker's own address, a document is a chip that saves, a bounce is
// said on the message that bounced and not on its neighbours, Attach is offered in a business mailbox's thread only, and an answer from an inbox that predates it draws no
// files at all. In a stand-in DOM, over the same stand-in inbox the local page is fixtured with.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { attached, newCompose } from '../src/client/compose'
import { openConversation } from '../src/conversation'
import { type StandInMessage, type StandInThread, standInInbox, standInMeet } from '../src/stand-ins'
import { RIDGEWAY, ago, contact, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const PDF = new TextEncoder().encode('%PDF-1.4\n')

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const messages: StandInMessage[] = [
  {
    id: 'm-in',
    at: ago(300),
    direction: 'in',
    from: 'Rosa Whitfield <rosa@example.org>',
    text: 'Here are the results.',
    files: [
      { name: 'form.png', type: 'image/png', bytes: PNG },
      { name: 'invoice.pdf', type: 'application/pdf', bytes: PDF },
    ],
  },
  { id: 'm-good', at: ago(250), direction: 'out', from: 'Ridgeway <info@ridgewaycycles.example>', text: 'We have them.', delivery: [{ recipient: 'rosa@example.org', state: 'delivered', reason: '', at: ago(249) }] },
  {
    id: 'm-bad',
    at: ago(200),
    direction: 'out',
    from: 'Ridgeway <info@ridgewaycycles.example>',
    text: 'The drop-off form.',
    files: [{ name: 'intake.pdf', type: 'application/pdf', bytes: PDF }],
    delivery: [{ recipient: 'rosa@example.org', state: 'bounced', reason: '550 5.1.1 User unknown', at: ago(199) }],
  },
  { id: 'm-plain', at: ago(100), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: 'Nothing attached.' },
  { id: 'm-big', at: ago(90), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: 'Four big photos.', tooLarge: true, files: [{ name: 'photo1.png', type: 'image/png', bytes: PNG }] },
]

async function draw(o: { withFiles?: boolean; mailbox?: boolean; chosen?: File[]; messages?: StandInMessage[]; reading?: boolean } = {}) {
  const threads: StandInThread[] = [thread('t1', ago(100), ['c-ro'], { subject: 'Photos', messages: o.messages ?? messages, ...(o.mailbox === false ? {} : { mailbox: RIDGEWAY }) })]
  const inbox = standInInbox([contact('c-ro', 'Rosa Whitfield', 'rosa@example.org')], threads, { withFiles: o.withFiles ?? true, ...(o.reading && { withReading: true }) })
  const meet = standInMeet({ direct: [], channels: [] }, { history: {} })
  const opened = await openConversation({ apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, 'rosa@example.org')
  if (!opened.ok) throw new Error(opened.message)
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationView } = await import('../src/client/Conversation')
  document.body.innerHTML = '<div id="root"></div>'
  const host = document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  const props = {
    me: ME,
    now: T0,
    answer: opened.value,
    sources: opened.value.sources,
    loadingEarlier: false,
    onEarlier: () => undefined,
    way: 'email' as const,
    onWay: () => undefined,
    threadId: null,
    onThread: () => undefined,
    compose: attached({ ...newCompose(), text: 'Hi' }, o.chosen ?? []),
    onText: () => undefined,
    onSend: () => undefined,
    onSendAndClose: () => undefined,
    onClose: () => undefined,
    onReopen: () => undefined,
    reopen: null,
    changing: false,
    changed: null,
    onDismiss: () => undefined,
    drafts: {},
    onSendDraft: () => undefined,
    onDismissDraft: () => undefined,
    onDraftChanged: () => undefined,
    profileOpen: false,
    onProfile: () => undefined,
    onBack: () => undefined,
    timeZone: 'UTC',
  }
  await act(async () => {
    root.render(createElement(ConversationView, props))
    await sleep(10)
  })
  return { host, done: () => act(async () => root.unmount()) }
}

const entry = (host: HTMLElement, text: string): HTMLElement => {
  const found = ([...host.querySelectorAll('[data-testid="entry"]')] as HTMLElement[]).find((e) => (e.textContent ?? '').includes(text))
  if (!found) throw new Error(`no message with ${text}`)
  return found
}

describe('files and delivery notes in the conversation', () => {
  test('a picture is a thumbnail asked of the Worker’s own address and a document is a chip that saves it, on the message they came with', async () => {
    const { host, done } = await draw()
    const files = entry(host, 'Here are the results.').querySelectorAll('[data-testid="file"]')
    expect([...files].map((f) => f.getAttribute('data-file'))).toEqual(['picture', 'download'])
    const img = entry(host, 'Here are the results.').querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/attachment?m=m-in&n=0&how=view')
    const save = entry(host, 'Here are the results.').querySelector('a[data-file="download"]') as HTMLAnchorElement
    expect(save.getAttribute('href')).toBe('/api/attachment?m=m-in&n=1&how=download')
    expect(save.getAttribute('download')).toBe('invoice.pdf')
    expect(save.textContent).toContain('invoice.pdf')
    expect(entry(host, 'Nothing attached.').querySelector('[data-testid="files"]')).toBeNull()
    await done()
  })

  test('a bounce is said on the message that bounced, as a problem with Cloudflare’s reason; a delivery is quiet; the messages around them say nothing', async () => {
    const { host, done } = await draw()
    const bad = entry(host, 'The drop-off form.')
    const note = bad.querySelector('[data-testid="delivery"] li') as HTMLElement
    expect(note.textContent).toBe('Bounced: it did not reach rosa@example.org (550 5.1.1 User unknown)')
    expect(note.getAttribute('role')).toBe('alert')
    expect(note.className).toContain('problem')
    const good = entry(host, 'We have them.').querySelector('[data-testid="delivery"] li') as HTMLElement
    expect(good.textContent).toBe('Delivered to rosa@example.org')
    expect(good.className).not.toContain('problem')
    expect(entry(host, 'Here are the results.').querySelector('[data-testid="delivery"]')).toBeNull()
    expect(entry(host, 'Nothing attached.').querySelector('[data-testid="delivery"]')).toBeNull()
    await done()
  })

  test('files of a message too large for the inbox to open are named, and say why, with nothing to ask for or save', async () => {
    const { host, done } = await draw()
    const chip = entry(host, 'Four big photos.').querySelector('[data-testid="file"]') as HTMLElement
    expect(chip.getAttribute('data-file')).toBe('too-large')
    expect(chip.getAttribute('title')).toContain('too large for the inbox to open')
    expect(chip.tagName).toBe('SPAN')
    expect(entry(host, 'Four big photos.').querySelector('img')).toBeNull()
    await done()
  })

  test('Attach is offered in a business mailbox’s thread with the files chosen listed and able to be taken out, and not in Gmail’s', async () => {
    const mailbox = await draw({ chosen: [new File([new Uint8Array(2048)], 'receipt.pdf', { type: 'application/pdf' })] })
    expect(mailbox.host.querySelector('[data-testid="attach-button"]')).not.toBeNull()
    expect((mailbox.host.querySelector('[data-testid="chosen-file"]') as HTMLElement).textContent).toContain('receipt.pdf (2 KB)')
    await mailbox.done()
    const plain = await draw({ mailbox: false })
    expect(plain.host.querySelector('[data-testid="attach"]')).toBeNull()
    await plain.done()
  })

  test('files the inbox would refuse are said before Send, and Send waits', async () => {
    const many = Array.from({ length: 11 }, (_, n) => new File([new Uint8Array(1)], `f${n}.txt`))
    const { host, done } = await draw({ chosen: many })
    expect((host.querySelector('[data-testid="attach-why"]') as HTMLElement).textContent).toContain('at most 10')
    expect((host.querySelector('[data-testid="send"]') as HTMLButtonElement).disabled).toBe(true)
    await done()
  })

  test('an answer from an inbox that predates files draws no files, no notes and no Attach', async () => {
    const { host, done } = await draw({ withFiles: false })
    expect(host.querySelector('[data-testid="files"]')).toBeNull()
    expect(host.querySelector('[data-testid="delivery"]')).toBeNull()
    expect(host.querySelector('[data-testid="attach"]')).toBeNull()
    expect(entry(host, 'Here are the results.').textContent).toContain('Here are the results.')
    await done()
  })
})

describe('videos and pictures sent as files from Telegram', () => {
  const MP4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])
  const from = 'Rosa Whitfield <rosa@example.org>'
  const tg: StandInMessage[] = [
    { id: 'v-clip', at: ago(300), direction: 'in', from, text: '[Video]', files: [{ name: 'Video.mp4', type: 'video/mp4', bytes: MP4, video: true, seconds: 75 }] },
    { id: 'v-caption', at: ago(250), direction: 'in', from, text: 'The recording.', files: [{ name: 'Video.mp4', type: 'video/mp4', bytes: MP4, video: true }] },
    { id: 'v-image', at: ago(200), direction: 'in', from, text: '[Image]', files: [{ name: 'Image.png', type: 'image/png', bytes: PNG }] },
    { id: 'v-heic', at: ago(150), direction: 'in', from, text: '[Image]', files: [{ name: 'Image.heic', type: 'image/heic', bytes: PNG }] },
    { id: 'v-big', at: ago(100), direction: 'out', from: 'Tessa', text: '[Video]', files: [{ name: 'Video.mp4', type: 'video/mp4', bytes: new Uint8Array(0), size: 48 * 1024 * 1024, note: 'Too large to copy. Open it in Telegram.' }] },
  ]

  test('a video is an inline player over the Worker’s own address that loads nothing until played, with its length and a Save link, and a bare placeholder is not drawn over it', async () => {
    const { host, done } = await draw({ messages: tg, reading: true })
    const clip = [...host.querySelectorAll('[data-testid="entry"]')][0] as HTMLElement
    expect(clip.querySelector('.msg-text')).toBeNull()
    const player = clip.querySelector('video[data-testid="video-player"]') as HTMLVideoElement
    expect(player.getAttribute('src')).toBe('/api/attachment?m=v-clip&n=0&how=view')
    expect(player.getAttribute('preload')).toBe('none')
    expect(player.hasAttribute('controls')).toBe(true)
    expect(clip.querySelector('figcaption')?.textContent).toBe('Video, 1:15 (8 B)')
    expect((clip.querySelector('[data-testid="video-save"]') as HTMLAnchorElement).getAttribute('href')).toBe('/api/attachment?m=v-clip&n=0&how=download')
    expect(clip.querySelector('[data-testid="video-failed"]')).toBeNull()
    // With a caption, the caption is drawn over the player.
    expect(entry(host, 'The recording.').querySelector('.msg-text')?.textContent).toContain('The recording.')
    await done()
  })

  test('a picture sent as a file is a thumbnail with no placeholder over it; a heic one and a video left in Telegram keep their words and the line that says where it is', async () => {
    const { host, done } = await draw({ messages: tg, reading: true })
    const entries = [...host.querySelectorAll('[data-testid="entry"]')] as HTMLElement[]
    expect(entries[2]?.querySelector('img')?.getAttribute('src')).toBe('/api/attachment?m=v-image&n=0&how=view')
    expect(entries[2]?.querySelector('.msg-text')).toBeNull()
    expect(entries[3]?.querySelector('img')).toBeNull()
    expect(entries[3]?.querySelector('[data-file="download"]')?.textContent).toBe(`Image.heic (${PNG.length} B)`)
    expect(entries[4]?.querySelector('.msg-text')?.textContent).toBe('[Video]')
    expect(entries[4]?.querySelector('.msg-text')?.className).toContain('placeholder')
    expect(entries[4]?.querySelector('[data-testid="file-note"]')?.textContent).toBe('Too large to copy. Open it in Telegram.')
    await done()
  })
})

describe('photos and voice notes from Telegram', () => {
  const OGG = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 2])
  const tg: StandInMessage[] = [
    { id: 'm-photo', at: ago(300), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/png', bytes: PNG }] },
    { id: 'm-caption', at: ago(250), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: 'This corner.', files: [{ name: 'Photo.jpg', type: 'image/png', bytes: PNG }] },
    { id: 'm-voice', at: ago(200), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: '[Voice note]', files: [{ name: 'Voice note.ogg', type: 'audio/ogg', bytes: OGG, play: true, seconds: 65 }] },
    { id: 'm-big', at: ago(150), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/jpeg', bytes: new Uint8Array(0), size: 11 * 1024 * 1024, note: 'Too large to copy. Open it in Telegram.' }] },
    { id: 'm-copying', at: ago(100), direction: 'in', from: 'Rosa Whitfield <rosa@example.org>', text: '[Photo]', files: [{ name: 'Photo.jpg', type: 'image/jpeg', bytes: new Uint8Array(0), note: 'Copying from Telegram.' }] },
  ]

  test('a photo is a thumbnail and a voice note is a player over the Worker’s own address, and a bare placeholder is not drawn over either', async () => {
    const { host, done } = await draw({ messages: tg, reading: true })
    const photo = [...host.querySelectorAll('[data-testid="entry"]')][0] as HTMLElement
    expect(photo.querySelector('img')?.getAttribute('src')).toBe('/api/attachment?m=m-photo&n=0&how=view')
    expect(photo.querySelector('.msg-text')).toBeNull()
    // With a caption, the caption is drawn.
    expect(entry(host, 'This corner.').querySelector('.msg-text')?.textContent).toContain('This corner.')
    const voice = [...host.querySelectorAll('[data-testid="entry"]')][2] as HTMLElement
    expect(voice.querySelector('.msg-text')).toBeNull()
    const player = voice.querySelector('audio[data-testid="voice-player"]') as HTMLAudioElement
    expect(player.getAttribute('src')).toBe('/api/attachment?m=m-voice&n=0&how=view')
    expect(player.getAttribute('preload')).toBe('none')
    expect(voice.querySelector('figcaption')?.textContent).toBe('Voice note, 1:05 (6 B)')
    const save = voice.querySelector('[data-testid="voice-save"]') as HTMLAnchorElement
    expect(save.getAttribute('href')).toBe('/api/attachment?m=m-voice&n=0&how=download')
    expect(voice.querySelector('[data-testid="voice-failed"]')).toBeNull()
    await done()
  })

  test('a file left in Telegram is named with the inbox’s own line, drawn on the page and not only in a tooltip, and a photo still being copied has no size to name', async () => {
    const { host, done } = await draw({ messages: tg, reading: true })
    const big = entry(host, '[Photo]').parentElement?.querySelectorAll('[data-testid="file-note"]') ?? []
    expect([...big].map((n) => n.textContent)).toEqual(['Too large to copy. Open it in Telegram.', 'Copying from Telegram.'])
    const left = [...host.querySelectorAll('[data-file="left"]')] as HTMLElement[]
    expect(left.map((l) => l.querySelector('.file-chip')?.textContent)).toEqual(['Photo.jpg (11.0 MB)', 'Photo.jpg'])
    // Nothing to ask for or save.
    expect(left.every((l) => l.querySelector('a, img, audio') === null)).toBe(true)
    // The placeholder of a file that is NOT shown stays: it is all the message says.
    expect(left.every((l) => (l.closest('[data-testid="entry"]')?.textContent ?? '').includes('[Photo]'))).toBe(true)
    await done()
  })
})

