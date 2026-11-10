/**
 * The seal check: the whole of a finished document's PDF work, run on a file, so that the spike (e2e/spike.test.ts),
 * the operator's check in production and the signing core's completion all prove the same chain. Inspect, take a working
 * copy, flatten, stamp the four corners of every page, append a page, attach a file, seal.
 *
 * With no file it builds the largest thing the service accepts, a scan of about 19 MB, because the first deploy's
 * question is whether that fits the Worker's CPU and memory (the spec's "operator-only seal check").
 */
import { type Inspection, type Result, type Stamp, finish, inspect, workingCopy } from './engine'
import { sha256Hex } from '../bytes'
import { type ServiceWords, sealReason } from '../service'
import type { Sealer } from '../seal/sealer'
import { syntheticScan } from './synthetic'

/** Four corner marks, each its own pure color, so a render can find each one and compare it with where it was placed. */
export const CORNERS = [
  { name: 'top-left', box: { x: 0.04, y: 0.03, width: 0.12, height: 0.05 }, color: [1, 0, 0] },
  { name: 'top-right', box: { x: 0.84, y: 0.03, width: 0.12, height: 0.05 }, color: [0, 0.7, 0] },
  { name: 'bottom-left', box: { x: 0.04, y: 0.92, width: 0.12, height: 0.05 }, color: [0, 0, 1] },
  { name: 'bottom-right', box: { x: 0.84, y: 0.92, width: 0.12, height: 0.05 }, color: [1, 0, 1] },
] as const

export function cornerStamps(pageCount: number): Stamp[] {
  const out: Stamp[] = []
  for (let page = 0; page < pageCount; page++) for (const c of CORNERS) out.push({ page, kind: 'rect', box: { ...c.box }, color: [...c.color] })
  return out
}

export interface SealCheckReport {
  input: { bytes: number; synthetic: boolean }
  inspection: Pick<Inspection, 'pageCount' | 'encrypted' | 'restrictionsOnly' | 'xfa' | 'signatures' | 'mixedSizes' | 'turnedPages' | 'scannedPages' | 'recovered'> & { fields: number }
  workingBytes: number
  outputBytes: number
  outputSha256: string
  seal: { subject: string; rootFingerprint: string; certFingerprint: string; notAfter: string; level: 'B-B' | 'B-T' }
  /** Wall time per stage as the Worker's clock reports it. A Worker's clock only moves on I/O, so these read near zero in production: the CPU figure is Workers Logs'. */
  stagesMs: Record<string, number>
}

/**
 * `all` is upload and completion in one request. `prepare` is the PDF path's upload (inspect, working copy) alone and
 * `finish` is the signing core's completion (flatten, stamp, append, attach, seal) alone, on a file taken as already
 * prepared: the two run in separate requests in the service, so each has its own memory and CPU to measure.
 */
export type Stage = 'all' | 'prepare' | 'finish'

export async function sealCheck(opts: { bytes?: Uint8Array; password?: string; sealer: Sealer; /** The install's names for the service. */ service: ServiceWords; at: Date; stage?: Stage; /** The synthetic scan's size in MB when no file is given (default 19, the largest the service accepts). */ syntheticMb?: number; clock?: () => number }): Promise<Result<{ bytes: Uint8Array; report: SealCheckReport }>> {
  const clock = opts.clock ?? (() => performance.now())
  const stagesMs: Record<string, number> = {}
  const time = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = clock()
    try {
      return await f()
    } finally {
      stagesMs[name] = Math.round(clock() - t)
    }
  }
  const stage = opts.stage ?? 'all'
  const synthetic = opts.bytes === undefined
  const input = opts.bytes ?? (await time('build', () => syntheticScan(opts.syntheticMb ?? 19, 3)))
  const working: Result<{ bytes: Uint8Array; inspection: Inspection }> =
    stage === 'finish'
      ? await time('inspect', async () => {
          const i = await inspect(input, { password: opts.password })
          return i.ok ? { ok: true as const, value: { bytes: input, inspection: i.value } } : i
        })
      : await time('prepare', () => workingCopy(input, { password: opts.password }))
  if (!working.ok) return working
  const info = working.value.inspection
  if (stage === 'prepare') return { ok: true, value: { bytes: working.value.bytes, report: await reportOf(opts, input, synthetic, info, working.value.bytes, working.value.bytes, stagesMs) } }
  const sealed = await time('finish', () =>
    finish(working.value.bytes, {
      stamps: cornerStamps(info.pageCount),
      appendPages: [{ title: 'Seal check', lines: [`This page was appended by ${opts.service.name} to prove the PDF engine can add pages.`, `The input held ${info.pageCount} page(s).`] }],
      attachments: [{ name: 'events.json', data: new TextEncoder().encode(JSON.stringify({ check: true, at: opts.at.toISOString() })), mimeType: 'application/json', description: 'The event log, as attached to a finished document' }],
      seal: { signer: opts.sealer.signer, timestampAuthority: opts.sealer.timestampAuthority, reason: sealReason(opts.service), at: opts.at },
    }),
  )
  if (!sealed.ok) return sealed
  const out = sealed.value.bytes
  return { ok: true, value: { bytes: out, report: await reportOf(opts, input, synthetic, info, working.value.bytes, out, stagesMs) } }
}

async function reportOf(opts: { sealer: Sealer }, input: Uint8Array, synthetic: boolean, info: Inspection, working: Uint8Array, out: Uint8Array, stagesMs: Record<string, number>): Promise<SealCheckReport> {
  return {
    input: { bytes: input.length, synthetic },
    inspection: {
      pageCount: info.pageCount,
      encrypted: info.encrypted,
      restrictionsOnly: info.restrictionsOnly,
      xfa: info.xfa,
      signatures: info.signatures,
      mixedSizes: info.mixedSizes,
      turnedPages: info.turnedPages,
      scannedPages: info.scannedPages,
      recovered: info.recovered,
      fields: info.fields.length,
    },
    workingBytes: working.length,
    outputBytes: out.length,
    outputSha256: await sha256Hex(out),
    seal: {
      subject: opts.sealer.subject,
      rootFingerprint: opts.sealer.rootFingerprint,
      certFingerprint: opts.sealer.certFingerprint,
      notAfter: opts.sealer.notAfter,
      level: opts.sealer.timestampAuthority ? 'B-T' : 'B-B',
    },
    stagesMs,
  }
}
