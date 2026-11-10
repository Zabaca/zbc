// The level bar and the speaking light. Readings arrive about every 80 ms from the
// pipeline (your own microphone) or the controller (someone else's), so they are
// written straight onto the element and never go through React state: a call
// that re-rendered eight times a second per person would be the expensive part.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AudioPipeline, AudioState } from './effects/audio'
import type { LevelSource } from './effects/levels'

export function LevelBar({ source, label, className = '' }: { source: LevelSource; label: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      source((r) => {
        const el = ref.current
        if (!el) return
        const pct = String(Math.round(r.level * 100))
        if (el.dataset.level !== pct) {
          el.dataset.level = pct
          el.style.setProperty('--level', String(r.level))
          el.setAttribute('aria-valuenow', pct)
        }
        // The tile around the bar gets its speaking light while the person speaks.
        const tile = el.closest('.tile')
        const speaking = String(r.speaking)
        if (tile && tile.getAttribute('data-speaking') !== speaking) tile.setAttribute('data-speaking', speaking)
      }),
    [source],
  )
  return (
    <span
      ref={ref}
      className={`level ${className}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      data-level="0"
      data-testid="level"
    >
      <i />
    </span>
  )
}

const noSubscription = () => () => {}
const noState = () => null

/** The pipeline's state (audio context, path, fallback) as React state. Null when there is no microphone. */
export function useAudioState(audio: AudioPipeline | null): AudioState | null {
  return useSyncExternalStore(audio ? audio.subscribeState : noSubscription, audio ? audio.getState : noState)
}

/**
 * The sentence for noise cancellation that was asked for and is not in use, or null. A path that was working and
 * then stopped (the Self-check caught it mid-call) says so; one that never started says that.
 */
export function noiseNotice(state: AudioState | null): string | null {
  if (!state?.fallback) return null
  return state.stopped
    ? 'Noise cancellation stopped working; sending your mic without it. Switch it on to try again.'
    : "Noise cancellation couldn't start in this browser; sending your mic without it."
}
