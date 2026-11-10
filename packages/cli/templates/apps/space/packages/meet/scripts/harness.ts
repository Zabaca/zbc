// What the two browser checks share (scripts/live.ts, scripts/audio.ts): flags,
// pass/fail lines, waiting, screenshots at both widths, and launching Chrome with
// its fake camera and microphone.

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type Page, chromium } from 'playwright'

export const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
export const BASE = arg('base') ?? 'http://localhost:4812'
export const SHOTS = arg('shots')
export const VIDEO = arg('video')
// Playwright's own browser download, or any Chrome: --chrome '<path to the executable>'.
export const CHROME = arg('chrome') ?? process.env.MEET_CHROME

const results: Array<{ ok: boolean; what: string }> = []
export function check(ok: boolean, what: string, detail = ''): void {
  results.push({ ok, what })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

/** The level bar under `scope` (a selector), 0 to 100. */
export const level = (page: Page, scope: string): Promise<number> =>
  page.evaluate((sel) => Number(document.querySelector(`${sel} [data-testid=level]`)?.getAttribute('data-level') ?? '0'), scope)

/** The highest the bar reads over `ms`. Chrome's own fake microphone beeps for a moment about once a second. */
export async function peakLevel(page: Page, scope: string, ms = 3500): Promise<number> {
  let peak = 0
  const end = Date.now() + ms
  while (Date.now() < end) {
    peak = Math.max(peak, await level(page, scope))
    await sleep(40)
  }
  return peak
}

/** What the call's microphone sender holds, against what the pipeline says should be sent. */
export const micSender = (page: Page) =>
  page.evaluate(() => {
    const m = (window as any).__meet
    const audio = m.o.audio
    const track = m.senders.get('mic')?.track as MediaStreamTrack | undefined
    return {
      hasSender: Boolean(track),
      isOutgoing: track?.id === audio.outgoing.id,
      isProcessed: track?.id === audio.processedTrack?.id,
      readyState: track?.readyState,
    }
  })

/** A screenshot at a phone's width and a laptop's. */
export async function shoot(page: Page, dir: string, label: string): Promise<void> {
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    await sleep(600)
    await page.screenshot({ path: join(dir, `${label}-${w}.png`) })
  }
}

/**
 * Chrome with its fake camera and microphone. Chrome's own fake microphone beeps for a moment each second, which
 * is not speech; `audioFile` plays a file instead (see speechLikeWav).
 */
export function launch(opts: { audioFile?: string } = {}): Promise<Browser> {
  const args = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--enable-features=WebRtcHideLocalIpsWithMdns:false',
    ...(VIDEO ? [`--use-file-for-fake-video-capture=${VIDEO}`] : []),
    ...(opts.audioFile ? [`--use-file-for-fake-audio-capture=${opts.audioFile}`] : []),
  ]
  return chromium.launch({ headless: true, args, ...(CHROME ? { executablePath: CHROME } : {}) })
}

/**
 * A 10 second mono WAV that behaves like talking as far as a level bar can tell: half a second of a voiced
 * 150 Hz tone with its harmonics, a third of a second of quiet, over and over.
 */
export function speechLikeWav(): string {
  const rate = 48000
  const n = rate * 10
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const voiced = (t % 0.8) < 0.5
    const envelope = voiced ? Math.min(1, (t % 0.8) / 0.03, (0.5 - (t % 0.8)) / 0.05) : 0
    const f = 150 + 12 * Math.sin(2 * Math.PI * 4 * t)
    let v = 0
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h
    const hiss = (Math.random() * 2 - 1) * 0.003
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, 0.12 * envelope * v + hiss)) * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  const dir = join(tmpdir(), 'meet-checks')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'speech-like.wav')
  writeFileSync(path, Buffer.concat([header, pcm]))
  return path
}

// Faults to put into a page before it loads (page.addInitScript), to see what the sound features do when the
// browser misbehaves. Each is a plain function, so it runs in the page.

/** A worklet that loads under RNNoise's name and says nothing: the processed track is exactly silent. */
export const SILENT_WORKLET = () => {
  const real = AudioWorklet.prototype.addModule
  AudioWorklet.prototype.addModule = function (_url: string | URL, options?: WorkletOptions) {
    const code =
      "class Silent extends AudioWorkletProcessor { process(_i, o) { for (const ch of o[0]) ch.fill(0); return true } } registerProcessor('@sapphi-red/web-noise-suppressor/rnnoise', Silent)"
    return real.call(this, URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), options)
  }
}

/** A worklet file that cannot be fetched (page.route does not see an AudioWorklet's own requests). */
export const NO_WORKLET = () => {
  AudioWorklet.prototype.addModule = () => Promise.reject(new DOMException('The module could not be loaded.', 'AbortError'))
}

/** An audio context that is suspended at birth and whose resume() never settles: Safari on a bad day. */
export const SUSPENDED_CONTEXT = () => {
  AudioContext.prototype.resume = () => new Promise(() => {})
  const Real = AudioContext
  const Patched = function (this: unknown, options?: AudioContextOptions) {
    const ctx = new Real(options)
    void ctx.suspend()
    return ctx
  } as unknown as typeof AudioContext
  Patched.prototype = Real.prototype
  window.AudioContext = Patched
}

/**
 * Safari on a bad day: the audio context starts asleep, resume() only works after a tap (a click, a key press or a
 * touch), and the audio worklet's load waits for the context to run. Before this was handled, a lobby that waited for
 * the worklet before it listened for the tap could never get its Join button.
 */
export const WAITS_FOR_TAP = () => {
  const w = window as any
  w.__tapped = false
  for (const e of ['click', 'keydown', 'touchend']) document.addEventListener(e, () => (w.__tapped = true), true)
  const Real = AudioContext
  const realResume = Real.prototype.resume
  const Patched = function (this: unknown, options?: AudioContextOptions) {
    const ctx = new Real(options)
    void ctx.suspend()
    let wake!: () => void
    const awake = new Promise<void>((r) => (wake = r))
    ctx.resume = () => (w.__tapped ? realResume.call(ctx).then(() => wake()) : new Promise(() => {}))
    const worklet = ctx.audioWorklet
    const realAdd = worklet.addModule.bind(worklet)
    worklet.addModule = (url: string | URL, opts?: WorkletOptions) => awake.then(() => realAdd(url, opts))
    return ctx
  } as unknown as typeof AudioContext
  Patched.prototype = Real.prototype
  window.AudioContext = Patched
}

/** A gate on resume(): while `window.__blockResume` is set, a context that is suspended stays so (an iOS interruption). */
export const RESUME_GATE = () => {
  const w = window as any
  const real = AudioContext.prototype.resume
  AudioContext.prototype.resume = function (this: AudioContext) {
    return w.__blockResume ? new Promise<void>(() => {}) : real.call(this)
  }
}

/** A browser that refuses to play a sound until the person taps something inside a banner (Safari, on a bad day). */
export const AUTOPLAY_BLOCKED = () => {
  const w = window as any
  const real = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (this instanceof HTMLAudioElement && !w.__tapped) return Promise.reject(new DOMException('play() needs a tap', 'NotAllowedError'))
    return real.call(this)
  }
  document.addEventListener('click', (e) => (w.__tapped = w.__tapped || Boolean((e.target as Element | null)?.closest?.('.banner'))), true)
}

/** Print the tally and exit with it. */
export function finish(): never {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exit(failed.length === 0 ? 0 : 1)
}
