import { describe, expect, test } from 'bun:test'
import { INBOX_CAPTION_MAX, INBOX_PICTURE_MAX_BYTES, INBOX_PICTURE_TYPES } from '@space/workspace'
import {
  SEND_FETCH_TIMEOUT_MS,
  SEND_IN_FLIGHT_MS,
  SEND_RETRY_FOR_MS,
  SEND_UPLOAD_TIMEOUT_MS,
  sniffPicture,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_PICTURE_MAX_BYTES,
  TELEGRAM_PICTURE_TYPES,
} from '../src/telegram/wire'
import { AGENT, asker, BRIDGE, harness, OWNER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { account, channel, chat, group, groupMessage, member, message, push } from '../test-support/telegram'

/**
 * TESSA SENDS A PICTURE. A reply box takes one picture (a PNG or a JPEG) with the words as its caption; the inbox keeps the picture in the raw-mail bucket under the
 * draft's own `tg/` key, owes the bridge the send, and gives the bridge the bytes on the door's seventh call, `picture`, for that send alone. Every rule of sending holds (the random id, the in-flight bound, "check
 * Telegram", matching on `randomId`), and the picture is the owner's to see and never Claude's.
 *
 * The seam is the one the other Telegram suites use: the bridge's door as a function over the real store on a real SQLite and a fake bucket, the space's part for what Tessa presses and sees. What this cannot show is Telegram
 * (that a photo goes out once under its random id, what it does to a screenshot, what a group that forbids pictures answers) and R2: the hand tests.
 */

type H = ReturnType<typeof harness>

const KEY = (n: number | string) => `compose-${n}`.padEnd(24, '0')
const G = '-1001234567'
const MIN = 60_000
const CAPTION = 'The red box is the bug.'
const DASH = '\u2014'

/** The first bytes of a PNG and of a JPEG, with a few bytes after them that tell one picture from another. */
const png = (n = 1) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, n, 7, 7])
const jpeg = (n = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, n])
const file = (bytes: Uint8Array, name = 'Screenshot.png', type = 'image/png') => ({ name, type, bytes })
const sha = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

const post = async (h: H, path: string, body: unknown) => (await h.bridge(BRIDGE, path, body)).json
const feed = (h: H, body: unknown) => post(h, '/api/push', body)
const work = (h: H, over: Record<string, unknown> = { pictures: true }) => post(h, '/api/work', { account, ...over })
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const conversationOf = (h: H, chatId: string): string =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE telegram_chat_id = '${chatId}'`)[0] as { id: string }).id
const detail = async (h: H, conversationId: string) =>
  (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
const randomIdOf = (h: H, messageId: string): string =>
  (
    JSON.parse(
      (
        rows<{ value: string }>(h, `SELECT value FROM setting WHERE key = 'telegram-send:${messageId}'`)[0] as {
          value: string
        }
      ).value,
    ) as { randomId: string }
  ).randomId
const outcomes = (h: H, list: Record<string, unknown>[]) =>
  post(h, '/api/outcomes', {
    account,
    outcomes: list.map((o) =>
      o.kind === 'send' && o.randomId === undefined ? { ...o, randomId: randomIdOf(h, String(o.messageId)) } : o,
    ),
  })
const messages = (h: H, chatId: string) =>
  rows<{
    id: string
    status: string
    direction: string
    body: string
    attachments: string
    raw_key: string | null
    arrival_key: string | null
    sent_by: string | null
  }>(
    h,
    `SELECT m.id, m.status, m.direction, m.body, m.attachments, m.raw_key, m.arrival_key, m.sent_by
       FROM message m JOIN conversation c ON c.id = m.conversation_id WHERE c.telegram_chat_id = '${chatId}' ORDER BY m.rowid`,
  )
const sweep = (h: H) => (h.store as unknown as { call(method: string): Promise<number> }).call('sweepTelegramMedia')
type OfferedSend = {
  kind: 'send'
  messageId: string
  chatId: string
  text: string
  randomId: string
  picture?: { type: string; size: number }
  leftMs?: number
}
const offeredSends = (owed: { kind: string }[]) => owed.filter((o) => o.kind === 'send') as OfferedSend[]
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const getPicture = (h: H, messageId: string, randomId: string, who: Record<string, unknown> | null = BRIDGE) =>
  h.bridge(
    who,
    `/api/picture?${new URLSearchParams({ account: account.id, message: messageId, random: randomId })}`,
    undefined,
  )

/** Tessa presses Send on a reply in the chat with a picture, as the space does for a reply box. */
async function press(
  h: H,
  chatId: string,
  over: { text?: string; files?: ReturnType<typeof file>[]; key?: string } = {},
) {
  const id = conversationOf(h, chatId)
  return h.space().send(await asker(OWNER), {
    key: over.key ?? KEY(1),
    conversationId: id,
    through: (await detail(h, id)).through,
    text: over.text ?? CAPTION,
    attachments: over.files ?? [file(png())],
  })
}

async function oneToOne(h: H) {
  await feed(h, push([chat()], [message({ id: 1, text: 'Can you send me the screenshot?' })]))
}

/** A picture pressed in a chat and offered to a bridge that sends pictures: the send as the bridge sees it. */
async function pressed(h: H, over: Parameters<typeof press>[2] = {}) {
  await oneToOne(h)
  const answer = unwrap(await press(h, '2001', over))
  const offered = offeredSends((await work(h)).owed)
  return { answer, offered: offered[0] as OfferedSend }
}

describe('the limits are written once and agree', () => {
  test('the page’s numbers are the inbox’s: ten megabytes, a thousand and twenty-four characters, a PNG or a JPEG', () => {
    expect(INBOX_PICTURE_MAX_BYTES).toBe(TELEGRAM_PICTURE_MAX_BYTES)
    expect(INBOX_CAPTION_MAX).toBe(TELEGRAM_CAPTION_MAX)
    expect([...INBOX_PICTURE_TYPES]).toEqual([...TELEGRAM_PICTURE_TYPES])
    expect(TELEGRAM_CAPTION_MAX).toBeLessThan(4096)
  })

  test('the time a send may still land grew by the fetch and the upload, for every send: 13.5 minutes in place of 11.5', () => {
    expect(SEND_FETCH_TIMEOUT_MS).toBe(MIN)
    expect(SEND_UPLOAD_TIMEOUT_MS).toBe(MIN)
    expect(SEND_IN_FLIGHT_MS).toBe(13.5 * MIN)
  })

  test('a picture is told from anything else by its first bytes alone', () => {
    expect(sniffPicture(png())).toBe('image/png')
    expect(sniffPicture(jpeg())).toBe('image/jpeg')
    expect(sniffPicture(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull()
    expect(sniffPicture(new TextEncoder().encode('GIF89a'))).toBeNull()
    expect(sniffPicture(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(sniffPicture(new Uint8Array(0))).toBeNull()
  })
})

describe('Tessa presses Send with a picture', () => {
  test('the picture is kept under the draft’s own key and named on the draft; the answer is "sending"; the bridge is offered the caption and the picture’s type and size, and the bytes when it asks on the seventh call', async () => {
    const h = harness()
    const { answer, offered } = await pressed(h)
    expect(answer).toMatchObject({ status: 'sending' })

    const draft = messages(h, '2001')[1] as ReturnType<typeof messages>[number]
    expect(draft).toMatchObject({ status: 'sending', direction: 'out', body: CAPTION, raw_key: `tg/${draft.id}` })
    // The object is in the bucket, byte for byte, and the draft names it as a kept photo with its true length and its fingerprint.
    expect(new Uint8Array(h.bucket.objects.get(`tg/${draft.id}`)?.bytes as ArrayBuffer)).toEqual(png())
    expect(JSON.parse(draft.attachments)).toEqual([
      {
        name: 'Photo.png',
        size: png().length,
        mimeType: 'image/png',
        tg: { kind: 'photo', copy: 'kept', sha256: await sha(png()) },
      },
    ])

    expect(offered).toMatchObject({
      kind: 'send',
      messageId: draft.id,
      chatId: '2001',
      text: CAPTION,
      picture: { type: 'image/png', size: png().length },
    })
    expect(offered.randomId).toMatch(/^[1-9][0-9]{0,18}$/)

    const fetched = await getPicture(h, offered.messageId, offered.randomId)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(fetched.headers.get('cache-control')).toBe('no-store')
    expect(fetched.bytes).toEqual(png())
  })

  test('a JPEG goes the same way and a picture with no words goes alone, as an empty caption', async () => {
    const h = harness()
    const { offered } = await pressed(h, { text: '', files: [file(jpeg(), 'IMG_1.jpeg', 'image/jpeg')] })
    expect(offered).toMatchObject({ text: '', picture: { type: 'image/jpeg', size: jpeg().length } })
    expect(messages(h, '2001')[1]).toMatchObject({ status: 'sending', body: '' })
    expect((await getPicture(h, offered.messageId, offered.randomId)).bytes).toEqual(jpeg())
  })

  test('the outcome files the sent message with its picture and its caption: one message, one object, read and closed as every message he sends', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    h.tick(2000)
    expect(
      await outcomes(h, [
        { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' },
      ]),
    ).toEqual({ settled: 1, unknown: 0 })
    const filed = messages(h, '2001')
    expect(filed).toHaveLength(2)
    expect(filed[1]).toMatchObject({
      id: offered.messageId,
      status: 'sent',
      direction: 'out',
      body: CAPTION,
      arrival_key: '2001:77',
      sent_by: OWNER_EMAIL,
      raw_key: `tg/${offered.messageId}`,
    })
    expect(h.bucket.objects.has(`tg/${offered.messageId}`)).toBe(true)
    expect(offeredSends((await work(h)).owed)).toEqual([])
    // The audit of the send says which picture went out on whose word.
    const audit = rows<{ after: string }>(
      h,
      `SELECT after FROM audit WHERE action = 'message.send' AND subject = 'message:${offered.messageId}'`,
    )
    expect(JSON.parse(audit[0]?.after as string)).toMatchObject({ picture: await sha(png()) })
  })

  test('the owner sees the sent picture (the bytes decide what it is) and Claude’s token is never handed it', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [
      { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' },
    ])
    const seen = await h.space().attachment(await asker(OWNER), offered.messageId, 0, 'view')
    expect(seen.ok).toBe(true)
    if (seen.ok) expect(seen.value).toMatchObject({ type: 'image/png', inline: true, bytes: png() })
    const denied = await h.store.call('readAttachment', offered.messageId, 0, 'view', { agent: true })
    expect(denied).toMatchObject({ ok: false, status: 403 })
    // And the conversation says the message carries a picture, not that it is only words.
    const history = unwrap(
      await h.space().messagesWith(await asker(OWNER), {
        contactId: rows<{ contact_id: string }>(
          h,
          `SELECT contact_id FROM identity WHERE kind = 'telegram' AND address = '2001'`,
        )[0]?.contact_id as string,
      }),
    )
    const mine = history.messages.find((m) => m.id === offered.messageId)
    expect(mine?.attachments).toEqual([expect.objectContaining({ name: 'Photo.png', picture: true, download: true })])
  })

  test('a group is sent a picture by its own chat id and a channel is refused with nothing kept or claimed', async () => {
    const h = harness()
    await feed(h, push([group()], [groupMessage({ id: 5, text: 'Lunch?', sender: member('3001', 'Ana Ruiz') })]))
    unwrap(await press(h, G, { text: 'Noon.' }))
    const offered = offeredSends((await work(h)).owed)
    expect(offered).toEqual([expect.objectContaining({ chatId: G, text: 'Noon.', picture: expect.any(Object) })])

    const c = harness()
    await feed(c, push([channel()], [message({ chatId: '-1009876543', id: 3, text: 'Status: all green' })]))
    const refused = await press(c, '-1009876543')
    expect(refused).toMatchObject({ ok: false })
    expect(c.bucket.objects.size).toBe(0)
    expect(offeredSends((await work(c)).owed)).toEqual([])
  })

  test('the thread says it takes a picture: a person’s chat and a group, not a channel, and canAttach stays the business mailboxes’', async () => {
    const h = harness()
    await feed(
      h,
      push(
        [chat(), group(), channel()],
        [
          message({ id: 1, text: 'hi' }),
          groupMessage({ id: 5, text: 'Lunch?', sender: member('3001', 'Ana Ruiz') }),
          message({ chatId: '-1009876543', id: 3, text: 'Status' }),
        ],
      ),
    )
    const threads = async (chatId: string) => {
      const contactId = rows<{ contact_id: string }>(
        h,
        `SELECT i.contact_id FROM identity i WHERE i.kind = 'telegram' AND i.address = '${chatId}'`,
      )[0]?.contact_id as string
      const got = unwrap(
        await h.space().messagesWith(await asker(OWNER), { contactId }, { include: ['bulk', 'closed'] }),
      )
      return got.threads
    }
    expect((await threads('2001'))[0]).toMatchObject({ canReply: true, canPicture: true, canAttach: false })
    expect((await threads(G))[0]).toMatchObject({ canReply: true, canPicture: true })
    expect((await threads('-1009876543'))[0]?.canPicture).toBeUndefined()
  })
})

describe('what a picture send refuses, before anything is kept or claimed', () => {
  test('a second picture, a file that is not a picture by its bytes (whatever its name or type say), an empty one and one over ten megabytes', async () => {
    const h = harness()
    await oneToOne(h)
    const refusal = async (files: ReturnType<typeof file>[]) => {
      const r = await press(h, '2001', { files })
      expect(r.ok).toBe(false)
      return r
    }
    await refusal([file(png(1)), file(png(2))])
    const script = await refusal([file(new TextEncoder().encode('<script>alert(1)</script>'), 'cat.png', 'image/png')])
    expect(JSON.stringify(script)).toContain('PNG or a JPEG')
    await refusal([file(new TextEncoder().encode('GIF89a......'), 'x.gif', 'image/gif')])
    await refusal([file(new Uint8Array(0))])
    const big = new Uint8Array(TELEGRAM_PICTURE_MAX_BYTES + 1)
    big.set(png())
    await refusal([file(big)])
    // Nothing was kept, claimed or offered, and no draft is left for Tessa to send from Drafts.
    expect(h.bucket.objects.size).toBe(0)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent'])
    expect(offeredSends((await work(h)).owed)).toEqual([])
  })

  test('exactly ten megabytes goes', async () => {
    const h = harness()
    await oneToOne(h)
    const exact = new Uint8Array(TELEGRAM_PICTURE_MAX_BYTES)
    exact.set(png())
    unwrap(await press(h, '2001', { files: [file(exact)] }))
    expect(offeredSends((await work(h)).owed)[0]?.picture).toEqual({
      type: 'image/png',
      size: TELEGRAM_PICTURE_MAX_BYTES,
    })
  })

  test('words under a picture are at most 1,024 characters, never split into a second message; words alone stay at 4,096', async () => {
    const h = harness()
    await oneToOne(h)
    const tooLong = await press(h, '2001', { text: 'x'.repeat(TELEGRAM_CAPTION_MAX + 1) })
    expect(tooLong).toMatchObject({ ok: false })
    expect(JSON.stringify(tooLong)).toContain('1024')
    expect(h.bucket.objects.size).toBe(0)
    expect(messages(h, '2001')).toHaveLength(1)

    unwrap(await press(h, '2001', { text: 'x'.repeat(TELEGRAM_CAPTION_MAX), key: KEY(2) }))
    const offered = offeredSends((await work(h)).owed)
    expect(offered).toHaveLength(1)
    expect(offered[0]?.text).toHaveLength(TELEGRAM_CAPTION_MAX)

    const h2 = harness()
    await oneToOne(h2)
    unwrap(await press(h2, '2001', { text: 'y'.repeat(4096), files: [] }))
    expect(offeredSends((await work(h2)).owed)[0]?.text).toHaveLength(4096)
  })

  test('the em dash rule holds for the caption, whoever wrote it', async () => {
    const h = harness()
    await oneToOne(h)
    const r = await press(h, '2001', { text: `see the box ${DASH} here` })
    expect(r).toMatchObject({ ok: false })
    expect(h.bucket.objects.size).toBe(0)
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent'])
  })

  test('a bucket that will not take the picture refuses the send in words and leaves no draft', async () => {
    const h = harness()
    await oneToOne(h)
    h.bucket.failPut = true
    const r = await press(h, '2001')
    expect(r).toMatchObject({ ok: false })
    h.bucket.failPut = false
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent'])
    expect(offeredSends((await work(h)).owed)).toEqual([])
  })

  test('a reply in a business mailbox’s thread is not changed by any of this: files there stay the mailbox’s own', async () => {
    const h = harness()
    await oneToOne(h)
    // A picture in a words-only reply box of a Telegram chat is a picture; the same press with no picture is the words alone.
    unwrap(await press(h, '2001', { files: [], text: 'only words' }))
    const offered = offeredSends((await work(h)).owed)
    expect(offered[0]).toMatchObject({ text: 'only words' })
    expect(offered[0]?.picture).toBeUndefined()
  })
})

describe('the bridge’s seventh call gives out the picture of the send it is being offered, and nothing else', () => {
  test('an older bridge (no `pictures`) is never offered a picture send, and the send goes back to a draft with its picture after five minutes, with the plain note', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    expect(offeredSends((await work(h, {})).owed)).toEqual([])
    expect(offeredSends((await work(h, { media: true })).owed)).toEqual([])
    h.tick(SEND_RETRY_FOR_MS + 1000)
    // Still not offered to it, and now it is returned to a draft: nothing can have gone out, since nothing was ever offered.
    expect(offeredSends((await work(h, {})).owed)).toEqual([])
    const draft = messages(h, '2001')[1] as ReturnType<typeof messages>[number]
    expect(draft.status).toBe('draft')
    expect(draft.raw_key).toBe(`tg/${draft.id}`)
    expect(JSON.parse(draft.attachments)[0].tg.copy).toBe('kept')
    expect(h.bucket.objects.has(`tg/${draft.id}`)).toBe(true)
    // The words of a bridge that sends pictures arriving late do not revive it.
    expect(offeredSends((await work(h)).owed)).toEqual([])
  })

  test('a send of words alone is offered to a bridge that sends pictures and to one that does not, as it always was, with no picture field', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001', { files: [], text: 'plain' }))
    const old = offeredSends((await work(h, {})).owed)
    const newer = offeredSends((await work(h)).owed)
    expect(old[0]).toEqual({
      kind: 'send',
      messageId: expect.any(String),
      chatId: '2001',
      text: 'plain',
      randomId: expect.any(String),
      leftMs: SEND_RETRY_FOR_MS,
    })
    expect(newer[0]).toEqual({ ...(old[0] as OfferedSend), leftMs: expect.any(Number) })
  })

  test('every offer says how much of its five minutes is left, so the bridge starts nothing after it: all of it at the first offer, less at each repeat', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001', { files: [], text: 'plain' }))
    expect(offeredSends((await work(h)).owed)[0]?.leftMs).toBe(SEND_RETRY_FOR_MS)
    h.tick(90_000)
    expect(offeredSends((await work(h)).owed)[0]?.leftMs).toBe(SEND_RETRY_FOR_MS - 90_000)
  })

  test('it answers only for a send that was offered: not before the first offer, not another draft, not another random id, not a message that is not waiting', async () => {
    const h = harness()
    await oneToOne(h)
    unwrap(await press(h, '2001'))
    const draft = messages(h, '2001')[1] as ReturnType<typeof messages>[number]
    const rid = randomIdOf(h, draft.id)

    // Claimed but never offered: the bridge does not know the random id yet; a guess is refused.
    expect((await getPicture(h, draft.id, rid)).status).toBe(409)
    const offered = offeredSends((await work(h)).owed)[0] as OfferedSend
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(200)

    expect((await getPicture(h, offered.messageId, String(BigInt(offered.randomId) + 1n))).status).toBe(409)
    expect((await getPicture(h, 'no-such-send', offered.randomId)).status).toBe(409)
    // The sent incoming message, the words of a conversation nothing waits on: refused.
    const incoming = messages(h, '2001')[0] as ReturnType<typeof messages>[number]
    expect((await getPicture(h, incoming.id, offered.randomId)).status).toBe(409)
    // The picture of one send is not given for another's random id.
    unwrap(await press(h, '2001', { key: KEY(2), files: [file(png(9))] }))
    const second = offeredSends((await work(h)).owed).find((o) => o.messageId !== offered.messageId) as OfferedSend
    expect((await getPicture(h, second.messageId, offered.randomId)).status).toBe(409)
    expect((await getPicture(h, offered.messageId, second.randomId)).status).toBe(409)
    expect((await getPicture(h, second.messageId, second.randomId)).bytes).toEqual(png(9))
  })

  test('only while the send may still be offered: five minutes from its first offer and the fetch’s own limit, never after', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    h.tick(SEND_RETRY_FOR_MS + SEND_FETCH_TIMEOUT_MS - 1000)
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(200)
    h.tick(2000)
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(409)
  })

  test('not after the send is settled, and not when the draft is a draft again', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [
      { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 5, at: '2026-10-20T12:00:02Z' },
    ])
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(409)

    const g = harness()
    const second = await pressed(g)
    await outcomes(g, [
      { kind: 'send', messageId: second.offered.messageId, ok: false, reason: 'CHAT_SEND_PHOTOS_FORBIDDEN' },
    ])
    expect((await getPicture(g, second.offered.messageId, second.offered.randomId)).status).toBe(409)
  })

  test('only the bridge’s token: Claude’s is refused, no token is refused, and a bridge signed in as another account is refused', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    expect((await getPicture(h, offered.messageId, offered.randomId, AGENT)).status).toBe(403)
    expect((await getPicture(h, offered.messageId, offered.randomId, null)).status).toBe(401)
    const other = await h.bridge(
      BRIDGE,
      `/api/picture?${new URLSearchParams({ account: '1234567', message: offered.messageId, random: offered.randomId })}`,
      undefined,
    )
    expect(other.status).toBe(409)
  })

  test('the query is checked as the shape it is, and the call is a POST like every other', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    const bad = await h.bridge(BRIDGE, `/api/picture?account=${account.id}&message=${offered.messageId}`, undefined)
    expect(bad.status).toBe(422)
    const get = await h.bridge(BRIDGE, `/api/picture?account=${account.id}&message=x&random=1`, undefined, {
      method: 'GET',
    })
    expect(get.status).toBe(404)
  })

  test('the object must be the length, the kind and the fingerprint the draft names, or nothing is given', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    const key = `tg/${offered.messageId}`
    // The object in the bucket is swapped for another picture of the same length (a tampered bucket): the fingerprint stops it.
    h.bucket.objects.set(key, { bytes: png(9).buffer as ArrayBuffer, metadata: {} })
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(409)
    // And for a longer one.
    h.bucket.objects.set(key, { bytes: new Uint8Array([...png(), 1]).buffer as ArrayBuffer, metadata: {} })
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(409)
    h.bucket.objects.delete(key)
    expect((await getPicture(h, offered.messageId, offered.randomId)).status).toBe(404)
  })
})

describe('the send settles as every send does, with one message and one object', () => {
  test('the copy in the stream arriving BEFORE the outcome settles the send, takes the draft’s picture and shows once; the outcome that follows finds nothing waiting', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    const echo = await feed(
      h,
      push(
        [chat()],
        [
          message({
            id: 77,
            out: true,
            text: CAPTION,
            at: '2026-10-20T12:00:02Z',
            media: { kind: 'photo', size: 1234, mime: 'image/jpeg' },
          }),
        ],
      ),
    )
    expect(echo).toEqual({ stored: 1, repeated: 0, skipped: 0 })
    const filed = messages(h, '2001')
    expect(filed.map((m) => m.status)).toEqual(['sent', 'sent'])
    expect(filed[1]).toMatchObject({
      arrival_key: '2001:77',
      sent_by: OWNER_EMAIL,
      body: CAPTION,
      raw_key: `tg/${offered.messageId}`,
    })
    // Its own owed download is dropped: one object, no second download.
    expect(rows(h, `SELECT key FROM setting WHERE key LIKE 'telegram-media-owed:%'`)).toEqual([])
    expect(JSON.parse(filed[1]?.attachments as string)[0]).toMatchObject({
      size: png().length,
      tg: { copy: 'kept', sha256: await sha(png()) },
    })
    expect(await sweep(h)).toBe(0)
    expect(h.bucket.objects.has(`tg/${offered.messageId}`)).toBe(true)
    expect(offeredSends((await work(h)).owed)).toEqual([])
    expect(
      await outcomes(h, [
        {
          kind: 'send',
          messageId: offered.messageId,
          randomId: offered.randomId,
          ok: true,
          telegramId: 77,
          at: '2026-10-20T12:00:02Z',
        },
      ]),
    ).toEqual({ settled: 0, unknown: 1 })
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
  })

  test('a picture alone is NOT settled by a captionless photo in the chat (its words are only Telegram’s label); the bridge’s outcome, naming the message, settles it and takes that copy as the same message', async () => {
    const h = harness()
    const { offered } = await pressed(h, { text: '' })
    await feed(
      h,
      push(
        [chat()],
        [
          message({
            id: 78,
            out: true,
            text: '[Photo]',
            at: '2026-10-20T12:00:03Z',
            media: { kind: 'photo', size: 99 },
          }),
        ],
      ),
    )
    // Any captionless photo Tessa sent from his phone meanwhile looks the same, so the stream alone settles nothing: the send still waits and is not shown as sent.
    expect(messages(h, '2001').filter((m) => m.status === 'sending')).toHaveLength(1)
    await outcomes(h, [
      {
        kind: 'send',
        messageId: offered.messageId,
        randomId: offered.randomId,
        ok: true,
        telegramId: 78,
        at: '2026-10-20T12:00:03Z',
      },
    ])
    expect(messages(h, '2001').map((m) => m.status)).toEqual(['sent', 'sent'])
    expect(messages(h, '2001')[1]).toMatchObject({ arrival_key: '2001:78', raw_key: `tg/${offered.messageId}` })
    expect(offeredSends((await work(h)).owed)).toEqual([])
  })

  test('a photo with other words, or a message with no file, does not settle it', async () => {
    const h = harness()
    await pressed(h)
    await feed(h, push([chat()], [message({ id: 79, out: true, text: 'other', media: { kind: 'photo', size: 9 } })]))
    await feed(h, push([chat()], [message({ id: 80, out: true, text: CAPTION })]))
    expect(messages(h, '2001').filter((m) => m.status === 'sending')).toHaveLength(1)
  })

  test('a copy that had already kept an object of its own keeps it; the draft’s object is deleted with the draft, once the sweep runs', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    // The copy arrived after the draft's window (so it did not settle it by itself), was copied from Telegram, and then the outcome comes.
    await feed(h, push([chat()], [message({ id: 77, out: true, text: 'another message' })]))
    await feed(
      h,
      push(
        [chat()],
        [message({ id: 81, out: true, text: 'zzz', at: '2026-10-20T11:00:00Z', media: { kind: 'photo', size: 9 } })],
      ),
    )
    const copy = messages(h, '2001').find((m) => m.arrival_key === '2001:81') as ReturnType<typeof messages>[number]
    h.bucket.objects.set(`tg/${copy.id}`, { bytes: png(5).buffer as ArrayBuffer, metadata: {} })
    h.db
      .query(`UPDATE message SET raw_key = ?, attachments = ? WHERE id = ?`)
      .run(
        `tg/${copy.id}`,
        JSON.stringify([
          { name: 'Photo.jpg', size: png(5).length, mimeType: 'image/jpeg', tg: { kind: 'photo', copy: 'kept' } },
        ]),
        copy.id,
      )
    await outcomes(h, [
      { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 81, at: '2026-10-20T12:00:02Z' },
    ])
    expect(messages(h, '2001').filter((m) => m.arrival_key === '2001:81')).toHaveLength(1)
    expect(messages(h, '2001').find((m) => m.arrival_key === '2001:81')?.raw_key).toBe(`tg/${copy.id}`)
    expect(rows(h, `SELECT key FROM setting WHERE key = 'telegram-media-drop:tg/${offered.messageId}'`)).toHaveLength(1)
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.has(`tg/${offered.messageId}`)).toBe(false)
    expect(h.bucket.objects.has(`tg/${copy.id}`)).toBe(true)
  })

  test('the outcome arriving first and the copy second: the copy is the same message and takes no second file', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [
      { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' },
    ])
    const echo = await feed(
      h,
      push(
        [chat()],
        [
          message({
            id: 77,
            out: true,
            text: CAPTION,
            at: '2026-10-20T12:00:02Z',
            media: { kind: 'photo', size: 1234 },
          }),
        ],
      ),
    )
    expect(echo).toEqual({ stored: 0, repeated: 1, skipped: 0 })
    expect(messages(h, '2001')).toHaveLength(2)
    // Pushed again WITH a file, the held message names its picture already, so it is left as it is and nothing is owed.
    expect(rows(h, `SELECT key FROM setting WHERE key LIKE 'telegram-media-owed:%'`)).toEqual([])
    expect(messages(h, '2001')[1]?.raw_key).toBe(`tg/${offered.messageId}`)
  })
})

describe('when it goes wrong: the same words as today, and the picture kept', () => {
  test('a group that does not allow pictures: the draft comes back with the reason in words, still carrying its picture, and it can be pressed again', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [{ kind: 'send', messageId: offered.messageId, ok: false, reason: 'CHAT_SEND_PHOTOS_FORBIDDEN' }])
    const draft = messages(h, '2001')[1] as ReturnType<typeof messages>[number]
    expect(draft).toMatchObject({ status: 'draft', raw_key: `tg/${offered.messageId}` })
    expect(h.bucket.objects.has(`tg/${offered.messageId}`)).toBe(true)
    const listed = unwrap(await h.space().drafts(await asker(OWNER)))
    expect(listed[0]?.refusal).toContain('does not allow pictures')

    // Pressed again as the draft it is, it goes out with the picture it kept, under a new random id.
    const again = await h.space().send(await asker(OWNER), {
      key: KEY(2),
      draftId: draft.id,
      rev: listed[0]?.rev as number,
      through: (await detail(h, conversationOf(h, '2001'))).through,
    })
    expect(unwrap(again)).toMatchObject({ status: 'sending' })
    const second = offeredSends((await work(h)).owed)[0] as OfferedSend
    expect(second.picture).toEqual({ type: 'image/png', size: png().length })
    expect(second.randomId).not.toBe(offered.randomId)
    expect((await getPicture(h, second.messageId, second.randomId)).bytes).toEqual(png())
  })

  test('a picture Telegram finds too tall says so in words', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [{ kind: 'send', messageId: offered.messageId, ok: false, reason: 'PHOTO_INVALID_DIMENSIONS' }])
    const listed = unwrap(await h.space().drafts(await asker(OWNER)))
    expect(listed[0]?.refusal).toContain('too tall')
  })

  test('a late answer for a send Tessa took back and sent again (another random id) settles nothing', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    expect(
      await outcomes(h, [
        {
          kind: 'send',
          messageId: offered.messageId,
          randomId: '12345',
          ok: true,
          telegramId: 9,
          at: '2026-10-20T12:00:02Z',
        },
      ]),
    ).toEqual({ settled: 0, unknown: 1 })
    expect(messages(h, '2001')[1]?.status).toBe('sending')
  })

  test('a send no one could confirm is "check Telegram" after the longer bound and not before, and answering it as removed deletes its picture', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    h.tick(SEND_IN_FLIGHT_MS - 1000)
    const early = await h.store.call('resolveSend', offered.messageId, false, OWNER_EMAIL)
    expect(early).toMatchObject({ ok: false, status: 409 })
    h.tick(2000)
    const gone = await h.store.call('resolveSend', offered.messageId, true, OWNER_EMAIL)
    expect(gone).toMatchObject({ ok: true })
    expect(messages(h, '2001')).toHaveLength(1)
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.size).toBe(0)
  })

  test('"it did not go out" is refused while the copy of the picture is already in the chat, as it is for words', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    h.tick(SEND_IN_FLIGHT_MS + 1000)
    await feed(
      h,
      push(
        [chat()],
        [message({ id: 90, out: true, text: CAPTION, at: '2026-10-20T12:00:30Z', media: { kind: 'photo', size: 9 } })],
      ),
    )
    const said = await h.store.call('resolveSend', offered.messageId, false, OWNER_EMAIL)
    expect(said).toMatchObject({ ok: false, status: 409 })
  })
})

describe('every way a draft that carries a picture goes away deletes the picture', () => {
  test('discarding the draft a refused send gave back', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [{ kind: 'send', messageId: offered.messageId, ok: false, reason: 'CHAT_WRITE_FORBIDDEN' }])
    const draft = unwrap(await h.space().drafts(await asker(OWNER)))[0]
    expect(await h.store.call('deleteDraft', offered.messageId, OWNER_EMAIL, draft?.rev as number)).toMatchObject({
      ok: true,
    })
    expect(rows(h, `SELECT key FROM setting WHERE key = 'telegram-media-drop:tg/${offered.messageId}'`)).toHaveLength(1)
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.size).toBe(0)
    expect(rows(h, `SELECT key FROM setting WHERE key LIKE 'telegram-media-drop:%'`)).toEqual([])
  })

  test('an object another message names again is never swept', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    await outcomes(h, [
      { kind: 'send', messageId: offered.messageId, ok: true, telegramId: 77, at: '2026-10-20T12:00:02Z' },
    ])
    h.db
      .query(`INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?, 'drop', ?, 'telegram')`)
      .run(`telegram-media-drop:tg/${offered.messageId}`, '2026-10-20T12:00:00.000Z')
    expect(await sweep(h)).toBe(0)
    expect(h.bucket.objects.has(`tg/${offered.messageId}`)).toBe(true)
  })
})

describe('Claude’s door has no route that reaches the picture', () => {
  test('Claude cannot call the bridge’s seventh call, and a sent picture is not a file its token can read', async () => {
    const h = harness()
    const { offered } = await pressed(h)
    const asClaude = await h.request(
      AGENT,
      'POST',
      `/api/picture?${new URLSearchParams({ account: account.id, message: offered.messageId, random: offered.randomId })}`,
    )
    expect([404, 403]).toContain(asClaude.status)
    expect(asClaude.bytes.length === png().length && asClaude.bytes.every((b, i) => b === png()[i])).toBe(false)
  })
})
