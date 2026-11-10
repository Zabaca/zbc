/**
 * PDFs made out of nothing, for the operator's seal check and the spike's scan fixture: image-only pages as large
 * as a real scan, built without an image encoder. A tiny valid JPEG gets comment segments of seeded noise after
 * its first marker, which every decoder skips, so the file is a valid JPEG of any size and LibPDF embeds it
 * without decoding it, as it would a scanner's own output.
 */
import { PDF } from '@libpdf/core'
import { TILE_JPEG_BASE64 } from './tile'

export const tileJpeg = (): Uint8Array => Uint8Array.from(atob(TILE_JPEG_BASE64), (c) => c.charCodeAt(0))

/** The tile with `megabytes` of seeded noise in comment segments after its APP0 marker. */
export function noisyJpeg(tile: Uint8Array, megabytes: number, seed: number): Uint8Array {
  const segment = 65_000
  const count = Math.max(1, Math.floor((megabytes * 1024 * 1024) / segment))
  const head = tile.subarray(0, 20)
  const rest = tile.subarray(20)
  const out = new Uint8Array(head.length + count * (4 + segment) + rest.length)
  out.set(head)
  let at = head.length
  let s = seed >>> 0
  for (let i = 0; i < count; i++) {
    out[at] = 0xff
    out[at + 1] = 0xfe
    out[at + 2] = (segment + 2) >> 8
    out[at + 3] = (segment + 2) & 0xff
    at += 4
    for (let j = 0; j < segment; j++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      out[at++] = s >>> 24
    }
  }
  out.set(rest, at)
  return out
}

/** `pages` Letter pages, each one image, `totalMegabytes` in all: a scan. */
export async function syntheticScan(totalMegabytes: number, pages = 3): Promise<Uint8Array> {
  const pdf = PDF.create()
  const tile = tileJpeg()
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage({ size: 'letter' })
    const img = pdf.embedJpeg(noisyJpeg(tile, totalMegabytes / pages, 1234 + i))
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 })
  }
  return pdf.save()
}
