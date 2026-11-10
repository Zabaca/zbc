// Files on an email shown and sent, and what Cloudflare reported of a reply, in the space. Driven through the real
// router with a stand-in inbox behind the binding. What is asserted is what a person is given or refused: a file only to the signed-in owner and never from a public
// address, a reply that carries its files, a bounce on the message that bounced, and an answer from an inbox that predates the fields drawn as it was. What it cannot
// show is the inbox's own side (packages/inbox/test/files-and-reports.test.ts) or a browser (the screenshots in the report).
import { describe, expect, test } from 'bun:test'
import { ANSWER_WITHIN_MS, INBOX_MOST_FILES, type InboxFileOut, type SpaceReply } from '@space/workspace'
import { lane, northfield } from '../../workspace/test/helpers'
import { attached, begin, canSend, detached, filesOf, newCompose, whyNotFiles } from '../src/client/compose'
import { sizeWords } from '../src/client/Files'
import type { ConversationAnswer, WriteOutcome } from '../src/conversation'
import { FILE_WITHIN_MS, parseFileQuery } from '../src/files'
import { isInboxHistory } from '../src/reach'
import { type StandInMessage, type StandInThread, standInInbox } from '../src/stand-ins'
import { RIDGEWAY, LANE_TEAM, NORTHFIELD_TEAM, ago, contact, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const key = (n: number) => `file-key-${String(n).padStart(8, '0')}`
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n')
const RUN = 'Rosa Whitfield <rosa@example.org>'

const inboxMessages = (): StandInMessage[] => [
  {
    id: 'm-in',
    at: ago(300),
    direction: 'in',
    from: RUN,
    text: 'Here are the results.',
    files: [
      { name: 'form.png', type: 'image/png', bytes: PNG },
      { name: 'invoice.pdf', type: 'application/pdf', bytes: PDF },
    ],
  },
  {
    id: 'm-out',
    at: ago(200),
    direction: 'out',
    from: 'Ridgeway Cycles <info@ridgewaycycles.example>',
    text: 'Thank you.',
    delivery: [{ recipient: 'rosa@example.org', state: 'bounced', reason: '550 5.1.1 User unknown', at: ago(199) }],
  },
  { id: 'm-plain', at: ago(100), direction: 'in', from: RUN, text: 'Nothing attached.' },
]

const ridgeway = (messages = inboxMessages()): StandInThread => thread('t-shop', ago(100), ['c-rosa'], { subject: 'Photos', mailbox: RIDGEWAY, messages })
const gmail = (): StandInThread =>
  thread('t-gmail', ago(50), ['c-rosa'], { subject: 'Quote', messages: [{ id: 'g-1', at: ago(50), direction: 'in', from: RUN, text: 'Photo attached.', files: [{ name: 'shop.png', type: 'image/png', bytes: PNG }, { name: 'q.pdf', type: 'application/pdf', bytes: PDF }] }] })

async function asOwner(o: { threads?: StandInThread[]; withFiles?: boolean; company?: 'lane' } = {}) {
  const inbox = standInInbox([contact('c-rosa', 'Rosa Whitfield', 'rosa@example.org')], o.threads ?? [ridgeway(), gmail()], { withFiles: o.withFiles ?? true })
  const w = o.company === 'lane' ? await world(lane(), LANE_TEAM, { inbox: inbox }, undefined, { answerWithinMs: 60, writeWithinMs: 200 }) : await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox }, undefined, { answerWithinMs: 60, writeWithinMs: 200 })
  const jwt = await w.signIn(o.company === 'lane' ? 'lane@pinecrest.test' : 'tessa@northfield.example')
  const open = async (): Promise<ConversationAnswer> => (await (await w.call('/api/conversation?key=rosa%40example.org', { jwt })).json()) as ConversationAnswer
  const file = (query: string, init: { jwt?: string | null; headers?: Record<string, string> } = {}) => w.call(`/api/attachment${query}`, { ...(init.jwt === null ? {} : { jwt: init.jwt ?? jwt }), ...(init.headers && { headers: init.headers }) })
  const form = (fields: Record<string, string>, files: File[], headers: Record<string, string> = {}, over: { jwt?: string | null } = {}) => {
    const body = new FormData()
    for (const [k, v] of Object.entries(fields)) body.set(k, v)
    for (const f of files) body.append('file', f, f.name)
    return w.call('/api/email/files', { method: 'POST', ...(over.jwt === null ? {} : { jwt: over.jwt ?? jwt }), headers: { origin: ORIGIN, 'x-space-write': '1', ...headers }, body })
  }
  return { w, jwt, inbox, open, file, form }
}

const reply = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ key: key(n), conversationId: 't-shop', through: 3, text: 'Thank you, we have them.', ...extra })
const file = (name: string, type: string, bytes: Uint8Array | number = 3) => new File([typeof bytes === 'number' ? new Uint8Array(bytes).fill(1) : (bytes as BlobPart)], name, { type })

describe('the files on an email, as the space is told of them', () => {
  test('a message carries its files and what was reported of it, a thread says whether it can carry files, and a message with none says nothing', async () => {
    const s = await asOwner()
    const answer = await s.open()
    const mail = answer.sources.find((x) => x.kind === 'mail')
    if (!mail || mail.kind !== 'mail') throw new Error('no mail')
    const by = (id: string) => mail.messages.find((m) => m.id === id)
    expect(by('m-in')?.attachments).toEqual([
      { name: 'form.png', size: PNG.length, type: 'image/png', picture: true, download: true },
      { name: 'invoice.pdf', size: PDF.length, type: 'application/pdf', picture: false, download: true },
    ])
    expect(by('m-out')?.delivery?.[0]).toMatchObject({ recipient: 'rosa@example.org', state: 'bounced', reason: '550 5.1.1 User unknown' })
    expect(by('m-plain') && 'attachments' in (by('m-plain') as object)).toBe(false)
    expect(by('m-plain') && 'delivery' in (by('m-plain') as object)).toBe(false)
    // Gmail's file is a picture that can be shown and a document that can only be named.
    expect(by('g-1')?.attachments).toEqual([
      { name: 'shop.png', size: PNG.length, type: 'image/png', picture: true, download: false },
      { name: 'q.pdf', size: PDF.length, type: 'application/pdf', picture: false, download: false },
    ])
    expect(Object.fromEntries(answer.threads.map((t) => [t.conversationId, t.canAttach]))).toEqual({ 't-shop': true, 't-gmail': false })
  })

  test('an answer from an inbox that predates files draws as before: no files, no notes, and no thread that can carry any', async () => {
    const s = await asOwner({ withFiles: false })
    const answer = await s.open()
    const mail = answer.sources.find((x) => x.kind === 'mail')
    if (!mail || mail.kind !== 'mail') throw new Error('no mail')
    expect(mail.messages.length).toBeGreaterThan(0)
    for (const m of mail.messages) {
      expect('attachments' in m).toBe(false)
      expect('delivery' in m).toBe(false)
    }
    expect(answer.threads.every((t) => t.canAttach === false)).toBe(true)
  })

  test('an answer whose files or reports are not the shape the contract says is not half read', () => {
    const base = { more: false, threads: [], messages: [{ id: 'm', conversationId: 'c', subject: '', direction: 'in', at: 1, from: 'a', text: 't', textCut: false, alsoOn: [] }] }
    expect(isInboxHistory(base)).toBe(true)
    const withMessage = (extra: Record<string, unknown>) => ({ ...base, messages: [{ ...(base.messages[0] as object), ...extra }] })
    expect(isInboxHistory(withMessage({ attachments: [{ name: 'a', size: 1, type: '', picture: false, download: true }] }))).toBe(true)
    expect(isInboxHistory(withMessage({ attachments: [{ name: 'a', size: -1, type: '', picture: false, download: true }] }))).toBe(false)
    expect(isInboxHistory(withMessage({ attachments: [{ name: 'a', size: 1, type: '', picture: false }] }))).toBe(false)
    expect(isInboxHistory(withMessage({ attachments: 'a.png' }))).toBe(false)
    expect(isInboxHistory(withMessage({ delivery: [{ recipient: 'a@b.c', state: 'bounced', reason: '', at: 1 }] }))).toBe(true)
    expect(isInboxHistory(withMessage({ delivery: [{ recipient: 'a@b.c', state: 'imploded', reason: '', at: 1 }] }))).toBe(false)
  })
})

describe('giving a file back', () => {
  test('a signed-in person gets a picture inline as a picture and a document as a download, with headers that make either inert', async () => {
    const s = await asOwner()
    const shown = await s.file('?m=m-in&n=0&how=view')
    expect(shown.status).toBe(200)
    expect(shown.headers.get('content-type')).toBe('image/png')
    expect(shown.headers.get('content-disposition')).toStartWith('inline;')
    expect(shown.headers.get('x-content-type-options')).toBe('nosniff')
    expect(shown.headers.get('cache-control')).toBe('private, no-store')
    expect(shown.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(Array.from(new Uint8Array(await shown.arrayBuffer()))).toEqual(Array.from(PNG))

    const saved = await s.file('?m=m-in&n=1&how=download')
    expect(saved.status).toBe(200)
    expect(saved.headers.get('content-type')).toBe('application/octet-stream')
    expect(saved.headers.get('content-disposition')).toStartWith('attachment; filename="invoice.pdf"')
    expect(Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(Array.from(PDF))
    expect(s.inbox.fileReads).toEqual([
      { messageId: 'm-in', index: 0, how: 'view' },
      { messageId: 'm-in', index: 1, how: 'download' },
    ])
  })

  test('with no sign-in nothing is given and the inbox is not asked, at either path; the Access cookie alone is no sign-in', async () => {
    const s = await asOwner()
    expect((await s.file('?m=m-in&n=0&how=view', { jwt: null })).status).toBe(401)
    expect((await s.file('?m=m-in&n=1&how=download', { jwt: null })).status).toBe(401)
    expect((await s.w.call('/api/attachment?m=m-in&n=0', { cookieJwt: s.jwt })).status).toBe(401)
    expect((await s.form({}, [], {}, { jwt: null })).status).toBe(401)
    expect(s.inbox.fileReads).toEqual([])
    expect(s.inbox.sent).toEqual([])
  })

  test('a person of another company’s install is nobody here, and the inbox is not asked', async () => {
    const s = await asOwner({ company: 'lane' })
    const stranger = await s.w.signIn('tessa@northfield.example')
    expect((await s.file('?m=m-in&n=0', { jwt: stranger })).status).toBe(403)
    expect(s.inbox.fileReads).toEqual([])
  })

  test('the inbox’s refusal that this person may not have it is a 403, a file it has not is a 404, a way it will not give it is a 400 in its words, and it down is a 503 (a fault it knew of, a 502)', async () => {
    const s = await asOwner()
    const original = s.inbox.attachment
    s.inbox.attachment = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'private' })
    expect((await s.file('?m=m-in&n=0')).status).toBe(403)
    s.inbox.attachment = original
    expect((await s.file('?m=m-in&n=9')).status).toBe(404)
    expect((await s.file('?m=no-such&n=0')).status).toBe(404)
    // A document asked to be shown, and a Gmail document asked to be saved: the stand-in refuses as the inbox does.
    const doc = await s.file('?m=m-in&n=1&how=view')
    expect(doc.status).toBe(400)
    expect(((await doc.json()) as { error: string }).error).toContain('not a PNG')
    expect((await s.file('?m=g-1&n=1&how=download')).status).toBe(400)
    s.inbox.attachment = async () => {
      throw new Error('down')
    }
    expect((await s.file('?m=m-in&n=0')).status).toBe(503)
    s.inbox.attachment = async () => ({ ok: true, value: { nonsense: true } }) as unknown as SpaceReply<InboxFileOut>
    expect((await s.file('?m=m-in&n=0')).status).toBe(503)
    s.inbox.attachment = async () => ({ ok: false, kind: 'failed', reason: 'broken', message: 'The kept copy could not be read.' })
    expect((await s.file('?m=m-in&n=0')).status).toBe(502)
  })

  test('what the inbox calls a picture is served as one only when its type is one of the four, and a hostile name cannot leave its quotes', async () => {
    const s = await asOwner()
    s.inbox.attachment = async () => ({ ok: true, value: { name: 'x";\r\nSet-Cookie: a=b‮.html', type: 'text/html', inline: true, bytes: new TextEncoder().encode('<script>alert(1)</script>') } })
    const res = await s.file('?m=m-in&n=0')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toStartWith('attachment;')
    expect(disposition).not.toMatch(/[\r\n]/)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(disposition).toContain("filename*=UTF-8''")
  })

  test('only a message and a place are taken from the address; anything else is a 400 before the inbox is asked', async () => {
    const s = await asOwner()
    for (const query of ['', '?m=m-in', '?n=0', '?m=../x&n=0', '?m=m-in&n=-1', '?m=m-in&n=1000', '?m=m-in&n=0&how=open', '?m=m-in&n=a']) {
      expect([query, (await s.file(query)).status]).toEqual([query, 400])
    }
    expect(parseFileQuery({ m: 'm-in', n: '2' })).toEqual({ messageId: 'm-in', index: 2, how: 'view' })
    expect(s.inbox.fileReads).toEqual([])
  })

  test('is a read: a form, a post or a delete to the address is refused', async () => {
    const s = await asOwner()
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await s.w.call('/api/attachment?m=m-in&n=0', { method, jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })
      expect([method, res.status]).toEqual([method, 405])
    }
  })
})

describe('a reply with files', () => {
  test('carries them to the inbox from a business mailbox’s thread, and the answer is a done send', async () => {
    const s = await asOwner()
    const res = await s.form({ json: reply(1) }, [file('receipt.pdf', 'application/pdf', PDF), file('photo.png', 'image/png', PNG)])
    expect(res.status).toBe(200)
    expect((await res.json()) as WriteOutcome).toEqual({ result: 'done', status: 'sent' })
    const sent = s.inbox.sent[0]
    expect(sent).toMatchObject({ conversationId: 't-shop', through: 3, text: 'Thank you, we have them.' })
    expect('attachments' in (sent as object) && (sent as unknown as { attachments: { name: string; type: string; bytes: Uint8Array }[] }).attachments.map((f) => [f.name, f.type, f.bytes.length])).toEqual([
      ['receipt.pdf', 'application/pdf', PDF.length],
      ['photo.png', 'image/png', PNG.length],
    ])
  })

  test('from Tessa’s Gmail thread it is refused in the inbox’s words and sends nothing; the same reply with no files then sends under the same key', async () => {
    const s = await asOwner()
    const body = JSON.stringify({ key: key(2), conversationId: 't-gmail', through: 1, text: 'Here you go.' })
    const refused = (await (await s.form({ json: body }, [file('a.pdf', 'application/pdf', PDF)])).json()) as WriteOutcome
    expect(refused).toMatchObject({ result: 'refused', reason: 'bad-request' })
    expect(s.inbox.sent).toEqual([])
    const plain = await s.w.call('/api/email', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body })
    expect((await plain.json()) as WriteOutcome).toEqual({ result: 'done', status: 'sent' })
  })

  test('a repeat with the same key sends nothing new, files or not', async () => {
    const s = await asOwner()
    const files = () => [file('r.pdf', 'application/pdf', PDF)]
    expect((await (await s.form({ json: reply(3) }, files())).json()) as WriteOutcome).toEqual({ result: 'done', status: 'sent' })
    expect((await (await s.form({ json: reply(3) }, files())).json()) as WriteOutcome).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('is refused before the inbox is asked: too many files, too many bytes, an empty file, a draft or a new email instead of a reply, no words, a body that is not JSON', async () => {
    const s = await asOwner()
    const many = Array.from({ length: INBOX_MOST_FILES + 1 }, (_, n) => file(`f${n}.txt`, 'text/plain'))
    expect((await s.form({ json: reply(4) }, many)).status).toBe(400)
    expect((await s.form({ json: reply(4) }, [file('big.bin', 'application/octet-stream', 16 * 1024 * 1024)])).status).toBe(400)
    expect((await s.form({ json: reply(4) }, [file('empty.txt', 'text/plain', 0)])).status).toBe(400)
    expect((await s.form({ json: JSON.stringify({ key: key(4), draftId: 'd1', rev: 1, through: 1 }) }, [file('a.txt', 'text/plain')])).status).toBe(400)
    expect(s.inbox.sent).toEqual([])
    // No words with a file is passed on (a picture can speak for itself); the inbox refuses it where a picture cannot go, in its words, and sends nothing.
    const wordless = await s.form({ json: JSON.stringify({ key: key(4), conversationId: 't-shop', through: 3, text: '   ' }) }, [file('a.txt', 'text/plain')])
    expect(wordless.status).toBe(200)
    expect((await wordless.json()) as WriteOutcome).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'There is nothing in the body to send.' })
    expect((await s.form({ json: 'not json' }, [file('a.txt', 'text/plain')])).status).toBe(400)
    expect((await s.form({}, [file('a.txt', 'text/plain')])).status).toBe(400)
    expect(s.inbox.sent).toEqual([])
  })

  test('a Telegram chat takes ONE picture with or without words: the form is passed on, a picture of the wrong kind or a second one is refused by the inbox, and an email thread of Tessa’s Gmail still takes no file', async () => {
    const tg = thread('t-tg', ago(20), ['c-rosa'], { subject: '', kind: 'telegram', messages: [{ id: 'tg-1', at: ago(20), direction: 'in', from: RUN, text: 'Can you send the screenshot?' }] })
    const s = await asOwner({ threads: [tg, gmail()] })
    const say = (n: number, over: Record<string, unknown> = {}) => JSON.stringify({ key: key(n), conversationId: 't-tg', through: 1, text: 'the red box', ...over })
    const sentNow = async (res: Response) => (await res.json()) as WriteOutcome

    // A picture alone, then a picture with words.
    expect(await sentNow(await s.form({ json: say(20, { text: '' }) }, [file('Screenshot.png', 'image/png', PNG)]))).toEqual({ result: 'done', status: 'sending' })
    expect(await sentNow(await s.form({ json: say(21, { through: 2 }) }, [file('IMG.png', 'image/png', PNG)]))).toEqual({ result: 'done', status: 'sending' })
    expect(s.inbox.sent.map((x) => ('text' in x ? x.text : ''))).toEqual(['', 'the red box'])
    expect(s.inbox.sent.every((x) => 'attachments' in x && x.attachments?.length === 1)).toBe(true)

    // A text file named like a picture, and two pictures: the inbox's refusals, in its words; nothing more is sent.
    expect(await sentNow(await s.form({ json: say(22, { through: 3 }) }, [file('cat.png', 'image/png', new TextEncoder().encode('<script>')) ]))).toMatchObject({ result: 'refused', reason: 'bad-request' })
    expect(await sentNow(await s.form({ json: say(23, { through: 3 }) }, [file('a.png', 'image/png', PNG), file('b.png', 'image/png', PNG)]))).toMatchObject({ result: 'refused' })
    expect(s.inbox.sent).toHaveLength(2)

    // Tessa's Gmail still takes no file.
    const gmailReply = JSON.stringify({ key: key(24), conversationId: 't-gmail', through: 1, text: 'hi' })
    expect(await sentNow(await s.form({ json: gmailReply }, [file('a.png', 'image/png', PNG)]))).toMatchObject({ result: 'refused', reason: 'bad-request' })
    expect(s.inbox.sent).toHaveLength(2)
  })

  test('is a request the page made itself: another site’s origin, no mark of the page, or JSON in its place is refused', async () => {
    const s = await asOwner()
    expect((await s.form({ json: reply(5) }, [file('a.txt', 'text/plain')], { origin: 'https://evil.example' })).status).toBe(403)
    const bare = await s.w.call('/api/email/files', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN }, body: (() => { const f = new FormData(); f.set('json', reply(5)); return f })() })
    expect(bare.status).toBe(415)
    const asJson = await s.w.call('/api/email/files', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-space-write': '1' }, body: reply(5) })
    expect(asJson.status).toBe(415)
    const huge = await s.w.call('/api/email/files', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN, 'x-space-write': '1', 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(40 * 1024 * 1024) }, body: '--x--' })
    expect(huge.status).toBe(413)
    expect(s.inbox.sent).toEqual([])
  })

  test('a get is not accepted at the path, and the JSON email path still refuses a form', async () => {
    const s = await asOwner()
    expect((await s.w.call('/api/email/files', { jwt: s.jwt })).status).toBe(404)
    const form = new FormData()
    form.set('json', reply(6))
    expect((await s.w.call('/api/email', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN }, body: form })).status).toBe(415)
  })
})

describe('what the page holds for a reply', () => {
  test('files are added to and taken out of a compose that can be written in, and a compose waiting for an answer keeps what it has', () => {
    const c = attached(newCompose(), [file('a.txt', 'text/plain'), file('b.txt', 'text/plain')])
    expect(filesOf(c).map((f) => f.name)).toEqual(['a.txt', 'b.txt'])
    expect(filesOf(detached(c, 0)).map((f) => f.name)).toEqual(['b.txt'])
    const sending = begin({ ...c, text: 'Hi' })
    expect(filesOf(attached(sending, [file('c.txt', 'text/plain')]))).toHaveLength(2)
    expect(filesOf(detached(sending, 0))).toHaveLength(2)
    expect(filesOf(newCompose())).toEqual([])
  })

  test('Send is held back by files the inbox would refuse, and the words say why', () => {
    const ok = { ...newCompose(), text: 'Hi' }
    expect(canSend(ok)).toBe(true)
    expect(canSend(attached(ok, [file('a.txt', 'text/plain')]))).toBe(true)
    const over = attached(ok, Array.from({ length: INBOX_MOST_FILES + 1 }, (_, n) => file(`f${n}`, 'text/plain')))
    expect(canSend(over)).toBe(false)
    expect(whyNotFiles(filesOf(over))).toContain(`at most ${INBOX_MOST_FILES}`)
    expect(whyNotFiles([file('z.txt', 'text/plain', 0)])).toBe('z.txt is empty.')
    expect(whyNotFiles([{ name: 'big', size: 16 * 1024 * 1024 }])).toContain('15 MB')
    expect(whyNotFiles([])).toBeNull()
  })

  test('a file is waited for longer than a list is, and the longer wait is the one a download gets', () => {
    expect(FILE_WITHIN_MS).toBeGreaterThan(ANSWER_WITHIN_MS)
  })

  test('sizes are said in words', () => {
    expect([sizeWords(500), sizeWords(2048), sizeWords(1024 * 1024 * 3.5)]).toEqual(['500 B', '2 KB', '3.5 MB'])
  })
})

describe('a video from Telegram', () => {
  const MP4 = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
  const clip = (type = 'video/mp4'): StandInThread =>
    thread('t-clip', ago(100), ['c-rosa'], {
      subject: 'Clip',
      mailbox: RIDGEWAY,
      messages: [{ id: 'c-1', at: ago(100), direction: 'in', from: RUN, text: '[Video]', files: [{ name: 'Video.mp4', type, bytes: MP4, video: true, seconds: 9 }] }],
    })

  test('is served inline as the video it is, in pieces when asked (Safari will not play one it is given whole), with the same inert headers', async () => {
    const s = await asOwner({ threads: [clip()] })
    const whole = await s.file('?m=c-1&n=0&how=view')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('content-disposition')).toStartWith('inline;')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff')
    expect(whole.headers.get('content-security-policy')).toContain("default-src 'none'")
    const piece = await s.file('?m=c-1&n=0&how=view', { headers: { range: 'bytes=4-7' } })
    expect(piece.status).toBe(206)
    expect(piece.headers.get('content-range')).toBe(`bytes 4-7/${MP4.length}`)
    expect(Array.from(new Uint8Array(await piece.arrayBuffer()))).toEqual(Array.from(MP4.slice(4, 8)))
    expect((await s.file('?m=c-1&n=0&how=view', { headers: { range: 'bytes=999-' } })).status).toBe(416)
  })

  test('a QuickTime movie and a WebM are served as the types they are; anything the inbox calls inline that is not a picture, a sound or one of these three videos is a download', async () => {
    for (const type of ['video/quicktime', 'video/webm']) {
      const s = await asOwner({ threads: [clip(type)] })
      expect((await s.file('?m=c-1&n=0&how=view')).headers.get('content-type')).toBe(type)
    }
    const s = await asOwner({ threads: [clip('text/html')] })
    const res = await s.file('?m=c-1&n=0&how=view')
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toStartWith('attachment;')
    expect(res.headers.get('accept-ranges')).toBeNull()
  })
  test('a video past the whole-file size is read a part at a time: a range gets one part (206), no range, several ranges and a save get the whole file, joined from its parts', async () => {
    // 20 MiB: over INBOX_FILE_WHOLE_BYTES (10 MiB), so the inbox hands it over in parts of INBOX_FILE_PART_BYTES (8 MiB). Every byte is its position's low byte, so a part from the wrong place shows.
    const total = 20 * 1024 * 1024
    const big = new Uint8Array(total)
    for (let i = 0; i < total; i++) big[i] = i % 251
    big.set(MP4.slice(0, 16), 0)
    const thread_ = thread('t-big', ago(100), ['c-rosa'], {
      subject: 'Big',
      mailbox: RIDGEWAY,
      messages: [{ id: 'b-1', at: ago(100), direction: 'in', from: RUN, text: '[Video]', files: [{ name: 'Video.mp4', type: 'video/mp4', bytes: big, video: true, seconds: 90 }] }],
    })
    const s = await asOwner({ threads: [thread_] })

    // `bytes=0-` asks for everything; a part is what comes, and a browser asks again from where it stopped.
    const open = await s.file('?m=b-1&n=0&how=view', { headers: { range: 'bytes=0-' } })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe(`bytes 0-${8 * 1024 * 1024 - 1}/${total}`)
    expect(open.headers.get('content-length')).toBe(String(8 * 1024 * 1024))
    const next = await s.file('?m=b-1&n=0&how=view', { headers: { range: `bytes=${8 * 1024 * 1024}-` } })
    expect(next.status).toBe(206)
    expect(next.headers.get('content-range')).toBe(`bytes ${8 * 1024 * 1024}-${16 * 1024 * 1024 - 1}/${total}`)
    const tail = await s.file('?m=b-1&n=0&how=view', { headers: { range: 'bytes=-5' } })
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe(`bytes ${total - 5}-${total - 1}/${total}`)
    expect(Array.from(new Uint8Array(await tail.arrayBuffer()))).toEqual(Array.from(big.slice(total - 5)))
    const between = await s.file('?m=b-1&n=0&how=view', { headers: { range: 'bytes=100-199' } })
    expect(between.status).toBe(206)
    expect(Array.from(new Uint8Array(await between.arrayBuffer()))).toEqual(Array.from(big.slice(100, 200)))
    const past = await s.file('?m=b-1&n=0&how=view', { headers: { range: `bytes=${total}-` } })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${total}`)

    // Without a range, with several, and for a save: the whole file, 200, in the length it is, joined from three parts.
    const reads = s.inbox.fileReads.length
    for (const request of [
      () => s.file('?m=b-1&n=0&how=view'),
      () => s.file('?m=b-1&n=0&how=view', { headers: { range: 'bytes=0-1,5-6' } }),
      () => s.file('?m=b-1&n=0&how=download', { headers: { range: 'bytes=0-1' } }),
    ]) {
      const res = await request()
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe(String(total))
      const body = new Uint8Array(await res.arrayBuffer())
      expect(body.length).toBe(total)
      expect(body.every((b, i) => b === big[i])).toBe(true)
    }
    // Each of the three took three parts (8 + 8 + 4 MiB): the first answer, then two more asked for from where the last stopped.
    const asked = s.inbox.fileReads.slice(reads).map((r) => r.range)
    const eight = { first: 8 * 1024 * 1024 }
    const sixteen = { first: 16 * 1024 * 1024 }
    expect(asked).toEqual([undefined, eight, sixteen, undefined, eight, sixteen, undefined, eight, sixteen])
  })

})

describe('a voice note from Telegram', () => {
  const OGG = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3, 4, 5])
  const voice = (): StandInThread =>
    thread('t-voice', ago(100), ['c-rosa'], {
      subject: 'Voice',
      mailbox: RIDGEWAY,
      messages: [{ id: 'v-1', at: ago(100), direction: 'in', from: RUN, text: '[Voice note]', files: [{ name: 'Voice note.ogg', type: 'audio/ogg', bytes: OGG, play: true, seconds: 4 }] }],
    })

  test('is served inline as Ogg audio with the same inert headers as a picture, and the whole file when no range is asked for', async () => {
    const s = await asOwner({ threads: [voice()] })
    const res = await s.file('?m=v-1&n=0&how=view')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/ogg')
    expect(res.headers.get('content-disposition')).toStartWith('inline;')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(OGG))
  })

  test('is answered in pieces when asked, as Safari asks: 206 with the range it was given, and 416 for one past the end', async () => {
    const s = await asOwner({ threads: [voice()] })
    const piece = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=2-5' } })
    expect(piece.status).toBe(206)
    expect(piece.headers.get('content-range')).toBe(`bytes 2-5/${OGG.length}`)
    expect(piece.headers.get('content-length')).toBe('4')
    expect(Array.from(new Uint8Array(await piece.arrayBuffer()))).toEqual(Array.from(OGG.slice(2, 6)))
    const first = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=0-1' } })
    expect(first.status).toBe(206)
    expect(first.headers.get('content-range')).toBe(`bytes 0-1/${OGG.length}`)
    const past = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=999-' } })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${OGG.length}`)
  })

  test('a range is honoured for a sound or a video only: a picture and a download are given whole', async () => {
    const s = await asOwner()
    const picture = await s.file('?m=m-in&n=0&how=view', { headers: { range: 'bytes=0-1' } })
    expect(picture.status).toBe(200)
    expect(picture.headers.get('accept-ranges')).toBeNull()
    const saved = await s.file('?m=m-in&n=1&how=download', { headers: { range: 'bytes=0-1' } })
    expect(saved.status).toBe(200)
  })

  test('the range header is read as bytes=a-b, a-, -n, and nothing else is a range (the shared parse and resolve, packages/workspace/test/files.test.ts, hold the table)', async () => {
    const s = await asOwner({ threads: [voice()] })
    const odd = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=1-2,4-5' } })
    expect(odd.status).toBe(200)
    expect(Array.from(new Uint8Array(await odd.arrayBuffer()))).toEqual(Array.from(OGG))
    expect((await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=-0' } })).status).toBe(416)
    expect((await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=5-2' } })).status).toBe(416)
    expect((await s.file('?m=v-1&n=0&how=view', { headers: { range: 'items=1-2' } })).status).toBe(200)
    const suffix = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=-3' } })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe(`bytes ${OGG.length - 3}-${OGG.length - 1}/${OGG.length}`)
    const open = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=2-' } })
    expect(open.headers.get('content-range')).toBe(`bytes 2-${OGG.length - 1}/${OGG.length}`)
    const long = await s.file('?m=v-1&n=0&how=view', { headers: { range: 'bytes=0-999' } })
    expect(long.headers.get('content-range')).toBe(`bytes 0-${OGG.length - 1}/${OGG.length}`)
  })

  test('the files an answer lists for it are the player’s: play and seconds are read, and a note is text', () => {
    const base = { more: false, threads: [], messages: [{ id: 'm', conversationId: 'c', subject: '', direction: 'in', at: 1, from: 'a', text: 't', textCut: false, alsoOn: [] }] }
    const withFile = (f: Record<string, unknown>) => ({ ...base, messages: [{ ...(base.messages[0] as object), attachments: [{ name: 'a', size: 1, type: '', picture: false, download: true, ...f }] }] })
    expect(isInboxHistory(withFile({ play: true, seconds: 4 }))).toBe(true)
    expect(isInboxHistory(withFile({ note: 'Too large to copy. Open it in Telegram.' }))).toBe(true)
    expect(isInboxHistory(withFile({ play: 'yes' }))).toBe(false)
    expect(isInboxHistory(withFile({ seconds: -1 }))).toBe(false)
    expect(isInboxHistory(withFile({ note: 5 }))).toBe(false)
  })
})

