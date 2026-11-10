import { describe, expect, test } from 'bun:test'
import { buildMime, encodeWords, isBareAddress, MimeError, toRaw } from '../src/gmail/mime'

/**
 * The MIME builder, ported from an earlier draft-making script with that
 * script's test cases (the three at the top of each block are its) and the cases
 * its changes need. Pure functions: what leaves the inbox is a table test.
 */

const base = {
  from: { name: 'Tessa Marlow', address: 'tessa@northfield.example' },
  to: 'abel@abelcpa.example',
  cc: [] as string[],
  subject: 'Hi',
  body: 'x',
  messageId: '<abc123@northfield.example>',
  inReplyTo: null as string | null,
  date: new Date('2026-10-20T12:34:56.000Z'),
}

/** A message split the way a mail server would: its headers (unfolded), and its decoded text body. */
function read(mime: string) {
  const split = mime.indexOf('\r\n\r\n')
  const headers: Record<string, string> = {}
  for (const line of mime
    .slice(0, split)
    .replace(/\r\n([ \t])/g, '$1')
    .split('\r\n')) {
    headers[line.slice(0, line.indexOf(':'))] = line.slice(line.indexOf(':') + 1).trim()
  }
  const body = new TextDecoder().decode(
    Uint8Array.from(atob(mime.slice(split + 4).replace(/\s+/g, '')), (c) => c.charCodeAt(0)),
  )
  return { headers, body, raw: mime }
}

describe('the header guard', () => {
  test('a header with a line break, or a bad address, is refused', () => {
    expect(() => buildMime({ ...base, subject: 'Hi\r\nBcc: evil@evil.example.com' })).toThrow(MimeError)
    expect(() => buildMime({ ...base, subject: 'Hi\nBcc: evil@evil.example.com' })).toThrow(MimeError)
    expect(() => buildMime({ ...base, to: 'abel@abelcpa.example\nBcc: evil@evil.example.com' })).toThrow(MimeError)
    expect(() => buildMime({ ...base, cc: ['Evil <evil@evil.example.com>'] })).toThrow(MimeError)
    expect(() =>
      buildMime({ ...base, from: { name: 'J\r\nBcc: x@y.example.com', address: 'tessa@northfield.example' } }),
    ).toThrow(MimeError)
    expect(() => buildMime({ ...base, subject: 'a\u0000b' })).toThrow(MimeError)
  })

  test('an address is bare printable ASCII: no name, no list, no quotes, no second recipient in one slot', () => {
    for (const bad of [
      'a@b',
      'a@b.example.com, c@d.example.com',
      'a@b.example.com;c@d.example.com',
      '"a"@b.example.com',
      '<a@b.example.com>',
      'A <a@b.example.com>',
      'a b@c.example.com',
      'a@c.example.com ',
      'a@exämple.test',
      'jö@example.com',
      '',
    ]) {
      expect(isBareAddress(bad), bad).toBe(false)
      expect(() => buildMime({ ...base, to: bad }), bad).toThrow(MimeError)
    }
    expect(isBareAddress('first.last+tag@sub.example.org')).toBe(true)
  })

  test('a Message-ID is refused unless it is one, on the message and on the one it answers', () => {
    expect(() => buildMime({ ...base, inReplyTo: 'abc@abelcpa.example' })).toThrow(MimeError)
    expect(() => buildMime({ ...base, inReplyTo: '<a@b>\r\nBcc: evil@evil.example.com' })).toThrow(MimeError)
    expect(() => buildMime({ ...base, messageId: 'abc@northfield.example' })).toThrow(MimeError)
  })

  test('there is no way to say Bcc: no input produces one', () => {
    const m = read(buildMime({ ...base, cc: ['info@abelcpa.example'], inReplyTo: '<p@x.example.com>', subject: 'Taxes, 2025' }))
    expect(Object.keys(m.headers).map((k) => k.toLowerCase())).not.toContain('bcc')
    expect(m.raw).not.toMatch(/^Bcc:/im)
  })
})

describe('the message', () => {
  test('carries the recipients, the subject and the body, as plain UTF-8 text', () => {
    const m = read(buildMime({ ...base, cc: ['info@abelcpa.example', 'b@example.com'], subject: 'Taxes, 2025' }))
    expect(m.headers).toMatchObject({
      From: 'Tessa Marlow <tessa@northfield.example>',
      To: 'abel@abelcpa.example',
      Cc: 'info@abelcpa.example, b@example.com',
      Subject: 'Taxes, 2025',
      'Message-ID': '<abc123@northfield.example>',
      'MIME-Version': '1.0',
      'Content-Type': 'text/plain; charset=UTF-8',
      'Content-Transfer-Encoding': 'base64',
    })
    expect(m.body).toBe('x')
    // No multipart and no attachment machinery: this build sends plain text only.
    expect(m.raw).not.toMatch(/multipart|attachment|boundary/i)
  })

  test('a reply carries In-Reply-To and References, and a new email carries neither', () => {
    const r = read(buildMime({ ...base, subject: 'RE: Hi', inReplyTo: '<abc.123@abelcpa.example>' }))
    expect(r.headers['In-Reply-To']).toBe('<abc.123@abelcpa.example>')
    expect(r.headers.References).toBe('<abc.123@abelcpa.example>')
    const fresh = read(buildMime(base))
    expect(Object.keys(fresh.headers)).not.toContain('In-Reply-To')
    expect(Object.keys(fresh.headers)).not.toContain('References')
  })

  test('the body keeps its words, its accents and its emoji, and its lines end CRLF on the wire', () => {
    const body = 'Héllo Zoë,\n\nCafé at 3? 👍\r\nSee you.\r'
    const m = read(buildMime({ ...base, body }))
    expect(m.body).toBe('Héllo Zoë,\r\n\r\nCafé at 3? 👍\r\nSee you.\r\n')
    // Every line of the encoded body is within a line's limit.
    for (const line of m.raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
  })

  test('a long body is wrapped at 76 characters, not sent as one line', () => {
    const m = buildMime({ ...base, body: 'word '.repeat(4000) })
    expect(Math.max(...m.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(76)
    expect(read(m).body).toBe(`${'word '.repeat(4000)}`)
  })
})

describe('the Date header', () => {
  test('is the moment given, in UTC with a numeric zone, so the header and the stored copy agree', () => {
    expect(read(buildMime(base)).headers.Date).toBe('Tue, 20 Oct 2026 12:34:56 +0000')
    expect(read(buildMime({ ...base, date: new Date('2026-01-02T03:04:05.000Z') })).headers.Date).toBe(
      'Fri, 02 Jan 2026 03:04:05 +0000',
    )
  })
})

describe('a subject that is not plain ASCII', () => {
  test('is sent as encoded words that decode to it', () => {
    const subject = 'Quote for Zoë’s café 👍'
    const wire = buildMime({ ...base, subject }).split('\r\n\r\n')[0] ?? ''
    expect(wire).toContain('=?UTF-8?B?')
    expect(wire).not.toContain('café')
    const line = (
      wire
        .replace(/\r\n([ \t])/g, '$1')
        .split('\r\n')
        .find((l) => l.startsWith('Subject:')) ?? ''
    ).slice(9)
    const words = [...line.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((w) =>
      new TextDecoder().decode(Uint8Array.from(atob(w[1] ?? ''), (c) => c.charCodeAt(0))),
    )
    expect(words.join('')).toBe(subject)
  })

  test('a long one is split into words that each fit a header line, never inside a character', () => {
    const subject = 'Renseignements sur le devis pour 🏠 la rénovation de la cuisine et de la salle de bain à Springfield'
    const encoded = encodeWords(subject)
    const words = encoded.split('\r\n ')
    expect(words.length).toBeGreaterThan(1)
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75)
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    }
    const decoded = words
      .map((w) =>
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)),
        ),
      )
      .join('')
    expect(decoded).toBe(subject)
  })

  test('plain ASCII is left alone', () => {
    expect(encodeWords('Re: Quote, 2025 (final)')).toBe('Re: Quote, 2025 (final)')
  })

  test('an ASCII subject that already holds an encoded-word marker is encoded, so it cannot be read as one', () => {
    const subject = 'Re: =?UTF-8?B?SGVsbG8=?= quote'
    const wire = buildMime({ ...base, subject })
    expect(wire).not.toContain('=?UTF-8?B?SGVsbG8=?= quote')
    expect((read(wire).headers.Subject ?? '').startsWith('=?UTF-8?B?')).toBe(true)
    const words = [...(read(wire).headers.Subject ?? '').matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((w) =>
      new TextDecoder().decode(Uint8Array.from(atob(w[1] ?? ''), (c) => c.charCodeAt(0))),
    )
    expect(words.join('')).toBe(subject)
  })

  test('an ASCII subject too long for one line is folded into words that fit one, and reads back whole', () => {
    const subject = `Re: ${'a long and wordy subject about the kitchen '.repeat(4)}end`
    const wire = buildMime({ ...base, subject })
    const head = wire.split('\r\n\r\n')[0] ?? ''
    for (const line of head.split('\r\n')) expect(line.length, line).toBeLessThanOrEqual(78)
    const words = [...(read(wire).headers.Subject ?? '').matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((w) =>
      new TextDecoder().decode(Uint8Array.from(atob(w[1] ?? ''), (c) => c.charCodeAt(0))),
    )
    expect(words.join('')).toBe(subject)
  })
})

describe('the raw form Gmail takes', () => {
  test('is the message, base64url, with no padding and none of +, / or =', () => {
    const mime = buildMime({ ...base, subject: '>>>???', body: '~~~~ ÿÿÿ' })
    const raw = toRaw(mime)
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    const standard = raw.replace(/-/g, '+').replace(/_/g, '/')
    const back = new TextDecoder().decode(
      Uint8Array.from(atob(standard + '='.repeat((4 - (standard.length % 4)) % 4)), (c) => c.charCodeAt(0)),
    )
    expect(back).toBe(mime)
  })
})
