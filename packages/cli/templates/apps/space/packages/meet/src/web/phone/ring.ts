// The ring sound for a call to the line's number: the usual two tones, two seconds on and four off, made with the browser's own
// audio (no file). A page that has had no tap yet may be refused sound by the browser; the banner and the flashing title still show.

import { useEffect } from 'react'
import { RING_OFF_MS, RING_ON_MS } from './state'

export function useRingTone(on: boolean): void {
  useEffect(() => {
    if (!on) return
    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch {
      return
    }
    const beep = () => {
      void ctx.resume().catch(() => undefined)
      const gain = ctx.createGain()
      gain.gain.value = 0.06
      gain.connect(ctx.destination)
      for (const hz of [440, 480]) {
        const osc = ctx.createOscillator()
        osc.frequency.value = hz
        osc.connect(gain)
        osc.start()
        osc.stop(ctx.currentTime + RING_ON_MS / 1000)
      }
    }
    beep()
    const id = setInterval(beep, RING_ON_MS + RING_OFF_MS)
    return () => {
      clearInterval(id)
      void ctx.close().catch(() => undefined)
    }
  }, [on])
}
