// The one AudioContext the page uses, and how loudness is read from it. Everything
// that touches sound (the microphone graph, the level of each remote person) shares
// this context, so a browser that limits how many exist, or that starts them asleep
// until a tap, has one thing to wake, and a diagnostics line has one state to show.
//
// RNNoise assumes 48 kHz, so the context is asked for it.

import { rms } from '../call/audio-health'

let shared: AudioContext | null = null

export function sharedAudioContext(): AudioContext {
  if (!shared || shared.state === 'closed') {
    try {
      shared = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    } catch {
      // A browser that will not make 48 kHz: its own rate is still good for levels and for the raw microphone.
      shared = new AudioContext()
    }
  }
  return shared
}

/**
 * Ask the context to run. Browsers only allow that from a tap, so callers are click handlers (Join, the noise
 * switch, the lobby's first tap). Resolves after `ms` at most: on Safari resume() can stay pending for good, and
 * nothing must wait on it.
 */
export async function resumeAudio(ms = 1000): Promise<void> {
  const ctx = sharedAudioContext()
  if (ctx.state === 'running') return
  await Promise.race([ctx.resume().catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))])
}

export function closeSharedAudioContext(): void {
  const ctx = shared
  shared = null
  void ctx?.close().catch(() => {})
}

export function makeAnalyser(ctx: AudioContext): AnalyserNode {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0
  return analyser
}

export function readAnalyser(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf)
  return rms(buf)
}

/** The loudness of one received stream. The stream must also be playing in an element, or Chrome feeds this silence. */
export class StreamLevel {
  private readonly source: MediaStreamAudioSourceNode
  private readonly analyser: AnalyserNode
  private readonly buf: Float32Array<ArrayBuffer>

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.source = ctx.createMediaStreamSource(stream)
    this.analyser = makeAnalyser(ctx)
    this.buf = new Float32Array(this.analyser.fftSize)
    this.source.connect(this.analyser)
  }

  read(): number {
    return readAnalyser(this.analyser, this.buf)
  }

  stop(): void {
    this.source.disconnect()
    this.analyser.disconnect()
  }
}

/**
 * Call `fn` about every `everyMs` while the page is visible, on animation frames; a hidden tab gets no frames,
 * so a slower timer keeps the checks that must go on (the Self-check, the Not arriving check) running there.
 */
export function everyFrame(fn: (now: number) => void, everyMs = 80): () => void {
  let raf = 0
  let last = -Infinity
  let stopped = false
  const run = () => {
    last = performance.now()
    fn(last)
  }
  const frame = (t: number) => {
    if (stopped) return
    if (t - last >= everyMs) run()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  const hidden = setInterval(() => {
    if (document.hidden && performance.now() - last >= 500) run()
  }, 500)
  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    clearInterval(hidden)
  }
}

export interface LevelReading {
  /** 0 to 1, for a bar. */
  level: number
  speaking: boolean
}
export type LevelSource = (fn: (r: LevelReading) => void) => () => void
