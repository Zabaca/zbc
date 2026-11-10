// What the sound is doing, as pure decisions over numbers, so none of it needs a
// browser to check: how loud a reading is, who counts as speaking, when the sound
// we send has gone silent while the microphone has not (the Self-check, which
// then sends the raw microphone instead), and when sound we should be receiving
// is Not arriving. The browser parts (effects/audio.ts, call/controller.ts) take the
// readings and act on these answers.

/** The sound we send has been silent this long while the microphone is not: stop using the processed path. */
export const SILENT_MS = 2000
/** The audio context has not been running this long (after the person's first tap): stop using it. */
export const CONTEXT_MS = 1500
/** A person is publishing sound and no bytes of it have arrived for this long: their sound is Not arriving. */
export const NOT_ARRIVING_MS = 5000
/** After a fallback caused by the audio context, the context must have been running this long before noise cancellation comes back. */
export const RECOVER_MS = 1000
/** The microphone has delivered exact silence for this long. */
export const DEAD_MIC_MS = 8000

// Root-mean-square readings, 1.0 being full scale. A microphone in a quiet room reads about 0.001 to 0.005 and
// speech 0.02 to 0.1. A pipeline that has stopped produces exact zeros, and so does RNNoise when it hears only
// noise (measured in Chrome with a fake microphone playing a file: steady white noise at 0.05 and a 120 Hz hum at 0.03 both came out as
// exact zeros), which is why exact silence is judged against what the microphone was doing: see SelfCheck.
const RAW_SIGNAL = 0.01
/** Below this, what is sent counts as exact silence. */
export const SENT_SILENT = 1e-4
const MIC_DEAD = 1e-5
/** How far back the microphone is looked at for something that sounds like speech. */
const SPEECH_WINDOW_MS = 3000
/**
 * Speech is a run of at least this long and this many readings above RAW_SIGNAL, with the microphone falling
 * below it in the pauses (a fan never does). Both, because a hidden tab is read twice a second: two readings
 * 500 ms apart are not a word.
 */
const SPEECH_RUN_MS = 240
const SPEECH_RUN_SAMPLES = 4
const SPEAK_ON = 0.012
const SPEAK_OFF = 0.006
const SPEAK_HOLD_MS = 500

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += (samples[i] as number) ** 2
  return Math.sqrt(sum / samples.length)
}

/** A reading as a 0 to 1 bar: decibels from -60 (empty) to -10 (full). */
export function toLevel(reading: number): number {
  if (!(reading > 0)) return 0
  return Math.min(1, Math.max(0, (20 * Math.log10(reading) + 60) / 50))
}

/** Speaking, from a stream of readings: on at a clear sound, off only after a short hold, so a pause between words does not flicker. */
export class Speaking {
  private on = false
  private lastLoud = 0

  update(now: number, reading: number): boolean {
    if (reading >= (this.on ? SPEAK_OFF : SPEAK_ON)) {
      this.on = true
      this.lastLoud = now
    } else if (this.on && now - this.lastLoud > SPEAK_HOLD_MS) {
      this.on = false
    }
    return this.on
  }
}

export interface SelfCheckSample {
  /** AudioContext.state. */
  ctx: string
  /** The microphone, before any processing. */
  raw: number
  /** What goes into the track that is published. */
  sent: number
  /** True while the noise-cancellation path is the one in use. */
  processed: boolean
  /** The tab is hidden: a browser slows its timers and may put its audio to sleep, so nothing is judged. */
  hidden?: boolean
}

export type Fallback = 'context' | 'silent'

/** Does what the microphone did over this window sound like someone speaking, not a fan or a keyboard? */
function speechLike(window: Array<{ at: number; raw: number }>): boolean {
  let paused = false
  let longest = 0
  let longestSamples = 0
  let runStart: number | null = null
  let samples = 0
  for (const { at, raw } of window) {
    if (raw >= RAW_SIGNAL) {
      runStart ??= at
      samples++
      if (at - runStart >= SPEECH_RUN_MS && samples >= SPEECH_RUN_SAMPLES) {
        longest = Math.max(longest, at - runStart)
        longestSamples = Math.max(longestSamples, samples)
      }
    } else {
      paused = true
      runStart = null
      samples = 0
    }
  }
  return paused && longest >= SPEECH_RUN_MS && longestSamples >= SPEECH_RUN_SAMPLES
}

/**
 * The Self-check. Watches what is being sent. Feed it a sample every few tenths of a second, once the person has
 * given the page a tap (before that a browser rightly keeps the audio context asleep).
 *
 *   - `context`: the audio context has not been running for CONTEXT_MS. Whatever goes through it is silence.
 *   - `silent`: on the noise-cancellation path, the sound sent has been exactly silent for SILENT_MS while the
 *     microphone was carrying speech. Exact silence alone is not a fault: RNNoise turns a fan, a hum or a
 *     keyboard all the way down to zero (measured), and it never turns speech down, so only speech-like sound
 *     going in with nothing coming out means the path is dead. A dead path is found when its owner next speaks.
 *
 * Nothing is judged while the tab is hidden. Either answer means: send the raw microphone track instead. `micDead` is separate: the microphone itself has
 * delivered nothing for DEAD_MIC_MS, which no processing choice can fix and the person should hear about.
 */
export class SelfCheck {
  private ctxBadSince: number | null = null
  private silentSince: number | null = null
  private deadSince: number | null = null
  private recent: Array<{ at: number; raw: number }> = []

  observe(now: number, s: SelfCheckSample): { fallback: Fallback | null; micDead: boolean } {
    if (s.hidden) {
      this.ctxBadSince = null
      this.silentSince = null
      this.deadSince = null
      this.recent = []
      return { fallback: null, micDead: false }
    }
    if (s.ctx !== 'running') {
      this.ctxBadSince ??= now
      this.silentSince = null
      this.deadSince = null
      this.recent = []
      return { fallback: now - this.ctxBadSince >= CONTEXT_MS ? 'context' : null, micDead: false }
    }
    this.ctxBadSince = null

    if (s.raw < MIC_DEAD) this.deadSince ??= now
    else this.deadSince = null
    const micDead = this.deadSince !== null && now - this.deadSince >= DEAD_MIC_MS

    if (!s.processed || s.sent >= SENT_SILENT) {
      this.silentSince = null
      this.recent = []
      return { fallback: null, micDead }
    }
    this.silentSince ??= now
    this.recent.push({ at: now, raw: s.raw })
    while (this.recent.length > 0 && (this.recent[0] as { at: number }).at < now - SPEECH_WINDOW_MS) this.recent.shift()
    const silentLongEnough = now - this.silentSince >= SILENT_MS
    return { fallback: silentLongEnough && speechLike(this.recent) ? 'silent' : null, micDead }
  }
}

/**
 * After a fallback caused by the audio context (an iOS interruption, a tab put to sleep): true once the context
 * has been running without a break for RECOVER_MS, which is when noise cancellation can come back by itself.
 */
export class RecoveryWatch {
  private since: number | null = null

  observe(now: number, ctx: string): boolean {
    if (ctx !== 'running') {
      this.since = null
      return false
    }
    this.since ??= now
    return now - this.since >= RECOVER_MS
  }
}

/**
 * Who we should be hearing and are not. Each update says, for everyone publishing sound, how many bytes of it
 * have arrived so far (null when nothing has even been subscribed to yet); a person is Not arriving once that
 * number has not changed for NOT_ARRIVING_MS. A number that goes down is a new connection, so it counts as change.
 */
export class NotArrivingWatch {
  private seen = new Map<string, { bytes: number | null; changedAt: number }>()

  update(now: number, publishing: Array<{ id: string; bytes: number | null }>): string[] {
    const keep = new Set(publishing.map((p) => p.id))
    for (const id of this.seen.keys()) if (!keep.has(id)) this.seen.delete(id)
    const late: string[] = []
    for (const { id, bytes } of publishing) {
      const held = this.seen.get(id)
      if (!held || (bytes !== null && bytes !== held.bytes)) this.seen.set(id, { bytes, changedAt: now })
      const since = (this.seen.get(id) as { changedAt: number }).changedAt
      if (now - since >= NOT_ARRIVING_MS) late.push(id)
    }
    return late.sort()
  }
}
