// The microphone as the call publishes it. Two ways to send it:
//
//   - through a graph: microphone source, then (when noise cancellation is on) the
//     RNNoise AudioWorklet, then a destination whose track is published ONCE. Switching
//     the effect only re-routes the graph around the worklet, so the published track
//     never changes and nobody hears a gap or a reconnect;
//   - directly: the raw microphone track, swapped in with replaceTrack. This is where
//     the pipeline lands when the graph cannot be trusted (the Self-check below).
//
// A graph that looks alive can send silence: an audio context that never started
// (Safari and iOS want a resume inside a tap), a worklet that loaded but produces
// nothing. Nothing in the track says so. So the pipeline measures with an
// AnalyserNode before the microphone and before the destination, and when the
// microphone has sound and what is sent has none (call/audio-health.ts decides),
// it sends the raw microphone track instead and says so. The same readings drive
// the level bar on your own tile (from the sender's own statistics while the
// context is asleep, which the controller feeds in). The fallback is not for good:
// switching noise cancellation on again tests the path once more, and a fallback
// caused by the context lifts by itself once the context has run for a second.
//
// The browser's echo cancellation stays on for the raw microphone; its own noise
// suppression is turned off where the browser allows it (Safari does not support
// the setting, so there RNNoise runs on top of Apple's own processing). Automatic
// gain is left at the browser's default.
//
// The worklet, its wasm and the SIMD build are served from this app's own assets
// (Vite's ?url imports), loaded when the pipeline is created.

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import { type Fallback, RecoveryWatch, SENT_SILENT, SelfCheck, Speaking, toLevel } from '../call/audio-health'
import { type LevelReading, everyFrame, makeAnalyser, readAnalyser, resumeAudio, sharedAudioContext } from './levels'

export const micConstraints = (deviceId?: string): MediaTrackConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  echoCancellation: true,
  noiseSuppression: false,
})

/** Why noise cancellation is not in use although it was asked for: it never loaded, or the Self-check turned it off. */
export type FallbackReason = 'unavailable' | Fallback

export interface AudioState {
  /** AudioContext.state, or 'closed'. */
  ctx: string
  /** 'processed': through the worklet. 'graph': the raw microphone through the graph. 'direct': the raw track itself. */
  path: 'processed' | 'graph' | 'direct'
  noise: boolean
  /** The switch can be tried: there is a graph and the browser has audio worklets. It may still fail again. */
  supportsNoise: boolean
  fallback: FallbackReason | null
  /** The fallback is the path stopping after it had worked, not failing to start. */
  stopped: boolean
  /** The microphone has delivered nothing for a while (and you are not muted). */
  micDead: boolean
  micLabel: string
  micId: string
  workletError: string | null
  graphError: string | null
}

interface Graph {
  source: MediaStreamAudioSourceNode
  dest: MediaStreamAudioDestinationNode
  rawAnalyser: AnalyserNode
  sentAnalyser: AnalyserNode
  rawBuf: Float32Array<ArrayBuffer>
  sentBuf: Float32Array<ArrayBuffer>
  processed: MediaStreamTrack
}

/** How long the worklet may take to load before the pipeline carries on without it. Safari can wait on a context that has not been tapped awake. */
const WORKLET_TIMEOUT_MS = 3000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// Loaded once per context: a second addModule for the same processor name is refused. A load that timed out
// stays in the map still pending, so a later try (after a tap) picks it up instead of adding the module twice.
const workletLoads = new WeakMap<AudioContext, Promise<ArrayBuffer>>()
function loadWorklet(ctx: AudioContext): Promise<ArrayBuffer> {
  let load = workletLoads.get(ctx)
  if (!load) {
    load = (async () => {
      await ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
      return loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    })()
    load.catch(() => workletLoads.delete(ctx))
    workletLoads.set(ctx, load)
  }
  return load
}

async function makeWorklet(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  const wasmBinary = await withTimeout(loadWorklet(ctx), WORKLET_TIMEOUT_MS)
  return new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })
}

export class AudioPipeline {
  private graph: Graph | null = null
  private graphError: string | null = null
  /** What the person asked for. Whether it is in use is `noiseCancellation`. */
  private wantNoise: boolean
  private worklet: RnnoiseWorkletNode | null
  private workletError: string | null
  /** The raw microphone track is what is published, and the graph only feeds the level bar. */
  private direct = false
  private directReason: FallbackReason | null = null
  private stoppedMidCall = false
  private ctxWasRunning = false
  private soundWasSent = false
  private muted = false
  private armed = false
  private deadMic = false
  private watch = new SelfCheck()
  private recovery = new RecoveryWatch()
  private speaking = new Speaking()
  private external: { rms: number; at: number } | null = null
  private state: AudioState
  private readonly levelListeners = new Set<(r: LevelReading) => void>()
  private readonly stateListeners = new Set<() => void>()
  private readonly outgoingListeners = new Set<(t: MediaStreamTrack) => void>()
  private readonly stopTicker: () => void
  /** The last readings, for the diagnostics panel. */
  lastRaw = 0
  lastSent = 0

  private constructor(
    private readonly ctx: AudioContext,
    private input: MediaStream,
    worklet: RnnoiseWorkletNode | null,
    workletError: string | null,
    wantNoise: boolean,
  ) {
    this.worklet = worklet
    this.workletError = workletError
    this.wantNoise = wantNoise
    if (worklet === null) {
      // Nothing to put in the graph but the microphone itself: publish the raw track, which needs no audio context.
      this.direct = true
      this.directReason = 'unavailable'
    }
    try {
      this.graph = this.buildGraph(input)
      this.route()
    } catch (err) {
      // Firefox refuses to connect a microphone whose rate differs from the context's. The raw track needs no graph.
      console.warn('the microphone graph could not be built', err)
      this.graphError = String(err)
      this.graph = null
      this.direct = true
      this.directReason = 'unavailable'
    }
    this.state = this.buildState()
    ctx.addEventListener('statechange', this.onContextState)
    document.addEventListener('visibilitychange', this.onVisible)
    this.stopTicker = everyFrame(this.sample)
  }

  /** The graph is built here, but the worklet is loaded first, so a failure to load is a message and not a throw. */
  static async create(input: MediaStream, noise: boolean): Promise<AudioPipeline> {
    const ctx = sharedAudioContext()
    // Not from a tap here, so this only works where the page already had one; the tap handlers call resume().
    void ctx.resume().catch(() => {})
    let worklet: RnnoiseWorkletNode | null = null
    let workletError: string | null = null
    try {
      worklet = await makeWorklet(ctx)
    } catch (err) {
      // No AudioWorklet, no WebAssembly, or a load that waited too long: the call still works, without noise cancellation.
      console.warn('noise cancellation unavailable', err)
      workletError = String(err)
    }
    return new AudioPipeline(ctx, input, worklet, workletError, noise)
  }

  private buildGraph(input: MediaStream): Graph {
    const ctx = this.ctx
    const source = ctx.createMediaStreamSource(input)
    const dest = ctx.createMediaStreamDestination()
    const rawAnalyser = makeAnalyser(ctx)
    const sentAnalyser = makeAnalyser(ctx)
    return {
      source,
      dest,
      rawAnalyser,
      sentAnalyser,
      rawBuf: new Float32Array(rawAnalyser.fftSize),
      sentBuf: new Float32Array(sentAnalyser.fftSize),
      processed: dest.stream.getAudioTracks()[0] as MediaStreamTrack,
    }
  }

  private get rawTrack(): MediaStreamTrack {
    return this.input.getAudioTracks()[0] as MediaStreamTrack
  }

  /** The track the call publishes: the graph's, until the pipeline has gone direct. */
  get outgoing(): MediaStreamTrack {
    return this.direct || !this.graph ? this.rawTrack : this.graph.processed
  }

  /** The graph's own track, for the diagnostics panel and the live check. */
  get processedTrack(): MediaStreamTrack | null {
    return this.graph?.processed ?? null
  }

  /** Noise cancellation is in use right now. */
  get noiseCancellation(): boolean {
    return this.wantNoise && this.worklet !== null && !this.direct
  }

  /** False where there is nothing to try (no graph, no audio worklets): the switch is then shown disabled. */
  get supportsNoiseCancellation(): boolean {
    return this.graph !== null && Boolean(this.ctx.audioWorklet)
  }

  get context(): AudioContext {
    return this.ctx
  }

  getState = (): AudioState => this.state

  subscribeState = (fn: () => void): (() => void) => {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  /** The level of what is being sent (zero while muted), about every 80 ms. */
  subscribeLevel = (fn: (r: LevelReading) => void): (() => void) => {
    this.levelListeners.add(fn)
    return () => this.levelListeners.delete(fn)
  }

  /** Like the camera: the call listens and calls replaceTrack when the track to send changes. */
  subscribeOutgoing(fn: (t: MediaStreamTrack) => void): () => void {
    this.outgoingListeners.add(fn)
    return () => this.outgoingListeners.delete(fn)
  }

  /**
   * The switch. Called from a tap, so it asks the audio context to run first. Switching on after a fallback tests
   * the path again: the worklet is loaded if it never was, and the pipeline leaves the raw microphone only when
   * the context is running; the Self-check then judges it afresh, and falls back again if it is still dead.
   */
  async setNoiseCancellation(on: boolean): Promise<void> {
    const awake = this.resume()
    this.wantNoise = on
    if (!on) {
      const before = this.outgoing
      this.route()
      this.afterChange(before)
      return
    }
    this.notify()
    if (!this.graph) return
    if (!this.worklet) {
      try {
        this.worklet = await makeWorklet(this.ctx)
        this.workletError = null
      } catch (err) {
        console.warn('noise cancellation still unavailable', err)
        this.workletError = String(err)
        this.notify()
        return
      }
    }
    await awake
    if (this.wantNoise && this.ctx.state === 'running') this.leaveDirect()
    else this.notify()
  }

  /** Muting turns the track off, which keeps sending silence frames, so the publication never idles out. */
  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyMute()
    this.notify()
  }

  /** Use another microphone. The published track stays the same unless the raw one is what is published. */
  async switchMic(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
    const before = this.outgoing
    const old = this.input
    this.input = stream
    this.watch = new SelfCheck()
    this.deadMic = false
    if (this.graph) {
      this.graph.source.disconnect()
      try {
        this.graph.source = this.ctx.createMediaStreamSource(stream)
        this.route()
      } catch (err) {
        console.warn('the microphone graph could not take the new microphone', err)
        this.graphError = String(err)
        this.graph = null
        this.direct = true
        this.directReason = 'unavailable'
      }
    }
    old.getTracks().forEach((t) => t.stop())
    this.afterChange(before)
  }

  /** The graph: source -> (worklet) -> dest, with a meter on each end. The unused leg is disconnected. */
  private route(): void {
    const g = this.graph
    if (!g) return
    g.source.disconnect()
    this.worklet?.disconnect()
    g.source.connect(g.rawAnalyser)
    let feed: AudioNode = g.source
    if (this.noiseCancellation && this.worklet) {
      g.source.connect(this.worklet)
      feed = this.worklet
    }
    feed.connect(g.dest)
    feed.connect(g.sentAnalyser)
  }

  /** Give up on the graph: publish the raw microphone track. Said to the person when they had asked for noise cancellation. */
  private fallBack(reason: Fallback): void {
    if (this.direct) return
    const before = this.outgoing
    this.stoppedMidCall = reason === 'context' ? this.ctxWasRunning : this.soundWasSent
    this.direct = true
    this.directReason = reason
    this.route()
    console.warn(`sending the raw microphone: ${reason}`)
    this.afterChange(before)
  }

  /** The way back: publish the graph's track again, with a fresh Self-check. */
  private leaveDirect(): void {
    if (!this.direct || !this.graph) return
    const before = this.outgoing
    this.direct = false
    this.directReason = null
    this.stoppedMidCall = false
    this.watch = new SelfCheck()
    this.recovery = new RecoveryWatch()
    this.route()
    this.afterChange(before)
  }

  /** The sender's own reading of the level (RTCStats media-source audioLevel), for while the context is asleep and the analysers read nothing. */
  feedExternalLevel(level: number): void {
    this.external = { rms: level, at: performance.now() }
  }

  /** A tap happened: ask the context to run. Called from Join, the noise switch and the lobby's first tap. */
  async resume(): Promise<void> {
    this.armed = true
    await resumeAudio()
  }

  private applyMute(): void {
    this.outgoing.enabled = !this.muted
    if (this.graph) this.graph.processed.enabled = !this.muted
  }

  private afterChange(before: MediaStreamTrack): void {
    this.applyMute()
    if (this.outgoing !== before) for (const fn of this.outgoingListeners) fn(this.outgoing)
    this.notify()
  }

  private buildState(): AudioState {
    const track = this.rawTrack
    const fallback = this.wantNoise ? this.directReason : null
    return {
      ctx: this.ctx.state,
      path: this.direct || !this.graph ? 'direct' : this.noiseCancellation ? 'processed' : 'graph',
      noise: this.noiseCancellation,
      supportsNoise: this.supportsNoiseCancellation,
      fallback,
      stopped: fallback !== null && this.stoppedMidCall,
      micDead: this.deadMic && !this.muted,
      micLabel: track?.label ?? '',
      micId: track?.getSettings().deviceId ?? '',
      workletError: this.workletError,
      graphError: this.graphError,
    }
  }

  private notify(): void {
    this.state = this.buildState()
    for (const fn of this.stateListeners) fn()
  }

  private readonly onContextState = (): void => {
    this.notify()
    if (this.ctx.state === 'suspended' || (this.ctx.state as string) === 'interrupted') void this.ctx.resume().catch(() => {})
  }

  private readonly onVisible = (): void => {
    if (!document.hidden && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
  }

  private readonly sample = (now: number): void => {
    const g = this.graph
    const raw = g ? readAnalyser(g.rawAnalyser, g.rawBuf) : 0
    const sent = g ? readAnalyser(g.sentAnalyser, g.sentBuf) : 0
    this.lastRaw = raw
    this.lastSent = sent
    const running = this.ctx.state === 'running'
    if (running) {
      this.armed = true
      this.ctxWasRunning = true
    }
    if (g && this.armed) {
      if (!this.direct) {
        const verdict = this.watch.observe(now, {
          ctx: this.ctx.state,
          raw,
          sent,
          processed: this.noiseCancellation,
          hidden: document.hidden,
        })
        if (running && this.noiseCancellation && sent > SENT_SILENT) this.soundWasSent = true
        if (verdict.micDead !== this.deadMic) {
          this.deadMic = verdict.micDead
          this.notify()
        }
        if (verdict.fallback) this.fallBack(verdict.fallback)
      } else if (this.directReason === 'context' && this.recovery.observe(now, this.ctx.state)) {
        this.leaveDirect()
      }
    }
    if (this.levelListeners.size > 0) {
      const external = !running && this.external && now - this.external.at < 1500 ? this.external.rms : null
      const shown = external ?? sent
      const level = this.muted ? 0 : toLevel(shown)
      const speaking = !this.muted && this.speaking.update(now, shown)
      for (const fn of this.levelListeners) fn({ level, speaking })
    }
  }

  stop(): void {
    this.stopTicker()
    this.ctx.removeEventListener('statechange', this.onContextState)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.worklet?.destroy()
    this.graph?.source.disconnect()
    this.input.getTracks().forEach((t) => t.stop())
    this.levelListeners.clear()
    this.stateListeners.clear()
    this.outgoingListeners.clear()
  }
}
