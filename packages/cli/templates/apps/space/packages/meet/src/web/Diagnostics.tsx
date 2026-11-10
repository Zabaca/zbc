// The panel behind ?debug=1: what the sound is doing, as plain lines to screenshot
// when something goes wrong. Refreshes once a second and costs nothing when off.

import { useEffect, useState } from 'react'
import type { CallController, CallView } from './call/controller'
import type { AudioPipeline } from './effects/audio'
import { useAudioState } from './Level'

const trackLine = (t: MediaStreamTrack | null): string =>
  t ? `enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}` : 'none'

const PATHS = {
  processed: 'processed (noise cancellation, RNNoise)',
  graph: 'raw mic through the audio graph (noise cancellation off)',
  direct: 'raw mic track, no audio graph',
} as const

export function Diagnostics({
  audio,
  controller,
  view,
  inline = false,
}: {
  audio: AudioPipeline | null
  controller?: CallController
  view?: CallView
  /** In the page's flow (the lobby) rather than floating over the call. */
  inline?: boolean
}) {
  const state = useAudioState(audio)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const stats = controller?.getAudioStats()
  const names = new Map((view?.snapshot?.members ?? []).map((m) => [m.id, m.name]))
  const lines: Array<[string, string]> = [
    ['audio context', audio ? `${state?.ctx ?? '?'}${audio.context.sampleRate ? ` at ${audio.context.sampleRate} Hz` : ''}` : 'none (no microphone)'],
    ['sending', state ? PATHS[state.path] : 'nothing'],
    ['noise cancellation', state ? `${state.noise ? 'on' : 'off'}${state.fallback ? `, fell back${state.stopped ? ' mid-call' : ''}: ${state.fallback}` : ''}` : '-'],
    ['worklet', state ? (state.workletError ? `failed: ${state.workletError}` : 'loaded') : '-'],
    ['graph', state?.graphError ? `failed: ${state.graphError}` : 'ok'],
    ['sent track', trackLine(audio?.outgoing ?? null)],
    ['mic', state ? `${state.micLabel || '(no label)'} [${state.micId.slice(0, 8)}]${state.micDead ? ' NO SOUND' : ''}` : '-'],
    ['mic level (rms)', audio ? `raw ${audio.lastRaw.toFixed(4)}, sent ${audio.lastSent.toFixed(4)}` : '-'],
  ]
  if (view) {
    lines.push(['muted by you', String(view.muted)])
    lines.push(['bytes out (audio)', stats ? String(stats.outBytes) : '-'])
    const inbound = stats ? Object.entries(stats.inbound) : []
    if (inbound.length === 0) lines.push(['bytes in (audio)', 'nobody'])
    for (const [id, bytes] of inbound) {
      const late = view.notArriving.includes(id)
      lines.push([`bytes in: ${names.get(id) ?? id.slice(0, 6)}`, `${bytes}${late ? '  NOT ARRIVING' : ''}`])
    }
    for (const m of view.snapshot?.members ?? []) {
      if (m.id !== view.selfId && m.publishing.some((p) => p.kind === 'mic') && !(m.id in (stats?.inbound ?? {})))
        lines.push([`bytes in: ${m.name}`, `no subscription${view.notArriving.includes(m.id) ? '  NOT ARRIVING' : ''}`])
    }
    lines.push(['publish failed', view.publishFailed.length ? view.publishFailed.join(', ') : 'none'])
    lines.push(['connection', `${view.phase}, ${view.link}`])
  }
  lines.push(['browser', navigator.userAgent])

  return (
    <aside className={`diag ${inline ? 'diag-inline' : ''}`} data-testid="diag" aria-label="Diagnostics">
      <dl>
        {lines.map(([k, v], i) => (
          <div key={i}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}
