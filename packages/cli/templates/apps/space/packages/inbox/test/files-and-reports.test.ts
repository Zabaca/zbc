import { describe, expect, test } from 'bun:test'
import { contentDisposition, INBOX_MOST_FILE_BYTES, INBOX_MOST_FILES, plainFilename } from '@space/workspace'
import { cleanFiles } from '../src/cloudflare/send'
import { type DeliveryEvent, notesFor, readDeliveryEvent } from '../src/delivery'
import type { MessageRow } from '../src/types'
import {
  AGENT,
  AGENT_AUD,
  AGENT_ID,
  asHttp,
  asker,
  harness,
  mint,
  OWNER,
  ownerDraft,
  STRANGER,
} from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { rawMail } from '../test-support/raw-mail'

/**
 * The files on mail that came through a Cloudflare mailbox are
 * shown and given back only to the owner, a reply from the mailbox carries files, and what Cloudflare reports of a reply is shown on that reply.
 *
 * The highest seam: Claude's door, `InboxForSpace` and the owner's own calls of the Mailroom (the owner has no router:
 * Tessa reaches the inbox through the space, whose entrypoint calls these same methods), over the real store and Mailroom,
 * with a bucket and a `send_email` binding that are fakes. How a file is drawn into a response (its headers) is the space's (packages/space/test/files.test.ts). What these cannot show is Cloudflare: that the binding takes `attachments` in this shape, that its `messageId` is the id its reports
 * name, and that a queue delivers them (packages/inbox/docs/runbooks/inbox-attachments-and-bounces.md is the hand test).
 */

type H = ReturnType<typeof harness>

const INFO = 'info@ridgewaycycles.example'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** A message to Ridgeway with a picture and a PDF attached, as a customer's mail client builds one. */
const withFiles = (id = 'files-1') =>
  [
    'Return-Path: <rosa@example.org>',
    'MIME-Version: 1.0',
    'From: Rosa Whitfield <rosa@example.org>',
    'Date: Mon, 26 Oct 2026 13:00:00 -0700',
    `Message-ID: <${id}@example.org>`,
    'Subject: My invoice',
    'To: info@ridgewaycycles.example',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Here are the results and a photo of the form.',
    '--b1',
    'Content-Type: image/png; name="form.png"',
    'Content-Disposition: attachment; filename="form.png"',
    'Content-Transfer-Encoding: base64',
    '',
    base64(PNG),
    '--b1',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    base64(PDF),
    '--b1--',
    '',
  ].join('\n')

async function filed(h: H, raw = withFiles()): Promise<{ conversationId: string; messageId: string }> {
  expect((await h.deliver(raw)).entered).toBe('filed')
  const row = h.db
    .query(`SELECT id, conversation_id FROM message WHERE direction = 'in' ORDER BY rowid DESC LIMIT 1`)
    .get() as {
    id: string
    conversation_id: string
  }
  return { conversationId: row.conversation_id, messageId: row.id }
}

/**
 * One file of one message, as the page's route asked for it: the Mailroom's `readAttachment` (what the part's `attachment` calls after it has admitted the owner),
 * as a person or, for `AGENT`, as Claude's token. `query` is '?download=1' to save it. Answers `{ status, json, file }`: the refusal's status and words, or the file.
 */
async function get(h: H, who: Record<string, unknown>, id: string, n: number, query = '') {
  const how = query === '?download=1' ? 'download' : 'view'
  const r = (await h.store.call('readAttachment', id, n, how, { agent: who === AGENT })) as
    | { ok: true; value: { bytes: Uint8Array; type: string; name: string; inline: boolean } }
    | { ok: false; status: number; error: string }
  return r.ok ? { status: 200, json: null, file: r.value } : { status: r.status, json: { error: r.error }, file: null }
}

/**
 * A send with files, as Tessa's: the Mailroom's `sendDraft` with the chosen files (what the part's `send` ends in; the page's form post is gone), as `actor`. `fields`
 * are `rev` and `through` as the form carried them, text.
 */
async function formSend(
  h: H,
  actor: string,
  draftId: string,
  fields: Record<string, string>,
  files: { name: string; type: string; bytes: Uint8Array }[] = [],
) {
  const whole = (v: string | undefined) => (v !== undefined && /^\d{1,12}$/.test(v) ? Number(v) : null)
  return asHttp(
    await h.store.call('sendDraft', draftId, { rev: whole(fields.rev), through: whole(fields.through) }, actor, files),
  )
}

async function draftReply(h: H, conversationId: string): Promise<MessageRow> {
  const res = await ownerDraft(h, { conversationId, body: 'Thank you, we have them.' })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json
}

const throughOf = async (h: H, id: string): Promise<number> =>
  (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json.through

describe('the files on mail that came through a Cloudflare mailbox', () => {
  test('are listed with their names, sizes and declared types, and nothing of their bytes is stored in the message', async () => {
    const h = harness()
    const { messageId } = await filed(h)
    const row = h.db.query(`SELECT attachments, raw_key FROM message WHERE id = ?`).get(messageId) as {
      attachments: string
      raw_key: string
    }
    expect(JSON.parse(row.attachments)).toEqual([
      { name: 'form.png', size: PNG.length, mimeType: 'image/png' },
      { name: 'invoice.pdf', size: PDF.length, mimeType: 'application/pdf' },
    ])
    expect(row.attachments).not.toContain(base64(PNG))
  })

  test('a picture is shown as the type its own bytes say, and a PDF is only ever a download, as an octet-stream, never shown', async () => {
    const h = harness()
    const { messageId } = await filed(h)

    const shown = await get(h, OWNER, messageId, 0)
    expect(shown.status).toBe(200)
    expect(shown.file).toMatchObject({ type: 'image/png', inline: true, name: 'form.png' })
    expect(Array.from(shown.file?.bytes ?? [])).toEqual(Array.from(PNG))

    // A PDF is not a picture: asked to be shown it is refused, asked to be saved it is handed over as a download.
    expect((await get(h, OWNER, messageId, 1)).status).toBe(415)
    const saved = await get(h, OWNER, messageId, 1, '?download=1')
    expect(saved.status).toBe(200)
    expect(saved.file).toMatchObject({ type: 'application/octet-stream', inline: false, name: 'invoice.pdf' })
    expect(Array.from(saved.file?.bytes ?? [])).toEqual(Array.from(PDF))
  })

  test('a file named as a picture that is not one is refused by its bytes, and a place past the end is not there', async () => {
    const h = harness()
    const html = new TextEncoder().encode('<script>alert(1)</script>')
    const raw = withFiles('fake-1').replace(base64(PNG), base64(html))
    const { messageId } = await filed(h, raw)
    expect((await get(h, OWNER, messageId, 0)).status).toBe(415)
    expect((await get(h, OWNER, messageId, 9)).status).toBe(404)
    expect((await get(h, OWNER, 'no-such-message', 0)).status).toBe(404)
  })

  test('only the owner opens them: no sign-in is refused, a person who is not the owner is refused, and Claude’s token is refused', async () => {
    const h = harness()
    const { messageId } = await filed(h)
    const reads = () => h.bucket.calls.filter((c) => c.startsWith('get:')).length
    const before = reads()
    // The Mailroom refuses Claude's token, and Claude's door has no route for a file at all (the page's route is gone). The space's entrypoint refuses everyone but the
    // verified owner (next test).
    expect((await get(h, AGENT, messageId, 1, '?download=1')).status).toBe(403)
    expect((await get(h, AGENT, messageId, 0)).status).toBe(403)
    expect((await h.request(AGENT, 'GET', `/api/messages/${messageId}/attachments/1?download=1`)).status).toBe(404)
    expect((await h.request(STRANGER, 'GET', `/api/messages/${messageId}/attachments/1?download=1`)).status).toBe(403)
    expect((await h.request(null, 'GET', `/api/messages/${messageId}/attachments/0`)).status).toBe(401)
    // Nothing was handed to any of them: the kept copy was not even read.
    expect(reads()).toBe(before)
  })

  test('the space asks the part with the person its check named, and only the owner is answered', async () => {
    const h = harness()
    const { messageId } = await filed(h)
    const space = h.space()

    const mine = await space.attachment(asker(OWNER), messageId, 1, 'download')
    expect(mine.ok, JSON.stringify(mine)).toBe(true)
    if (mine.ok) {
      expect(mine.value).toMatchObject({ name: 'invoice.pdf', type: 'application/octet-stream', inline: false })
      expect(Array.from(mine.value.bytes)).toEqual(Array.from(PDF))
    }
    const picture = await space.attachment(asker(OWNER), messageId, 0, 'view')
    expect(picture.ok && picture.value.inline && picture.value.type).toBe('image/png')

    const refused = async (reply: ReturnType<typeof space.attachment>, reason: string | string[]) => {
      const r = await reply
      expect(r.ok).toBe(false)
      if (!r.ok) expect([reason].flat()).toContain(r.reason)
    }
    // Someone who is not a person of the install, and a teammate, are not admitted: the inbox admits its owner and nobody else.
    await refused(space.attachment(asker(STRANGER), messageId, 1, 'download'), 'not-admitted')
    // Shapes that are not a message or a place are not found, and a way that is neither is a bad request.
    await refused(space.attachment(asker(OWNER), '../etc', 0, 'download'), 'not-found')
    await refused(space.attachment(asker(OWNER), messageId, -1, 'download'), 'not-found')
    await refused(space.attachment(asker(OWNER), messageId, 1, 'open' as never), 'bad-request')
    // A PDF to be viewed is not given.
    await refused(space.attachment(asker(OWNER), messageId, 1, 'view'), 'bad-request')
  })

  test('a message the space draws lists them, with whether a picture is worth asking for and whether any can be saved', async () => {
    const h = harness()
    const { messageId } = await filed(h)
    const history = await h.space().messagesWith(asker(OWNER), { address: 'rosa@example.org' })
    expect(history.ok).toBe(true)
    if (!history.ok) return
    const m = history.value.messages.find((x) => x.id === messageId)
    expect(m?.attachments).toEqual([
      { name: 'form.png', size: PNG.length, type: 'image/png', picture: true, download: true },
      { name: 'invoice.pdf', size: PDF.length, type: 'application/pdf', picture: false, download: true },
    ])
    expect(history.value.threads[0]).toMatchObject({ canReply: true, canAttach: true })
  })

  test('mail with no files draws as before: no attachments key and no delivery key on the answer', async () => {
    const h = harness()
    expect((await h.deliver(rawMail('first'))).entered).toBe('filed')
    const history = await h.space().messagesWith(asker(OWNER), { address: 'tessa@northfield.example' })
    expect(history.ok).toBe(true)
    if (!history.ok) return
    expect(history.value.messages.length).toBeGreaterThan(0)
    for (const m of history.value.messages) {
      expect('attachments' in m).toBe(false)
      expect('delivery' in m).toBe(false)
    }
  })

  test('a Gmail message’s files are pictures only, and none can be saved from here', async () => {
    const h = harness()
    h.google.mailbox.add({
      id: 'g1',
      threadId: 'tg',
      from: 'Dana <dana@example.com>',
      subject: 'Quote',
      body: 'Attached.',
      attachments: [{ name: 'quote.pdf', mimeType: 'application/pdf', bytes: PDF, inline: false }],
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const history = await h.space().messagesWith(asker(OWNER), { address: 'dana@example.com' })
    expect(history.ok).toBe(true)
    if (!history.ok) return
    expect(history.value.messages[0]?.attachments?.[0]).toMatchObject({
      name: 'quote.pdf',
      picture: false,
      download: false,
    })
    expect(history.value.threads[0]).toMatchObject({ canAttach: false })
    const id = history.value.messages[0]?.id as string
    const r = await h.space().attachment(asker(OWNER), id, 0, 'download')
    expect(r.ok).toBe(false)
  })
})

describe('opening the files of a kept message takes turns and checks the size first', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** A message to Ridgeway with four pictures attached, as four phone photos arrive. */
  const fourPictures = () => {
    const picture = (n: number) =>
      [
        '--b1',
        `Content-Type: image/png; name="p${n}.png"`,
        `Content-Disposition: attachment; filename="p${n}.png"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64(PNG),
        '',
      ].join('\n')
    return [
      'Return-Path: <rosa@example.org>',
      'MIME-Version: 1.0',
      'From: Rosa Whitfield <rosa@example.org>',
      'Date: Mon, 26 Oct 2026 13:00:00 -0700',
      'Message-ID: <four@example.org>',
      'Subject: Four photos',
      'To: info@ridgewaycycles.example',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Photos.',
      [1, 2, 3, 4].map(picture).join(''),
      '--b1--',
      '',
    ].join('\n')
  }

  test('four reads asked at once are done one at a time, and every one is answered', async () => {
    const h = harness()
    const { messageId } = await filed(h, fourPictures())
    let active = 0
    let most = 0
    const original = h.bucket.get.bind(h.bucket)
    h.bucket.get = async (key: string) => {
      const object = await original(key)
      if (!object) return object
      return {
        ...object,
        // The window the whole message is held in memory: from the body being asked for to its parse being handed back.
        arrayBuffer: async () => {
          active += 1
          most = Math.max(most, active)
          await sleep(15)
          try {
            return await object.arrayBuffer()
          } finally {
            active -= 1
          }
        },
      }
    }
    const reads = await Promise.all([0, 1, 2, 3].map((n) => get(h, OWNER, messageId, n)))
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(most).toBe(1)
  })

  test('a read that fails does not stop the ones behind it', async () => {
    const h = harness()
    const { messageId } = await filed(h, fourPictures())
    h.bucket.failGet = true
    const failed = await get(h, OWNER, messageId, 0)
    h.bucket.failGet = false
    expect(failed.status).toBe(502)
    expect((await get(h, OWNER, messageId, 1)).status).toBe(200)
  })

  test('a message over the limit is refused in words before a byte of it is read, and the files are listed as too large to open', async () => {
    const h = harness()
    const big = new Uint8Array(8 * 1024 * 1024).fill(7)
    const raw = withFiles('big-1').replace(base64(PDF), base64(big))
    const { messageId } = await filed(h, raw)
    const rawKey = (h.db.query('SELECT raw_key FROM message WHERE id = ?').get(messageId) as { raw_key: string })
      .raw_key
    expect(h.bucket.objects.get(rawKey)?.bytes.byteLength).toBeGreaterThan(10 * 1024 * 1024)
    const before = h.bucket.bodyReads.length
    const refused = await get(h, OWNER, messageId, 1, '?download=1')
    expect(refused.status).toBe(413)
    expect(refused.json?.error).toContain('larger than 10 MB')
    expect(h.bucket.bodyReads.length).toBe(before)

    const history = await h.space().messagesWith(asker(OWNER), { address: 'rosa@example.org' })
    if (!history.ok) throw new Error('no history')
    const files = history.value.messages.find((m) => m.id === messageId)?.attachments
    expect(files?.map((f) => [f.name, f.picture, f.download, f.tooLarge])).toEqual([
      ['form.png', false, false, true],
      ['invoice.pdf', false, false, true],
    ])
    const space = await h.space().attachment(asker(OWNER), messageId, 1, 'download')
    expect(space.ok).toBe(false)
    if (!space.ok) expect(space.reason).toBe('bad-request')
  })

  test('a message under the limit is opened, and its files are not marked too large', async () => {
    const h = harness()
    const { messageId } = await filed(h)
    const history = await h.space().messagesWith(asker(OWNER), { address: 'rosa@example.org' })
    if (!history.ok) throw new Error('no history')
    expect(history.value.messages.find((m) => m.id === messageId)?.attachments?.some((f) => 'tooLarge' in f)).toBe(
      false,
    )
  })
})

describe('a reply from a Cloudflare mailbox with files', () => {
  test('goes out with them, as the binding’s attachments, and the sent message lists them and gives them back', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    const draft = await draftReply(h, conversationId)
    h.tick()
    const res = await formSend(
      h,
      OWNER_EMAIL,
      draft.id,
      { rev: String(draft.rev), through: String(await throughOf(h, conversationId)) },
      [{ name: 'receipt (final).pdf', type: 'application/pdf', bytes: PDF }],
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)

    expect(h.email.handed).toHaveLength(1)
    const handed = h.email.handed[0]
    expect(handed?.attachments).toHaveLength(1)
    expect(handed?.attachments?.[0]).toMatchObject({
      filename: 'receipt (final).pdf',
      type: 'application/pdf',
      disposition: 'attachment',
    })
    expect(Array.from(new Uint8Array(handed?.attachments?.[0]?.content as ArrayBuffer))).toEqual(Array.from(PDF))

    const sent = h.db.query(`SELECT id, attachments, raw_key FROM message WHERE id = ?`).get(draft.id) as {
      id: string
      attachments: string
      raw_key: string
    }
    expect(JSON.parse(sent.attachments)).toEqual([
      { name: 'receipt (final).pdf', size: PDF.length, mimeType: 'application/pdf' },
    ])
    // The copy names the file and the bytes are their own object beside it.
    expect(h.bucket.text(sent.raw_key)).toContain('receipt (final).pdf')
    expect(h.bucket.text(sent.raw_key)).not.toContain(base64(PDF))
    expect(h.bucket.objects.has(`${sent.raw_key}/0`)).toBe(true)

    const back = await get(h, OWNER, draft.id, 0, '?download=1')
    expect(back.status).toBe(200)
    expect(Array.from(back.file?.bytes ?? [])).toEqual(Array.from(PDF))
  })

  test('the space’s reply carries them too, and only on a thread of a Cloudflare mailbox', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    const space = h.space()
    const history = await space.messagesWith(asker(OWNER), { address: 'rosa@example.org' })
    if (!history.ok) throw new Error('no history')
    const through = history.value.threads[0]?.through as number

    const sent = await space.send(asker(OWNER), {
      key: 'k'.repeat(32),
      conversationId,
      through,
      text: 'Thank you, we have them.',
      attachments: [{ name: 'receipt.pdf', type: 'application/pdf', bytes: PDF }],
    })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    expect(h.email.handed[0]?.attachments?.[0]).toMatchObject({ filename: 'receipt.pdf' })

    const after = await space.messagesWith(asker(OWNER), { address: 'rosa@example.org' })
    if (!after.ok) throw new Error('no history')
    const mine = after.value.messages.find((m) => m.direction === 'out')
    expect(mine?.attachments).toEqual([
      { name: 'receipt.pdf', size: PDF.length, type: 'application/pdf', picture: false, download: true },
    ])
  })

  test('from Tessa’s Gmail, files are refused before anything is drafted-and-sent or claimed, and the words are not sent without them', async () => {
    const h = harness()
    h.google.mailbox.add({
      id: 'g1',
      threadId: 'tg',
      from: 'Dana <dana@example.com>',
      subject: 'Quote',
      body: 'Hello.',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const convo = (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = 'tg'`).get() as { id: string }).id
    const space = h.space()
    const history = await space.messagesWith(asker(OWNER), { address: 'dana@example.com' })
    if (!history.ok) throw new Error('no history')
    const sent = await space.send(asker(OWNER), {
      key: 'g'.repeat(32),
      conversationId: convo,
      through: history.value.threads[0]?.through as number,
      text: 'Here you go.',
      attachments: [{ name: 'a.pdf', type: 'application/pdf', bytes: PDF }],
    })
    expect(sent.ok).toBe(false)
    if (!sent.ok) expect(sent.reason).toBe('bad-request')
    expect(h.google.calls.filter((c) => c.startsWith('send:'))).toEqual([])
    expect(h.email.handed).toEqual([])
    // The key is released, so the same reply without files sends.
    const again = await space.send(asker(OWNER), {
      key: 'g'.repeat(32),
      conversationId: convo,
      through: history.value.threads[0]?.through as number,
      text: 'Here you go.',
    })
    expect(again.ok, JSON.stringify(again)).toBe(true)
  })

  test('is refused with too many files or too many bytes, with nothing sent and the draft still a draft', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    const draft = await draftReply(h, conversationId)
    const through = String(await throughOf(h, conversationId))
    const many = Array.from({ length: INBOX_MOST_FILES + 1 }, (_, n) => ({
      name: `f${n}.txt`,
      type: 'text/plain',
      bytes: new Uint8Array([1, 2, 3]),
    }))
    expect((await formSend(h, OWNER_EMAIL, draft.id, { rev: String(draft.rev), through }, many)).status).toBe(422)
    const big = [
      { name: 'big.bin', type: 'application/octet-stream', bytes: new Uint8Array(INBOX_MOST_FILE_BYTES + 1) },
    ]
    expect((await formSend(h, OWNER_EMAIL, draft.id, { rev: String(draft.rev), through }, big)).status).toBe(422)
    const empty = [{ name: 'empty.txt', type: 'text/plain', bytes: new Uint8Array(0) }]
    expect((await formSend(h, OWNER_EMAIL, draft.id, { rev: String(draft.rev), through }, empty)).status).toBe(422)
    expect(h.email.handed).toEqual([])
    expect((h.db.query(`SELECT status FROM message WHERE id = ?`).get(draft.id) as { status: string }).status).toBe(
      'draft',
    )
  })

  test('Claude’s door carries no files: a form post there, with a verified token, is not a send; and a stranger and no sign-in are refused at it', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    const draft = await draftReply(h, conversationId)
    const fields = { rev: String(draft.rev), through: String(await throughOf(h, conversationId)) }
    const post = async (who: Record<string, unknown> | null) => {
      const form = new FormData()
      for (const [k, v] of Object.entries(fields)) form.set(k, v)
      form.append('file', new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' }))
      const headers: Record<string, string> = {}
      if (who) headers['cf-access-jwt-assertion'] = await mint(who, { audience: AGENT_AUD })
      return (
        await h.app.request(
          `https://space.northfield.example/api/drafts/${draft.id}/send`,
          { method: 'POST', headers, body: form },
          h.env,
        )
      ).status
    }
    expect(await post(null)).toBe(401)
    expect(await post(STRANGER)).toBe(403)
    expect(await post({ common_name: AGENT_ID })).toBe(400)
    expect(h.email.handed).toEqual([])
    expect((h.db.query(`SELECT status FROM message WHERE id = ?`).get(draft.id) as { status: string }).status).toBe(
      'draft',
    )
  })

  test('a refusal by Cloudflare leaves the draft a draft and keeps no file', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    const draft = await draftReply(h, conversationId)
    h.email.always({ kind: 'throw', code: 'E_CONTENT_TOO_LARGE' })
    const res = await formSend(
      h,
      OWNER_EMAIL,
      draft.id,
      { rev: String(draft.rev), through: String(await throughOf(h, conversationId)) },
      [{ name: 'a.pdf', type: 'application/pdf', bytes: PDF }],
    )
    expect(res.status).toBe(422)
    expect(h.bucket.calls.filter((c) => c.startsWith('put:out/'))).toEqual([])
  })
})

const bounce = (over: Partial<Record<string, unknown>> = {}, id = 'cf-1@ridgewaycycles.example') => ({
  type: 'cf.email.sending.message.bounced',
  source: { type: 'email.sending', zoneId: 'z', domain: 'ridgewaycycles.example' },
  payload: {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    messageId: id,
    sender: INFO,
    recipient: 'rosa@example.org',
    subject: 'Re: My invoice',
    terminal: true,
    delivery: { status: 'bounced', smtpResponse: '550 5.1.1 User unknown' },
    bounce: { type: 'hard', classification: 'permanent_failure', reason: '550 5.1.1 User unknown' },
    ...over,
  },
  metadata: {
    accountId: 'a',
    eventSubscriptionId: 's',
    eventSchemaVersion: 1,
    eventTimestamp: '2026-10-20T12:05:00.000Z',
  },
})

async function sendReply(h: H, conversationId: string, text = 'Thank you, we have them.'): Promise<string> {
  const draft = (await ownerDraft(h, { conversationId, body: text })).json as MessageRow
  h.tick()
  const res = asHttp(
    await h.store.call(
      'sendDraft',
      draft.id,
      { rev: draft.rev, through: await throughOf(h, conversationId) },
      OWNER_EMAIL,
    ),
  )
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return draft.id
}

describe('what Cloudflare reports of a reply', () => {
  test('a bounce shows on the reply that bounced, and not on the other replies of the conversation', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    h.email.sequence(
      { kind: 'accept', messageId: 'cf-1@ridgewaycycles.example' },
      { kind: 'accept', messageId: 'cf-2@ridgewaycycles.example' },
    )
    const first = await sendReply(h, conversationId, 'First reply.')
    h.tick()
    const second = await sendReply(h, conversationId, 'Second reply.')

    const kept = await h.store.call('keepDeliveryEvents', [bounce({}, 'cf-2@ridgewaycycles.example')])
    expect(kept).toEqual({ kept: 1, repeated: 0, dropped: 0, unmatched: 0 })

    const page = (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
    const by = (id: string) => page.messages.find((m: MessageRow) => m.id === id) as MessageRow
    expect(by(first).delivery).toBeUndefined()
    expect(by(second).delivery).toEqual([
      {
        recipient: 'rosa@example.org',
        state: 'bounced',
        reason: '550 5.1.1 User unknown',
        at: '2026-10-20T12:05:00.000Z',
      },
    ])

    const history = await h.space().messagesWith(asker(OWNER), { address: 'rosa@example.org' })
    if (!history.ok) throw new Error('no history')
    const drawn = (id: string) => history.value.messages.find((m) => m.id === id)
    expect(drawn(first) && 'delivery' in (drawn(first) as object)).toBe(false)
    expect(drawn(second)?.delivery).toEqual([
      {
        recipient: 'rosa@example.org',
        state: 'bounced',
        reason: '550 5.1.1 User unknown',
        at: Date.parse('2026-10-20T12:05:00.000Z'),
      },
    ])
  })

  test('a report that arrives before the send was filed waits for it, and a report delivered twice is one', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    h.email.always({ kind: 'accept', messageId: 'early-1@ridgewaycycles.example' })
    const event = bounce({}, 'early-1@ridgewaycycles.example')
    expect(await h.store.call('keepDeliveryEvents', [event, event])).toEqual({
      kept: 1,
      repeated: 1,
      dropped: 0,
      unmatched: 2,
    })
    const id = await sendReply(h, conversationId)
    const page = (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
    expect(page.messages.find((m: MessageRow) => m.id === id).delivery).toHaveLength(1)
  })

  test('the angle brackets Cloudflare’s id may or may not carry do not matter', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    h.email.always({ kind: 'accept', messageId: '<bracketed-1@ridgewaycycles.example>' })
    const id = await sendReply(h, conversationId)
    await h.store.call('keepDeliveryEvents', [bounce({}, 'bracketed-1@ridgewaycycles.example')])
    const page = (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
    expect(page.messages.find((m: MessageRow) => m.id === id).delivery[0].state).toBe('bounced')
  })

  test('what is not ours is dropped: another sender on the domain, a kind not known, garbage', async () => {
    const h = harness()
    const kept = await h.store.call('keepDeliveryEvents', [
      bounce({ sender: 'noreply@ridgewaycycles.example' }),
      { ...bounce(), type: 'cf.email.sending.message.unheard-of' },
      { ...bounce(), type: 'cf.email.routing.something' },
      'a string',
      null,
      42,
      bounce({ eventId: '' }),
      bounce({ recipient: 'not an address' }),
    ])
    expect(kept).toEqual({ kept: 0, repeated: 0, dropped: 8, unmatched: 0 })
    expect((h.db.query(`SELECT count(*) AS n FROM delivery_event`).get() as { n: number }).n).toBe(0)
  })

  test('a delivery after a deferral shows delivered, a deferral after a delivery does not undo it, and a complaint after a delivery shows', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    h.email.always({ kind: 'accept', messageId: 'mix-1@ridgewaycycles.example' })
    const id = await sendReply(h, conversationId)
    const at = (minute: number) => ({ eventTimestamp: `2026-10-20T12:0${minute}:00.000Z` })
    const event = (kind: string, minute: number, extra: Record<string, unknown> = {}) => {
      const e = bounce(
        { terminal: kind !== 'deferred', delivery: { status: kind }, bounce: undefined, ...extra },
        'mix-1@ridgewaycycles.example',
      )
      return { ...e, type: `cf.email.sending.message.${kind}`, metadata: { ...e.metadata, ...at(minute) } }
    }
    const state = async () =>
      (
        (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json.messages.find(
          (m: MessageRow) => m.id === id,
        ) as MessageRow
      ).delivery?.[0]?.state
    await h.store.call('keepDeliveryEvents', [event('delivered', 3), event('deferred', 4)])
    expect(await state()).toBe('delivered')
    await h.store.call('keepDeliveryEvents', [event('complained', 6, { complaint: { type: 'abuse' } })])
    expect(await state()).toBe('complained')
  })

  test('a message nobody reported on, and mail that came in, carry no delivery', async () => {
    const h = harness()
    const { conversationId } = await filed(h)
    const page = (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
    for (const m of page.messages) expect('delivery' in m).toBe(false)
  })
})

describe('reading a report', () => {
  const senders = [INFO]
  const now = new Date('2026-11-02T00:00:00.000Z')

  test('takes the reason from where its kind keeps it, cut short, as one line of text', () => {
    const long = `550 ${'x'.repeat(500)}`
    const read = readDeliveryEvent(bounce({ bounce: { type: 'hard', reason: long } }), senders, now) as DeliveryEvent
    expect(read.reason.length).toBe(300)
    expect(read.reason.endsWith('…')).toBe(true)
    const rejected = readDeliveryEvent(
      {
        ...bounce({
          rejection: { reason: 'suppressed', party: 'recipient', detail: 'Recipient is suppressed' },
          bounce: undefined,
        }),
        type: 'cf.email.sending.message.rejected',
      },
      senders,
      now,
    ) as DeliveryEvent
    expect(rejected).toMatchObject({ state: 'rejected', reason: 'Recipient is suppressed' })
    const control = readDeliveryEvent(
      bounce({ bounce: { reason: 'line one\nline two\u0007' } }),
      senders,
      now,
    ) as DeliveryEvent
    expect(control.reason).toBe('line one line two')
  })

  test('orders a report with no usable time by when it was read, and reads a sender written with a name', () => {
    const e = bounce({ sender: `Ridgeway Cycles <${INFO.toUpperCase()}>` })
    const read = readDeliveryEvent({ ...e, metadata: {} }, senders, now) as DeliveryEvent
    expect(read.at).toBe(now.toISOString())
    expect(read.recipient).toBe('rosa@example.org')
  })

  test('notesFor keeps one note per recipient: terminal over deferred, then the newer', () => {
    const held = (recipient: string, state: any, terminal: boolean, at: string) => ({
      recipient,
      state,
      terminal,
      reason: '',
      at,
      keptAt: at,
    })
    expect(
      notesFor([
        held('a@x.example.org', 'delivered', true, '2026-10-20T12:03:00.000Z'),
        held('a@x.example.org', 'deferred', false, '2026-10-20T12:09:00.000Z'),
        held('b@x.example.org', 'deferred', false, '2026-10-20T12:01:00.000Z'),
        held('b@x.example.org', 'bounced', true, '2026-10-20T12:02:00.000Z'),
      ]).map((n) => [n.recipient, n.state]),
    ).toEqual([
      ['a@x.example.org', 'delivered'],
      ['b@x.example.org', 'bounced'],
    ])
  })
})

describe('the files of a send, cleaned', () => {
  const file = (name: string, type: string, n = 3) => ({ name, type, bytes: new Uint8Array(n).fill(1) })

  test('a name loses what a header or a shell reads, a type that is not plain becomes the generic one, a parameter is dropped', () => {
    const [a, b, c] = cleanFiles([
      file('../../etc/passwd', 'text/plain; charset=utf-8'),
      file('x"; y=1\r\nBcc: a@b.c', 'Not A Type'),
      file('.hidden', 'IMAGE/PNG'),
    ])
    expect(a).toMatchObject({ filename: 'etc_passwd', type: 'text/plain' })
    expect(b?.filename).not.toMatch(/["\r\n;]/)
    expect(b?.type).toBe('application/octet-stream')
    expect(c).toMatchObject({ filename: 'hidden', type: 'image/png' })
    expect(plainFilename('')).toBe('attachment')
    expect(plainFilename('a‮txt.exe')).toBe('atxt.exe')
  })

  test('is refused past the counts, and the Content-Disposition holds the name in its quotes', () => {
    expect(() => cleanFiles(Array.from({ length: INBOX_MOST_FILES + 1 }, () => file('a.txt', 'text/plain')))).toThrow()
    expect(() => cleanFiles([file('a.bin', 'application/octet-stream', INBOX_MOST_FILE_BYTES + 1)])).toThrow()
    const header = contentDisposition('attachment', 'rep"ort é\r\n.pdf')
    expect(header).not.toMatch(/\r|\n/)
    expect(header).toContain("filename*=UTF-8''")
    expect(header.split('"').length).toBe(3)
  })
})
