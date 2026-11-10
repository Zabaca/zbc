// Mail that declares a Latin charset and is UTF-8: "can’t" must not become "canâ€™t".
import { describe, expect, test } from 'bun:test'
import { decodeBody, repairMojibake } from '../src/charset'
import { parseRaw } from '../src/cloudflare/parse'
import { bodyOf } from '../src/gmail/parse'

const utf8 = (s: string) => new TextEncoder().encode(s)
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

describe('decodeBody', () => {
  test('UTF-8 bytes under a us-ascii, iso-8859-1 or windows-1252 label are read as UTF-8', () => {
    for (const label of ['us-ascii', 'ISO-8859-1', '"windows-1252"', 'latin1']) {
      expect([label, decodeBody(utf8('I can’t, café'), label)]).toEqual([label, 'I can’t, café'])
    }
  })
  test('real Latin-1 bytes under that label stay Latin-1, and other charsets are honoured', () => {
    expect(decodeBody(Uint8Array.of(0x63, 0x61, 0x66, 0xe9), 'iso-8859-1')).toBe('café')
    expect(decodeBody(Uint8Array.of(0x93, 0x94), 'windows-1252')).toBe('“”')
    expect(decodeBody(Uint8Array.of(0x82, 0xa0), 'shift_jis')).toBe('あ')
    expect(decodeBody(utf8('é'), 'x-unknown-label')).toBe('é')
  })
})

describe('repairMojibake', () => {
  test('puts back UTF-8 that was read as windows-1252, and touches nothing else', () => {
    expect(repairMojibake('I canâ€™t go, cafÃ© â€œopenâ€\u009d')).toBe('I can’t go, café “open”')
    expect(repairMojibake('plain ascii')).toBe('plain ascii')
    expect(repairMojibake('café, naïve')).toBe('café, naïve')
    expect(repairMojibake('He said “hi” and it’s fine')).toBe('He said “hi” and it’s fine')
    expect(repairMojibake('日本語 canâ€™t')).toBe('日本語 canâ€™t')
  })
})

describe('the two parsers', () => {
  test('a Gmail part declared us-ascii that holds UTF-8', () => {
    const part = {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset="us-ascii"' }],
      body: { data: b64url(utf8('I can’t make it')) },
    }
    expect(bodyOf(part as never)).toBe('I can’t make it')
  })
  test('a Cloudflare arrival declared us-ascii that holds quoted-printable UTF-8', async () => {
    const raw = [
      'From: a@x.example',
      'To: b@y.example',
      'Subject: hi',
      'Message-ID: <1@x>',
      'Content-Type: text/plain; charset=us-ascii',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'I can=E2=80=99t make it',
    ].join('\r\n')
    expect((await parseRaw(utf8(raw))).body).toBe('I can’t make it')
  })
})
