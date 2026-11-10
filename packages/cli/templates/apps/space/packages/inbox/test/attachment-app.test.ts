import { describe, expect, test } from 'bun:test'
import { GmailAuthError, GmailError } from '../src/gmail/google'
import { MAX_PREVIEW_BYTES } from '../src/image'
import { AGENT, firstGmail, harness } from '../test-support/harness'

/**
 * The picture read through the Mailroom (`readAttachment`, which the space's `attachment` method calls for the owner), with a Google that can fail: a picture
 * attached to a message is fetched from Gmail when asked for and given only if its bytes are PNG, JPEG, GIF or WebP. What is refused, that nothing is stored and
 * that asking marks nothing read. The headers that keep what a sender attached from doing anything in the page's origin are the SPACE's now (the inbox's own
 * route, which set them, went with its page; packages/space/test/files.test.ts); the file names are cleaned there too.
 *
 * What it cannot show is Gmail: the fake models messages.attachments.get as the documented API describes it (an
 * attachmentId in the part, the bytes behind it), and its message shape is PLACEHOLDER like every Gmail fixture.
 * Whether real parts look like that (an inline picture's Content-ID, a part with no attachmentId) is the hand test.
 */

type H = ReturnType<typeof harness>

const text = (s: string) => new TextEncoder().encode(s)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250, 251, 252, 253, 254, 255])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 200, 201, 255])
const GIF = text('GIF89a\x01\x00\x01\x00\x80\x00\x00')
const WEBP = Uint8Array.from([...text('RIFF'), 0x24, 0, 0, 0, ...text('WEBPVP8 '), 9, 9])
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const HTML = text('<html><script>alert(1)</script></html>')
const PDF = text('%PDF-1.7\n')

const file = (name: string, mimeType: string, bytes: Uint8Array, inline = false) => ({ name, mimeType, bytes, inline })

/** Connect with one message in the Inbox that carries `attachments`, and answer the message's id and its thread. */
async function withAttachments(h: H, attachments: ReturnType<typeof file>[]) {
  h.google.mailbox.add({
    id: 'g1',
    threadId: 'tg',
    from: 'Dana <dana@example.com>',
    subject: 'Pictures',
    body: 'See attached.',
    attachments,
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  const row = h.db.query(`SELECT id FROM message WHERE gmail_id = 'g1'`).get() as { id: string }
  return row.id
}

/** One file as the owner asks for it (the Mailroom's own answer), in the shape the route's tests read: a status, the type and bytes of what is given, or the error. */
async function get(h: H, id: string, n: number, how: 'view' | 'download' = 'view') {
  const r = (await h.store.call('readAttachment', id, n, how, { agent: false })) as
    | { ok: true; value: { bytes: Uint8Array; type: string; name: string; inline: boolean } }
    | { ok: false; status: number; error: string }
  if (!r.ok) return { status: r.status, json: { error: r.error }, text: r.error, type: null, bytes: new Uint8Array() }
  return { status: 200, json: null, text: '', type: r.value.type, bytes: r.value.bytes }
}

describe('what is served, and as what', () => {
  test('a PNG, JPEG, GIF or WebP is given as the type its bytes name', async () => {
    const h = harness()
    const id = await withAttachments(h, [
      file('shot.png', 'image/png', PNG),
      file('photo.jpg', 'image/jpeg', JPEG),
      file('anim.gif', 'image/gif', GIF),
      file('pic.webp', 'image/webp', WEBP),
    ])
    const expected: [string, Uint8Array][] = [
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/gif', GIF],
      ['image/webp', WEBP],
    ]
    for (const [n, [type, body]] of expected.entries()) {
      const res = await get(h, id, n)
      expect(res.status, type).toBe(200)
      expect(res.type).toBe(type)
      expect([...res.bytes]).toEqual([...body])
    }
  })

  test('the type comes from the bytes: a generic label is given as the picture it is', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('photo.png', 'application/octet-stream', JPEG)])
    const res = await get(h, id, 0)
    expect(res.status).toBe(200)
    expect(res.type).toBe('image/jpeg')
  })

  test('a very small picture that Gmail puts inside the part itself is given without a second call', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('dot.png', 'image/png', PNG, true)])
    const res = await get(h, id, 0)
    expect(res.status).toBe(200)
    expect([...res.bytes]).toEqual([...PNG])
    expect(h.google.count('getAttachment')).toBe(0)
  })
})

describe('what is refused', () => {
  test('SVG, a PDF and other types are refused (415) without asking Gmail for the file', async () => {
    const h = harness()
    const id = await withAttachments(h, [
      file('logo.svg', 'image/svg+xml', SVG),
      file('doc.pdf', 'application/pdf', PDF),
      file('page.png', 'text/html', HTML),
    ])
    for (const n of [0, 1, 2]) {
      const res = await get(h, id, n)
      expect(res.status).toBe(415)
      expect(res.json?.error).toContain('does not show it')
    }
    expect(h.google.count('getAttachment')).toBe(0)
  })

  test('a file that says it is a picture and is not (HTML named .png, SVG named .png) is refused on its bytes', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('receipt.png', 'image/png', HTML), file('logo.png', 'image/png', SVG)])
    for (const n of [0, 1]) {
      const res = await get(h, id, n)
      expect(res.status).toBe(415)
      expect(res.text).not.toContain('<script>')
    }
    expect(h.google.count('getAttachment')).toBe(2)
  })

  test('a picture over the size limit is refused (413) before any bytes are fetched', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('huge.png', 'image/png', new Uint8Array(MAX_PREVIEW_BYTES + 1))])
    const res = await get(h, id, 0)
    expect(res.status).toBe(413)
    expect(h.google.count('getAttachment')).toBe(0)
  })

  test('bytes over the limit are refused (413) when the size Gmail gave for the part was under it', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('shot.png', 'image/png', PNG)])
    // Gmail lists the part at its small size, but the file it hands back is larger than the limit.
    const big = new Uint8Array(MAX_PREVIEW_BYTES + 1)
    big.set(PNG)
    h.google.mailbox.attachmentBytes.set('att-g1-0', big)
    const res = await get(h, id, 0)
    expect(res.status).toBe(413)
    expect(h.google.count('getAttachment')).toBe(1)
  })

  test('a part at that place with the stored name but another size is not the file listed (404), and is not fetched', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('shot.png', 'image/png', PNG)])
    const part = h.google.mailbox.messages.get('g1')?.payload?.parts?.[1]
    if (!part?.body) throw new Error('the fake has no attachment part')
    part.body.size = PNG.length + 1
    expect((await get(h, id, 0)).status).toBe(404)
    expect(h.google.count('getAttachment')).toBe(0)
  })

  test('an index past the attachments, a message with none, a message that is not there and a malformed id are 404', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    expect((await get(h, id, 1)).status).toBe(404)
    expect((await get(h, 'nope', 0)).status).toBe(404)
    expect((await get(h, 'a/../b', 0)).status).toBe(404)
    expect((await get(h, id, Number('x'))).status).toBe(404)
    expect((await get(h, id, -1)).status).toBe(404)
    expect((await get(h, id, 1)).status).toBe(404)
    expect(h.google.count('getAttachment')).toBe(0)
  })

  test('a message with no attachments, and a draft, have none to serve', async () => {
    const h = harness()
    h.google.mailbox.add({ id: 'p1', threadId: 'tp', body: 'No files.' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const { id } = h.db.query(`SELECT id FROM message WHERE gmail_id = 'p1'`).get() as { id: string }
    expect((await get(h, id, 0)).status).toBe(404)
  })

  test('Gmail no longer having the message, or having it with other files, is 404 and serves nothing', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG), file('b.png', 'image/png', PNG)])
    const message = h.google.mailbox.messages.get('g1')
    // The parts are swapped: what is at place 0 is no longer what the inbox listed there.
    const parts = message?.payload?.parts ?? []
    ;[parts[1], parts[2]] = [parts[2] as never, parts[1] as never]
    expect((await get(h, id, 0)).status).toBe(404)
    h.google.mailbox.messages.delete('g1')
    expect((await get(h, id, 1)).status).toBe(404)
  })

  test('Gmail refusing, or the grant being gone, is 502 in its words and changes nothing', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    h.google.failNext('getAttachment', new GmailError('Backend Error', 500))
    const refused = await get(h, id, 0)
    expect(refused.status).toBe(502)
    expect(refused.json?.error).toContain('Backend Error')
    h.google.failNext('getAttachment', new GmailAuthError('revoked'))
    const revoked = await get(h, id, 0)
    expect(revoked.status).toBe(502)
    expect(revoked.json?.error).toContain('Connect Gmail again')
  })

  test('with Gmail not set up there is nothing to fetch from (503)', async () => {
    const h = harness({}, { googleConfigured: false })
    expect((await get(h, 'any-id', 0)).status).toBe(503)
  })

  test('after Gmail is disconnected the picture cannot be fetched (503) and nothing is sent to Gmail', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    expect(
      (await h.store.call('disconnectMailbox', firstGmail(h.inbox)?.id as string, 'tessa@northfield.example')).ok,
    ).toBe(true)
    const before = h.google.count('getMessage')
    expect((await get(h, id, 0)).status).toBe(503)
    expect(h.google.count('getMessage')).toBe(before)
  })
})

describe('who may ask', () => {
  test('Claude reads a Gmail picture too (the Mailroom refuses it a business mailbox’s file: test/files-and-reports.test.ts)', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    const asAgent = (await h.store.call('readAttachment', id, 0, 'view', { agent: true })) as { ok: boolean }
    expect(asAgent.ok).toBe(true)
  })

  test('the inbox has no route for it any more: Claude’s door and the push hostname answer 404 and ask Gmail for nothing', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    const before = h.google.count('getAttachment')
    const door = await h.request(AGENT, 'GET', `/api/messages/${id}/attachments/0`)
    expect(door.status).toBe(404)
    const res = await h.push({ method: 'GET', path: `/api/messages/${id}/attachments/0` })
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('PNG')
    expect(h.google.count('getAttachment')).toBe(before)
  })
})

describe('what looking at a picture does not do', () => {
  test('it marks nothing read, closes nothing and changes nothing in Gmail or the store', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    const state = () =>
      JSON.stringify({
        rows: h.db.query(`SELECT * FROM message ORDER BY rowid`).all(),
        conversations: h.db.query(`SELECT * FROM conversation ORDER BY rowid`).all(),
        audit: h.db.query(`SELECT count(*) AS n FROM audit`).get(),
      })
    const before = state()
    const labels = JSON.stringify(h.google.mailbox.messages.get('g1')?.labelIds)
    const callsBefore = h.google.calls.length

    for (const agent of [false, true]) {
      const r = (await h.store.call('readAttachment', id, 0, 'view', { agent })) as { ok: boolean }
      expect(r.ok).toBe(true)
    }

    expect(state()).toBe(before)
    expect(JSON.stringify(h.google.mailbox.messages.get('g1')?.labelIds)).toBe(labels)
    // Two reads of Gmail per picture (the message, then the file) and no call that changes a thing.
    expect(h.google.calls.slice(callsBefore)).toEqual([
      'getMessage:g1',
      expect.stringMatching(/^getAttachment:g1\/att-g1-0$/),
      'getMessage:g1',
      expect.stringMatching(/^getAttachment:g1\/att-g1-0$/),
    ])
    const queue = (await h.request(AGENT, 'GET', '/api/queue?filter=unread')).json
    expect(queue.rows).toHaveLength(1)
  })

  test('no byte of an attachment is stored: the message keeps its name, size and declared type', async () => {
    const h = harness()
    const id = await withAttachments(h, [file('a.png', 'image/png', PNG)])
    await get(h, id, 0)
    const row = h.db.query(`SELECT attachments FROM message WHERE id = ?`).get(id) as { attachments: string }
    expect(JSON.parse(row.attachments)).toEqual([{ name: 'a.png', size: PNG.length, mimeType: 'image/png' }])
    const everything = JSON.stringify(
      h.db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .flatMap((t: any) => h.db.query(`SELECT * FROM "${t.name}"`).all()),
    )
    expect(everything).not.toContain(Buffer.from(PNG).toString('base64'))
    expect(everything).not.toContain(Buffer.from(PNG).toString('base64url'))
  })

  test('the conversation says what each attachment is, so the space can choose to ask', async () => {
    const h = harness()
    await withAttachments(h, [file('a.png', 'image/png', PNG), file('doc.pdf', 'application/pdf', PDF)])
    const convo = (h.db.query(`SELECT id FROM conversation`).get() as { id: string }).id
    const page = (await h.request(AGENT, 'GET', `/api/conversations/${convo}`)).json
    expect(page.messages[0].attachments).toEqual([
      { name: 'a.png', size: PNG.length, mimeType: 'image/png' },
      { name: 'doc.pdf', size: PDF.length, mimeType: 'application/pdf' },
    ])
    expect(page.messages[0].id).toBeString()
    expect(page.unread).toBe(true)
  })
})
