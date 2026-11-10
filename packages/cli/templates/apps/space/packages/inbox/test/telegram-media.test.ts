import { describe, expect, test } from 'bun:test'
import { TELEGRAM_SMALL_FILE_MAX_BYTES, TELEGRAM_VIDEO_MAX_BYTES } from '../src/telegram/wire'
import { AGENT, asker, BRIDGE, harness, OWNER, STRANGER } from '../test-support/harness'
import { account, channel, chat, group, groupMessage, message, push } from '../test-support/telegram'

/**
 * Photos and voice notes. The message is stored first, with its file named; the bridge is then asked for the bytes (an `owed` item of kind `media`), brings
 * them on the door's `media` call, and the inbox keeps them in the raw-mail bucket and shows them to the owner alone, as a Cloudflare mailbox's files are. Anything else a message carries, a file over the limit, a
 * channel's media and a file the bridge cannot get are named with one plain line and left in Telegram; none of it ever touches the message.
 *
 * The seam is the same as the other Telegram suites': the bridge's door as a function over the real store on a real SQLite and a fake bucket, the space's part for what the owner sees. What this cannot show is Telegram
 * (that a download returns the file's bytes) and R2 (the hand test).
 */

type H = ReturnType<typeof harness>

const send = async (h: H, body: unknown) => (await h.bridge(BRIDGE, '/api/push', body)).json
const events = async (h: H, body: Record<string, unknown>) =>
  (await h.bridge(BRIDGE, '/api/events', { account, edits: [], deletions: [], ...body })).json
const work = async (h: H, over: Record<string, unknown> = { media: true, videoMax: TELEGRAM_VIDEO_MAX_BYTES }) =>
  (await h.bridge(BRIDGE, '/api/work', { account, ...over })).json
const outcomes = async (h: H, list: unknown[]) =>
  (await h.bridge(BRIDGE, '/api/outcomes', { account, outcomes: list })).json
const upload = (
  h: H,
  chatId: string,
  id: number,
  bytes: Uint8Array,
  query: Record<string, string> = {},
  who: Record<string, unknown> | null = BRIDGE,
) =>
  h.bridge(
    who,
    `/api/media?${new URLSearchParams({ account: account.id, chat: chatId, id: String(id), ...query })}`,
    undefined,
    { bytes },
  )

// The first bytes of a PNG, and of an Ogg file: all the inbox looks at, and all a fake needs to be.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 9, 9])
/** A file as the keeper takes it: a stream of its bytes, and the length the door was told. */
const streamed = (bytes: Uint8Array) => ({
  body: new Response(bytes as unknown as BodyInit).body as ReadableStream<Uint8Array>,
  length: bytes.length,
})
const HTML = new TextEncoder().encode('<script>alert(1)</script>')
// The first bytes of an MP4, of a QuickTime movie and of a WebM: a box named `ftyp` at byte 4 (the brand after it), and an EBML header.
const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
const MOV = new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0])
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])

const photo = (id: number, over: Record<string, unknown> = {}) =>
  message({ id, text: '[Photo]', media: { kind: 'photo', size: PNG.length, mime: 'image/jpeg' }, ...over } as never)
const voice = (id: number, over: Record<string, unknown> = {}) =>
  message({
    id,
    text: '[Voice note]',
    media: { kind: 'voice', size: OGG.length, mime: 'audio/ogg', seconds: 12 },
    ...over,
  } as never)

const video = (id: number, over: Record<string, unknown> = {}) =>
  message({
    id,
    text: '[Video]',
    media: { kind: 'video', size: MP4.length, mime: 'video/mp4', seconds: 7 },
    ...over,
  } as never)
const image = (id: number, mime: string, over: Record<string, unknown> = {}) =>
  message({ id, text: '[Image]', media: { kind: 'image', size: PNG.length, mime }, ...over } as never)

const messageId = (h: H, chatId: string, id: number): string =>
  (h.db.query(`SELECT id FROM message WHERE arrival_key = ?`).get(`${chatId}:${id}`) as { id: string }).id
const row = (h: H, chatId: string, id: number) =>
  h.db.query(`SELECT attachments, raw_key, body FROM message WHERE arrival_key = ?`).get(`${chatId}:${id}`) as {
    attachments: string
    raw_key: string | null
    body: string
  }
const files = (h: H, chatId: string, id: number) =>
  JSON.parse(row(h, chatId, id).attachments) as Array<{
    name: string
    size: number
    mimeType?: string
    tg: { copy: string; why?: string; kind: string; seconds?: number }
  }>
const mediaOwed = (h: H) =>
  (h.db.query(`SELECT count(*) AS n FROM setting WHERE key LIKE 'telegram-media-owed:%'`).get() as { n: number }).n
type Owed = { kind: string; chatId: string; id: number; mediaKind: string }
const owedMedia = async (h: H) => ((await work(h)).owed as Owed[]).filter((o) => o.kind === 'media')

/** The Durable Object's sweep of files to delete, which it runs after a call that may have left one. */
const sweep = (h: H) => (h.store as unknown as { call(method: string): Promise<number> }).call('sweepTelegramMedia')
const opened = async (h: H, mid: string, how: 'view' | 'download') =>
  h.space().attachment(await asker(OWNER), mid, 0, how)
const history = async (h: H, address: string) => {
  const contactId = (
    h.db.query(`SELECT contact_id FROM identity WHERE kind = 'telegram' AND address = ?`).get(address) as {
      contact_id: string
    }
  ).contact_id
  const got = await h.space().messagesWith(await asker(OWNER), { contactId })
  if (!got.ok) throw new Error(JSON.stringify(got))
  return got.value.messages
}

describe('the message first, the file after', () => {
  test('a photo is stored with its words and its file named, the bridge is asked for the bytes, and the bytes make a thumbnail the owner can open', async () => {
    const h = harness()
    const pushed = await send(h, push([chat()], [photo(7, { text: 'look at this' })]))
    expect(pushed.stored).toBe(1)
    // Stored before any byte arrived: the words are there, the file is named, and it is owed.
    expect(row(h, '2001', 7).body).toBe('look at this')
    expect(files(h, '2001', 7)).toEqual([
      { name: 'Photo.jpg', size: PNG.length, mimeType: 'image/jpeg', tg: { kind: 'photo', copy: 'owed' } },
    ])
    expect(row(h, '2001', 7).raw_key).toBeNull()
    expect(await owedMedia(h)).toEqual([{ kind: 'media', chatId: '2001', id: 7, mediaKind: 'photo' }])
    expect(h.bucket.objects.size).toBe(0)

    const key = `tg/${messageId(h, '2001', 7)}`
    const sent = await upload(h, '2001', 7, PNG)
    expect([sent.status, sent.json]).toEqual([200, { kept: true, size: PNG.length }])
    expect([...h.bucket.objects.keys()]).toEqual([key])
    expect(row(h, '2001', 7).raw_key).toBe(key)
    expect(files(h, '2001', 7)[0]?.tg).toEqual({ kind: 'photo', copy: 'kept' })
    expect(mediaOwed(h)).toBe(0)
    expect(await owedMedia(h)).toEqual([])
  })

  test('the owner’s page lists a kept photo as a picture to show and save, and a kept photo is served as the picture its bytes are', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    await upload(h, '2001', 7, PNG)
    const mid = messageId(h, '2001', 7)

    const m = (await history(h, '2001')).find((x) => x.id === mid)
    expect(m?.attachments).toEqual([
      { name: 'Photo.jpg', size: PNG.length, type: 'image/jpeg', picture: true, download: true },
    ])

    const view = await opened(h, mid, 'view')
    expect(view.ok && view.value.inline && view.value.type).toBe('image/png')
    expect(view.ok && Array.from(view.value.bytes)).toEqual(Array.from(PNG))
    const saved = await opened(h, mid, 'download')
    expect(saved.ok && saved.value).toMatchObject({
      type: 'application/octet-stream',
      inline: false,
      name: 'Photo.jpg',
    })
  })

  test('a voice note is a player: the page is told to play it, it is served as Ogg audio, and what is not Ogg is saved and never played', async () => {
    const h = harness()
    await send(h, push([chat()], [voice(8), voice(9)]))
    await upload(h, '2001', 8, OGG)
    await upload(h, '2001', 9, HTML)
    const messages = await history(h, '2001')
    const byId = (id: number) => messages.find((x) => x.id === messageId(h, '2001', id))
    expect(byId(8)?.attachments).toEqual([
      {
        name: 'Voice note.ogg',
        size: OGG.length,
        type: 'audio/ogg',
        picture: false,
        download: true,
        play: true,
        seconds: 12,
      },
    ])

    const ok = await opened(h, messageId(h, '2001', 8), 'view')
    expect(ok.ok && ok.value).toMatchObject({ type: 'audio/ogg', inline: true })
    // The bytes decide, not the word voice: HTML under a voice note is refused for playing, and can only be saved as a download.
    const bad = await opened(h, messageId(h, '2001', 9), 'view')
    expect(bad.ok).toBe(false)
    const saved = await opened(h, messageId(h, '2001', 9), 'download')
    expect(saved.ok && saved.value).toMatchObject({ type: 'application/octet-stream', inline: false })
  })

  test('a photo whose bytes are not a picture is refused for showing, and a big one is shown up to the copy limit (it is one object read alone, not a message parsed out of mail)', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [photo(7, { media: { kind: 'photo', size: HTML.length } }), photo(8, { media: { kind: 'photo' } })],
      ),
    )
    await upload(h, '2001', 7, HTML)
    expect((await opened(h, messageId(h, '2001', 7), 'view')).ok).toBe(false)
    // 6 MB of a PNG, over the 5 MB of mail's previews and under the 10 MB of copying: shown, as a screenshot sent as a file may be.
    const big = new Uint8Array(6 * 1024 * 1024)
    big.set(PNG)
    await upload(h, '2001', 8, big)
    const view = await h.space().attachment(await asker(OWNER), messageId(h, '2001', 8), 0, 'view')
    expect(view.ok && view.value.type).toBe('image/png')
    const saved = await opened(h, messageId(h, '2001', 8), 'download')
    expect(saved.ok && saved.value.bytes.length).toBe(big.length)
  })

  test('a photo in a group is copied too, and the file is the message’s, not the sender’s', async () => {
    const h = harness()
    await send(
      h,
      push(
        [group()],
        [
          groupMessage({
            id: 5,
            text: '[Photo]',
            sender: { id: '3001', name: 'Tomas' },
            media: { kind: 'photo' },
          } as never),
        ],
      ),
    )
    expect(await owedMedia(h)).toEqual([{ kind: 'media', chatId: '-1001234567', id: 5, mediaKind: 'photo' }])
    expect((await upload(h, '-1001234567', 5, PNG)).status).toBe(200)
    expect(row(h, '-1001234567', 5).raw_key).toBe(`tg/${messageId(h, '-1001234567', 5)}`)
  })
})

describe('pictures sent as files and videos', () => {
  const noted = async (h: H, mid: string) => (await history(h, '2001')).find((x) => x.id === mid)?.attachments

  test('a picture sent as a file is copied like a photo: named by its declared type, a thumbnail for the three a browser draws', async () => {
    const h = harness()
    await send(h, push([chat()], [image(20, 'image/png'), image(21, 'image/jpeg'), image(22, 'image/webp')]))
    expect(await owedMedia(h)).toHaveLength(3)
    for (const id of [20, 21, 22]) await upload(h, '2001', id, PNG)
    expect(files(h, '2001', 20)).toEqual([
      { name: 'Image.png', size: PNG.length, mimeType: 'image/png', tg: { kind: 'image', copy: 'kept' } },
    ])
    expect((await noted(h, messageId(h, '2001', 21)))?.[0]).toEqual({
      name: 'Image.jpg',
      size: PNG.length,
      type: 'image/jpeg',
      picture: true,
      download: true,
    })
    const view = await opened(h, messageId(h, '2001', 22), 'view')
    expect(view.ok && view.value.type).toBe('image/png')
  })

  test('a heic picture is copied and saved, but not offered as a picture to draw (no browser but Safari does) and refused for showing', async () => {
    const h = harness()
    await send(h, push([chat()], [image(23, 'image/heic')]))
    const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0])
    await upload(h, '2001', 23, HEIC)
    const mid = messageId(h, '2001', 23)
    expect((await noted(h, mid))?.[0]).toEqual({
      name: 'Image.heic',
      size: HEIC.length,
      type: 'image/heic',
      picture: false,
      download: true,
    })
    expect((await opened(h, mid, 'view')).ok).toBe(false)
    const saved = await opened(h, mid, 'download')
    expect(saved.ok && saved.value).toMatchObject({
      type: 'application/octet-stream',
      inline: false,
      name: 'Image.heic',
    })
  })

  test('a gif sent as a file is a file: named, not copied', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [message({ id: 24, text: '[File]', media: { kind: 'file', size: 500, mime: 'image/gif' } } as never)],
      ),
    )
    expect(await owedMedia(h)).toEqual([])
    expect(files(h, '2001', 24)[0]?.tg).toEqual({ kind: 'file', copy: 'left', why: 'kind' })
  })

  test('a video is copied: owed as a video, kept, listed as a player with its length, and served as the video its bytes are (MP4, QuickTime, WebM), never as anything else', async () => {
    const h = harness()
    await send(h, push([chat()], [video(30), video(31), video(32), video(33)]))
    expect(await owedMedia(h)).toHaveLength(4)
    expect(files(h, '2001', 30)[0]).toMatchObject({
      name: 'Video.mp4',
      tg: { kind: 'video', copy: 'owed', seconds: 7 },
    })
    await upload(h, '2001', 30, MP4)
    await upload(h, '2001', 31, MOV)
    await upload(h, '2001', 32, WEBM)
    await upload(h, '2001', 33, HTML)
    expect((await noted(h, messageId(h, '2001', 30)))?.[0]).toEqual({
      name: 'Video.mp4',
      size: MP4.length,
      type: 'video/mp4',
      picture: false,
      download: true,
      video: true,
      seconds: 7,
    })
    const types: Record<number, string | false> = {
      30: 'video/mp4',
      31: 'video/quicktime',
      32: 'video/webm',
      33: false,
    }
    for (const [id, type] of Object.entries(types)) {
      const view = await opened(h, messageId(h, '2001', Number(id)), 'view')
      expect([id, view.ok && view.value.inline && view.value.type]).toEqual([id, type])
    }
    // Whatever it was called, a video's download is a download.
    const saved = await opened(h, messageId(h, '2001', 33), 'download')
    expect(saved.ok && saved.value).toMatchObject({ type: 'application/octet-stream', inline: false })
  })

  test('a video over the limit (50 MB) is named, says it is too large and where it is, and is not asked for; exactly the limit is copied, and so is one of 20 MB, which was left at 10', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [
          video(34, { media: { kind: 'video', size: TELEGRAM_VIDEO_MAX_BYTES + 1, mime: 'video/mp4' } }),
          video(35, { media: { kind: 'video', size: TELEGRAM_VIDEO_MAX_BYTES, mime: 'video/mp4' } }),
          video(36, { media: { kind: 'video', size: 20_588_359, mime: 'video/quicktime' } }),
        ],
      ),
    )
    expect((await owedMedia(h)).map((o) => o.id).sort()).toEqual([35, 36])
    expect(files(h, '2001', 34)[0]?.tg).toEqual({ kind: 'video', copy: 'left', why: 'too-large' })
    const listed = (await noted(h, messageId(h, '2001', 34)))?.[0]
    expect(listed).toMatchObject({ picture: false, download: false, note: 'Too large to copy. Open it in Telegram.' })
    expect(listed?.video).toBeUndefined()
  })

  test('a video in a channel or a bot’s chat is named only', async () => {
    const h = harness()
    await send(
      h,
      push(
        [channel()],
        [message({ id: 3, chatId: '-1009876543', text: '[Video]', media: { kind: 'video', size: 900 } } as never)],
      ),
    )
    await send(h, push([chat({ id: '5001', name: 'Build Bot', bot: true })], [video(4, { chatId: '5001' })]))
    expect(await owedMedia(h)).toEqual([])
    expect(files(h, '-1009876543', 3)[0]?.tg).toEqual({ kind: 'video', copy: 'left', why: 'channel' })
    expect(files(h, '5001', 4)[0]?.tg).toEqual({ kind: 'video', seconds: 7, copy: 'left', why: 'bot' })
  })
})

describe('a message the inbox held with no file is given one when it is pushed again with one (the repair)', () => {
  test('the file is named and owed, nothing else of the message changes, and a message that already names a file or was deleted is left alone', async () => {
    const h = harness()
    // As a bridge from before files pushed them: the words only, no file.
    await send(
      h,
      push(
        [chat()],
        [
          message({ id: 1, text: '[Photo]' }),
          message({ id: 2, text: 'caption' }),
          message({ id: 3, text: '[Video]' }),
          photo(4),
        ],
      ),
    )
    expect(await owedMedia(h)).toHaveLength(1)
    const before = row(h, '2001', 2)
    // Deleted for everyone, then pushed again with a file: left alone.
    await events(h, { deletions: [{ ids: [3], at: '2026-11-05T11:00:00Z' }] })
    const again = await send(
      h,
      push(
        [chat()],
        [
          message({ id: 1, text: '[Photo]', media: { kind: 'photo', size: 2048, mime: 'image/jpeg' } } as never),
          message({ id: 2, text: 'caption', media: { kind: 'image', size: 900, mime: 'image/png' } } as never),
          message({ id: 3, text: '[Video]', media: { kind: 'video', size: 900, mime: 'video/mp4' } } as never),
          photo(4, { media: { kind: 'voice', size: 5 } }),
        ],
      ),
    )
    expect([again.stored, again.repeated]).toEqual([0, 4])
    expect(files(h, '2001', 1)).toEqual([
      { name: 'Photo.jpg', size: 2048, mimeType: 'image/jpeg', tg: { kind: 'photo', copy: 'owed' } },
    ])
    expect(files(h, '2001', 2)[0]).toMatchObject({ name: 'Image.png', tg: { kind: 'image', copy: 'owed' } })
    expect(row(h, '2001', 2).body).toBe(before.body)
    expect(row(h, '2001', 3).attachments).toBe('[]')
    // Message 4 already named a file: a second push does not change it.
    expect(files(h, '2001', 4)[0]?.tg).toEqual({ kind: 'photo', copy: 'owed' })
    const owed = await owedMedia(h)
    expect(owed.map((o) => [o.id, o.mediaKind]).sort()).toEqual([
      [1, 'photo'],
      [2, 'image'],
      [4, 'photo'],
    ])
    // Then the bytes arrive, and the message shows them.
    expect((await upload(h, '2001', 1, PNG)).status).toBe(200)
    expect(files(h, '2001', 1)[0]?.tg).toEqual({ kind: 'photo', copy: 'kept' })
  })

  test('a repeated message with a file in a channel is named only, as a new one is', async () => {
    const h = harness()
    await send(h, push([channel()], [message({ id: 3, chatId: '-1009876543', text: '[Photo]' })]))
    await send(
      h,
      push(
        [channel()],
        [message({ id: 3, chatId: '-1009876543', text: '[Photo]', media: { kind: 'photo', size: 9 } } as never)],
      ),
    )
    expect(files(h, '-1009876543', 3)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'channel' })
    expect(mediaOwed(h)).toBe(0)
  })
})

describe('the chats the bridge is asked to read again for their files', () => {
  const marked = (h: H) =>
    (h.db.query(`SELECT key FROM setting WHERE key LIKE 'telegram-media-read:%'`).all() as { key: string }[]).map((r) =>
      r.key.slice('telegram-media-read:'.length),
    )
  const mediaRead = async (h: H) => ((await work(h)).mediaRead ?? []) as string[]

  test('every chat with a conversation is named, only to a bridge that takes files; the push that read it marks it, and it is not named again', async () => {
    const h = harness()
    await send(
      h,
      push([chat(), chat({ id: '2002', name: 'Sam' })], [message({ id: 1 }), message({ id: 2, chatId: '2002' })]),
    )
    expect(((await work(h, {})).mediaRead ?? []) as string[]).toEqual([])
    expect((await mediaRead(h)).sort()).toEqual(['2001', '2002'])
    // Named until its marker is stored; the marker rides with the push that read the chat.
    await send(h, { ...push([chat()], []), mediaRead: ['2001'] })
    expect(marked(h)).toEqual(['2001'])
    expect(await mediaRead(h)).toEqual(['2002'])
    await send(h, { ...push([chat({ id: '2002', name: 'Sam' })], []), mediaRead: ['2002'] })
    expect(await mediaRead(h)).toEqual([])
    expect((await work(h)).mediaRead).toBeUndefined()
  })

  test('at most five chats at a time', async () => {
    const h = harness()
    const ids = ['2001', '2002', '2003', '2004', '2005', '2006', '2007']
    await send(
      h,
      push(
        ids.map((id) => chat({ id, name: `P${id}` })),
        ids.map((id) => message({ id: 1, chatId: id })),
      ),
    )
    expect(await mediaRead(h)).toHaveLength(5)
  })

  test('a bad list of chats is refused whole', async () => {
    const h = harness()
    for (const bad of [['not a chat'], 'all', Array.from({ length: 201 }, (_, i) => String(1000 + i)), [5]]) {
      const res = await h.bridge(BRIDGE, '/api/push', { ...push([chat()], []), mediaRead: bad })
      expect([JSON.stringify(bad).slice(0, 30), res.status]).toEqual([JSON.stringify(bad).slice(0, 30), 422])
    }
    expect(marked(h)).toEqual([])
  })
})

describe('what stays in Telegram, and the line that says so', () => {
  const noted = async (h: H, mid: string, contactAddress: string) =>
    (await history(h, contactAddress)).find((x) => x.id === mid)?.attachments

  test('a photo declared over the limit is not asked for and says it is too large and where it is', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7, { media: { kind: 'photo', size: TELEGRAM_SMALL_FILE_MAX_BYTES + 1 } })]))
    expect(await owedMedia(h)).toEqual([])
    expect(mediaOwed(h)).toBe(0)
    expect(files(h, '2001', 7)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'too-large' })
    expect(await noted(h, messageId(h, '2001', 7), '2001')).toEqual([
      {
        name: 'Photo.jpg',
        size: TELEGRAM_SMALL_FILE_MAX_BYTES + 1,
        type: '',
        picture: false,
        download: false,
        note: 'Too large to copy. Open it in Telegram.',
      },
    ])
    // The message itself is there as always.
    expect(row(h, '2001', 7).body).toBe('[Photo]')
  })

  test('exactly the limit is copied', async () => {
    const h = harness()
    await send(h, push([chat()], [voice(7, { media: { kind: 'voice', size: TELEGRAM_SMALL_FILE_MAX_BYTES } })]))
    expect(await owedMedia(h)).toHaveLength(1)
  })

  test('a document, a sticker, a GIF and audio that is not a voice note are named with their size and never asked for', async () => {
    const h = harness()
    const kinds = ['file', 'sticker', 'gif', 'audio'] as const
    await send(
      h,
      push(
        [chat()],
        kinds.map((kind, i) => message({ id: 10 + i, text: `[${kind}]`, media: { kind, size: 1000 + i } } as never)),
      ),
    )
    expect(await owedMedia(h)).toEqual([])
    for (const [i, kind] of kinds.entries()) {
      expect(files(h, '2001', 10 + i)[0]).toMatchObject({ size: 1000 + i, tg: { kind, copy: 'left', why: 'kind' } })
    }
    const listedFiles = await noted(h, messageId(h, '2001', 10), '2001')
    expect(listedFiles).toEqual([
      {
        name: 'File',
        size: 1000,
        type: '',
        picture: false,
        download: false,
        note: 'Not copied here. Open it in Telegram.',
      },
    ])
    expect(h.bucket.objects.size).toBe(0)
  })

  test('a channel’s photo and voice note are named only: channels are Bulk and not worth the storage', async () => {
    const h = harness()
    await send(
      h,
      push(
        [channel()],
        [message({ id: 3, chatId: '-1009876543', text: '[Photo]', media: { kind: 'photo', size: 900 } } as never)],
      ),
    )
    expect(await owedMedia(h)).toEqual([])
    expect(files(h, '-1009876543', 3)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'channel' })
  })

  test('a bot’s chat is Bulk like a channel: its photo is named only, not copied', async () => {
    const h = harness()
    await send(h, push([chat({ id: '5001', name: 'Build Bot', bot: true })], [photo(3, { chatId: '5001' })]))
    expect(await owedMedia(h)).toEqual([])
    expect(files(h, '5001', 3)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'bot' })
    expect((await upload(h, '5001', 3, PNG)).status).toBe(409)
  })

  test('a message with a location, a contact or a poll has no file: its words are the whole of it', async () => {
    const h = harness()
    await send(h, push([chat()], [message({ id: 4, text: '[Location]' })]))
    expect(row(h, '2001', 4).attachments).toBe('[]')
  })

  test('a file the bridge cannot get is reported, the space stops asking, and the line under the message says why; the message is untouched', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7, { text: 'caption' }), voice(8), photo(9)]))
    expect(await owedMedia(h)).toHaveLength(3)
    const settled = await outcomes(h, [
      { kind: 'media', chatId: '2001', id: 7, ok: false, reason: 'gone' },
      { kind: 'media', chatId: '2001', id: 8, ok: false, reason: 'failed' },
      { kind: 'media', chatId: '2001', id: 9, ok: false, reason: 'too-large' },
      { kind: 'media', chatId: '2001', id: 99, ok: false, reason: 'gone' },
    ])
    expect(settled).toEqual({ settled: 3, unknown: 1 })
    expect(await owedMedia(h)).toEqual([])
    const messages = await history(h, '2001')
    const noteOf = (id: number) => messages.find((x) => x.id === messageId(h, '2001', id))?.attachments?.[0]?.note
    expect(noteOf(7)).toBe('Telegram no longer has this file. Open the chat in Telegram.')
    expect(noteOf(8)).toBe('Could not be copied. Open it in Telegram.')
    expect(noteOf(9)).toBe('Too large to copy. Open it in Telegram.')
    expect(row(h, '2001', 7).body).toBe('caption')
    // A second report for the same file settles nothing.
    expect(await outcomes(h, [{ kind: 'media', chatId: '2001', id: 7, ok: false, reason: 'gone' }])).toEqual({
      settled: 0,
      unknown: 1,
    })
  })

  test('a file still owed after a week is given up on, so a bridge that never comes back does not leave “Copying” for ever', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    const copying = async () =>
      (await history(h, '2001')).find((x) => x.id === messageId(h, '2001', 7))?.attachments?.[0]?.note
    expect(await copying()).toBe('Copying from Telegram.')
    h.tick(7 * 86_400_000 + 60_000)
    expect(await owedMedia(h)).toEqual([])
    expect(await copying()).toBe('Could not be copied. Open it in Telegram.')
  })
})

describe('the file never blocks the message, and the bridge can only bring what it was asked for', () => {
  test('a bucket that will not take the file leaves the message stored and the file still owed; the next upload works', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    h.bucket.failPut = true
    expect((await upload(h, '2001', 7, PNG)).status).toBe(503)
    expect(row(h, '2001', 7).body).toBe('[Photo]')
    expect(row(h, '2001', 7).raw_key).toBeNull()
    expect(await owedMedia(h)).toHaveLength(1)
    h.bucket.failPut = false
    expect((await upload(h, '2001', 7, PNG)).status).toBe(200)
  })

  test('a file nobody asked for is refused and kept nowhere: not a message that is not stored, not one already kept, not one the space left in Telegram, not a deleted one', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [photo(7), message({ id: 8, text: '[GIF]', media: { kind: 'gif', size: 5 } } as never), message({ id: 9 })],
      ),
    )
    expect((await upload(h, '2001', 99, PNG)).status).toBe(409)
    expect((await upload(h, '2001', 8, PNG)).status).toBe(409)
    expect((await upload(h, '2001', 9, PNG)).status).toBe(409)
    expect((await upload(h, '2001', 7, PNG, { account: '9999' })).status).toBe(409)
    expect(h.bucket.objects.size).toBe(0)
    expect((await upload(h, '2001', 7, PNG)).status).toBe(200)
    // Already kept: a second upload changes nothing.
    expect((await upload(h, '2001', 7, OGG)).status).toBe(409)
    expect(h.bucket.objects.size).toBe(1)
  })

  test('a body past the largest limit (50 MB) is refused at the door before a byte is read, and nothing is kept; the bridge reports such a file as too large itself', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7, { media: { kind: 'photo' } })]))
    const res = await upload(h, '2001', 7, new Uint8Array(TELEGRAM_VIDEO_MAX_BYTES + 1))
    expect(res.status).toBe(413)
    expect(h.bucket.objects.size).toBe(0)
    expect(h.bucket.calls.filter((c) => c.startsWith('put:'))).toEqual([])
    // It is still owed until the bridge says otherwise, and saying so names the file.
    expect(await owedMedia(h)).toHaveLength(1)
    await outcomes(h, [{ kind: 'media', chatId: '2001', id: 7, ok: false, reason: 'too-large' }])
    expect(files(h, '2001', 7)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'too-large' })
  })

  test('a request that says no length (a proxy that sent it chunked) is read in memory when it is a small file, and refused (411) when it passes the small files’ limit: R2 writes a stream only of a known length', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7), video(8, { media: { kind: 'video', size: 1000, mime: 'video/mp4' } })]))
    const path = (id: number) =>
      `/api/media?${new URLSearchParams({ account: account.id, chat: '2001', id: String(id) })}`
    const small = await h.bridge(BRIDGE, path(7), undefined, { bytes: PNG, headers: { 'content-length': '' } })
    expect([small.status, small.json]).toEqual([200, { kept: true, size: PNG.length }])
    const big = await h.bridge(BRIDGE, path(8), undefined, {
      bytes: new Uint8Array(TELEGRAM_SMALL_FILE_MAX_BYTES + 1),
      headers: { 'content-length': '' },
    })
    expect(big.status).toBe(411)
    expect([...h.bucket.objects.keys()]).toHaveLength(1)
    expect(await owedMedia(h)).toHaveLength(1)
  })

  test('the keeper holds a file to the limit of its own kind: a photo or a voice note over 10 MB is refused and named too large, a video up to 50 MB is kept', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [
          photo(7, { media: { kind: 'photo' } }),
          voice(8, { media: { kind: 'voice' } }),
          video(9, { media: { kind: 'video' } }),
        ],
      ),
    )
    const call = (id: number, length: number) =>
      h.store.call('keepTelegramMedia', {
        account: account.id,
        chatId: '2001',
        id,
        body: new Response(new Uint8Array(0)).body as ReadableStream<Uint8Array>,
        length,
      })
    expect(await call(7, TELEGRAM_SMALL_FILE_MAX_BYTES + 1)).toMatchObject({ ok: false, status: 413 })
    expect(await call(8, TELEGRAM_SMALL_FILE_MAX_BYTES + 1)).toMatchObject({ ok: false, status: 413 })
    expect(h.bucket.objects.size).toBe(0)
    expect(files(h, '2001', 7)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'too-large' })
    expect(files(h, '2001', 8)[0]?.tg).toMatchObject({ kind: 'voice', copy: 'left', why: 'too-large' })
    expect((await owedMedia(h)).map((o) => o.id)).toEqual([9])
    // A video of 40 MB goes through as a stream, and the bucket is never asked for it whole.
    const big = new Uint8Array(40 * 1024 * 1024)
    big.set(MP4)
    expect((await upload(h, '2001', 9, big)).json).toEqual({ kept: true, size: big.length })
    expect(h.bucket.objects.get(`tg/${messageId(h, '2001', 9)}`)?.bytes.byteLength).toBe(big.length)
    expect(files(h, '2001', 9)[0]).toMatchObject({ size: big.length, tg: { kind: 'video', copy: 'kept' } })
  })

  test('a body that is not the length it said is not kept: shorter or longer fails the write, the file stays owed, nothing is left in the bucket', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    const lying = (length: number) =>
      h.store.call('keepTelegramMedia', {
        account: account.id,
        chatId: '2001',
        id: 7,
        body: streamed(PNG).body,
        length,
      })
    expect(await lying(PNG.length + 5)).toMatchObject({ ok: false, status: 503 })
    expect(await lying(PNG.length - 1)).toMatchObject({ ok: false, status: 503 })
    expect(h.bucket.objects.size).toBe(0)
    expect(await owedMedia(h)).toHaveLength(1)
    expect((await upload(h, '2001', 7, PNG)).status).toBe(200)
  })

  test('an empty body, and a query that is not a chat and a message, are refused', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    expect((await upload(h, '2001', 7, new Uint8Array(0))).status).toBe(422)
    expect((await upload(h, '2001', 7, PNG, { chat: 'x' })).status).toBe(422)
    expect((await upload(h, '2001', 7, PNG, { id: '0' })).status).toBe(422)
    expect((await upload(h, '2001', 7, PNG, { account: 'me' })).status).toBe(422)
    expect(h.bucket.objects.size).toBe(0)
  })

  test('only the bridge’s token, by POST: Claude’s, the owner’s and a stranger’s are refused, and a GET is not found', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    for (const who of [AGENT, OWNER, STRANGER]) expect((await upload(h, '2001', 7, PNG, {}, who)).status).toBe(403)
    expect((await upload(h, '2001', 7, PNG, {}, null)).status).toBe(401)
    expect(
      (await h.bridge(BRIDGE, '/api/media?account=7000000001&chat=2001&id=7', undefined, { method: 'GET' })).status,
    ).toBe(404)
    expect(h.bucket.objects.size).toBe(0)
  })

  test('Telegram’s service chat and Saved Messages never get a file: a photo there is not stored and not asked for', async () => {
    const h = harness()
    const res = await send(
      h,
      push(
        [chat({ id: '777000', name: 'Telegram' }), chat({ id: account.id, name: 'Me' })],
        [photo(1, { chatId: '777000' }), photo(2, { chatId: account.id })],
      ),
    )
    expect(res.stored).toBe(0)
    expect(await owedMedia(h)).toEqual([])
    expect((await upload(h, '777000', 1, PNG)).status).toBe(409)
  })

  test('at most ten files are asked for at a time, newest first', async () => {
    const h = harness()
    const at = (n: number) => `2026-11-05T10:${String(n).padStart(2, '0')}:00Z`
    await send(
      h,
      push(
        [chat()],
        Array.from({ length: 12 }, (_, i) => photo(i + 1, { at: at(i) })),
      ),
    )
    const first = await owedMedia(h)
    expect(first).toHaveLength(10)
    // All were filed in one push, so they share a time; what matters is the bound.
    expect(new Set(first.map((o) => o.id)).size).toBe(10)
    await upload(h, '2001', first[0]?.id as number, PNG)
    expect(await owedMedia(h)).toHaveLength(10)
  })

  test('files are offered only to a bridge that says it takes them: one from before files would treat the item as a read mark', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    expect((await work(h, {})).owed).toEqual([])
    expect((await work(h, { media: false })).owed).toEqual([])
    expect(mediaOwed(h)).toBe(1)
    expect(await owedMedia(h)).toHaveLength(1)
    expect((await h.bridge(BRIDGE, '/api/work', { account, media: 'yes' })).status).toBe(422)
  })

  test('two uploads of one file at once keep it once: the loser does not delete the copy the winner kept', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    // Straight at the keeper, so both really pass the "is it owed" check before either has finished (through the door the two requests would be told apart by their timing).
    const keep = () =>
      (h.store as unknown as { call(m: string, a: unknown): Promise<{ ok: boolean; status?: number }> }).call(
        'keepTelegramMedia',
        { account: account.id, chatId: '2001', id: 7, ...streamed(PNG) },
      )
    const [a, b] = await Promise.all([keep(), keep()])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a.status, b.status].filter((x) => x !== undefined)).toEqual([409])
    const key = `tg/${messageId(h, '2001', 7)}`
    expect([...h.bucket.objects.keys()]).toEqual([key])
    expect(row(h, '2001', 7).raw_key).toBe(key)
    expect(files(h, '2001', 7)[0]?.tg.copy).toBe('kept')
    expect((await opened(h, messageId(h, '2001', 7), 'view')).ok).toBe(true)
  })

  test('a push repeated after a timeout owes the file once', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    await send(h, push([chat()], [photo(7)]))
    expect(mediaOwed(h)).toBe(1)
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE arrival_key = '2001:7'`).get()).toEqual({ n: 1 })
  })

  test('Claude is never handed a file: the agent is refused it, and the queue and a conversation do not name one', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    await upload(h, '2001', 7, PNG)
    const refused = await h.store.call('readAttachment', messageId(h, '2001', 7), 0, 'view', { agent: true })
    expect(refused).toMatchObject({ ok: false, status: 403 })
  })

  test('a non-owner of the install is refused the file, and a place past the end is not there', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    await upload(h, '2001', 7, PNG)
    const mid = messageId(h, '2001', 7)
    const stranger = await h.space().attachment(await asker(STRANGER), mid, 0, 'view')
    expect(stranger.ok).toBe(false)
    const past = await h.space().attachment(await asker(OWNER), mid, 1, 'view')
    expect(past.ok).toBe(false)
  })
})

describe('a message deleted for everyone takes its file with it', () => {
  test('the name goes, the object is deleted from the bucket, and the bytes can no longer be asked for', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7), photo(8)]))
    await upload(h, '2001', 7, PNG)
    const mid = messageId(h, '2001', 7)
    expect(h.bucket.objects.size).toBe(1)

    const when = '2026-11-05T11:00:00Z'
    // 8 was never copied: it is deleted while still owed, and the bridge is not asked for it any more.
    await events(h, { deletions: [{ ids: [7, 8], at: when }] })
    expect(row(h, '2001', 7).attachments).toBe('[]')
    expect(row(h, '2001', 7).raw_key).toBeNull()
    expect(mediaOwed(h)).toBe(0)
    expect(await owedMedia(h)).toEqual([])
    // The store says which object goes; the Durable Object's sweep (after the call) does it.
    expect(h.inbox.telegramMediaToDrop()).toEqual([`tg/${mid}`])
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.size).toBe(0)
    expect(h.inbox.telegramMediaToDrop()).toEqual([])
    expect((await opened(h, mid, 'view')).ok).toBe(false)
  })

  test('a sweep that cannot delete leaves the row for the next one, and an upload that lands after the deletion is not kept', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7), photo(8)]))
    await upload(h, '2001', 7, PNG)
    await events(h, { deletions: [{ ids: [7], at: '2026-11-05T11:00:00Z' }] })
    h.bucket.failDelete = true
    expect(await sweep(h)).toBe(0)
    expect(h.inbox.telegramMediaToDrop()).toHaveLength(1)
    h.bucket.failDelete = false
    expect(await sweep(h)).toBe(1)

    // The other photo is deleted before its bytes arrive: they are refused, and nothing is left in the bucket.
    await events(h, { deletions: [{ ids: [8], at: '2026-11-05T11:01:00Z' }] })
    expect((await upload(h, '2001', 8, PNG)).status).toBe(409)
    expect(h.bucket.objects.size).toBe(0)
  })

  test('an edit of a photo’s caption keeps the file', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7, { text: 'old' })]))
    await upload(h, '2001', 7, PNG)
    await events(h, { edits: [{ chatId: '2001', id: 7, text: 'new', at: '2026-11-05T11:00:00Z' }] })
    expect(row(h, '2001', 7).body).toBe('new')
    expect(files(h, '2001', 7)[0]?.tg.copy).toBe('kept')
  })
})

describe('the wire', () => {
  test('a push with a file the contract does not know is refused whole', async () => {
    const h = harness()
    for (const media of [
      { kind: 'executable' },
      { kind: 'photo', size: -1 },
      { kind: 'photo', size: 1.5 },
      { kind: 'photo', mime: 'not a type' },
      { kind: 'voice', seconds: -3 },
      'photo',
    ]) {
      const res = await h.bridge(BRIDGE, '/api/push', push([chat()], [message({ id: 1, media } as never)]))
      expect([JSON.stringify(media), res.status]).toEqual([JSON.stringify(media), 422])
    }
    expect(h.db.query('SELECT count(*) AS n FROM message').get()).toEqual({ n: 0 })
  })

  test('a media outcome that claims success, or names no reason it knows, is refused', async () => {
    const h = harness()
    for (const o of [
      { kind: 'media', chatId: '2001', id: 7, ok: true },
      { kind: 'media', chatId: '2001', id: 7, ok: false, reason: 'lazy' },
      { kind: 'media', chatId: 'x', id: 7, ok: false, reason: 'gone' },
    ]) {
      expect((await h.bridge(BRIDGE, '/api/outcomes', { account, outcomes: [o] })).status).toBe(422)
    }
  })
})

describe('a video of up to 50 MB is read in parts, never whole', () => {
  const MIB = 1024 * 1024
  // A 25 MiB movie: over the whole-file size (10 MiB), so a Durable Object's RPC (32 MiB) never carries it whole. Each byte is its position's remainder, so a part from the wrong place shows.
  const movie = (mib: number): Uint8Array => {
    const bytes = new Uint8Array(mib * MIB)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    bytes.set(MP4, 0)
    return bytes
  }
  const keptMovie = async (h: H, id: number, bytes: Uint8Array) => {
    await send(
      h,
      push([chat()], [video(id, { media: { kind: 'video', size: bytes.length, mime: 'video/mp4', seconds: 80 } })]),
    )
    expect((await upload(h, '2001', id, bytes)).status).toBe(200)
    return messageId(h, '2001', id)
  }
  const view = async (
    h: H,
    mid: string,
    range?: { first: number; last?: number } | { suffix: number },
    how: 'view' | 'download' = 'view',
  ) => h.space().attachment(await asker(OWNER), mid, 0, how, range)

  test('a range reads just its part from the bucket: a ranged get for the first bytes (what the file is) and a ranged get for the part, and no get of the whole', async () => {
    const h = harness()
    const bytes = movie(25)
    const mid = await keptMovie(h, 40, bytes)
    h.bucket.calls.length = 0
    const got = await view(h, mid, { first: 3 * MIB, last: 3 * MIB + 99 })
    expect(got.ok && got.value).toMatchObject({
      type: 'video/mp4',
      inline: true,
      total: bytes.length,
      part: { first: 3 * MIB, last: 3 * MIB + 99 },
    })
    expect(got.ok && Array.from(got.value.bytes)).toEqual(Array.from(bytes.slice(3 * MIB, 3 * MIB + 100)))
    expect(h.bucket.ranges.map((r) => [r.offset, r.length])).toEqual([
      [0, 32],
      [3 * MIB, 100],
    ])
    // Every get of the object was a ranged one.
    expect(h.bucket.calls.filter((c) => c.startsWith('get:'))).toHaveLength(2)
  })

  test('bytes=a-, bytes=0- and bytes=-n are cut to a part of 8 MiB, and the last bytes are the last bytes', async () => {
    const h = harness()
    const bytes = movie(25)
    const mid = await keptMovie(h, 40, bytes)
    const open = await view(h, mid, { first: 0 })
    expect(open.ok && open.value.part).toEqual({ first: 0, last: 8 * MIB - 1 })
    expect(open.ok && open.value.bytes.length).toBe(8 * MIB)
    const middle = await view(h, mid, { first: 20 * MIB })
    expect(middle.ok && middle.value.part).toEqual({ first: 20 * MIB, last: 25 * MIB - 1 })
    const tail = await view(h, mid, { suffix: 5 })
    expect(tail.ok && tail.value.part).toEqual({ first: bytes.length - 5, last: bytes.length - 1 })
    expect(tail.ok && Array.from(tail.value.bytes)).toEqual(Array.from(bytes.slice(-5)))
  })

  test('a range past the end is unsatisfiable, with the length, and nothing is read from the bucket', async () => {
    const h = harness()
    const bytes = movie(25)
    const mid = await keptMovie(h, 40, bytes)
    h.bucket.calls.length = 0
    const past = await view(h, mid, { first: bytes.length })
    expect(past.ok && past.value).toMatchObject({ unsatisfiable: true, total: bytes.length })
    expect(past.ok && past.value.bytes.length).toBe(0)
    const none = await view(h, mid, { suffix: 0 })
    expect(none.ok && none.value).toMatchObject({ unsatisfiable: true, total: bytes.length })
    expect(h.bucket.calls.filter((c) => c.startsWith('get:'))).toEqual([])
  })

  test('with no range a video over the whole-file size answers its first part (to read on from), a save the same; a small video comes whole', async () => {
    const h = harness()
    const mid = await keptMovie(h, 40, movie(25))
    const first = await view(h, mid)
    expect(first.ok && first.value).toMatchObject({
      type: 'video/mp4',
      total: 25 * MIB,
      part: { first: 0, last: 8 * MIB - 1 },
    })
    const saved = await view(h, mid, undefined, 'download')
    expect(saved.ok && saved.value).toMatchObject({
      type: 'application/octet-stream',
      inline: false,
      total: 25 * MIB,
      part: { first: 0, last: 8 * MIB - 1 },
    })
    const more = await view(h, mid, { first: 8 * MIB }, 'download')
    expect(more.ok && more.value).toMatchObject({ inline: false, part: { first: 8 * MIB, last: 16 * MIB - 1 } })

    const small = await keptMovie(h, 41, MP4)
    const whole = await view(h, small)
    expect(whole.ok && Array.from(whole.value.bytes)).toEqual(Array.from(MP4))
    expect(whole.ok && whole.value.part).toBeUndefined()
    // A range on the small one is still answered as a part, with the length.
    const piece = await view(h, small, { first: 4, last: 7 })
    expect(piece.ok && piece.value).toMatchObject({ total: MP4.length, part: { first: 4, last: 7 } })
  })

  test('a range is honoured for a voice note or a video only: a photo is whole, whatever was asked', async () => {
    const h = harness()
    await send(h, push([chat()], [photo(7)]))
    await upload(h, '2001', 7, PNG)
    const got = await view(h, messageId(h, '2001', 7), { first: 2, last: 3 })
    expect(got.ok && got.value.part).toBeUndefined()
    expect(got.ok && Array.from(got.value.bytes)).toEqual(Array.from(PNG))
  })

  test('an object that is not the length the store holds is not served, whole or in parts', async () => {
    const h = harness()
    const mid = await keptMovie(h, 40, movie(12))
    const key = `tg/${mid}`
    const real = h.bucket.objects.get(key) as { bytes: ArrayBuffer; metadata: Record<string, string> }
    h.bucket.objects.set(key, { ...real, bytes: real.bytes.slice(0, 11 * MIB) })
    expect(await view(h, mid, { first: 0, last: 9 })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await view(h, mid)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('what is not a video is not shown, however it is asked for: a part is sniffed by its first bytes, read apart', async () => {
    const h = harness()
    const html = new Uint8Array(12 * MIB).fill(0x41)
    const mid = await keptMovie(h, 40, html)
    expect(await view(h, mid, { first: 5 * MIB, last: 5 * MIB + 9 })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    // Saved, it is a download like any other.
    const saved = await view(h, mid, { first: 0 }, 'download')
    expect(saved.ok && saved.value).toMatchObject({ type: 'application/octet-stream', inline: false })
  })

  test('the owner’s page lists a 40 MB video as a player', async () => {
    const h = harness()
    const mid = await keptMovie(h, 40, movie(40))
    expect((await history(h, '2001')).find((x) => x.id === mid)?.attachments?.[0]).toMatchObject({
      size: 40 * MIB,
      video: true,
      download: true,
    })
  })
})

describe('videos left for being too large before the limit went to 50 MB', () => {
  const MARKER = 'telegram-video-cap:52428800'
  const leave = (h: H, id: number, why = 'too-large') => {
    const r = row(h, '2001', id)
    const parsed = JSON.parse(r.attachments) as Array<{ tg: Record<string, unknown> }>
    ;(parsed[0] as { tg: Record<string, unknown> }).tg = { ...(parsed[0]?.tg ?? {}), copy: 'left', why }
    h.db.run(`UPDATE message SET attachments = ? WHERE arrival_key = ?`, [JSON.stringify(parsed), `2001:${id}`])
    h.db.run(`DELETE FROM setting WHERE key = ?`, [`telegram-media-owed:${messageId(h, '2001', id)}`])
  }
  const marker = (h: H) => h.db.query(`SELECT value FROM setting WHERE key = ?`).get(MARKER) as { value: string } | null

  test('each one within the limit is owed once, nothing is read again from Telegram, and the pass is idempotent', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [
          video(50, { media: { kind: 'video', size: 20_588_359, mime: 'video/quicktime', seconds: 140 } }),
          video(51, { media: { kind: 'video', size: TELEGRAM_VIDEO_MAX_BYTES, mime: 'video/mp4' } }),
          video(52, { media: { kind: 'video', size: 30_000_000, mime: 'video/mp4' } }),
          video(53, { media: { kind: 'video', size: 30_000_000, mime: 'video/mp4' } }),
          photo(54, { media: { kind: 'photo', size: 30_000_000 } }),
        ],
      ),
    )
    // As the 10 MB inbox stored them: left in Telegram, nothing owed. One of them left for another reason, one never told its length.
    for (const id of [50, 51, 52, 53]) leave(h, id)
    leave(h, 52, 'failed')
    h.db.run(`UPDATE message SET attachments = ? WHERE arrival_key = '2001:53'`, [
      JSON.stringify([{ name: 'Video', size: 0, tg: { kind: 'video', copy: 'left', why: 'too-large' } }]),
    ])
    h.db.run(`DELETE FROM setting WHERE key LIKE 'telegram-media-owed:%'`)
    expect(mediaOwed(h)).toBe(0)
    expect(marker(h)).toBeNull()

    // A bridge that does not take files does not start it.
    await work(h, {})
    expect(marker(h)).toBeNull()

    const owed = await owedMedia(h)
    expect(owed.map((o) => [o.chatId, o.id, o.mediaKind]).sort()).toEqual([
      ['2001', 50, 'video'],
      ['2001', 51, 'video'],
    ])
    expect(files(h, '2001', 50)[0]).toMatchObject({
      size: 20_588_359,
      tg: { kind: 'video', copy: 'owed', seconds: 140 },
    })
    expect(files(h, '2001', 50)[0]?.tg.why).toBeUndefined()
    expect(files(h, '2001', 52)[0]?.tg).toMatchObject({ copy: 'left', why: 'failed' })
    expect(files(h, '2001', 53)[0]?.tg).toMatchObject({ copy: 'left', why: 'too-large' })
    expect(files(h, '2001', 54)[0]?.tg).toEqual({ kind: 'photo', copy: 'left', why: 'too-large' })
    expect(JSON.parse(marker(h)?.value ?? 'null')).toEqual({ owed: 2 })

    // Asked again, nothing changes: not a second row, not a second pass.
    expect(await owedMedia(h)).toEqual(owed)
    expect(mediaOwed(h)).toBe(2)

    // The bridge brings the 19.6 MB recording; it is kept, and the pass does not owe it again however often it is asked.
    const clip = new Uint8Array(20_588_359)
    clip.set(MOV)
    expect((await upload(h, '2001', 50, clip)).json).toEqual({ kept: true, size: 20_588_359 })
    expect(files(h, '2001', 50)[0]?.tg).toEqual({ kind: 'video', copy: 'kept', seconds: 140 })
    expect((await owedMedia(h)).map((o) => o.id)).toEqual([51])
    // A file the bridge later reports as too large for good stays that way: the pass has run for this limit.
    await outcomes(h, [{ kind: 'media', chatId: '2001', id: 51, ok: false, reason: 'too-large' }])
    expect(await owedMedia(h)).toEqual([])
    expect(files(h, '2001', 51)[0]?.tg).toMatchObject({ copy: 'left', why: 'too-large' })
  })

  test('the owed row is as new as the pass, so a video from last week still has its week to be fetched', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [video(50, { media: { kind: 'video', size: 20_588_359, mime: 'video/mp4' }, at: '2026-10-20T10:00:00Z' })],
      ),
    )
    leave(h, 50)
    expect((await owedMedia(h)).map((o) => o.id)).toEqual([50])
    expect(files(h, '2001', 50)[0]?.tg.copy).toBe('owed')
  })
})

describe('a bridge from before the 50 MB limit is never offered what it would refuse for good', () => {
  const MARKER = 'telegram-video-cap:52428800'
  const marker = (h: H) => h.db.query(`SELECT value FROM setting WHERE key = ?`).get(MARKER) as { value: string } | null
  const ids = (o: Owed[]) => o.map((x) => x.id).sort((a, b) => a - b)
  const old = (h: H, over: Record<string, unknown> = {}) =>
    work(h, { media: true, ...over }).then((w) => (w.owed as Owed[]).filter((o) => o.kind === 'media'))
  const leaveBig = (h: H, id: number) => {
    const parsed = JSON.parse(row(h, '2001', id).attachments) as Array<{ tg: Record<string, unknown> }>
    ;(parsed[0] as { tg: Record<string, unknown> }).tg = { kind: 'video', copy: 'left', why: 'too-large' }
    h.db.run(`UPDATE message SET attachments = ? WHERE arrival_key = ?`, [JSON.stringify(parsed), `2001:${id}`])
    h.db.run(`DELETE FROM setting WHERE key = ?`, [`telegram-media-owed:${messageId(h, '2001', id)}`])
  }

  test('the old bridge’s work request does not start the pass that owes the videos left for being too large, and does not use up its one run; the new bridge’s does', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [
          video(50, { media: { kind: 'video', size: 20_588_359, mime: 'video/quicktime', seconds: 140 } }),
          video(51, { media: { kind: 'video', size: 3_000_000, mime: 'video/mp4' } }),
          photo(52),
        ],
      ),
    )
    leaveBig(h, 50)
    // Today’s bridge: it takes files and says nothing of videos. Asked as often as it likes, nothing is owed for the 20 MB video and the marker is not written.
    for (const over of [{}, { videoMax: TELEGRAM_SMALL_FILE_MAX_BYTES }]) {
      expect(ids(await old(h, over))).toEqual([51, 52])
      expect(marker(h)).toBeNull()
      expect(files(h, '2001', 50)[0]?.tg).toMatchObject({ copy: 'left', why: 'too-large' })
    }
    // A bridge that is not asking for files at all starts nothing either.
    await work(h, { videoMax: TELEGRAM_VIDEO_MAX_BYTES })
    expect(marker(h)).toBeNull()
    // The new bridge: the pass runs, once, and the video is offered.
    expect(ids(await old(h, { videoMax: TELEGRAM_VIDEO_MAX_BYTES }))).toEqual([50, 51, 52])
    expect(marker(h)).not.toBeNull()
    expect(files(h, '2001', 50)[0]?.tg).toMatchObject({ copy: 'owed' })
  })

  test('a video over 10 MB planned while the old bridge is the one running waits for the new bridge, and the old bridge’s small files are not crowded out by them', async () => {
    const h = harness()
    await send(
      h,
      push(
        [chat()],
        [
          ...Array.from({ length: 12 }, (_, i) =>
            video(100 + i, {
              media: { kind: 'video', size: 30_000_000, mime: 'video/mp4' },
              at: `2026-11-06T10:${String(i).padStart(2, '0')}:00Z`,
            }),
          ),
          photo(7, { at: '2026-11-01T10:00:00Z' }),
          video(8, { media: { kind: 'video', size: 3_000_000, mime: 'video/mp4' }, at: '2026-11-01T10:01:00Z' }),
        ],
      ),
    )
    // Planned as owed at once (nothing is told of the bridge at a push), but only offered to a bridge that takes them: the old one, with twelve big ones newer than its photo, still gets the photo and the small video.
    expect(mediaOwed(h)).toBe(14)
    expect(ids(await old(h))).toEqual([7, 8])
    expect(ids(await old(h, { videoMax: TELEGRAM_VIDEO_MAX_BYTES }))).toHaveLength(10)
    // The old bridge is not able to report them too large: nothing was asked of it.
    expect(files(h, '2001', 100)[0]?.tg).toEqual({ kind: 'video', copy: 'owed' })
  })

  test('a work request that names a videoMax which is not a number is refused', async () => {
    const h = harness()
    for (const videoMax of ['big', -1, 1.5]) {
      expect((await h.bridge(BRIDGE, '/api/work', { account, media: true, videoMax })).status).toBe(422)
    }
  })
})

describe('whole reads of a Telegram file take turns; parts of a video do not', () => {
  const MIB = 1024 * 1024
  test('a dozen pictures asked for at once are read one at a time, so they are not all in the heap together', async () => {
    const h = harness()
    const ids = Array.from({ length: 6 }, (_, i) => 200 + i)
    await send(
      h,
      push(
        [chat()],
        ids.map((id) => photo(id)),
      ),
    )
    for (const id of ids) await upload(h, '2001', id, PNG)
    h.bucket.readDelayMs = 3
    h.bucket.maxActive = 0
    const owner = await asker(OWNER)
    const got = await Promise.all(ids.map((id) => h.space().attachment(owner, messageId(h, '2001', id), 0, 'view')))
    expect(got.every((r) => r.ok)).toBe(true)
    expect(h.bucket.maxActive).toBe(1)
  })

  test('parts of a video are read as they are asked for, not one at a time behind each other', async () => {
    const h = harness()
    const bytes = new Uint8Array(25 * MIB)
    bytes.set(MP4)
    await send(h, push([chat()], [video(40, { media: { kind: 'video', size: bytes.length, mime: 'video/mp4' } })]))
    expect((await upload(h, '2001', 40, bytes)).status).toBe(200)
    h.bucket.readDelayMs = 3
    h.bucket.maxActive = 0
    const owner = await asker(OWNER)
    const mid = messageId(h, '2001', 40)
    const parts = await Promise.all(
      [0, 8 * MIB, 16 * MIB].map((first) => h.space().attachment(owner, mid, 0, 'view', { first, last: first + 99 })),
    )
    expect(parts.every((r) => r.ok)).toBe(true)
    expect(h.bucket.maxActive).toBeGreaterThan(1)
  })
})
