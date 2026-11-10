import { describe, expect, test } from 'bun:test'
import {
  attachmentsOf,
  BODY_CAP,
  base64Bytes,
  bodyOf,
  decodeWords,
  htmlToText,
  parseAddressList,
  parseMessage,
  UNREADABLE_BODY,
} from '../src/gmail/parse'
import type { GmailMessage, GmailPart } from '../src/gmail/types'
import { MAX_PREVIEW_BYTES } from '../src/image'
import multipart from './fixtures/gmail/message-multipart.json'
import newsletter from './fixtures/gmail/message-newsletter.json'
import plain from './fixtures/gmail/message-plain.json'
import sent from './fixtures/gmail/message-sent.json'

/**
 * The Gmail module as pure functions: a message as the API returns it becoming
 * the row the store keeps. An earlier Gmail-reading script's cases (plain over html,
 * html reduced to text, attachments listed by name and size) are carried over.
 *
 * ⚠️ THE FIXTURES ARE PLACEHOLDERS. Every file in test/fixtures/gmail is shaped
 * from Google's documented API and marked `_fixture: PLACEHOLDER`, because this was
 * written without access to the mailbox. The option's rule is trimmed REAL
 * responses; replace each one after Gmail is connected (the runbook's "After
 * connecting" lists them), and tighten any expectation below that the real shape
 * disproves. Until then a green here proves the parser matches the documentation
 * and nothing more.
 */

const b64 = (text: string) => Buffer.from(text).toString('base64url')
const asMessage = (fixture: unknown) => fixture as unknown as GmailMessage

describe('the fixtures say what they are', () => {
  test.each([
    ['message-plain', plain],
    ['message-multipart', multipart],
    ['message-newsletter', newsletter],
    ['message-sent', sent],
  ])('%s is marked as a placeholder', (_name, fixture) => {
    expect((fixture as { _fixture: string })._fixture).toStartWith('PLACEHOLDER')
  })
})

describe('a message becoming a row', () => {
  test('a plain inbound message: people, subject, text, labels and Gmail’s own time', () => {
    const m = parseMessage(asMessage(plain))
    expect(m).toMatchObject({
      gmailId: '19a1f0c2b7d4e801',
      threadId: '19a1f0c2b7d4e801',
      rfcMessageId: '<CAKd3x7w1@mail.example.com>',
      inReplyTo: null,
      subject: 'Revised quote for the site',
      snippet: 'Hi Tessa, can you send the revised quote for the site? Thanks, Dana',
      bodyTruncated: false,
      labels: ['UNREAD', 'CATEGORY_PERSONAL', 'INBOX'],
      receivedAt: '2026-10-20T12:00:00.000Z',
      listUnsubscribe: false,
      attachments: [],
    })
    expect(m.from).toEqual({ name: 'Smith, Dana', address: 'dana@example.com' })
    expect(m.to).toEqual([{ name: 'Tessa Marlow', address: 'tessa@northfield.example' }])
    expect(m.body).toBe('Hi Tessa,\n\ncan you send the revised quote for the site?\n\nThanks,\nDana')
    expect(m.senderDate).toBe('2026-10-20T12:00:00.000Z')
  })

  test('a multipart message: text wins over html, the attachment is a name, a size and the declared type, encoded words are decoded', () => {
    const m = parseMessage(asMessage(multipart))
    expect(m.body).toBe('Quote attached. Café meeting works for us.')
    expect(m.attachments).toEqual([{ name: 'Quote 2026-10.pdf', size: 40213, mimeType: 'application/pdf' }])
    expect(m.subject).toBe('Re: Revised quote for the site – café')
    expect(m.from).toEqual({ name: 'Dana Smith \u{1F642}', address: 'dana@example.com' })
    expect(m.to).toEqual([
      { name: 'Tessa Marlow', address: 'tessa@northfield.example' },
      { name: 'Ortiz, Ramon', address: 'ramon@example.org' },
    ])
    expect(m.cc).toEqual([{ name: 'Priya', address: 'priya@example.net' }])
    expect(m.inReplyTo).toBe('<CAKd3x7w1@mail.example.com>')
    expect(m.toHeader).toBe('Tessa Marlow <tessa@northfield.example>, "Ortiz, Ramon" <ramon@example.org>')
  })

  test('a newsletter: html reduced to text with script and style gone, and the List-Unsubscribe fact kept', () => {
    const m = parseMessage(asMessage(newsletter))
    expect(m.body).toBe('This week:\nThree ways to cut your hosting bill & more.')
    expect(m.body).not.toContain('alert')
    expect(m.body).not.toContain('<')
    expect(m.listUnsubscribe).toBe(true)
    expect(m.labels).toContain('CATEGORY_PROMOTIONS')
  })

  test('a sent message keeps its SENT label and its recipient', () => {
    const m = parseMessage(asMessage(sent))
    expect(m.labels).toEqual(['SENT'])
    expect(m.to).toEqual([{ name: 'Dana Smith', address: 'dana@example.com' }])
    expect(m.inReplyTo).toBe('<CAKd3x7w2@mail.example.com>')
  })

  test('the Reply-To is kept as written, decoded, and is empty (not unknown) when there is none', () => {
    expect(parseMessage(asMessage(plain)).replyToHeader).toBe('')
    const withReplyTo = {
      id: 'x',
      threadId: 'y',
      payload: { headers: [{ name: 'reply-to', value: '=?UTF-8?B?WmXDqw==?= <zoe@example.org>' }] },
    }
    expect(parseMessage(withReplyTo).replyToHeader).toBe('Zeë <zoe@example.org>')
  })

  test('a message with no payload or headers still parses, as empty', () => {
    const m = parseMessage({ id: 'x', threadId: 'y' })
    expect(m).toMatchObject({
      subject: '',
      body: '',
      from: null,
      to: [],
      labels: [],
      receivedAt: null,
      senderDate: null,
    })
  })

  test('a body that cannot be decoded is stored with a marker, and the rest of the message still parses', () => {
    const message: GmailMessage = {
      id: 'broken',
      threadId: 't',
      labelIds: ['INBOX'],
      snippet: 'A snippet',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Dana <dana@example.com>' },
          { name: 'Subject', value: 'Still readable' },
        ],
        body: { data: '!!! not base64 !!!' },
      },
    }
    const m = parseMessage(message)
    expect(m.body).toBe(UNREADABLE_BODY)
    expect(m).toMatchObject({ subject: 'Still readable', labels: ['INBOX'], snippet: 'A snippet' })
    expect(m.from?.address).toBe('dana@example.com')
  })

  test('a body past the cap is cut, says so, and never splits a surrogate pair', () => {
    const body = `${'a'.repeat(9)}\u{1F642}${'b'.repeat(50)}`
    const message: GmailMessage = {
      id: 'x',
      threadId: 'y',
      payload: { mimeType: 'text/plain', body: { data: b64(body) } },
    }
    const m = parseMessage(message, 10)
    expect(m.bodyTruncated).toBe(true)
    expect(m.body).toBe('a'.repeat(9))
    expect(parseMessage(message).bodyTruncated).toBe(false)
    expect(BODY_CAP).toBe(100_000)
  })
})

describe('the body', () => {
  const text = (data: string, charset = 'UTF-8'): GmailPart => ({
    mimeType: 'text/plain',
    headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }],
    body: { data },
  })

  test('text/plain wins over text/html, wherever it is nested', () => {
    const part: GmailPart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<b>html</b>') } },
        { mimeType: 'multipart/related', parts: [text(b64('plain'))] },
      ],
    }
    expect(bodyOf(part)).toBe('plain')
  })

  test('a part with a filename is an attachment, never the body', () => {
    const part: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attached text'), size: 13 } }],
    }
    expect(bodyOf(part)).toBe('')
    expect(attachmentsOf(part)).toEqual([{ name: 'notes.txt', size: 13, mimeType: 'text/plain' }])
  })

  test('a charset other than UTF-8 is decoded as that charset', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url')
    expect(bodyOf(text(latin1, 'ISO-8859-1'))).toBe('café')
  })

  test('a charset the runtime does not know falls back to UTF-8 instead of throwing', () => {
    expect(bodyOf(text(b64('plain'), 'x-made-up'))).toBe('plain')
  })

  test('html entities, named and numeric, are decoded once and not twice', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &#8217;s &#x41; &amp;lt;</p>')).toBe('Tom & Jerry ’s A &lt;')
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc')
  })

  test('mail that is nothing but an image has an empty body', () => {
    expect(bodyOf({ mimeType: 'image/png', body: { attachmentId: 'a', size: 10 } })).toBe('')
  })
})

describe('base64 to bytes', () => {
  test('every byte value comes back, from base64url with or without padding and from plain base64', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    const standard = Buffer.from(all).toString('base64')
    expect([...base64Bytes(standard)]).toEqual([...all])
    expect([...base64Bytes(Buffer.from(all).toString('base64url'))]).toEqual([...all])
    expect([...base64Bytes(standard.replace(/=+$/, ''))]).toEqual([...all])
    expect(base64Bytes('')).toHaveLength(0)
  })

  test('a picture at the size limit decodes to the same bytes (the decoder holds one array, not a list per byte)', () => {
    const big = new Uint8Array(MAX_PREVIEW_BYTES)
    for (let i = 0; i < big.length; i += 4093) big[i] = i % 251
    const bytes = base64Bytes(Buffer.from(big).toString('base64url'))
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes).equals(Buffer.from(big))).toBe(true)
  })
})

describe('headers', () => {
  test.each([
    ['=?UTF-8?B?Q2Fmw6k=?=', 'Café'],
    ['=?UTF-8?Q?Caf=C3=A9_au_lait?=', 'Café au lait'],
    ['=?ISO-8859-1?Q?caf=E9?=', 'café'],
    ['=?UTF-8?B?SGVsbG8g?= =?UTF-8?B?V29ybGQ=?=', 'Hello World'],
    ['Plain subject', 'Plain subject'],
    ['=?x-unknown-charset?B?SGk=?=', '=?x-unknown-charset?B?SGk=?='],
  ])('decodeWords(%s)', (input, expected) => {
    expect(decodeWords(input)).toBe(expected)
  })

  test.each([
    ['Dana <dana@example.com>', [{ name: 'Dana', address: 'dana@example.com' }]],
    [
      '"Smith, Dana" <dana@example.com>, bob@example.org',
      [
        { name: 'Smith, Dana', address: 'dana@example.com' },
        { name: '', address: 'bob@example.org' },
      ],
    ],
    ['bob@example.org (Bob B)', [{ name: 'Bob B', address: 'bob@example.org' }]],
    ['"Quote \\"Q\\"" <q@example.com>', [{ name: 'Quote "Q"', address: 'q@example.com' }]],
    ['undisclosed-recipients:;', []],
    [
      'Team: a@example.com, b@example.com;',
      [
        { name: '', address: 'a@example.com' },
        { name: '', address: 'b@example.com' },
      ],
    ],
    ['', []],
    ['not an address', []],
  ])('parseAddressList(%s)', (input, expected) => {
    expect(parseAddressList(input)).toEqual(expected)
  })
})
