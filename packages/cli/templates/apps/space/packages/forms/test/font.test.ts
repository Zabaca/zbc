// The document's font: which file it is (pinned by hash, version and licence), that what the browser is told it can draw is what the
// font can draw, and that a document carries only the glyphs it uses. Pure; no app.
import { PDF } from '@libpdf/core'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { sha256Hex } from '../src/bytes'
import { COVERED } from '../src/pdf/coverage'
import { BOLD_BASE64, FONT, REGULAR_BASE64 } from '../src/pdf/font-data'
import { finish } from '../src/pdf/engine'
import { layoutForm } from '../src/pdf/formpages'
import { canDraw, canDrawChar, drawable, whyNotDrawable } from '../src/pdf/glyphs'
import { fixtureBytes } from '../scripts/fixtures'
import { isWinAnsi } from '../src/pdf/engine'
import { hasPoppler } from './render'
import { NORTHFIELD_WORDS } from './words'
import { testSealer } from './seal-fixture'

const file = (name: string) => new Uint8Array(readFileSync(new URL(`../src/pdf/fonts/${name}`, import.meta.url)))
const regular = file('NotoSans-Regular.subset.ttf')
const bold = file('NotoSans-Bold.subset.ttf')

describe('the font file, pinned', () => {
  test('is Noto Sans 2.015 under the SIL Open Font License 1.1, and the files are the ones recorded', async () => {
    expect(FONT).toMatchObject({ family: 'Noto Sans', version: '2.015', license: 'SIL Open Font License 1.1', licenseFile: 'src/pdf/fonts/OFL.txt' })
    expect(await sha256Hex(regular)).toBe(FONT.sha256.regular)
    expect(await sha256Hex(bold)).toBe(FONT.sha256.bold)
    const licence = new TextDecoder().decode(file('OFL.txt'))
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(licence).toContain('Noto Project Authors')
    // The file's own name table says the same version (UTF-16BE: "Version 2.015").
    const utf16 = (s: string) => Buffer.from([...s].flatMap((c) => [0, c.charCodeAt(0)]))
    expect(Buffer.from(regular).includes(utf16('Version 2.015'))).toBe(true)
    expect(Buffer.from(bold).includes(utf16('Version 2.015'))).toBe(true)
  })

  test('is what the app imports: the generated modules are the files, not an older copy', () => {
    expect(Buffer.from(REGULAR_BASE64, 'base64').equals(Buffer.from(regular))).toBe(true)
    expect(Buffer.from(BOLD_BASE64, 'base64').equals(Buffer.from(bold))).toBe(true)
  })

  test('stays a subset: the two files together are far below the full font, so the Worker bundle stays small', () => {
    expect(regular.length + bold.length).toBeLessThan(260 * 1024)
    expect(REGULAR_BASE64.length + BOLD_BASE64.length).toBeLessThan(360 * 1024)
  })
})

describe('what can be drawn', () => {
  test('the coverage the browser reads is exactly what the font can encode', () => {
    const font = PDF.create().embedFont(regular)
    for (let cp = 0x20; cp <= 0x2200; cp++) {
      if (cp >= 0x7f && cp < 0xa0) continue
      expect(canDrawChar(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toBe(font.canEncode(String.fromCodePoint(cp)))
    }
    expect(COVERED.length).toBeGreaterThan(5)
  })

  test('Latin with its extended and Vietnamese letters, Greek and Cyrillic are drawn; Chinese, Arabic and emoji are not', () => {
    for (const ok of ['Nguyễn Thị Hằng Ạ ế ỹ ơ ư', 'Łukasz Żółć Ąę', 'Dvořák Šťastný', 'İşığ', 'Παπαδόπουλος', 'Иванов Пётр', 'Zoë – “quoted” … € ™ №']) expect(canDraw(ok), ok).toBe(true)
    for (const no of ['陈大文', 'مرحبا', '😀', 'ไทย', 'עברית']) expect(canDraw(no), no).toBe(false)
  })

  test('says why, plainly: Chinese, Japanese and Korean by name, anything else by the character', () => {
    expect(whyNotDrawable('Nguyễn')).toBeNull()
    for (const s of ['陈大文', 'こんにちは', '한국어']) expect(whyNotDrawable(s)).toBe('Chinese, Japanese and Korean letters cannot be printed on this document yet. Please write it in English letters.')
    expect(whyNotDrawable('a مرحبا')).toBe('This document cannot print "م". It prints Latin, Greek and Cyrillic letters, so please use those.')
    expect(whyNotDrawable('x\u0007')).toContain('a control character')
  })

  test('a layout turns a tab into a space and what cannot be drawn into a question mark, and keeps line breaks', () => {
    expect(drawable('a\tb')).toBe('a b')
    expect(drawable('x 陈 y')).toBe('x ? y')
    expect(drawable('line one\nline two')).toBe('line one\nline two')
  })
})

describe('a document carries only the glyphs it uses', () => {
  test('a form page in Vietnamese and Cyrillic is a few tens of KB, not a font', async () => {
    const def = {
      title: 'Nguyễn',
      roles: [{ name: 'Client', fields: [] }, { name: 'CPA', fields: [] }],
      questions: [{ id: 'q1', type: 'short' as const, label: 'Tên', required: true, sensitive: false }],
    }
    const doc = await layoutForm({ title: 'Hợp đồng', client: { display_name: 'Công ty', accent_color: '#1f4e79' }, service: NORTHFIELD_WORDS, logo: null, def, answers: { q1: 'Nguyễn Thị Hằng' }, uploads: [], signers: [{ name: 'Nguyễn Thị Hằng' }, { name: 'Иван Петров' }] })
    expect(doc.bytes.length).toBeLessThan(60 * 1024)
    const pdf = await PDF.load(doc.bytes)
    const text = pdf.getPages().map((p) => p.extractText().text).join('\n')
    expect(text).toContain('Nguyễn Thị Hằng')
    expect(text).toContain('Иван Петров')
  })

  test('and a sealed one too: the seal saves on its own, so the subsetting is asked for first', async () => {
    const sealer = await testSealer()
    const blank = PDF.create()
    blank.addPage({ size: 'letter' })
    const base = await blank.save()
    const done = await finish(base, {
      stamps: [{ page: 0, kind: 'text', text: 'Hằng', box: { x: 0.1, y: 0.1, width: 0.3, height: 0.04 } }],
      appendBlocks: [{ title: 'Certificate', blocks: [{ kind: 'text', text: 'Nguyễn Thị Hằng, Łukasz, Иван Петров' }] }],
      seal: { signer: sealer.signer, reason: 'test', at: new Date('2026-10-31T20:00:00Z') },
    })
    if (!done.ok) throw new Error(done.refusal.message)
    expect(done.value.bytes.length).toBeLessThan(80 * 1024)
    const text = (await PDF.load(done.value.bytes)).getPages().map((p) => p.extractText().text).join('\n')
    expect(text).toContain('Nguyễn Thị Hằng, Łukasz, Иван Петров')
    if (hasPoppler) {
      const path = `${process.env.TMPDIR ?? '/tmp'}/font-subset-${Date.now()}.pdf`
      await Bun.write(path, done.value.bytes)
      const fonts = Bun.spawnSync(['pdffonts', path]).stdout.toString()
      expect(fonts).toMatch(/[A-Z]{6}\+NotoSans/)
    }
  })
})


describe("a value for a PDF's own text field", () => {
  const NAME = 'topmostSubform[0].Page1[0].f1_01[0]'
  const OTHER = 'topmostSubform[0].Page1[0].f1_02[0]'

  test("is written in the document font when the file's own font cannot show it, and in its own font when it can", async () => {
    const w9 = await fixtureBytes('w9')
    const done = await finish(w9, { fieldFills: [{ name: NAME, value: 'Nguyễn Văn Ωμέγα Жуков' }, { name: OTHER, value: 'Café Zoë' }] })
    if (!done.ok) throw new Error(done.refusal.message)
    if (!hasPoppler) return
    const path = `${process.env.TMPDIR ?? '/tmp'}/w9-own-${Date.now()}.pdf`
    await Bun.write(path, done.value.bytes)
    const text = Bun.spawnSync(['pdftotext', '-layout', path, '-']).stdout.toString()
    expect(text).toContain('Nguyễn Văn Ωμέγα Жуков')
    expect(text).toContain('Café Zoë')
    expect(Bun.spawnSync(['pdffonts', path]).stdout.toString()).toMatch(/NotoSans/)
    // A value the file's own font can show keeps it: the document font is not brought in for it.
    const plain = await finish(w9, { fieldFills: [{ name: OTHER, value: 'Café Zoë' }] })
    if (!plain.ok) throw new Error(plain.refusal.message)
    await Bun.write(path, plain.value.bytes)
    expect(Bun.spawnSync(['pdffonts', path]).stdout.toString()).not.toMatch(/NotoSans/)
  })

  test("what the file's fonts can show is told apart from what only the document font can", () => {
    expect(isWinAnsi('Café Zoë “quoted” €')).toBe(true)
    expect(isWinAnsi('Nguyễn')).toBe(false)
    expect(isWinAnsi('Жуков')).toBe(false)
    expect(isWinAnsi('Ωμέγα')).toBe(false)
  })

  test('typed as a base letter and a mark, it is one letter before it is checked and stored', async () => {
    const { checkAnswer, readDefinition } = await import('../src/forms/definition')
    const q = readDefinition({ title: 't', roles: [{ name: 'C' }], questions: [{ id: 'a', type: 'short', label: 'A' }] }).def.questions[0]!
    const decomposed = 'Nguyễn'
    expect(decomposed).not.toBe(decomposed.normalize('NFC'))
    expect(checkAnswer(q, decomposed)).toEqual({ ok: true, value: 'Nguyễn' })
  })
})
