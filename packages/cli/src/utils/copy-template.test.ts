/**
 * Scaffolding a template file.
 *
 * The interesting case is the binary one. Every template was text until the
 * walgit app template gained `assets/agentgit-og.png` — the card the Worker
 * serves — and a copy that reads a file as UTF-8 and writes the string back
 * does not round-trip bytes: a PNG scaffolded that way arrives corrupt, and
 * nothing downstream notices until a crawler fetches it.
 */

import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { copyTemplateFile } from './copy-template'

async function tmpdir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'zbc-copy-'))
}

describe('copyTemplateFile', () => {
  test('substitutes {{VARS}} in a text file', async () => {
    const dir = await tmpdir()
    const src = path.join(dir, 'zbc.config.ts')
    await Bun.write(src, 'export const project = "{{PROJECT_NAME}}"\n')
    const dest = path.join(dir, 'out', 'zbc.config.ts')

    await copyTemplateFile(src, dest, { vars: { PROJECT_NAME: 'acme' } })

    expect(await Bun.file(dest).text()).toBe('export const project = "acme"\n')
  })

  test('copies a binary file byte for byte', async () => {
    const dir = await tmpdir()
    const src = path.join(dir, 'card.png')
    // A real 1×1 PNG: the eight-byte signature, IHDR, IDAT and IEND. Its
    // second byte (0x50) is fine in UTF-8, but the compressed IDAT payload
    // holds bytes that are not valid UTF-8 at all, so a text round-trip
    // replaces them and the file stops being a PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await Bun.write(src, png)
    const dest = path.join(dir, 'out', 'card.png')

    await copyTemplateFile(src, dest)

    const copied = Buffer.from(await Bun.file(dest).arrayBuffer())
    expect(copied.equals(png)).toBe(true)
  })
})
