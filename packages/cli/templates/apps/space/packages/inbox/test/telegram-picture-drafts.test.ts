import { describe, expect, test } from 'bun:test'
import { type CliIo, runCli } from '../scripts/cli'
import { TELEGRAM_PICTURE_MAX_BYTES } from '../src/telegram/wire'
import { SEND_FIELDS } from '../src/types'
import { AGENT, AGENT_AUD, AGENT_ID, asker, BRIDGE, harness, mint, OWNER, STRANGER } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { as, ownerRequest } from '../test-support/owner-requests'
import { account, channel, chat, message, push } from '../test-support/telegram'

/**
 * PICTURES ON DRAFTS. Claude puts a picture on a Telegram draft through its door and its script (an edit of the draft like an edit of its words, named by
 * its revision), the owner puts one or takes it out from the draft card, `drafts` tells Claude a draft carries a picture (its type, size and fingerprint, never its bytes), and Claude's instructed send of such a
 * draft NAMES the fingerprint, so Tessa's word covers the picture he approved and no other. The bridge's side of a send is telegram-pictures.test.ts's and is not re-proved here beyond one whole send.
 *
 * The seam is the one telegram-pictures.test.ts uses: Claude's real router and script, the space's part for the owner, the bridge's door as a function over the real store on a real SQLite and a fake bucket.
 */

type H = ReturnType<typeof harness>

const WORDS = 'Here is the screenshot you asked for.'
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }
const EARLY = '2026-10-20T11:00:00Z'
const MIN = 60_000
const png = (n = 1) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, n, 7, 7])
const jpeg = (n = 1) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, n])
const sha = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

const post = async (h: H, path: string, body: unknown) => (await h.bridge(BRIDGE, path, body)).json
const feed = (h: H, body: unknown) => post(h, '/api/push', body)
const work = (h: H) => post(h, '/api/work', { account, pictures: true })
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const conversationOf = (h: H, chatId: string): string =>
  (rows<{ id: string }>(h, `SELECT id FROM conversation WHERE telegram_chat_id = '${chatId}'`)[0] as { id: string }).id
const detail = async (h: H, conversationId: string) =>
  (await h.request(AGENT, 'GET', `/api/conversations/${conversationId}`)).json
const sweep = (h: H) => (h.store as unknown as { call(method: string): Promise<number> }).call('sweepTelegramMedia')
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
type Draft = {
  id: string
  rev: number
  body: string
  status: string
  updatedBy: string
  picture?: { type: string; size: number; fingerprint: string }
  attachments: { name: string; size: number; mimeType?: string; tg?: { kind: string; copy: string; sha256?: string } }[]
}

async function oneToOne(h: H, at = EARLY) {
  await feed(h, push([chat()], [message({ id: 1, text: 'Can you send me the screenshot?', at })]))
}

/** Claude's draft on the chat, as Claude makes it. */
async function claudeDraft(h: H, chatId = '2001'): Promise<Draft> {
  const res = await h.request(AGENT, 'POST', '/api/drafts', {
    conversationId: conversationOf(h, chatId),
    body: WORDS,
    why: 'She asked for the screenshot.',
  })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json as Draft
}
const put = (h: H, draft: { id: string }, rev: number | string | null, bytes: Uint8Array, who = AGENT) =>
  h.request(who, 'PUT', `/api/drafts/${draft.id}/picture${rev === null ? '' : `?rev=${rev}`}`, bytes)
const take = (h: H, draft: { id: string }, rev: number | string | null) =>
  h.request(AGENT, 'DELETE', `/api/drafts/${draft.id}/picture${rev === null ? '' : `?rev=${rev}`}`)
const listed = async (h: H): Promise<Draft[]> => (await h.request(AGENT, 'GET', '/api/drafts')).json
const allow = async (h: H) =>
  expect((await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(200)
const claudeSends = async (h: H, draft: { id: string; rev: number }, over: Record<string, unknown> = {}) =>
  h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, {
    rev: draft.rev,
    through: (await detail(h, conversationOf(h, '2001'))).through,
    instruction: SAID,
    ...over,
  })

describe('Claude puts a picture on a Telegram draft', () => {
  test('through its door, at the revision it read: the picture is kept under the draft’s own key, the revision rises, the answer says what the picture is and never gives it back', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const res = await put(h, draft, draft.rev, png())
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({
      id: draft.id,
      status: 'draft',
      rev: draft.rev + 1,
      picture: { type: 'image/png', size: png().length, fingerprint: await sha(png()) },
    })
    expect(new Uint8Array(h.bucket.objects.get(`tg/${draft.id}`)?.bytes as ArrayBuffer)).toEqual(png())
    // No byte of it in any answer Claude can read: `drafts` says what is there, as a fingerprint.
    const list = await h.request(AGENT, 'GET', '/api/drafts')
    expect(list.json[0].picture).toEqual({ type: 'image/png', size: png().length, fingerprint: await sha(png()) })
    expect(JSON.stringify(list.json)).not.toContain('137,80,78,71')
    expect(res.text).not.toContain('137,80,78,71')
    // It is an edit of the draft, audited as Claude's.
    const audit = (await ownerRequest(h, 'GET', '/api/audit')).json as {
      action: string
      actor: string
      subject: string
    }[]
    expect(audit.filter((a) => a.action === 'draft.update' && a.subject === `message:${draft.id}`)[0]?.actor).toBe(
      `agent:${AGENT_ID}`,
    )
  })

  test('a JPEG goes the same way; a second picture replaces the first under the same key, with its own fingerprint, and there is one object', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const first = (await put(h, draft, draft.rev, png())).json as Draft
    const second = await put(h, draft, first.rev, jpeg())
    expect(second.status).toBe(200)
    expect(second.json.picture).toEqual({ type: 'image/jpeg', size: jpeg().length, fingerprint: await sha(jpeg()) })
    expect(second.json.rev).toBe(first.rev + 1)
    expect([...h.bucket.objects.keys()]).toEqual([`tg/${draft.id}`])
    expect(new Uint8Array(h.bucket.objects.get(`tg/${draft.id}`)?.bytes as ArrayBuffer)).toEqual(jpeg())
  })

  test('a replacement whose commit fails (the draft moved while the object was being written) leaves the OLD bytes under the old fingerprint, so the send is not stuck; a first picture that fails leaves no object', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const first = (await put(h, draft, draft.rev, png())).json as Draft
    // The draft is edited by someone else between the plan and the commit: the commit's own check of the revision refuses.
    const realPut = h.bucket.put.bind(h.bucket)
    let moveOnce: string | null = draft.id
    h.bucket.put = (async (...args: Parameters<typeof realPut>) => {
      const done = await realPut(...args)
      if (moveOnce !== null) h.db.query(`UPDATE message SET rev = rev + 1 WHERE id = ?`).run(moveOnce)
      return done
    }) as typeof h.bucket.put
    const failed = await put(h, draft, first.rev, jpeg())
    expect(failed.status).toBe(409)
    moveOnce = null
    // The row still names the first picture, and the object is the first picture's bytes: they agree.
    expect(new Uint8Array(h.bucket.objects.get(`tg/${draft.id}`)?.bytes as ArrayBuffer)).toEqual(png())
    const row = (await listed(h))[0] as Draft
    expect(row.picture).toEqual({ type: 'image/png', size: png().length, fingerprint: await sha(png()) })
    // A draft with no picture: the failed put leaves nothing behind.
    const bare = await claudeDraft(h)
    moveOnce = bare.id
    expect((await put(h, bare, bare.rev, png())).status).toBe(409)
    expect(h.bucket.objects.has(`tg/${bare.id}`)).toBe(false)
  })

  test('is refused for a draft at another revision, with no revision, for a file that is not a PNG or a JPEG by its bytes, an empty one and one past ten megabytes, and nothing is kept', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    expect((await put(h, draft, draft.rev + 1, png())).status).toBe(409)
    expect((await put(h, draft, null, png())).status).toBe(422)
    expect((await put(h, draft, 'abc', png())).status).toBe(422)
    const html = await put(h, draft, draft.rev, new TextEncoder().encode('<script>alert(1)</script>'))
    expect(html.status).toBe(422)
    expect(html.json.error).toContain('PNG or a JPEG')
    expect((await put(h, draft, draft.rev, new Uint8Array(0))).status).toBe(422)
    const big = new Uint8Array(TELEGRAM_PICTURE_MAX_BYTES + 1)
    big.set(png())
    expect((await put(h, draft, draft.rev, big)).status).toBe(413)
    expect(h.bucket.objects.size).toBe(0)
    expect((await listed(h))[0]).toMatchObject({ rev: draft.rev })
    expect((await listed(h))[0]?.picture).toBeUndefined()
    // Exactly ten megabytes goes.
    const exact = new Uint8Array(TELEGRAM_PICTURE_MAX_BYTES)
    exact.set(png())
    expect((await put(h, draft, draft.rev, exact)).status).toBe(200)
  })

  test('is refused for a draft on a channel, on an email conversation or on none, for a message that came in and for one that does not exist; and for a bucket that will not take it, with nothing changed', async () => {
    const h = harness()
    await feed(
      h,
      push(
        [chat(), channel()],
        [message({ id: 1, text: 'hi', at: EARLY }), message({ chatId: '-1009876543', id: 2, at: EARLY })],
      ),
    )
    const toChannel = await claudeDraft(h, '-1009876543')
    expect((await put(h, toChannel, toChannel.rev, png())).status).toBe(422)
    // An email draft, and a hand draft on no conversation.
    const email = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'dana@example.com',
      subject: 'Hi',
      body: 'Hello',
      why: 'x',
    })
    expect((await put(h, email.json, email.json.rev, png())).status).toBe(422)
    const loose = await h.request(AGENT, 'POST', '/api/drafts', {
      address: '626-555-0101',
      name: 'Dana',
      subject: 'x',
      body: 'Hello',
      why: 'x',
    })
    expect((await put(h, loose.json, loose.json.rev, png())).status).toBe(422)
    // The message that came in is not a draft.
    const incoming = rows<{ id: string }>(h, `SELECT id FROM message WHERE direction = 'in'`)[0] as { id: string }
    expect((await put(h, incoming, 0, png())).status).toBe(409)
    expect((await put(h, { id: 'no-such-draft' }, 0, png())).status).toBe(404)
    expect(h.bucket.objects.size).toBe(0)

    const draft = await claudeDraft(h)
    h.bucket.failPut = true
    expect((await put(h, draft, draft.rev, png())).status).toBe(503)
    h.bucket.failPut = false
    expect((await listed(h)).find((d) => d.id === draft.id)).toMatchObject({ rev: draft.rev })
    expect((await listed(h)).find((d) => d.id === draft.id)?.picture).toBeUndefined()
  })

  test('only Claude’s token and the owner put one: the bridge’s token is refused at Claude’s door, and a stranger cannot through the space’s part', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    expect((await put(h, draft, draft.rev, png(), BRIDGE as never)).status).toBe(403)
    const refused = await h.space().putDraftPicture(await asker(STRANGER), {
      draftId: draft.id,
      rev: draft.rev,
      picture: { name: 'a.png', type: 'image/png', bytes: png() },
    })
    expect(refused).toMatchObject({ ok: false })
    expect(h.bucket.objects.size).toBe(0)
  })
})

describe('Claude takes a picture out, and the owner puts one on or takes it out', () => {
  test('taking it out is an edit like any other: the revision rises, the entry and key leave the row, and the object is deleted by the sweep; a second take-out names a moved revision and is refused', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    const removed = await take(h, draft, withPicture.rev)
    expect(removed.status, JSON.stringify(removed.json)).toBe(200)
    expect(removed.json.rev).toBe(withPicture.rev + 1)
    expect(removed.json.picture).toBeUndefined()
    expect(removed.json.attachments).toEqual([])
    expect(rows(h, `SELECT key FROM setting WHERE key = 'telegram-media-drop:tg/${draft.id}'`)).toHaveLength(1)
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.size).toBe(0)
    expect((await take(h, draft, withPicture.rev)).status).toBe(409)
    expect((await take(h, draft, null)).status).toBe(422)
  })

  test('taking out a picture that is not there (a draft that never had one, one already taken out, an email draft) is refused and changes nothing: the revision does not rise', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const refused = await take(h, draft, draft.rev)
    expect(refused.status, JSON.stringify(refused.json)).toBe(409)
    expect(refused.json.error).toContain('no picture')
    expect(((await listed(h))[0] as Draft).rev).toBe(draft.rev)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    const removed = (await take(h, draft, withPicture.rev)).json as Draft
    expect((await take(h, draft, removed.rev)).status).toBe(409)
    expect(((await listed(h))[0] as Draft).rev).toBe(removed.rev)
  })

  test('the owner’s Edit: a picture put on Claude’s draft is shown as his edit, and taken out with the words in the same save', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const put1 = unwrap(
      await h.space().putDraftPicture(await asker(OWNER), {
        draftId: draft.id,
        rev: draft.rev,
        picture: { name: 'Screenshot.png', type: 'image/png', bytes: png() },
      }),
    )
    expect(put1).toMatchObject({
      rev: draft.rev + 1,
      picture: { type: 'image/png', size: png().length },
      editedBy: 'owner',
    })
    // The page gets the type and length, and nothing it could use to name the picture to Claude.
    expect(put1.picture).toEqual({ type: 'image/png', size: png().length })
    expect(new Uint8Array(h.bucket.objects.get(`tg/${draft.id}`)?.bytes as ArrayBuffer)).toEqual(png())

    // Words and the picture changed in one save, at the revision shown.
    const saved = unwrap(
      await h.space().editDraft(await asker(OWNER), {
        draftId: draft.id,
        rev: put1.rev,
        text: 'Here you go.',
        takeOutPicture: true,
      }),
    )
    expect(saved).toMatchObject({ text: 'Here you go.', rev: put1.rev + 1 })
    expect(saved.picture).toBeUndefined()
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.size).toBe(0)
    // A stale revision is a conflict and changes nothing.
    const stale = await h.space().putDraftPicture(await asker(OWNER), {
      draftId: draft.id,
      rev: draft.rev,
      picture: { name: 'a.png', type: 'image/png', bytes: png() },
    })
    expect(stale).toMatchObject({ ok: false })
    expect((await listed(h))[0]?.picture).toBeUndefined()
  })

  test('the words of a draft with a picture may be none, and are needed again once it is taken out; the draft with no picture refuses an empty edit as ever', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const blank = await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: draft.rev, body: '' })
    expect(blank.status).toBe(422)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    const wordless = await ownerRequest(h, 'PATCH', `/api/drafts/${draft.id}`, { rev: withPicture.rev, body: '' })
    expect(wordless.status, JSON.stringify(wordless.json)).toBe(200)
    // Taking the picture out of a draft whose words are none leaves nothing to send: refused, and the picture stays.
    const empty = await h
      .space()
      .editDraft(await asker(OWNER), { draftId: draft.id, rev: wordless.json.rev, takeOutPicture: true })
    expect(empty).toMatchObject({ ok: false })
    expect((await listed(h))[0]?.picture).toBeDefined()
  })

  test('the owner reads the draft’s picture to show its thumbnail (the bytes decide what it is), and Claude’s token and a stranger never do', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    unwrap(
      await h.space().putDraftPicture(await asker(OWNER), {
        draftId: draft.id,
        rev: draft.rev,
        picture: { name: 'a.png', type: 'image/png', bytes: png() },
      }),
    )
    const seen = await h.space().attachment(await asker(OWNER), draft.id, 0, 'view')
    expect(seen.ok).toBe(true)
    if (seen.ok) expect(seen.value).toMatchObject({ type: 'image/png', inline: true, bytes: png() })
    expect(await h.store.call('readAttachment', draft.id, 0, 'view', { agent: true })).toMatchObject({
      ok: false,
      status: 403,
    })
    expect((await h.space().attachment(await asker(STRANGER), draft.id, 0, 'view')).ok).toBe(false)
    // And an email draft still has no file to give.
    const email = await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'dana@example.com',
      subject: 'Hi',
      body: 'Hello',
      why: 'x',
    })
    expect((await h.space().attachment(await asker(OWNER), email.json.id, 0, 'view')).ok).toBe(false)
  })

  test('discarding the draft deletes its picture, and so does Claude’s delete', async () => {
    const h = harness()
    await oneToOne(h)
    const a = await claudeDraft(h)
    const withPicture = (await put(h, a, a.rev, png())).json as Draft
    const gone = await h.request(AGENT, 'DELETE', `/api/drafts/${a.id}?rev=${withPicture.rev}`)
    expect(gone.status).toBe(200)
    expect(await sweep(h)).toBe(1)
    expect(h.bucket.objects.size).toBe(0)
  })
})

describe('Claude sends a draft that carries a picture on Tessa’s word, and the send names the picture', () => {
  test('with the switch on, the instruction recorded and the fingerprint named, it is claimed, offered to the bridge with its picture, fetched, and filed as sent by Claude, keeping the picture the record names', async () => {
    const h = harness()
    await oneToOne(h)
    await allow(h)
    const draft = await claudeDraft(h)
    h.tick(MIN)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    const fingerprint = await sha(png())
    const sent = await claudeSends(h, withPicture, { picture: fingerprint })
    expect(sent.status, JSON.stringify(sent.json)).toBe(200)
    expect(sent.json).toMatchObject({ status: 'sending', instruction: { text: SAID.text }, picture: { fingerprint } })

    const offered = (
      (await work(h)).owed as { kind: string; messageId: string; text: string; randomId: string; picture?: unknown }[]
    ).filter((o) => o.kind === 'send')
    expect(offered).toEqual([
      expect.objectContaining({ messageId: draft.id, text: WORDS, picture: { type: 'image/png', size: png().length } }),
    ])
    const got = await h.bridge(
      BRIDGE,
      `/api/picture?${new URLSearchParams({ account: account.id, message: draft.id, random: offered[0]?.randomId as string })}`,
      undefined,
    )
    expect(got.status).toBe(200)
    expect(got.bytes).toEqual(png())

    h.tick(1000)
    await post(h, '/api/outcomes', {
      account,
      outcomes: [
        {
          kind: 'send',
          messageId: draft.id,
          randomId: offered[0]?.randomId,
          ok: true,
          telegramId: 41,
          at: '2026-10-20T12:00:03Z',
        },
      ],
    })
    const filed = rows<{
      status: string
      sent_by: string
      arrival_key: string
      attachments: string
      instruction_text: string
    }>(h, `SELECT status, sent_by, arrival_key, attachments, instruction_text FROM message WHERE id = '${draft.id}'`)[0]
    expect(filed).toMatchObject({
      status: 'sent',
      sent_by: `agent:${AGENT_ID}`,
      arrival_key: '2001:41',
      instruction_text: SAID.text,
    })
    // Which picture went out on his word is on the sent message's own file entry, in the audit of the send, and in Claude's list.
    expect(JSON.parse(filed?.attachments as string)[0].tg.sha256).toBe(fingerprint)
    const audit = (await ownerRequest(h, 'GET', '/api/audit')).json as { action: string; after: { picture?: string } }[]
    expect(audit.find((a) => a.action === 'message.send')?.after.picture).toBe(fingerprint)
    expect(audit.find((a) => a.action === 'message.sending')?.after.picture).toBe(fingerprint)
    const list = (await as(h, OWNER, 'GET', '/api/claude-sends')).json as {
      message: { id: string; picture?: { fingerprint: string } }
    }[]
    expect(list[0]?.message).toMatchObject({ id: draft.id, picture: { fingerprint } })
  })

  test('a send that names no picture for a draft that carries one is refused (422), another fingerprint is refused (409), a picture named for a draft with none is refused (409), and nothing is claimed or offered', async () => {
    const h = harness()
    await oneToOne(h)
    await allow(h)
    const draft = await claudeDraft(h)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    expect((await claudeSends(h, withPicture)).status).toBe(422)
    expect((await claudeSends(h, withPicture, { picture: await sha(png(2)) })).status).toBe(409)
    expect((await claudeSends(h, withPicture, { picture: 'not a fingerprint' })).status).toBe(409)
    const plain = await claudeDraft(h)
    expect((await claudeSends(h, plain, { picture: await sha(png()) })).status).toBe(409)
    expect(rows(h, `SELECT id FROM message WHERE status = 'sending'`)).toEqual([])
    expect(((await work(h)).owed as { kind: string }[]).filter((o) => o.kind === 'send')).toEqual([])
    // The fingerprint may be written in capitals: it is the same number.
    expect((await claudeSends(h, withPicture, { picture: (await sha(png())).toUpperCase() })).status).toBe(200)
  })

  test('a picture put on, replaced or taken out by anyone but Claude AFTER Tessa spoke is refused: he agreed to the draft as he saw it', async () => {
    const h = harness()
    await oneToOne(h)
    await allow(h)
    const draft = await claudeDraft(h)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    // Tessa swaps the picture after his instruction (12:04), at 12:10.
    h.tick(10 * MIN)
    const swapped = unwrap(
      await h.space().putDraftPicture(await asker(OWNER), {
        draftId: draft.id,
        rev: withPicture.rev,
        picture: { name: 'b.png', type: 'image/png', bytes: png(2) },
      }),
    )
    const refused = await claudeSends(h, swapped, { picture: await sha(png(2)) })
    expect(refused.status).toBe(409)
    expect(rows(h, `SELECT id FROM message WHERE status = 'sending'`)).toEqual([])
    // Claude's own changes are not held against it: it puts a picture itself after he spoke, and names that one.
    const h2 = harness()
    await oneToOne(h2)
    await allow(h2)
    const d2 = await claudeDraft(h2)
    h2.tick(10 * MIN)
    const mine = (await put(h2, d2, d2.rev, png(3))).json as Draft
    expect((await claudeSends(h2, mine, { picture: await sha(png(3)) })).status).toBe(200)
  })

  test('with the switch off, or no instruction, a picture draft is refused as any draft is, whatever it names', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    expect((await claudeSends(h, withPicture, { picture: await sha(png()) })).status).toBe(403)
    await allow(h)
    expect((await claudeSends(h, withPicture, { picture: await sha(png()), instruction: undefined })).status).toBe(403)
    expect(rows(h, `SELECT id FROM message WHERE status = 'sending'`)).toEqual([])
  })

  test('a send still carries no text of its own: the fields are the old ones and the picture’s fingerprint, and the script and the server agree', async () => {
    expect([...SEND_FIELDS]).toEqual(['rev', 'through', 'instruction', 'picture'])
    const h = harness()
    await oneToOne(h)
    await allow(h)
    const draft = await claudeDraft(h)
    expect((await claudeSends(h, draft, { text: 'something else' })).status).toBe(422)
  })

  test('Tessa’s press on the card of a draft with a picture sends it, with no fingerprint needed, the bridge is offered the picture, and a words-only draft is sent as ever', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    const through = (await detail(h, conversationOf(h, '2001'))).through
    const sent = await h
      .space()
      .send(await asker(OWNER), { key: 'compose-picture-draft-0001', draftId: draft.id, rev: withPicture.rev, through })
    expect(unwrap(sent)).toMatchObject({ status: 'sending' })
    const offered = ((await work(h)).owed as { kind: string; picture?: unknown }[]).filter((o) => o.kind === 'send')
    expect(offered).toHaveLength(1)
    expect(offered[0]?.picture).toEqual({ type: 'image/png', size: png().length })

    const h2 = harness()
    await oneToOne(h2)
    const plain = await claudeDraft(h2)
    const sent2 = await h2.space().send(await asker(OWNER), {
      key: 'compose-picture-draft-0002',
      draftId: plain.id,
      rev: plain.rev,
      through: (await detail(h2, conversationOf(h2, '2001'))).through,
    })
    expect(unwrap(sent2)).toMatchObject({ status: 'sending' })
    expect(
      ((await work(h2)).owed as { kind: string; picture?: unknown }[]).filter((o) => o.kind === 'send')[0]?.picture,
    ).toBeUndefined()
  })

  test('the draft’s picture and the press: a picture put on after Tessa pressed Send, between the plan and the claim, refuses the claim (the revision moved)', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const withPicture = (await put(h, draft, draft.rev, png())).json as Draft
    const through = (await detail(h, conversationOf(h, '2001'))).through
    // Tessa pressed at the revision before the swap.
    unwrap(
      await h.space().putDraftPicture(await asker(OWNER), {
        draftId: draft.id,
        rev: withPicture.rev,
        picture: { name: 'b.png', type: 'image/png', bytes: png(2) },
      }),
    )
    const refused = await h
      .space()
      .send(await asker(OWNER), { key: 'compose-picture-draft-0003', draftId: draft.id, rev: withPicture.rev, through })
    expect(refused).toMatchObject({ ok: false })
    expect(rows(h, `SELECT id FROM message WHERE status = 'sending'`)).toEqual([])
  })
})

describe('Claude’s script', () => {
  function cli(h: H, files: Record<string, Uint8Array> = {}) {
    const requests: { method: string; path: string; bodyLength: number | null }[] = []
    const io: CliIo = {
      env: { INBOX_ACCESS_CLIENT_ID: AGENT_ID, INBOX_ACCESS_CLIENT_SECRET: 'not-a-real-secret' },
      sopsKey: () => {
        throw new Error('sops must not be called when the env is set')
      },
      readInput: async (spec) => spec,
      readBytes: async (path) => {
        const found = files[path]
        if (!found) throw new Error(`no such file ${path}`)
        return found
      },
      fetch: async (url, init) => {
        const headers = new Headers(init.headers)
        const u = new URL(url)
        requests.push({
          method: init.method ?? 'GET',
          path: u.pathname.replace('/agent/inbox', '') + u.search,
          bodyLength: init.body instanceof Uint8Array ? init.body.length : null,
        })
        headers.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
        return h.app.request(url.replace('/agent/inbox', ''), { ...init, headers }, h.env)
      },
    }
    return { run: (...argv: string[]) => runCli(argv, io), requests }
  }

  test('`picture` puts a file on a draft at the revision drafts printed, `none` takes it out, and `drafts` prints the type, size and fingerprint', async () => {
    const h = harness()
    await oneToOne(h)
    const draft = await claudeDraft(h)
    const { run, requests } = cli(h, { '/tmp/shot.png': png(), '/tmp/photo.jpg': jpeg() })
    const put1 = await run('picture', draft.id, String(draft.rev), '/tmp/shot.png')
    expect(put1.exitCode, put1.output).toBe(0)
    expect(JSON.parse(put1.output)).toMatchObject({
      rev: draft.rev + 1,
      picture: { type: 'image/png', size: png().length, fingerprint: await sha(png()) },
    })
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      path: `/api/drafts/${draft.id}/picture?rev=${draft.rev}`,
      bodyLength: png().length,
    })

    const printed = JSON.parse((await run('drafts')).output) as Draft[]
    expect(printed[0]?.picture?.fingerprint).toBe(await sha(png()))

    const swapped = JSON.parse((await run('picture', draft.id, String(draft.rev + 1), '/tmp/photo.jpg')).output)
    expect(swapped.picture.type).toBe('image/jpeg')
    const out = await run('picture', draft.id, String(swapped.rev), 'none')
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.output).picture).toBeUndefined()
    expect(requests.at(-1)).toEqual({
      method: 'DELETE',
      path: `/api/drafts/${draft.id}/picture?rev=${swapped.rev}`,
      bodyLength: null,
    })
  })

  test('refuses what cannot work before any request: no draft, no revision, no file', async () => {
    const h = harness()
    const { run, requests } = cli(h)
    for (const argv of [
      ['picture'],
      ['picture', 'abc'],
      ['picture', 'abc', 'x', 'shot.png'],
      ['picture', 'abc', '1'],
    ]) {
      const r = await run(...argv)
      expect(r.exitCode, argv.join(' ')).toBe(1)
    }
    expect(requests).toEqual([])
    const missing = await run('picture', 'abc', '1', '/tmp/not-there.png')
    expect(missing.exitCode).toBe(1)
    expect(requests).toEqual([])
  })

  test('`send` passes the fingerprint (64 hex digits, as `drafts` printed it) and refuses anything else before it asks', async () => {
    const h = harness()
    await oneToOne(h)
    await allow(h)
    const draft = await claudeDraft(h)
    const { run, requests } = cli(h, { '/tmp/shot.png': png() })
    const withPicture = JSON.parse((await run('picture', draft.id, String(draft.rev), '/tmp/shot.png')).output) as Draft
    const through = (await detail(h, conversationOf(h, '2001'))).through
    const before = requests.length
    const bad = await run(
      'send',
      draft.id,
      JSON.stringify({ rev: withPicture.rev, through, instruction: SAID, picture: 'abc' }),
    )
    expect(bad.exitCode).toBe(1)
    expect(requests.length).toBe(before)

    const none = await run('send', draft.id, JSON.stringify({ rev: withPicture.rev, through, instruction: SAID }))
    expect(none.exitCode).toBe(1)
    expect(none.output).toContain('422')

    const sent = await run(
      'send',
      draft.id,
      JSON.stringify({ rev: withPicture.rev, through, instruction: SAID, picture: withPicture.picture?.fingerprint }),
    )
    expect(sent.exitCode, sent.output).toBe(0)
    expect(JSON.parse(sent.output)).toMatchObject({ status: 'sending' })
    expect(OWNER_EMAIL).toBe('tessa@northfield.example')
  })
})
