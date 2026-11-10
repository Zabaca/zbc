// The call: a grid of everyone with their names, a muted mark and a level bar
// (your own is the sound you send; theirs lights the tile while they speak). A
// tile says so when someone is sending sound that is not reaching you. When
// someone shares their screen it fills the main area and the cameras move to a
// strip (on a phone the share is on top and the cameras scroll below it).
// Controls: microphone, microphone picker, camera, Noise cancellation, Blur,
// Share screen, Copy link, Leave.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CallController, type RemoteStreams } from './call/controller'
import { ChatPanel } from './Chat'
import { Diagnostics } from './Diagnostics'
import { listDevices, onDevicesChange } from './effects/devices'
import { type LevelSource, resumeAudio } from './effects/levels'
import { LevelBar, noiseNotice, useAudioState } from './Level'
import type { JoinPlan } from './Lobby'
import { PREF, writeFlag } from './prefs'
import { callLink } from './site'
import { CopyLink, Icon, Wordmark, initials, type IconName } from './ui'

function Video({ stream, mirror = false, className }: { stream: MediaStream | null; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => {})
  }, [stream])
  return <video ref={ref} className={`${className ?? ''} ${mirror ? 'mirror' : ''}`} autoPlay muted playsInline />
}

/** True for the one refusal that a tap fixes; an interrupted play (the stream was swapped) is not that. */
const needsTap = (err: unknown): boolean => err instanceof DOMException && err.name === 'NotAllowedError'

/**
 * Plays one remote sound. If the browser refuses to start it, `onBlocked` raises the Tap to hear banner. If
 * something pauses it later (a phone call, a headset coming and going) it is started again, and refused again
 * means the banner again.
 */
function Sound({ stream, onBlocked }: { stream: MediaStream; onBlocked: () => void }) {
  const ref = useRef<HTMLAudioElement>(null)
  const blockedRef = useRef(onBlocked)
  blockedRef.current = onBlocked
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const start = () =>
      el.play().catch((err: unknown) => {
        if (needsTap(err)) blockedRef.current()
      })
    el.srcObject = stream
    void start()
    el.addEventListener('pause', start)
    return () => el.removeEventListener('pause', start)
  }, [stream])
  return <audio ref={ref} autoPlay data-testid="remote-sound" />
}

interface TileModel {
  id: string
  name: string
  you: boolean
  muted: boolean
  cameraOff: boolean
  stream: MediaStream | null
  /** Where this person's level comes from (null: they send no sound, or it is not subscribed yet). */
  levels: LevelSource | null
  /** Their sound is Not arriving: they are sending it and none is reaching you. */
  notArriving: boolean
}

function Tile({ t, compact }: { t: TileModel; compact?: boolean }) {
  const showVideo = t.stream !== null && !t.cameraOff
  return (
    <figure className={`tile ${compact ? 'tile-compact' : ''}`} data-testid={t.you ? 'tile-self' : 'tile'} data-member={t.id}>
      {showVideo ? <Video stream={t.stream} mirror={t.you} className="tile-video" /> : <div className="avatar">{initials(t.name)}</div>}
      {t.notArriving && (
        <span className="tile-flag" role="status" data-testid="tile-not-arriving" title="They are sending sound, but none of it is reaching you">
          No sound arriving
        </span>
      )}
      <figcaption className="tile-name">
        {t.muted && (
          <span className="mark" title="Muted" aria-label="Muted">
            <Icon name="micOff" />
          </span>
        )}
        <span>{t.you ? `${t.name} (you)` : t.name}</span>
        {t.levels && <LevelBar source={t.levels} label={t.you ? 'Your microphone level' : `${t.name}'s sound level`} />}
      </figcaption>
    </figure>
  )
}

function Ctl({
  icon,
  label,
  short,
  on,
  off,
  disabled,
  danger,
  title,
  onClick,
  testId,
  badge,
}: {
  icon: IconName
  label: string
  /** What the button says on a phone, where the full label does not fit. */
  short?: string
  on?: boolean
  off?: boolean
  disabled?: boolean
  danger?: boolean
  title?: string
  onClick: () => void
  testId?: string
  /** A count shown on the corner of the button when above zero (unread messages). */
  badge?: number
}) {
  return (
    <button
      type="button"
      className={`ctl ${on ? 'ctl-on' : ''} ${off ? 'ctl-off' : ''} ${danger ? 'ctl-danger' : ''}`}
      aria-pressed={on === undefined ? undefined : on}
      disabled={disabled}
      title={title ?? label}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name={icon} />
      {badge !== undefined && badge > 0 && (
        <span className="ctl-badge" data-testid={`${testId}-badge`} aria-label={`${badge} unread`}>
          {badge > 9 ? '9+' : badge}
        </span>
      )}
      {short ? (
        <>
          <span className="lbl-long">{label}</span>
          <span className="lbl-short">{short}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </button>
  )
}

export default function Call({
  plan,
  room,
  token,
  forceRelay,
  debug,
}: {
  plan: JoinPlan
  room: string
  token: string
  forceRelay: boolean
  debug: boolean
}) {
  const controller = useMemo(
    () => new CallController({ room, token, name: plan.name, audio: plan.audio, camera: plan.camera, forceRelay }),
    [room, token, plan, forceRelay],
  )
  const view = useSyncExternalStore(controller.subscribe, controller.getView)
  const audio = useAudioState(plan.audio)
  const [soundBlocked, setSoundBlocked] = useState(false)
  const [ownTrack, setOwnTrack] = useState<MediaStreamTrack>(plan.camera.outgoing)
  const [micOpen, setMicOpen] = useState(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const callRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLElement>(null)

  useEffect(() => {
    void controller.start()
    ;(window as unknown as { __meet?: CallController }).__meet = controller
    const off = plan.camera.subscribe(setOwnTrack)
    return () => off()
  }, [controller, plan.camera])

  // The microphone picker: who is plugged in now, kept current.
  useEffect(() => {
    const read = () => void listDevices().then((all) => setMics(all.filter((d) => d.kind === 'audioinput')))
    read()
    return onDevicesChange(read)
  }, [])

  // The phone's chat sheet, the microphone picker and the diagnostics all sit just above the controls bar, whose
  // height is not fixed (its buttons wrap on a narrow screen, and it pads for the home indicator): measure it.
  const ended = view.phase === 'ended'
  useEffect(() => {
    const bar = controlsRef.current
    const root = callRef.current
    if (!bar || !root) return
    const measure = () => root.style.setProperty('--controls-h', `${bar.offsetHeight}px`)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(bar)
    return () => watch.disconnect()
  }, [ended])

  const toggleChat = (open: boolean) => {
    setChatOpen(open)
    controller.setChatOpen(open)
  }

  const ownStream = useMemo(() => new MediaStream([ownTrack]), [ownTrack])

  // One stable subscription function per person, so their level bar subscribes once.
  const sources = useRef(new Map<string, LevelSource>())
  const levelsFor = useCallback(
    (id: string): LevelSource => {
      let source = sources.current.get(id)
      if (!source) {
        source = (fn) => controller.subscribeLevel(id, fn)
        sources.current.set(id, source)
      }
      return source
    },
    [controller],
  )

  const members = view.snapshot?.members ?? []
  const you = members.find((m) => m.id === view.selfId)
  const tiles: TileModel[] = members.map((m) => {
    const self = m.id === view.selfId
    return {
      id: m.id,
      name: m.name,
      you: self,
      muted: self ? view.muted : m.muted,
      cameraOff: self ? view.cameraOff : m.cameraOff,
      stream: self ? ownStream : (view.remote[m.id]?.camera ?? null),
      levels: self ? (plan.audio ? plan.audio.subscribeLevel : null) : m.publishing.some((p) => p.kind === 'mic') ? levelsFor(m.id) : null,
      notArriving: !self && view.notArriving.includes(m.id),
    }
  })
  // Anyone else's share we have a picture for. Your own is not mirrored back to you.
  const sharer = members.find((m) => m.id !== view.selfId && view.remote[m.id]?.screen)
  const shared = sharer ? view.remote[sharer.id]?.screen : undefined
  const sounds = Object.entries(view.remote).flatMap(([id, s]: [string, RemoteStreams]) =>
    ([s.mic, s.screenAudio].filter(Boolean) as MediaStream[]).map((stream, i) => ({ key: `${id}:${i}`, stream })),
  )

  // A tap is what a browser wants before it plays sound: start every sound again, and the audio context, and
  // keep the banner only if one of them is still refused.
  const unblock = useCallback(async () => {
    void resumeAudio()
    const refused = await Promise.all(
      [...document.querySelectorAll('audio')].map((a) =>
        a.play().then(
          () => false,
          (err: unknown) => needsTap(err),
        ),
      ),
    )
    setSoundBlocked(refused.some(Boolean))
  }, [])
  // While the banner is up, a tap anywhere on the page counts, not only a tap on the banner.
  useEffect(() => {
    if (!soundBlocked) return
    const tap = () => void unblock()
    const events = ['click', 'touchend', 'keydown'] // the inputs a browser counts as a tap
    for (const e of events) document.addEventListener(e, tap, { capture: true })
    return () => {
      for (const e of events) document.removeEventListener(e, tap, { capture: true })
    }
  }, [soundBlocked, unblock])
  const link = callLink(room)

  if (view.phase === 'ended') {
    return (
      <main className="page page-center">
        <Wordmark />
        <h1 className="title">{view.message ?? 'You left the call.'}</h1>
        {!view.message?.includes('paused') && !view.message?.includes('full') && (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Rejoin
          </button>
        )}
      </main>
    )
  }

  return (
    <div className="call" data-phase={view.phase} ref={callRef}>
      <header className="call-head">
        <Wordmark />
        <span className="count" data-testid="count">
          {view.snapshot ? `${view.snapshot.count} in the call` : 'Connecting'}
        </span>
        <span className={`badge badge-${view.link}`} data-testid="link-badge" title="How your picture and sound reach the call">
          {view.link === 'relayed' ? 'Relayed' : view.link === 'direct' ? 'Direct' : 'Connecting'}
        </span>
      </header>

      <div className="banners">
        {view.phase === 'reconnecting' && (
          <p className="banner" role="status">
            Reconnecting.
          </p>
        )}
        {view.phase === 'failed' && (
          <p className="banner banner-error" role="alert">
            {view.message ?? 'The connection was lost.'}
            <button type="button" className="btn btn-small" onClick={() => controller.rejoin()}>
              Rejoin
            </button>
          </p>
        )}
        {soundBlocked && (
          <p className="banner" role="status">
            <button type="button" className="btn btn-small btn-primary" onClick={() => void unblock()}>
              Tap to hear everyone
            </button>
          </p>
        )}
        {noiseNotice(audio) && (
          <p className="banner" role="status" data-testid="noise-notice">
            {noiseNotice(audio)}
          </p>
        )}
        {view.publishFailed.includes('mic') && (
          <p className="banner banner-error" role="alert" data-testid="mic-publish-failed">
            Your microphone could not be sent to the call, so others cannot hear you. Leave and join again, or try another browser.
          </p>
        )}
        {audio?.micDead && (
          <p className="banner banner-error" role="alert" data-testid="mic-dead">
            No sound is coming from your microphone. Check it, or choose another one under Input.
          </p>
        )}
        {view.micError && (
          <p className="banner banner-error" role="alert">
            {view.micError}
          </p>
        )}
        {view.busy && (
          <p className="banner" role="status">
            {view.busy}.
          </p>
        )}
      </div>

      <div className={`call-main ${chatOpen ? 'call-main-chat' : ''}`}>
        <main className={`stage ${shared ? 'stage-share' : ''}`} data-count={tiles.length}>
          {shared && sharer && (
            <section className="share" aria-label={`${sharer.name} is sharing their screen`}>
              <Video stream={shared} className="share-video" />
              <p className="share-name">{sharer.name} is sharing their screen</p>
            </section>
          )}
          <div className={shared ? 'strip' : 'grid'} data-n={Math.min(tiles.length, 8)}>
            {tiles.map((t) => (
              <Tile key={t.id} t={t} compact={Boolean(shared)} />
            ))}
          </div>
        </main>
        {chatOpen && (
          <ChatPanel
            messages={view.chat}
            mine={view.chatMine}
            error={view.chatError}
            onSend={(text) => controller.sendChat(text)}
            onClose={() => toggleChat(false)}
          />
        )}
      </div>

      {sounds.map((s) => (
        <Sound key={s.key} stream={s.stream} onBlocked={() => setSoundBlocked(true)} />
      ))}

      <footer className="controls" ref={controlsRef}>
        <Ctl
          icon={view.muted ? 'micOff' : 'mic'}
          label={view.muted ? 'Unmute' : 'Mute'}
          off={view.muted}
          disabled={!plan.audio}
          title={plan.audio ? undefined : 'No microphone'}
          onClick={() => controller.setMuted(!view.muted)}
          testId="ctl-mic"
        />
        <Ctl
          icon="settings"
          label="Microphone"
          short="Input"
          on={micOpen}
          disabled={!plan.audio}
          title={plan.audio ? 'Choose which microphone is used' : 'No microphone'}
          onClick={() => setMicOpen(!micOpen)}
          testId="ctl-input"
        />
        <Ctl
          icon={view.cameraOff ? 'camOff' : 'cam'}
          label={view.cameraOff ? 'Camera on' : 'Camera off'}
          short={view.cameraOff ? 'Cam on' : 'Cam off'}
          off={view.cameraOff}
          disabled={!plan.camera.available}
          title={plan.camera.available ? undefined : 'No camera'}
          onClick={() => void controller.setCameraOff(!view.cameraOff)}
          testId="ctl-camera"
        />
        <Ctl
          icon="noise"
          label="Noise cancellation"
          short="Noise"
          on={view.noise}
          disabled={!audio?.supportsNoise}
          title={
            audio && !audio.supportsNoise ? 'Not available in this browser' : audio?.fallback ? 'Try noise cancellation again' : undefined
          }
          onClick={() => {
            // What the person asked for is what is remembered, even if the browser cannot do it right now.
            void controller.setNoise(!view.noise)
            writeFlag(PREF.noise, !view.noise)
          }}
          testId="ctl-noise"
        />
        <Ctl
          icon="blur"
          label="Blur"
          on={view.blur}
          disabled={view.cameraOff || Boolean(view.busy)}
          onClick={() =>
            void controller.setBlur(!view.blur).then(() => {
              // After it settles, so a blur that could not start is not remembered as on.
              writeFlag(PREF.blur, controller.getView().blur)
            })
          }
          testId="ctl-blur"
        />
        {controller.canShare && (
          <Ctl
            icon="screen"
            label={view.sharing ? 'Stop sharing' : 'Share screen'}
            short={view.sharing ? 'Stop' : 'Share'}
            on={view.sharing}
            onClick={() => void (view.sharing ? controller.stopShare() : controller.startShare())}
            testId="ctl-share"
          />
        )}
        <Ctl
          icon="chat"
          label="Chat"
          title="Chat. Messages in this chat are saved."
          on={chatOpen}
          badge={chatOpen ? 0 : view.chatUnread}
          onClick={() => toggleChat(!chatOpen)}
          testId="ctl-chat"
        />
        <CopyLink href={link} className="ctl ctl-link" />
        <Ctl icon="leave" label="Leave" danger onClick={() => void controller.leave()} testId="ctl-leave" />
      </footer>
      {micOpen && plan.audio && (
        <section className="popover" role="group" aria-label="Microphone" data-testid="mic-popover">
          <label className="field">
            <span>Microphone</span>
            <select
              value={mics.some((d) => d.deviceId === audio?.micId) ? audio?.micId : ''}
              onChange={(e) => void controller.setMic(e.target.value || undefined)}
              data-testid="mic-select"
            >
              {!mics.some((d) => d.deviceId === audio?.micId) && <option value="">{audio?.micLabel || 'Default'}</option>}
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
            </select>
          </label>
          <LevelBar source={plan.audio.subscribeLevel} label="Microphone level" className="level-lg" />
        </section>
      )}
      {debug && <Diagnostics audio={plan.audio} controller={controller} view={view} />}
      <span hidden data-testid="you">
        {you?.name ?? ''}
      </span>
    </div>
  )
}
