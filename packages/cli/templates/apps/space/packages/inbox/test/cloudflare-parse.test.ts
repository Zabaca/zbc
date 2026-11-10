import { describe, expect, test } from 'bun:test'
import { formatAddress, messageIds, parseRaw } from '../src/cloudflare/parse'
import { parseAddressList } from '../src/gmail/parse'
import { rawMail } from '../test-support/raw-mail'

const parse = (name: string) => parseRaw(new TextEncoder().encode(rawMail(name)))

/**
 * Raw mail becoming the row the store keeps (src/cloudflare/parse.ts), through the parser the Ridgeway app runs on real
 * mail. The messages are hand-written to the shape of Gmail's (see test-support/raw-mail.ts), so these assert what is made
 * of them and not the bytes of one fixture.
 */
describe('a message from Cloudflare, parsed', () => {
  test('a plain message from a person: the headers as they read, the text, nothing else', async () => {
    const m = await parse('first')
    expect(m.messageId).toBe('<CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com>')
    expect(m.inReplyTo).toBeNull()
    expect(m.references).toEqual([])
    expect(m.from).toEqual({ name: 'Tessa Marlow', address: 'tessa@northfield.example' })
    expect(m.fromHeader).toBe('Tessa Marlow <tessa@northfield.example>')
    expect(m.toHeader).toBe('Ridgeway Test <test@ridgewaycycles.example>')
    expect(m.ccHeader).toBe('')
    expect(m.replyToHeader).toBe('')
    expect(m.subject).toBe('Hours question')
    expect(m.body).toContain('Do you do the $40 tune-up walk-in?')
    expect(m.body).not.toContain('<div')
    expect(m.bodyTruncated).toBe(false)
    expect(m.attachments).toEqual([])
    expect(m.senderDate).toBe('2026-10-26T18:02:05.000Z')
    expect(m.listUnsubscribe).toBe(false)
  })

  test('a reply carries what it answers, so threading can find it', async () => {
    const m = await parse('reply')
    expect(m.inReplyTo).toBe('<CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com>')
    expect(m.references).toEqual(['<CAF3b9xR1kq2c8Zw4pVhE5nT7yUo6Lr0aJdG9sXm1BvNc2Hq4Wg@mail.gmail.com>'])
    expect(m.subject).toBe('Re: Hours question')
  })

  test('HTML only is reduced to text, with the markup and the script gone, and attachments are a name, a size and a type', async () => {
    const m = await parse('html-and-attachment')
    expect(m.body).toContain('Here are my results.')
    expect(m.body).toContain('Line two & three.')
    expect(m.body).not.toMatch(/<|alert/)
    expect(m.attachments).toEqual([{ name: 'invoice.pdf', size: 48, mimeType: 'application/pdf' }])
    expect(m.subject).toBe('Results and café')
  })

  test('names with a comma are quoted so the header reads back as the same person, and Reply-To is kept', async () => {
    const m = await parse('html-and-attachment')
    expect(m.fromHeader).toBe('"Lane, Tessa" <tessa@northfield.example>')
    expect(m.replyToHeader).toBe('"Lane, Tessa" <reply@northfield.example>')
    expect(m.ccHeader).toBe('Someone Else <else@example.com>')
    // The Gmail half reads these headers back with parseAddressList: the two must agree.
    expect(parseAddressList(m.fromHeader)).toEqual([{ name: 'Lane, Tessa', address: 'tessa@northfield.example' }])
    expect(parseAddressList(m.replyToHeader)).toEqual([{ name: 'Lane, Tessa', address: 'reply@northfield.example' }])
  })

  test('an encoded name and subject are decoded, and a message with no Message-ID has none', async () => {
    const stranger = await parse('stranger-same-subject')
    expect(stranger.from).toEqual({ name: 'Priya Nair', address: 'priya.n@example.org' })
    const bulk = await parse('no-message-id')
    expect(bulk.messageId).toBeNull()
    expect(bulk.listUnsubscribe).toBe(true)
  })

  test('a body past the cap is cut and says so', async () => {
    const long = `From: a@example.com\r\nTo: info@ridgewaycycles.example\r\nSubject: long\r\n\r\n${'x'.repeat(150_000)}\r\n`
    const m = await parseRaw(new TextEncoder().encode(long))
    expect(m.body.length).toBe(100_000)
    expect(m.bodyTruncated).toBe(true)
  })

  test('mail is data: a subject with a line break in it is one plain line', async () => {
    const raw = 'From: a@example.com\r\nTo: info@ridgewaycycles.example\r\nSubject: one\r\n\ttwo\r\n\r\nbody\r\n'
    expect((await parseRaw(new TextEncoder().encode(raw))).subject).toBe('one two')
  })
})

describe('message ids and addresses', () => {
  test('every Message-ID in a header, bracketed, in order; nothing else', () => {
    expect(messageIds('<a@x.example.com> junk <b@y.example.org>\r\n <c@z.example.net>')).toEqual(['<a@x.example.com>', '<b@y.example.org>', '<c@z.example.net>'])
    expect(messageIds(undefined)).toEqual([])
    expect(messageIds('no ids here')).toEqual([])
  })

  test('an address is formatted as a header would write it, quoted where its name needs it', () => {
    expect(formatAddress({ name: '', address: 'a@x.example.com' })).toBe('a@x.example.com')
    expect(formatAddress({ name: 'Ann Lane', address: 'a@x.example.com' })).toBe('Ann Lane <a@x.example.com>')
    expect(formatAddress({ name: 'Lane, Ann', address: 'a@x.example.com' })).toBe('"Lane, Ann" <a@x.example.com>')
    expect(formatAddress({ name: 'Ann "AJ" Lane', address: 'a@x.example.com' })).toBe('"Ann \\"AJ\\" Lane" <a@x.example.com>')
  })
})
