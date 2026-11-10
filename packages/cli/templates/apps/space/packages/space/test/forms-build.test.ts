// The Forms tab's screens are in the space's bundle (ADR 0007), so what the PDF screens need to load is the space's own files: a missing worker or WASM
// is a placement screen that draws nothing, and nothing but a browser would notice. This builds the real thing and reads what it wrote; the
// browser's own proof is e2e/documents.test.ts, which draws a PDF under the space's content security policy.
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NORTHFIELD_DECLARATION_FILE } from '../../workspace/northfield/paths'

const root = fileURLToPath(new URL('..', import.meta.url))
const assets = `${root}dist/client/assets`
const read = (file: string) => readFileSync(`${assets}/${file}`, 'utf8')

beforeAll(() => {
  const built = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, env: { ...process.env, SPACE_DECLARATION: NORTHFIELD_DECLARATION_FILE }, stderr: 'pipe', stdout: 'pipe' })
  expect(built.exitCode, built.stderr.toString()).toBe(0)
}, 120_000)

describe('the built page', () => {
  test('names every file it loads under /assets/, the space’s own folder: nothing of forms’ is asked for', () => {
    const html = readFileSync(`${root}dist/client/index.html`, 'utf8')
    const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!)
    expect(files.length).toBeGreaterThan(1)
    const present = new Set(readdirSync(assets))
    for (const f of files) expect(present.has(f.split('/').pop()!), f).toBe(true)
    for (const file of readdirSync(assets).filter((n) => /\.(js|css)$/.test(n))) {
      expect(read(file), file).not.toMatch(/\/forms\/(assets|app)\b/)
    }
  })

  test('carries the pdf.js worker, and the WASM decoders and their JavaScript twins beside the script that asks for them', () => {
    const files = readdirSync(assets)
    expect(files.some((f) => /^pdf\.worker\.min-.*\.mjs$/.test(f))).toBe(true)
    const wasm = readdirSync(`${assets}/pdfjs-wasm`)
    for (const need of ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm', 'openjpeg_nowasm_fallback.js']) expect(wasm, need).toContain(need)
    // The script that points pdf.js at them says where, from its own address: the folder it was itself loaded from (src/public/PdfPages.tsx).
    const asks = files.filter((f) => f.endsWith('.js')).filter((f) => read(f).includes('pdfjs-wasm/'))
    expect(asks.length).toBeGreaterThan(0)
    for (const f of asks) expect(read(f), f).toMatch(/import\.meta\.url/)
  })

  test('has the screens: the placement screen and the builder are in the bundle', () => {
    const all = readdirSync(assets).filter((n) => n.endsWith('.js')).map(read).join('\n')
    for (const word of ['Fields already in the file', 'Add a question', '/forms/api']) expect(all, word).toContain(word)
  })

  test('has the screens’ styles: the utilities the screens use are in the stylesheet, under the layers that let them beat the space’s element rules', () => {
    const css = readdirSync(assets).filter((n) => n.endsWith('.css')).map(read).join('\n')
    expect(css).toMatch(/@layer theme,\s*base,\s*components,\s*utilities/)
    for (const rule of ['.bg-card', '.border-border', '.text-muted-foreground', '.min-h-10']) expect(css, rule).toContain(rule)
    // The space's own colours under the admin's names, not the admin's light palette.
    expect(css).toMatch(/--color-card:\s*var\(--panel\)/)
  })
})
