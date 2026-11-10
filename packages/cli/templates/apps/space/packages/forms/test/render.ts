// Poppler, for the tests that must LOOK at a PDF: render a page and find a stamp's pixels, and ask pdfsig whether
// the seal holds. Both are installed on the Mac (brew install poppler) and CI installs them; where a tool is
// missing the test that needs it says so and skips rather than passing quietly.
import { test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const hasTool = (name: string) => Bun.spawnSync(['which', name]).exitCode === 0
export const hasPoppler = hasTool('pdftoppm') && hasTool('pdfsig')

/**
 * Where a tool is missing the tests that need it skip, and a skipped test is a green one. In CI (CI is set) that is a failure
 * instead: this registers a test that fails, so the run says which tool to install rather than passing for nothing. The
 * workflow's own steps fail first (.github/workflows/test.yml); this is the second line for any runner or command that skips them.
 */
export function requiredInCi(tool: string, present: boolean): void {
  if (process.env.CI && !present) test(`${tool} is installed (CI does not skip the tests that need it)`, () => { throw new Error(`${tool} is missing on this CI runner, so the tests that need it were skipped and would have passed for nothing. Install it.`) })
}
requiredInCi('poppler (pdfsig and pdftoppm)', hasPoppler)

export interface Raster {
  width: number
  height: number
  rgb: Uint8Array
}

function parsePpm(buf: Uint8Array): Raster {
  // P6\n<w> <h>\n255\n then w*h*3 bytes. Header tokens may be split by any whitespace.
  let p = 0
  const token = () => {
    while (buf[p] === 0x20 || buf[p] === 0x0a || buf[p] === 0x0d || buf[p] === 0x09) p++
    const start = p
    while (buf[p] !== 0x20 && buf[p] !== 0x0a && buf[p] !== 0x0d && buf[p] !== 0x09) p++
    return new TextDecoder().decode(buf.subarray(start, p))
  }
  if (token() !== 'P6') throw new Error('not a P6 ppm')
  const width = Number(token())
  const height = Number(token())
  token()
  p++
  return { width, height, rgb: buf.subarray(p, p + width * height * 3) }
}

/** Every page of a PDF as pixels, at 72 dpi (one pixel per point) through the crop box, the way a reader shows it. */
export function renderPages(pdf: Uint8Array, dpi = 72): Raster[] {
  const dir = mkdtempSync(join(tmpdir(), 'forms-render-'))
  try {
    writeFileSync(join(dir, 'in.pdf'), pdf)
    const run = Bun.spawnSync(['pdftoppm', '-r', String(dpi), '-cropbox', join(dir, 'in.pdf'), join(dir, 'page')], { stderr: 'pipe' })
    if (run.exitCode !== 0) throw new Error(`pdftoppm failed: ${run.stderr.toString()}`)
    return readdirSync(dir)
      .filter((f) => f.startsWith('page') && f.endsWith('.ppm'))
      .sort()
      .map((f) => parsePpm(new Uint8Array(readFileSync(join(dir, f)))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type Rgb = [number, number, number]

/** The bounding box, in pixels from the top-left, of every pixel close to `target`; null when none. */
export function findColor(r: Raster, target: Rgb, tolerance = 60): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  let x0 = r.width
  let y0 = r.height
  let x1 = -1
  let y1 = -1
  let count = 0
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 3
      if (Math.abs(r.rgb[i]! - target[0]) <= tolerance && Math.abs(r.rgb[i + 1]! - target[1]) <= tolerance && Math.abs(r.rgb[i + 2]! - target[2]) <= tolerance) {
        count++
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
    }
  }
  return count === 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, count }
}

export interface SigReport {
  /** "Signature is Valid." and the whole file covered. */
  valid: boolean
  /** The seal covers every byte of the file. */
  coversWholeFile: boolean
  /** "Certificate issuer isn't Trusted." */
  untrusted: boolean
  commonName: string | null
  signatureType: string | null
  signatures: number
  /** pdfsig's standard output. */
  raw: string
  /** Its standard error and exit code, for a message when `valid` is false and `raw` says nothing. */
  diagnostics: string
}

/** What poppler's pdfsig says about a PDF. */
export function pdfsig(pdf: Uint8Array): SigReport {
  const dir = mkdtempSync(join(tmpdir(), 'forms-sig-'))
  try {
    writeFileSync(join(dir, 'in.pdf'), pdf)
    const run = Bun.spawnSync(['pdfsig', '-nssdir', join(dir, 'nss'), join(dir, 'in.pdf')], { stdout: 'pipe', stderr: 'pipe' })
    const raw = run.stdout.toString()
    const diagnostics = `exit ${run.exitCode}, stderr ${JSON.stringify(run.stderr.toString().slice(0, 500))}, ${pdf.length} bytes ending ${JSON.stringify(Buffer.from(pdf.slice(-24)).toString('latin1'))}`
    return {
      valid: /Signature Validation: Signature is Valid\./.test(raw),
      coversWholeFile: /Total document signed/.test(raw),
      untrusted: /Certificate issuer isn't Trusted|Certificate issuer is unknown|self signed|not trusted/i.test(raw),
      commonName: /Signer Certificate Common Name: (.+)/.exec(raw)?.[1] ?? null,
      signatureType: /Signature Type: (.+)/.exec(raw)?.[1] ?? null,
      signatures: (raw.match(/^Signature #\d+:/gm) ?? []).length,
      raw,
      diagnostics,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
