import { describe, expect, test } from 'bun:test'
import { belongsInStore, inPlay } from '../src/gmail/types'
import { foldersByRole, labelsOf } from '../src/jmap/mapping'
import { parseJmapMessage, TOO_LARGE_BODY, UNREADABLE_BODY } from '../src/jmap/parse'
import type { JmapEmail } from '../src/jmap/types'

/** The mapping, row by row, and the parse of a message the server holds. */

const folders = foldersByRole([
  { id: 'a', name: 'Inbox', role: 'inbox' },
  { id: 'c', name: 'Junk Mail', role: 'junk' },
  { id: 'd', name: 'Drafts', role: 'drafts' },
  { id: 'e', name: 'Sent Items', role: 'sent' },
  { id: 'b', name: 'Deleted Items', role: 'trash' },
  { id: 'h', name: 'Archive', role: 'archive' },
  { id: 'x', name: 'Receipts', role: null },
])
const email = (mailboxes: string[], keywords: string[] = []): Pick<JmapEmail, 'mailboxIds' | 'keywords'> => ({
  mailboxIds: Object.fromEntries(mailboxes.map((m) => [m, true])),
  keywords: Object.fromEntries(keywords.map((k) => [k, true])),
})

describe('the mapping', () => {
  test('in the Inbox is open, and not marked seen is unread', () => {
    expect(labelsOf(email(['a']), folders)).toEqual(['INBOX', 'UNREAD'])
    expect(labelsOf(email(['a'], ['$seen']), folders)).toEqual(['INBOX'])
  })

  test('in Archive, or in any folder but the Inbox, is closed: no INBOX, and its read mark is its own', () => {
    expect(labelsOf(email(['h'], ['$seen']), folders)).toEqual([])
    expect(labelsOf(email(['h']), folders)).toEqual(['UNREAD'])
    expect(labelsOf(email(['x'], ['$seen']), folders)).toEqual([])
  })

  test('moved back to the Inbox is open again', () => {
    expect(labelsOf(email(['a'], ['$seen']), folders)).toContain('INBOX')
  })

  test('in Sent is a message the mailbox sent: SENT, never unread, never open', () => {
    expect(labelsOf(email(['e'], ['$seen']), folders)).toEqual(['SENT'])
    expect(labelsOf(email(['e']), folders)).toEqual(['SENT'])
  })

  test('in Trash is kept and counted for nothing; in Junk is not brought in; in Drafts is not brought in', () => {
    expect(labelsOf(email(['b']), folders)).toEqual(['TRASH', 'UNREAD'])
    expect(inPlay(labelsOf(email(['b']), folders))).toBe(false)
    expect(labelsOf(email(['c']), folders)).toContain('SPAM')
    expect(belongsInStore(labelsOf(email(['c']), folders), false)).toBe(false)
    expect(belongsInStore(labelsOf(email(['c']), folders), true)).toBe(false)
    expect(belongsInStore(labelsOf(email(['d'], ['$seen', '$draft']), folders), false)).toBe(false)
    expect(labelsOf(email(['a'], ['$draft']), folders)).toContain('DRAFT')
  })

  test('a message thrown away or filed as junk is never open, even if the server still lists it in the Inbox as well', () => {
    expect(labelsOf(email(['a', 'b']), folders)).not.toContain('INBOX')
    expect(labelsOf(email(['a', 'c']), folders)).not.toContain('INBOX')
  })

  test('flagged is kept with the message and decides nothing', () => {
    expect(labelsOf(email(['a'], ['$seen', '$flagged']), folders)).toEqual(['INBOX', 'STARRED'])
    const plain = labelsOf(email(['a'], ['$seen']), folders)
    const starred = labelsOf(email(['a'], ['$seen', '$flagged']), folders).filter((l) => l !== 'STARRED')
    expect(starred).toEqual(plain)
  })

  test('what belongs in the store is the Inbox or Sent, or a thread already held', () => {
    expect(belongsInStore(labelsOf(email(['a']), folders), false)).toBe(true)
    expect(belongsInStore(labelsOf(email(['e'], ['$seen']), folders), false)).toBe(true)
    expect(belongsInStore(labelsOf(email(['h'], ['$seen']), folders), false)).toBe(false)
    expect(belongsInStore(labelsOf(email(['h'], ['$seen']), folders), true)).toBe(true)
  })

  test('an account with no folder for a role maps what it has', () => {
    const bare = foldersByRole([{ id: 'a', name: 'Inbox', role: 'inbox' }])
    expect(labelsOf(email(['a']), bare)).toEqual(['INBOX', 'UNREAD'])
    expect(bare.archive).toBeNull()
  })
})

const meta = (over: Partial<JmapEmail> = {}): JmapEmail => ({
  id: 'e1',
  threadId: 't1',
  mailboxIds: { a: true },
  keywords: {},
  receivedAt: '2026-11-05T12:00:00Z',
  blobId: 'b1',
  size: 400,
  ...over,
})
const rawOf = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('parsing a message the server holds', () => {
  test('headers, text, people and ids come out as they do for a Cloudflare mailbox, with the server’s ids and its time', async () => {
    const raw = rawOf(
      'From: Dana Smith <dana@example.com>\r\nTo: Test <test@harborline.example>\r\nCc: ann@example.com\r\nSubject: =?UTF-8?B?Q2Fmw6k=?=\r\nDate: Wed, 05 Nov 2026 11:59:00 +0000\r\nMessage-ID: <abc@example.com>\r\nIn-Reply-To: <prev@harborline.example>\r\nList-Unsubscribe: <mailto:x@y.z>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello there.\r\n',
    )
    const m = await parseJmapMessage(meta(), raw, ['INBOX', 'UNREAD'])
    expect(m).toMatchObject({
      gmailId: 'e1',
      threadId: 't1',
      rfcMessageId: '<abc@example.com>',
      inReplyTo: '<prev@harborline.example>',
      from: { name: 'Dana Smith', address: 'dana@example.com' },
      subject: 'Café',
      body: 'Hello there.',
      snippet: 'Hello there.',
      labels: ['INBOX', 'UNREAD'],
      receivedAt: '2026-11-05T12:00:00.000Z',
      senderDate: '2026-11-05T11:59:00.000Z',
      listUnsubscribe: true,
    })
    expect(m.to.map((p) => p.address)).toEqual(['test@harborline.example'])
    expect(m.cc.map((p) => p.address)).toEqual(['ann@example.com'])
    expect(m.fromHeader).toBe('Dana Smith <dana@example.com>')
  })

  test('HTML only is reduced to text and the markup is gone', async () => {
    const raw = rawOf(
      'From: a@example.com\r\nTo: test@harborline.example\r\nSubject: s\r\nContent-Type: text/html\r\n\r\n<p>Hi <b>there</b></p><script>alert(1)</script>\r\n',
    )
    const m = await parseJmapMessage(meta(), raw, [])
    expect(m.body).toBe('Hi there')
    expect(m.body).not.toContain('<')
  })

  test('a file is a name, a size and a type, and no byte of it is kept', async () => {
    const raw = rawOf(
      'From: a@example.com\r\nTo: test@harborline.example\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nsee file\r\n--B\r\nContent-Type: application/pdf; name="r.pdf"\r\nContent-Disposition: attachment; filename="r.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--B--\r\n',
    )
    const m = await parseJmapMessage(meta(), raw, [])
    expect(m.attachments).toEqual([{ name: 'r.pdf', size: 5, mimeType: 'application/pdf' }])
    expect(m.body).toBe('see file')
  })

  test('a message too large to read is stored from what the server says of it, with a plain line that says so', async () => {
    const m = await parseJmapMessage(
      meta({
        size: 30_000_000,
        structure: {
          from: [{ name: 'Dana', email: 'dana@example.com' }],
          to: [{ name: null, email: 'test@harborline.example' }],
          cc: null,
          replyTo: null,
          subject: 'Big file',
          sentAt: '2026-11-05T11:00:00Z',
          preview: 'the preview',
          messageId: ['big@example.com'],
          inReplyTo: null,
        },
      }),
      null,
      ['INBOX'],
    )
    expect(m).toMatchObject({
      rfcMessageId: '<big@example.com>',
      subject: 'Big file',
      body: TOO_LARGE_BODY,
      snippet: 'the preview',
      from: { name: 'Dana', address: 'dana@example.com' },
    })
    expect(m.toHeader).toBe('test@harborline.example')
  })

  test('a message the parser cannot read is stored from the server’s account of it and never throws', async () => {
    const m = await parseJmapMessage(
      meta({
        structure: {
          from: [{ name: null, email: 'a@example.com' }],
          to: null,
          cc: null,
          replyTo: null,
          subject: 'odd',
          sentAt: null,
          preview: '',
          messageId: null,
          inReplyTo: null,
        },
      }),
      new Proxy(new Uint8Array(1), {
        get: () => {
          throw new Error('boom')
        },
      }),
      [],
    )
    expect(m.body).toBe(UNREADABLE_BODY)
    expect(m.subject).toBe('odd')
  })
})
