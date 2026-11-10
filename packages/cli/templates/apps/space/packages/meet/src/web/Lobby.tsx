// The lobby before joining: your own camera, a name, the microphone and camera
// pickers, the two effect switches, a level bar for the sound that will be sent,
// and how many are already in the call. One permission request opens the camera
// and microphone; Join hands both on to the call so the person is not asked twice.
//
// The microphone graph (effects/audio.ts) is built here, not at Join, so the
// level bar shows what the call would send and the noise switch works on it live.

import { useEffect, useRef, useState } from 'react'
import { CHAT_SAVED_NOTICE, type RoomInfo } from '../model'
import type { PausedInfo } from './api'
import { Diagnostics } from './Diagnostics'
import { AudioPipeline, micConstraints } from './effects/audio'
import { CameraSource, cameraConstraints } from './effects/camera'
import { listDevices, onDevicesChange } from './effects/devices'
import { closeSharedAudioContext, resumeAudio } from './effects/levels'
import { LevelBar, noiseNotice, useAudioState } from './Level'
import { PREF, nameFromLink, readPref, writeFlag, writePref } from './prefs'
import { callLink } from './site'
import { CopyLink, Icon, Wordmark } from './ui'

export interface JoinPlan {
  name: string
  audio: AudioPipeline | null
  camera: CameraSource
}

/** A sentence for a refused or missing device, saying what to do. */
function deviceMessage(err: unknown, what: 'camera' | 'microphone'): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Your browser is blocking the ${what}. Click the lock or camera icon beside the address, allow the ${what}, then reload this page.`
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what} was found. You can still join without it.`
  return `The ${what} could not be opened. Another app may be using it. You can still join without it.`
}

const MIC_SWITCH_FAILED = 'That microphone could not be opened. Your last one is still in use.'

export default function Lobby({
  room,
  info,
  blurPath,
  debug,
  onJoin,
}: {
  room: string
  info: RoomInfo & PausedInfo
  blurPath: 'auto' | 'canvas'
  debug: boolean
  onJoin: (plan: JoinPlan) => void
}) {
  const [name, setName] = useState(() => nameFromLink(window.location.search) ?? readPref(PREF.name, ''))
  const [noise, setNoise] = useState(() => readPref(PREF.noise, '1') === '1')
  const [blur, setBlur] = useState(() => readPref(PREF.blur, '0') === '1')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [camId, setCamId] = useState<string | undefined>()
  const [camera, setCamera] = useState<CameraSource | null>(null)
  const [pipeline, setPipeline] = useState<AudioPipeline | null>(null)
  const [micPending, setMicPending] = useState(true)
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const blurRef = useRef(blur)
  blurRef.current = blur
  const noiseRef = useRef(noise)
  noiseRef.current = noise
  const handedOn = useRef(false)
  const held = useRef<{ camera: CameraSource | null; pipeline: AudioPipeline | null }>({ camera: null, pipeline: null })
  const audio = useAudioState(pipeline)

  // Open the camera and microphone, the camera again whenever its picker changes. The microphone is
  // opened once, with the camera so there is one permission prompt; its picker has its own handler.
  useEffect(() => {
    let live = true
    const found: string[] = []
    ;(async () => {
      const wantMic = held.current.pipeline === null
      let micStream: MediaStream | null = null
      let camTrack: MediaStreamTrack | null = null
      try {
        const both = await navigator.mediaDevices.getUserMedia({
          audio: wantMic ? micConstraints() : false,
          video: cameraConstraints(camId),
        })
        micStream = both.getAudioTracks().length > 0 ? new MediaStream(both.getAudioTracks()) : null
        camTrack = both.getVideoTracks()[0] ?? null
      } catch {
        // One of them is refused or missing: ask for each on its own so the message can say which.
        if (wantMic) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() })
          } catch (e) {
            found.push(deviceMessage(e, 'microphone'))
          }
        }
        try {
          camTrack = (await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(camId) })).getVideoTracks()[0] ?? null
        } catch (e) {
          found.push(deviceMessage(e, 'camera'))
        }
      }
      if (!live) {
        micStream?.getTracks().forEach((t) => t.stop())
        camTrack?.stop()
        return
      }
      // A picker changed: let go of the camera opened before.
      held.current.camera?.stop()
      const source = new CameraSource(camTrack, camId, false, blurPath)
      source.onBlurError = (m) => setProblems((p) => (p.includes(m) ? p : [...p, m]))
      setCamera(source)
      setProblems(found)
      setDevices(await listDevices())
      if (micStream) {
        try {
          const made = await AudioPipeline.create(micStream, noiseRef.current)
          if (!live) {
            made.stop()
            return
          }
          held.current.pipeline = made
          // For scripts/audio.ts (as __meet is for live.ts): in dev and behind ?debug=1 only.
          if (debug || import.meta.env.DEV) (window as unknown as { __meetAudio?: AudioPipeline }).__meetAudio = made
          setPipeline(made)
        } catch (err) {
          console.warn('the microphone could not be set up', err)
          micStream.getTracks().forEach((t) => t.stop())
          setProblems((p) => [...p, 'The microphone could not be set up in this browser. You can still join without it.'])
        }
      }
      setMicPending(false)
      if (blurRef.current && camTrack) {
        setBusy('Loading background blur')
        await source.setBlur(true)
        if (live) setBusy(null)
      }
    })()
    return () => {
      live = false
    }
  }, [camId, blurPath])

  // Release the devices if the person leaves the lobby without joining.
  held.current.camera = camera
  useEffect(
    () => () => {
      if (handedOn.current) return
      held.current.camera?.stop()
      held.current.pipeline?.stop()
      closeSharedAudioContext()
    },
    [],
  )

  useEffect(() => onDevicesChange(() => void listDevices().then(setDevices)), [])

  // A browser starts the audio context only after a tap on the page; the first one wakes it. This is listened for
  // from the moment the lobby opens, not once the microphone is ready: Safari can hold the worklet's load until
  // the context runs, and the microphone is not ready until the worklet has loaded.
  useEffect(() => {
    const wake = () => void (held.current.pipeline ? held.current.pipeline.resume() : resumeAudio())
    const events = ['click', 'touchend', 'keydown'] // the inputs a browser counts as a tap
    for (const e of events) document.addEventListener(e, wake, { capture: true })
    return () => {
      for (const e of events) document.removeEventListener(e, wake, { capture: true })
    }
  }, [])

  // Show what others will get: the raw camera or the blurred track.
  useEffect(() => {
    const el = videoRef.current
    if (!el || !camera) return
    const show = (t: MediaStreamTrack) => {
      el.srcObject = new MediaStream([t])
      void el.play().catch(() => {})
    }
    show(camera.outgoing)
    return camera.subscribe(show)
  }, [camera])

  async function toggleBlur() {
    const next = !blur
    setBlur(next)
    writeFlag(PREF.blur, next)
    if (!camera) return
    setBusy(next ? 'Loading background blur' : null)
    await camera.setBlur(next)
    setBlur(camera.blur)
    setBusy(null)
  }

  async function changeMic(deviceId: string) {
    if (!pipeline) return
    try {
      await pipeline.switchMic(deviceId || undefined)
      setProblems((p) => p.filter((m) => m !== MIC_SWITCH_FAILED))
      setDevices(await listDevices())
    } catch (err) {
      console.warn('could not switch microphone', err)
      setProblems((p) => (p.includes(MIC_SWITCH_FAILED) ? p : [...p, MIC_SWITCH_FAILED]))
    }
  }

  async function join() {
    if (!camera) return
    setJoining(true)
    const clean = name.replace(/\s+/g, ' ').trim()
    writePref(PREF.name, clean)
    writeFlag(PREF.noise, noise)
    // Here, inside the tap, so the audio context is allowed to start.
    const awake = pipeline?.resume()
    await awake
    handedOn.current = true
    onJoin({ name: clean, audio: pipeline, camera })
  }

  const link = callLink(room)
  const mics = devices.filter((d) => d.kind === 'audioinput')
  const cams = devices.filter((d) => d.kind === 'videoinput')
  const blocked = info.paused ? `Calls are paused until ${info.pausedUntil}.` : info.full ? 'This call is full.' : null
  const hasCamera = camera !== null && camera.available && !camera.cameraOff
  const micChosen = mics.some((d) => d.deviceId === audio?.micId) ? (audio?.micId ?? '') : ''
  const levelHint = !audio
    ? ''
    : audio.micDead
      ? 'No sound from this microphone. Check it, or pick another one.'
      : audio.ctx !== 'running'
        ? audio.fallback === 'context'
          ? "This browser would not start its audio engine, so there is no level bar. Your microphone is still sent."
          : 'Tap anywhere to start the microphone level.'
        : 'Microphone level, as others will hear it'
  const fallbackNotice = noiseNotice(audio)

  return (
    <main className="page lobby">
      <header className="lobby-head">
        <Wordmark />
        <p className="count" data-testid="in-call">
          {info.count === 0
            ? 'No one is in the call yet'
            : info.count === 1
              ? '1 person is in the call'
              : `${info.count} people are in the call`}
        </p>
      </header>

      <div className="lobby-body">
        <div className="preview-col">
          <section className="preview" aria-label="Your camera">
            <video ref={videoRef} className="mirror" autoPlay muted playsInline />
            {!hasCamera && <div className="preview-off">{camera === null ? 'Opening your camera' : 'Camera off'}</div>}
            {busy && <div className="preview-busy">{busy}</div>}
          </section>
          {pipeline && (
            <div className="level-row" data-testid="lobby-level">
              <Icon name="mic" />
              <LevelBar source={pipeline.subscribeLevel} label="Microphone level" className="level-lg" />
              <small className={audio?.micDead ? 'level-hint level-hint-warn' : 'level-hint'}>{levelHint}</small>
            </div>
          )}
        </div>

        <section className="lobby-form">
          <h1 className="title title-sm">Ready to join?</h1>
          <label className="field">
            <span>Your name</span>
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Guest" autoComplete="name" />
          </label>
          {mics.length > 1 && (
            <label className="field">
              <span>Microphone</span>
              <select value={micChosen} onChange={(e) => void changeMic(e.target.value)} disabled={!pipeline} data-testid="mic-select">
                {micChosen === '' && <option value="">Default</option>}
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Microphone'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {cams.length > 1 && (
            <label className="field">
              <span>Camera</span>
              <select value={camId ?? ''} onChange={(e) => setCamId(e.target.value || undefined)}>
                <option value="">Default</option>
                {cams.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Camera'}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="switches">
            <label className="switch">
              <input
                type="checkbox"
                checked={audio ? audio.noise : noise}
                disabled={audio !== null && !audio.supportsNoise}
                onChange={(e) => {
                  setNoise(e.target.checked)
                  void pipeline?.setNoiseCancellation(e.target.checked) // inside the tap: wakes the audio context
                }}
                data-testid="lobby-noise"
              />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">
                <strong>Noise cancellation</strong>
                <small>Keeps fans, typing and street sound out of what others hear</small>
              </span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={blur} onChange={() => void toggleBlur()} disabled={!camera || !camera.available} />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-label">
                <strong>Blur background</strong>
                <small>Uses more battery. Downloads about 15 MB the first time</small>
              </span>
            </label>
          </div>

          {fallbackNotice && (
            <p className="notice" role="status" data-testid="noise-notice">
              {fallbackNotice}
            </p>
          )}
          {problems.map((p) => (
            <p key={p} className="notice notice-error" role="alert">
              {p}
            </p>
          ))}
          {blocked && (
            <p className="notice notice-error" role="alert">
              {blocked}
            </p>
          )}

          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-big"
              onClick={() => void join()}
              disabled={!camera || micPending || joining || blocked !== null}
            >
              <Icon name="cam" />
              <span>{joining ? 'Joining' : 'Join'}</span>
            </button>
            <CopyLink href={link} />
          </div>
          <p className="fine" data-testid="lobby-chat-notice">
            This call has a chat. {CHAT_SAVED_NOTICE}
          </p>
        </section>
      </div>
      {debug && <Diagnostics audio={pipeline} inline />}
    </main>
  )
}
