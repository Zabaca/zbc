import { describe, expect, test } from 'bun:test'
import { MAX_PREVIEW_BYTES, type PreviewType, sniffImage, wantsPreview } from '../src/image'

/**
 * Which files are pictures, by their first bytes, and which attachments the page asks to preview. The bytes below are
 * the signatures (the first bytes every such file starts with), not whole images.
 */

const bytes = (...b: number[]) => Uint8Array.from(b)
const text = (s: string) => new TextEncoder().encode(s)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46)
const GIF89 = text('GIF89a\x01\x00\x01\x00')
const GIF87 = text('GIF87a\x01\x00\x01\x00')
const WEBP = Uint8Array.from([...text('RIFF'), 0x24, 0, 0, 0, ...text('WEBPVP8 ')])

describe('sniffImage: the bytes decide, and only four kinds are pictures', () => {
  const cases: [string, Uint8Array, PreviewType | null][] = [
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF89a', GIF89, 'image/gif'],
    ['GIF87a', GIF87, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
    ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null],
    ['SVG with an XML prolog', text('<?xml version="1.0"?><svg/>'), null],
    ['HTML', text('<!doctype html><script>alert(1)</script>'), null],
    ['a PDF', text('%PDF-1.7'), null],
    ['a WAV (RIFF, not WebP)', Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WAVEfmt ')]), null],
    ['a PNG cut inside its signature', PNG.slice(0, 6), null],
    ['a BMP', text('BM\x00\x00'), null],
    ['an ICO', bytes(0, 0, 1, 0, 1, 0), null],
    ['nothing', new Uint8Array(), null],
  ]
  for (const [name, input, expected] of cases) {
    test(name, () => expect(sniffImage(input)).toBe(expected))
  }

  test('text that begins like a picture is not one', () => {
    expect(sniffImage(text('GIF is a format'))).toBeNull()
    expect(sniffImage(text('PNG file'))).toBeNull()
  })
})

describe('wantsPreview: a hint from what the sender declared, never a yes to anything but the four kinds', () => {
  const ask = (name: string, mimeType?: string, size = 1000) => wantsPreview({ name, size, mimeType })
  test('the four declared types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(ask('x', t)).toBe(true)
    expect(ask('x', 'IMAGE/PNG; name="x.png"')).toBe(true)
  })
  test('never SVG or any other type, whatever the name says', () => {
    expect(ask('logo.svg', 'image/svg+xml')).toBe(false)
    expect(ask('logo.png', 'image/svg+xml')).toBe(false)
    expect(ask('scan.png', 'application/pdf')).toBe(false)
    expect(ask('page.png', 'text/html')).toBe(false)
    expect(ask('icon.ico', 'image/x-icon')).toBe(false)
    expect(ask('photo.bmp', 'image/bmp')).toBe(false)
    expect(ask('photo.heic', 'image/heic')).toBe(false)
  })
  test('with no type, or the generic one, the extension is the hint', () => {
    expect(ask('photo.JPG')).toBe(true)
    expect(ask('photo.jpeg', 'application/octet-stream')).toBe(true)
    expect(ask('shot.webp', '')).toBe(true)
    expect(ask('logo.svg')).toBe(false)
    expect(ask('notes.txt')).toBe(false)
    expect(ask('png')).toBe(false)
    expect(ask('photo.png.exe')).toBe(false)
  })
  test('a picture over the size limit stays a chip', () => {
    expect(ask('big.png', 'image/png', MAX_PREVIEW_BYTES)).toBe(true)
    expect(ask('big.png', 'image/png', MAX_PREVIEW_BYTES + 1)).toBe(false)
  })
})
