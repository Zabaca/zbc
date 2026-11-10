// Seam 2: the sound decisions, over literal readings. No page, no media.
import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_MS,
  DEAD_MIC_MS,
  NOT_ARRIVING_MS,
  NotArrivingWatch,
  RECOVER_MS,
  RecoveryWatch,
  SILENT_MS,
  SelfCheck,
  type SelfCheckSample,
  Speaking,
  rms,
  toLevel,
} from '../src/web/call/audio-health'

type Sampler = SelfCheckSample | ((t: number) => SelfCheckSample)

/** Feed a watch one sample every 100 ms for `ms`, returning the first fallback it asked for, and when. */
function run(watch: SelfCheck, from: number, ms: number, sample: Sampler) {
  let micDead = false
  for (let t = from; t <= from + ms; t += 100) {
    const v = watch.observe(t, typeof sample === 'function' ? sample(t) : sample)
    micDead = v.micDead
    if (v.fallback) return { fallback: v.fallback, at: t, micDead }
  }
  return { fallback: null, at: from + ms, micDead }
}

const speech = 0.05 // the microphone while someone talks
const hiss = 0.003 // the microphone in a quiet room

/** Someone talking: half a second of voice, a third of a second of pause, over and over. Nothing comes out. */
const talking =
  (sent = 0, processed = true) =>
  (t: number): SelfCheckSample => ({ ctx: 'running', raw: t % 800 < 500 ? speech : hiss, sent, processed })

describe('the level bar', () => {
  test('rms of a signal, and a bar from -60 dB (empty) to -10 dB (full)', () => {
    expect(rms([])).toBe(0)
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 6)
    expect(toLevel(0)).toBe(0)
    expect(toLevel(0.0005)).toBe(0) // -66 dB, below the floor
    expect(toLevel(0.001)).toBeCloseTo(0, 6) // -60 dB
    expect(toLevel(0.0316)).toBeCloseTo(0.6, 2) // -30 dB
    expect(toLevel(0.5)).toBe(1) // louder than -10 dB is full
    expect(toLevel(Number.NaN)).toBe(0)
  })
})

describe('speaking', () => {
  test('on at a clear sound, and a pause between words does not flicker it off', () => {
    const s = new Speaking()
    expect(s.update(0, 0.002)).toBe(false)
    expect(s.update(100, 0.05)).toBe(true)
    expect(s.update(300, 0.001)).toBe(true) // 200 ms of quiet: still speaking
    expect(s.update(700, 0.001)).toBe(false) // more than half a second of quiet: done
  })

  test('once on, a softer sound keeps it on, but a soft sound alone does not turn it on', () => {
    const s = new Speaking()
    expect(s.update(0, 0.009)).toBe(false) // between the off and on thresholds
    expect(s.update(100, 0.05)).toBe(true)
    expect(s.update(200, 0.009)).toBe(true)
    expect(s.update(900, 0.009)).toBe(true) // still above the off threshold, so never held out
  })
})

describe('the Self-check on what is sent', () => {
  test('a context that never runs sends silence: fall back after the grace, not before', () => {
    const w = new SelfCheck()
    const r = run(w, 0, 5000, { ctx: 'suspended', raw: 0, sent: 0, processed: true })
    expect(r.fallback).toBe('context')
    expect(r.at).toBe(CONTEXT_MS)
  })

  test('the grace for a context that is about to start is not spent while it is running', () => {
    const w = new SelfCheck()
    expect(run(w, 0, 1000, { ctx: 'suspended', raw: 0, sent: 0, processed: true }).fallback).toBeNull()
    // It starts; later it stops again: the clock starts over.
    expect(run(w, 1100, 3000, { ctx: 'running', raw: speech, sent: speech, processed: true }).fallback).toBeNull()
    const again = run(w, 4200, 5000, { ctx: 'interrupted', raw: 0, sent: 0, processed: true })
    expect(again.fallback).toBe('context')
    expect(again.at).toBe(4200 + CONTEXT_MS)
  })

  test('a context that is not running counts in raw-through-the-graph mode too: that path is silent as well', () => {
    const w = new SelfCheck()
    expect(run(w, 0, 5000, { ctx: 'suspended', raw: 0, sent: 0, processed: false }).fallback).toBe('context')
  })

  test('someone talks and the processed track is exactly silent for 2 s: fall back', () => {
    const r = run(new SelfCheck(), 0, 5000, talking())
    expect(r.fallback).toBe('silent')
    expect(r.at).toBe(SILENT_MS)
  })

  test('noise suppression doing its job is not a fault: quiet but not silent, or a quiet microphone, never falls back', () => {
    // RNNoise took a fan down by 40 dB: far below the microphone, far above digital silence.
    expect(run(new SelfCheck(), 0, 30_000, { ctx: 'running', raw: 0.05, sent: 0.0005, processed: true }).fallback).toBeNull()
    // A quiet room: the microphone has hiss only, and the processed track is silent. Nothing is wrong.
    expect(run(new SelfCheck(), 0, 30_000, { ctx: 'running', raw: hiss, sent: 0, processed: true }).fallback).toBeNull()
  })

  test('RNNoise turns a steady fan or hum all the way to zero, and that is not a fault either (measured)', () => {
    // Loud and exactly silent out for as long as you like, but it never changes: nothing like speech.
    expect(run(new SelfCheck(), 0, 60_000, { ctx: 'running', raw: 0.05, sent: 0, processed: true }).fallback).toBeNull()
    expect(run(new SelfCheck(), 0, 60_000, (t) => ({ ctx: 'running', raw: 0.03 + 0.001 * Math.sin(t), sent: 0, processed: true })).fallback).toBeNull()
  })

  test('typing or clapping, loud but in bursts too short to be words, never falls back', () => {
    const typing = (t: number): SelfCheckSample => ({ ctx: 'running', raw: t % 500 < 100 ? 0.3 : hiss, sent: 0, processed: true })
    expect(run(new SelfCheck(), 0, 60_000, typing).fallback).toBeNull()
  })

  test('a dead path is found when its owner next speaks, however long it was silent before', () => {
    const w = new SelfCheck()
    expect(run(w, 0, 30_000, { ctx: 'running', raw: 0.05, sent: 0, processed: true }).fallback).toBeNull() // a fan
    expect(w.observe(30_100, { ctx: 'running', raw: 0.2, sent: 0, processed: true }).fallback).toBeNull() // one clap
    expect(run(w, 30_200, 4000, (t) => talking()(t - 30_200)).fallback).toBe('silent')
  })

  test('a knock is not a word: three loud readings in a row never count as speech, four (about a third of a second) do', () => {
    const burst = (n: number) => (t: number): SelfCheckSample => ({
      ctx: 'running',
      raw: t % 1000 < n * 100 ? speech : hiss,
      sent: 0,
      processed: true,
    })
    expect(run(new SelfCheck(), 0, 60_000, burst(3)).fallback).toBeNull()
    expect(run(new SelfCheck(), 0, 5000, burst(4)).fallback).toBe('silent')
  })

  test('a hidden tab is read twice a second: two loud readings 500 ms apart are not a word, and nothing is judged at all while hidden', () => {
    const slow = (t: number): SelfCheckSample => ({ ctx: 'running', raw: t % 1500 < 1000 ? speech : hiss, sent: 0, processed: true })
    const w = new SelfCheck()
    let fell = null
    for (let t = 0; t <= 60_000; t += 500) fell = fell ?? w.observe(t, slow(t)).fallback
    expect(fell).toBeNull()
    // Hidden, even with speech going in and nothing coming out, or a context asleep: no verdict.
    const hidden = new SelfCheck()
    expect(run(hidden, 0, 30_000, (t) => ({ ...talking()(t), hidden: true })).fallback).toBeNull()
    expect(run(hidden, 30_100, 30_000, { ctx: 'suspended', raw: 0, sent: 0, processed: true, hidden: true }).fallback).toBeNull()
  })

  test('coming back to a hidden tab starts the clocks over', () => {
    const w = new SelfCheck()
    run(w, 0, 1900, talking())
    expect(w.observe(2000, { ...talking()(2000), hidden: true }).fallback).toBeNull()
    const again = run(w, 2100, 5000, (t) => talking()(t - 2100))
    expect(again.at).toBe(2100 + SILENT_MS)
  })

  test('any sound on the processed track starts the 2 s over', () => {
    const w = new SelfCheck()
    expect(run(w, 0, 1900, talking()).fallback).toBeNull()
    expect(w.observe(2000, { ctx: 'running', raw: speech, sent: 0.02, processed: true }).fallback).toBeNull()
    expect(run(w, 2100, 1800, (t) => talking()(t - 2100)).fallback).toBeNull()
  })

  test('without noise cancellation the sent sound is the microphone itself, so there is nothing to compare', () => {
    expect(run(new SelfCheck(), 0, 10_000, { ctx: 'running', raw: speech, sent: 0, processed: false }).fallback).toBeNull()
  })

  test('a microphone that delivers exact silence for 8 s is reported, once, and it clears when sound returns', () => {
    const w = new SelfCheck()
    const quiet: SelfCheckSample = { ctx: 'running', raw: 0, sent: 0, processed: false }
    expect(run(w, 0, DEAD_MIC_MS - 100, quiet).micDead).toBe(false)
    expect(w.observe(DEAD_MIC_MS, quiet).micDead).toBe(true)
    expect(w.observe(DEAD_MIC_MS + 100, { ...quiet, raw: hiss }).micDead).toBe(false)
  })

  test('hiss is a live microphone, not a dead one', () => {
    expect(run(new SelfCheck(), 0, 60_000, { ctx: 'running', raw: hiss, sent: hiss, processed: false }).micDead).toBe(false)
  })
})

describe('sound that is Not arriving', () => {
  const pub = (...entries: Array<[string, number | null]>) => entries.map(([id, bytes]) => ({ id, bytes }))

  test('a person whose bytes stop rising for 5 s is flagged; one whose bytes keep rising is not', () => {
    const w = new NotArrivingWatch()
    expect(w.update(0, pub(['ana', 100], ['ben', 100]))).toEqual([])
    expect(w.update(2000, pub(['ana', 400], ['ben', 100]))).toEqual([])
    expect(w.update(4900, pub(['ana', 900], ['ben', 100]))).toEqual([])
    expect(w.update(5000, pub(['ana', 1000], ['ben', 100]))).toEqual(['ben'])
    expect(w.update(9000, pub(['ana', 2000], ['ben', 100]))).toEqual(['ben'])
  })

  test('the flag clears the moment bytes arrive again', () => {
    const w = new NotArrivingWatch()
    w.update(0, pub(['ben', 100]))
    expect(w.update(NOT_ARRIVING_MS, pub(['ben', 100]))).toEqual(['ben'])
    expect(w.update(NOT_ARRIVING_MS + 1000, pub(['ben', 160]))).toEqual([])
  })

  test('someone who is publishing sound that was never subscribed to is flagged after the same 5 s', () => {
    const w = new NotArrivingWatch()
    expect(w.update(0, pub(['ben', null]))).toEqual([])
    expect(w.update(NOT_ARRIVING_MS - 1, pub(['ben', null]))).toEqual([])
    expect(w.update(NOT_ARRIVING_MS, pub(['ben', null]))).toEqual(['ben'])
  })

  test('a counter that goes down is a new connection, so it counts as arriving', () => {
    const w = new NotArrivingWatch()
    w.update(0, pub(['ben', 5000]))
    expect(w.update(NOT_ARRIVING_MS, pub(['ben', 5000]))).toEqual(['ben'])
    expect(w.update(NOT_ARRIVING_MS + 100, pub(['ben', 40]))).toEqual([])
  })

  test('someone who stops publishing sound is forgotten, and starts fresh if they come back', () => {
    const w = new NotArrivingWatch()
    w.update(0, pub(['ben', 100]))
    expect(w.update(NOT_ARRIVING_MS, pub(['ben', 100]))).toEqual(['ben'])
    expect(w.update(NOT_ARRIVING_MS + 100, pub())).toEqual([])
    expect(w.update(NOT_ARRIVING_MS + 200, pub(['ben', 100]))).toEqual([])
  })

  test('the answer is in a stable order', () => {
    const w = new NotArrivingWatch()
    w.update(0, pub(['zed', 1], ['amy', 1]))
    expect(w.update(NOT_ARRIVING_MS, pub(['zed', 1], ['amy', 1]))).toEqual(['amy', 'zed'])
  })
})

describe('the way back after a context fallback', () => {
  test('noise cancellation may return once the context has run for a second without a break, not before', () => {
    const r = new RecoveryWatch()
    expect(r.observe(0, 'suspended')).toBe(false)
    expect(r.observe(1000, 'running')).toBe(false)
    expect(r.observe(1000 + RECOVER_MS - 1, 'running')).toBe(false)
    expect(r.observe(1000 + RECOVER_MS, 'running')).toBe(true)
  })

  test('a context that drops again in between starts the second over', () => {
    const r = new RecoveryWatch()
    r.observe(0, 'running')
    expect(r.observe(500, 'interrupted')).toBe(false)
    expect(r.observe(600, 'running')).toBe(false)
    expect(r.observe(600 + RECOVER_MS, 'running')).toBe(true)
  })
})
