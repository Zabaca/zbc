// The browser's side of one call. It owns:
//
//   - two peer connections to the SFU, one that only sends and one that only
//     receives, each with its own first-in-first-out queue (queue.ts),
//   - the check-in loop, which is both the heartbeat and the read of who is in
//     the call and what each person is sending,
//   - the reconciler's output turned into subscribe and unsubscribe batches,
//   - reconnecting, and the quality step.
//
// The effects (audio.ts, camera.ts, screen.ts) hand it finished tracks. It never
// processes media itself. The server's rules and the SFU calls live behind
// api.ts; this file never sees a session id.

import { CHECKIN_MS, type ChatMessage, type Kind, type Snapshot } from '../../model'
import { ApiError, type IceServer, api } from '../api'
import type { AudioPipeline } from '../effects/audio'
import type { CameraSource } from '../effects/camera'
import { type LevelReading, StreamLevel, closeSharedAudioContext, everyFrame, sharedAudioContext } from '../effects/levels'
import { type Share, canShareScreen, captureScreen } from '../effects/screen'
import { NotArrivingWatch, Speaking, toLevel } from './audio-health'
import { checkInFailure } from './checkin'
import { mergeMessages, rememberMine, unreadCount } from './chat'
import { SerialQueue } from './queue'
import { sendPlan } from './quality'
import { type Pub, keyOf, reconcile } from './reconcile'

export type Phase = 'connecting' | 'live' | 'reconnecting' | 'failed' | 'ended'
export type Link = 'direct' | 'relayed' | 'unknown'
export type RemoteStreams = Partial<Record<Kind, MediaStream>>

export interface CallView {
  phase: Phase
  /** A plain sentence for the person when something is wrong, or null. */
  message: string | null
  selfId: string | null
  snapshot: Snapshot | null
  remote: Record<string, RemoteStreams>
  link: Link
  sharing: boolean
  muted: boolean
  cameraOff: boolean
  noise: boolean
  blur: boolean
  /** Something is loading for an effect (the blur engine downloads the first time). */
  busy: string | null
  /** People whose sound is Not arriving: they are publishing it and none has reached this browser for a few seconds. */
  notArriving: string[]
  /** Kinds this tab tried to publish that the SFU refused (the person is told when it is the microphone). */
  publishFailed: Kind[]
  /** A microphone that could not be switched to, as a sentence. */
  micError: string | null
  /** The call's chat, oldest first: what this browser has been sent so far. */
  chat: ChatMessage[]
  /** Messages from others since you arrived (or last had the chat open). */
  chatUnread: number
  /** The member ids that are you in this chat: the one you have now and any you had before a drop. */
  chatMine: string[]
  /** Why the last message was not sent, as a sentence, or null. */
  chatError: string | null
}

/** What the last audio statistics poll saw, for the diagnostics panel. */
export interface AudioStats {
  /** Bytes of audio this tab has sent. */
  outBytes: number
  /** Bytes of microphone sound received, per member (null: nothing subscribed to yet). */
  inbound: Record<string, number | null>
}

interface RemoteLevel {
  level: StreamLevel
  speaking: Speaking
  last: LevelReading
}

export interface CallOptions {
  room: string
  token: string
  name: string
  audio: AudioPipeline | null
  camera: CameraSource
  forceRelay: boolean
}

const RECONNECT_TRIES = 3
const STALE_AFTER_FAILURES = 3
const RETRY_PAUSE_MS = 10_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface Link2 {
  pc: RTCPeerConnection
  queue: SerialQueue
}

export class CallController {
  private view: CallView
  private listeners = new Set<() => void>()
  private gen = 0
  private selfId = ''
  private send: Link2 | null = null
  private recv: Link2 | null = null
  private senders = new Map<Kind, RTCRtpSender>()
  private transceivers = new Map<Kind, RTCRtpTransceiver>()
  private share: Share | null = null
  private held = new Map<string, Pub>()
  private midMap = new Map<string, Pub>()
  private retryAfter = new Map<string, number>()
  private quality: Snapshot['quality'] = 'full'
  private timer: ReturnType<typeof setTimeout> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private failures = 0
  private reconnecting = false
  private closed = false
  private unsubscribeCamera: () => void
  private unsubscribeAudio: Array<() => void> = []
  private remoteLevels = new Map<string, RemoteLevel>()
  private levelListeners = new Map<string, Set<(r: LevelReading) => void>>()
  private stopLevels: (() => void) | null = null
  private audioTimer: ReturnType<typeof setInterval> | null = null
  private ownLevelTimer: ReturnType<typeof setInterval> | null = null
  private notArrivingWatch = new NotArrivingWatch()
  private audioStats: AudioStats = { outBytes: 0, inbound: {} }
  /** Chat: the newest message id held (asked for at the next check-in), the newest in the call when this person joined (history), and the newest read. */
  private chatSince = 0
  private chatBaseline: number | null = null
  private chatReadUpTo = 0
  /** Every member id this person has had in this call (a rejoin after a drop is a new one). */
  private mine = new Set<string>()
  private joinedBefore = false
  private chatOpen = false

  constructor(private readonly o: CallOptions) {
    this.view = {
      phase: 'connecting',
      message: null,
      selfId: null,
      snapshot: null,
      remote: {},
      link: 'unknown',
      sharing: false,
      muted: false,
      cameraOff: o.camera.cameraOff,
      noise: o.audio?.noiseCancellation ?? false,
      blur: o.camera.blur,
      busy: null,
      notArriving: [],
      publishFailed: [],
      micError: null,
      chat: [],
      chatUnread: 0,
      chatMine: [],
      chatError: null,
    }
    this.unsubscribeCamera = o.camera.subscribe((track) => void this.swapCamera(track))
    if (o.audio) {
      const audio = o.audio
      this.unsubscribeAudio = [
        audio.subscribeOutgoing((track) => void this.swapMic(track)),
        audio.subscribeState(() => this.set({ noise: audio.noiseCancellation })),
      ]
    }
  }

  // --- For React ------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getView = (): CallView => this.view

  private set(patch: Partial<CallView>): void {
    this.view = { ...this.view, ...patch }
    for (const fn of this.listeners) fn()
  }

  get canShare(): boolean {
    return canShareScreen()
  }

  // --- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    try {
      await this.connect()
      this.set({ phase: 'live', message: null })
      this.loop()
      this.startTimers()
    } catch (err) {
      this.fail(err)
    }
  }

  /** Leave on purpose. */
  async leave(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const gen = this.gen
    this.teardownLinks()
    this.stopTimers()
    this.share?.stop()
    this.unsubscribeCamera()
    this.unsubscribeAudio.forEach((off) => off())
    await api.leave(this.o.room, this.o.token, gen)
    this.releaseMedia()
    this.set({ phase: 'ended', message: null, remote: {} })
  }

  /** The Rejoin button, after the automatic tries have run out. */
  rejoin(): void {
    void this.reconnect(true)
  }

  private fail(err: unknown): void {
    this.stopTimers()
    this.teardownLinks()
    if (err instanceof ApiError && (err.status === 403 || err.status === 404 || err.status === 409)) {
      this.set({ phase: 'ended', message: err.message })
      this.releaseMedia()
      return
    }
    console.warn('call failed', err)
    this.set({ phase: 'failed', message: err instanceof ApiError ? err.message : 'The connection could not be made.' })
  }

  private releaseMedia(): void {
    this.o.camera.stop()
    this.o.audio?.stop()
    closeSharedAudioContext()
  }

  /** The looks that run for the whole call. A Rejoin after the connection failed starts them again. */
  private startTimers(): void {
    this.statsTimer ??= setInterval(() => void this.readLink(), 3000)
    this.audioTimer ??= setInterval(() => void this.pollAudio(), 1000)
    this.ownLevelTimer ??= setInterval(() => void this.pollOwnLevel(), 250)
    this.stopLevels ??= everyFrame(this.sampleRemote)
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.audioTimer) clearInterval(this.audioTimer)
    if (this.ownLevelTimer) clearInterval(this.ownLevelTimer)
    this.stopLevels?.()
    this.timer = null
    this.statsTimer = null
    this.audioTimer = null
    this.ownLevelTimer = null
    this.stopLevels = null
  }

  // --- Connecting -----------------------------------------------------------

  /** Join (or rejoin under the same token), open both connections, and publish what is being sent. */
  private async connect(): Promise<void> {
    const joined = await api.join(this.o.room, this.o.token, this.o.name)
    this.gen = joined.generation
    this.selfId = joined.memberId
    this.quality = joined.snapshot.quality
    this.chatBaseline ??= joined.chatLast
    this.mine = rememberMine(this.o.room, joined.memberId)
    if (this.joinedBefore) {
      // Back after a drop or a reconnect: your own earlier messages, sent under the id you had then, are still yours.
      // Nothing else changes what is read, so messages you had not opened stay unread.
      this.set({ chatMine: [...this.mine], chatUnread: unreadCount(this.view.chat, this.mine, this.chatBaseline, this.chatReadUpTo) })
    } else this.set({ chatMine: [...this.mine] })
    this.joinedBefore = true
    this.set({ selfId: joined.memberId, snapshot: joined.snapshot, publishFailed: [] })
    const gen = this.gen
    this.openLinks(joined.iceServers)
    await this.publishInitial()
    if (gen !== this.gen) return
    this.onSnapshot(joined.snapshot)
  }

  private openLinks(iceServers: IceServer[]): void {
    const config: RTCConfiguration = {
      iceServers,
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: this.o.forceRelay ? 'relay' : 'all',
    }
    const send = new RTCPeerConnection(config)
    const recv = new RTCPeerConnection(config)
    for (const pc of [send, recv]) {
      pc.addEventListener('connectionstatechange', () => {
        if (this.closed || (pc !== this.send?.pc && pc !== this.recv?.pc)) return
        if (pc.connectionState === 'failed') void this.reconnect(false)
        if (pc.connectionState === 'disconnected') {
          // A blip often heals itself; give it a few seconds first.
          setTimeout(() => {
            if (!this.closed && pc.connectionState !== 'connected' && (pc === this.send?.pc || pc === this.recv?.pc))
              void this.reconnect(false)
          }, 6000)
        }
      })
    }
    recv.addEventListener('track', (ev) => {
      const info = ev.transceiver.mid ? this.midMap.get(ev.transceiver.mid) : undefined
      if (!info) return
      const stream = new MediaStream([ev.track])
      if (info.kind === 'mic') this.watchLevel(info.memberId, stream)
      this.set({ remote: { ...this.view.remote, [info.memberId]: { ...this.view.remote[info.memberId], [info.kind]: stream } } })
    })
    this.send = { pc: send, queue: new SerialQueue() }
    this.recv = { pc: recv, queue: new SerialQueue() }
  }

  private teardownLinks(): void {
    this.send?.pc.close()
    this.recv?.pc.close()
    this.send = null
    this.recv = null
    this.senders.clear()
    this.transceivers.clear()
    this.held.clear()
    this.midMap.clear()
    this.retryAfter.clear()
    for (const id of [...this.remoteLevels.keys()]) this.dropLevel(id)
    this.notArrivingWatch = new NotArrivingWatch()
    this.set({ remote: {}, link: 'unknown', notArriving: [] })
  }

  /** The first publication after a join: microphone and camera, plus a share that was running. */
  private async publishInitial(): Promise<void> {
    const parts: Array<{ kind: Kind; track: MediaStreamTrack }> = []
    if (this.o.audio) parts.push({ kind: 'mic', track: this.o.audio.outgoing })
    parts.push({ kind: 'camera', track: this.o.camera.outgoing })
    if (this.share) {
      parts.push({ kind: 'screen', track: this.share.video })
      if (this.share.audio) parts.push({ kind: 'screenAudio', track: this.share.audio })
    }
    await this.publish(parts)
  }

  /** Add transceivers for `parts`, send the whole offer, apply the SFU's answer. */
  private publish(parts: Array<{ kind: Kind; track: MediaStreamTrack }>): Promise<void> {
    const link = this.send
    if (!link) return Promise.resolve()
    const gen = this.gen
    return link.queue.run(async () => {
      if (gen !== this.gen) return
      const added = parts.map((p) => {
        const tr = link.pc.addTransceiver(p.track, { direction: 'sendonly' })
        this.transceivers.set(p.kind, tr)
        this.senders.set(p.kind, tr.sender)
        return { kind: p.kind, tr }
      })
      await link.pc.setLocalDescription(await link.pc.createOffer())
      const offer = link.pc.localDescription?.sdp ?? ''
      const res = await api.publish(
        this.o.room,
        this.o.token,
        gen,
        offer,
        added.map((a) => ({ kind: a.kind, mid: a.tr.mid ?? '' })),
      )
      if (res.answer) await link.pc.setRemoteDescription({ type: 'answer', sdp: res.answer })
      for (const f of res.failed) console.warn(`could not publish ${f.kind}: ${f.error}`)
      if (res.failed.length > 0) this.set({ publishFailed: [...new Set([...this.view.publishFailed, ...res.failed.map((f) => f.kind)])] })
      await Promise.all(added.map((a) => this.applyCaps(a.kind)))
    })
  }

  private async unpublish(kinds: Kind[]): Promise<void> {
    const link = this.send
    if (!link) return
    const gen = this.gen
    await link.queue.run(async () => {
      if (gen !== this.gen) return
      for (const k of kinds) {
        const tr = this.transceivers.get(k)
        if (tr) tr.direction = 'inactive'
      }
      await link.pc.setLocalDescription(await link.pc.createOffer())
      const res = await api.unpublish(this.o.room, this.o.token, gen, kinds, link.pc.localDescription?.sdp)
      if (res.answer) await link.pc.setRemoteDescription({ type: 'answer', sdp: res.answer })
      for (const k of kinds) {
        this.senders.delete(k)
        this.transceivers.delete(k)
      }
    })
  }

  /** Tell the sender what to send at: the quality step for the camera, the caps for a share. */
  private async applyCaps(kind: Kind): Promise<void> {
    const sender = this.senders.get(kind)
    const track = sender?.track
    if (!sender || !track) return
    const s = track.getSettings()
    const plan = sendPlan(kind, this.quality, { width: s.width ?? 1280, height: s.height ?? 720 })
    if (!plan) return
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      const enc = params.encodings[0] as RTCRtpEncodingParameters
      enc.maxBitrate = plan.maxBitrate
      enc.maxFramerate = plan.maxFramerate
      if (kind === 'camera') enc.scaleResolutionDownBy = plan.scaleResolutionDownBy
      params.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced'
      await sender.setParameters(params)
    } catch (err) {
      console.warn('could not set sender parameters', err)
    }
  }

  private async swapMic(track: MediaStreamTrack): Promise<void> {
    const sender = this.senders.get('mic')
    if (!sender) return
    try {
      await sender.replaceTrack(track)
    } catch (err) {
      console.warn('could not swap the microphone', err)
    }
  }

  private async swapCamera(track: MediaStreamTrack): Promise<void> {
    const sender = this.senders.get('camera')
    if (!sender) return
    try {
      await sender.replaceTrack(track)
      await this.applyCaps('camera')
    } catch (err) {
      console.warn('could not swap the camera', err)
    }
  }

  // --- The check-in loop ----------------------------------------------------

  private loop(): void {
    if (this.closed) return
    this.timer = setTimeout(async () => {
      await this.tick()
      this.loop()
    }, CHECKIN_MS)
  }

  private async tick(): Promise<void> {
    if (this.closed || this.reconnecting) return
    const gen = this.gen
    try {
      const { snapshot, chat } = await api.checkIn(this.o.room, this.o.token, gen, {
        muted: this.view.muted,
        cameraOff: this.view.cameraOff,
        since: this.chatSince,
      })
      if (gen !== this.gen) return
      this.takeChat(chat.messages, true)
      this.failures = 0
      if (this.view.phase === 'reconnecting' && !this.reconnecting) this.set({ phase: 'live', message: null })
      this.set({ snapshot })
      this.onSnapshot(snapshot)
    } catch (err) {
      const verdict = checkInFailure(err instanceof ApiError ? err.status : null, gen, this.gen, this.reconnecting)
      if (verdict === 'reconnect') void this.reconnect(false)
      else if (verdict === 'end') this.fail(new ApiError(409, 'This call was opened in another window.'))
      else if (verdict === 'count' && ++this.failures >= STALE_AFTER_FAILURES && this.view.phase === 'live') {
        this.set({ phase: 'reconnecting', message: 'Reconnecting.' })
      }
    }
  }

  private onSnapshot(snapshot: Snapshot): void {
    if (snapshot.quality !== this.quality) {
      this.quality = snapshot.quality
      void this.applyCaps('camera')
    }
    const now = Date.now()
    const { subscribe, unsubscribe } = reconcile(snapshot, this.selfId, this.held.values())
    if (unsubscribe.length > 0) void this.unsubscribe(unsubscribe)
    const ready = subscribe.filter((p) => (this.retryAfter.get(keyOf(p)) ?? 0) <= now)
    if (ready.length > 0) void this.subscribeTo(ready)
  }

  // --- Subscribing ----------------------------------------------------------

  private subscribeTo(pubs: Pub[]): Promise<void> {
    const link = this.recv
    if (!link) return Promise.resolve()
    const gen = this.gen
    for (const p of pubs) this.held.set(keyOf(p), p)
    return link.queue
      .run(async () => {
        if (gen !== this.gen) return
        const res = await api.subscribe(
          this.o.room,
          this.o.token,
          gen,
          pubs.map(({ memberId, kind, v }) => ({ memberId, kind, v })),
        )
        if (gen !== this.gen) return
        const got = new Set<string>()
        for (const t of res.tracks) {
          this.midMap.set(t.mid, { memberId: t.memberId, kind: t.kind, v: t.v })
          got.add(keyOf(t))
        }
        // Anything the server did not hand back is let go, so the next check-in asks again (after a pause).
        for (const p of pubs) {
          if (!got.has(keyOf(p))) {
            this.held.delete(keyOf(p))
            this.retryAfter.set(keyOf(p), Date.now() + RETRY_PAUSE_MS)
          }
        }
        if (res.offer) {
          await link.pc.setRemoteDescription({ type: 'offer', sdp: res.offer })
          await link.pc.setLocalDescription(await link.pc.createAnswer())
          await api.renegotiate(this.o.room, this.o.token, gen, link.pc.localDescription?.sdp ?? '')
        }
      })
      .catch((err) => {
        console.warn('subscribe failed', err)
        for (const p of pubs) {
          this.held.delete(keyOf(p))
          this.retryAfter.set(keyOf(p), Date.now() + RETRY_PAUSE_MS)
        }
      })
  }

  private unsubscribe(pubs: Pub[]): Promise<void> {
    const link = this.recv
    if (!link) return Promise.resolve()
    const gen = this.gen
    const remote = { ...this.view.remote }
    for (const p of pubs) {
      this.held.delete(keyOf(p))
      if (p.kind === 'mic') this.dropLevel(p.memberId)
      const mine = remote[p.memberId]
      if (mine) {
        const { [p.kind]: _gone, ...rest } = mine
        if (Object.keys(rest).length > 0) remote[p.memberId] = rest
        else delete remote[p.memberId]
      }
    }
    for (const [mid, info] of this.midMap) if (pubs.some((p) => keyOf(p) === keyOf(info))) this.midMap.delete(mid)
    this.set({ remote })
    return link.queue
      .run(async () => {
        if (gen !== this.gen) return
        await api.unsubscribe(
          this.o.room,
          this.o.token,
          gen,
          pubs.map(({ memberId, kind, v }) => ({ memberId, kind, v })),
        )
      })
      .then(
        () => undefined,
        (err) => console.warn('unsubscribe failed', err),
      )
  }

  // --- Reconnecting ---------------------------------------------------------

  private async reconnect(manual: boolean): Promise<void> {
    if (this.reconnecting || this.closed) return
    this.reconnecting = true
    this.set({ phase: 'reconnecting', message: 'Reconnecting.' })
    this.teardownLinks()
    try {
      for (let attempt = 0; attempt < RECONNECT_TRIES && !this.closed; attempt++) {
        try {
          await this.connect()
          this.failures = 0
          this.set({ phase: 'live', message: null })
          if (!this.timer) this.loop()
          this.startTimers()
          return
        } catch (err) {
          this.teardownLinks()
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return this.fail(err)
          await sleep(1000 * (attempt + 1))
        }
      }
      if (!this.closed) this.set({ phase: 'failed', message: manual ? 'Still not connected.' : 'The connection was lost.' })
    } finally {
      this.reconnecting = false
    }
  }

  // --- What the person controls ---------------------------------------------

  setMuted(muted: boolean): void {
    this.o.audio?.setMuted(muted)
    this.set({ muted })
  }

  async setCameraOff(off: boolean): Promise<void> {
    this.set({ cameraOff: off })
    await this.o.camera.setCameraOff(off)
  }

  /** Call from the switch's tap: it also asks the audio context to run. After a fallback it tests the path again. */
  async setNoise(on: boolean): Promise<void> {
    await this.o.audio?.setNoiseCancellation(on)
    this.set({ noise: this.o.audio?.noiseCancellation ?? on })
  }

  async setMic(deviceId?: string): Promise<void> {
    this.set({ micError: null })
    try {
      await this.o.audio?.switchMic(deviceId)
    } catch (err) {
      console.warn('could not switch microphone', err)
      this.set({ micError: 'That microphone could not be opened. Your last one is still in use.' })
    }
  }

  async setBlur(on: boolean): Promise<void> {
    this.set({ busy: on ? 'Loading background blur' : null })
    try {
      await this.o.camera.setBlur(on)
    } finally {
      this.set({ blur: this.o.camera.blur, busy: null })
    }
  }

  async startShare(): Promise<void> {
    if (this.share) return
    let share: Share
    try {
      share = await captureScreen(() => void this.stopShare())
    } catch (err) {
      // The person closed the picker, or the browser refused: nothing to report for the first.
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      throw err
    }
    this.share = share
    this.set({ sharing: true })
    const parts: Array<{ kind: Kind; track: MediaStreamTrack }> = [{ kind: 'screen', track: share.video }]
    if (share.audio) parts.push({ kind: 'screenAudio', track: share.audio })
    try {
      await this.publish(parts)
    } catch (err) {
      console.warn('could not share the screen', err)
      share.stop()
      this.share = null
      this.set({ sharing: false })
    }
  }

  async stopShare(): Promise<void> {
    const share = this.share
    if (!share) return
    this.share = null
    this.set({ sharing: false })
    const kinds: Kind[] = share.audio ? ['screen', 'screenAudio'] : ['screen']
    share.stop()
    await this.unpublish(kinds).catch((err) => console.warn('could not stop the share cleanly', err))
  }

  // --- Chat -----------------------------------------------------------------

  /**
   * Messages arrive with each check-in, and your own as the reply to your send. Only a check-in's moves the point
   * the next one asks from: your own message may have a higher id than history still on its way, and must not skip it.
   */
  private takeChat(messages: ChatMessage[], advance: boolean): void {
    if (advance) {
      for (const m of messages) this.chatSince = Math.max(this.chatSince, m.id)
    }
    const merged = mergeMessages(this.view.chat, messages)
    if (this.chatOpen) this.chatReadUpTo = Math.max(this.chatReadUpTo, this.chatSince)
    const unread = unreadCount(merged, this.mine, this.chatBaseline ?? Number.MAX_SAFE_INTEGER, this.chatReadUpTo)
    if (merged !== this.view.chat || unread !== this.view.chatUnread) this.set({ chat: merged, chatUnread: unread })
  }

  /** The panel opened or closed. Open, everything held is read. */
  setChatOpen(open: boolean): void {
    this.chatOpen = open
    if (open) this.chatReadUpTo = Math.max(this.chatReadUpTo, this.chatSince)
    this.set({ chatUnread: unreadCount(this.view.chat, this.mine, this.chatBaseline ?? Number.MAX_SAFE_INTEGER, this.chatReadUpTo) })
  }

  /** Send a message. True when the call took it; false with `chatError` saying why. */
  async sendChat(text: string): Promise<boolean> {
    this.set({ chatError: null })
    try {
      const { message } = await api.chat(this.o.room, this.o.token, this.gen, text)
      this.takeChat([message], false)
      return true
    } catch (err) {
      this.set({ chatError: err instanceof ApiError ? err.message : 'The message could not be sent. Try again.' })
      return false
    }
  }

  // --- Listening ------------------------------------------------------------

  /** The level of one member's received microphone, about every 80 ms. For their tile's bar and speaking light. */
  subscribeLevel(memberId: string, fn: (r: LevelReading) => void): () => void {
    let set = this.levelListeners.get(memberId)
    if (!set) this.levelListeners.set(memberId, (set = new Set()))
    set.add(fn)
    const held = this.remoteLevels.get(memberId)
    if (held) fn(held.last)
    return () => this.levelListeners.get(memberId)?.delete(fn)
  }

  private watchLevel(memberId: string, stream: MediaStream): void {
    this.dropLevel(memberId)
    try {
      this.remoteLevels.set(memberId, {
        level: new StreamLevel(sharedAudioContext(), stream),
        speaking: new Speaking(),
        last: { level: 0, speaking: false },
      })
    } catch (err) {
      // The sound still plays; only the speaking indicator is lost.
      console.warn('could not read the level of a remote microphone', err)
    }
  }

  private dropLevel(memberId: string): void {
    const held = this.remoteLevels.get(memberId)
    if (!held) return
    held.level.stop()
    this.remoteLevels.delete(memberId)
    for (const fn of this.levelListeners.get(memberId) ?? []) fn({ level: 0, speaking: false })
  }

  private readonly sampleRemote = (now: number): void => {
    for (const [id, held] of this.remoteLevels) {
      const reading = held.level.read()
      held.last = { level: toLevel(reading), speaking: held.speaking.update(now, reading) }
      for (const fn of this.levelListeners.get(id) ?? []) fn(held.last)
    }
  }

  /**
   * Once a second: how many bytes of audio went out, and how many of each person's microphone have come in.
   * Someone whose sound is Not arriving (publishing it, none received for a few seconds) is flagged on their tile,
   * so "they are silent" and "their sound is not reaching me" look different.
   */
  private async pollAudio(): Promise<void> {
    if (this.closed || this.reconnecting || this.view.phase !== 'live') return
    const gen = this.gen
    const send = this.send?.pc
    const recv = this.recv?.pc
    if (!send || !recv) return
    try {
      let outBytes = 0
      ;(await send.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') outBytes += r.bytesSent ?? 0
      })
      const inbound: Record<string, number | null> = {}
      for (const tr of recv.getTransceivers()) {
        const info = tr.mid ? this.midMap.get(tr.mid) : undefined
        if (!info || info.kind !== 'mic') continue
        let bytes = 0
        ;(await tr.receiver.getStats()).forEach((r) => {
          if (r.type === 'inbound-rtp') bytes += r.bytesReceived ?? 0
        })
        inbound[info.memberId] = bytes
      }
      if (gen !== this.gen || this.reconnecting) return
      this.audioStats = { outBytes, inbound }
      const publishing = (this.view.snapshot?.members ?? [])
        .filter((m) => m.id !== this.selfId && m.publishing.some((p) => p.kind === 'mic'))
        .map((m) => ({ id: m.id, bytes: inbound[m.id] ?? null }))
      const notArriving = this.notArrivingWatch.update(performance.now(), publishing)
      if (notArriving.join() !== this.view.notArriving.join()) this.set({ notArriving })
    } catch {
      // Statistics are a convenience.
    }
  }

  /**
   * While the audio context is asleep (a Safari that was never tapped awake, an iOS interruption) the level bar's
   * analysers read nothing, so your own bar would be blank although the microphone is being sent. The sender's own
   * statistics still know the level of the track it holds; this reads them four times a second and hands them to the
   * pipeline, which uses them only while the context is not running.
   */
  private async pollOwnLevel(): Promise<void> {
    const audio = this.o.audio
    const send = this.send?.pc
    if (!audio || !send || audio.context.state === 'running') return
    try {
      let level: number | null = null
      ;(await send.getStats()).forEach((r) => {
        if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') level = r.audioLevel
      })
      if (level !== null) audio.feedExternalLevel(level)
    } catch {
      // Statistics are a convenience.
    }
  }

  getAudioStats = (): AudioStats => this.audioStats

  // --- Looking -------------------------------------------------------------

  /** Direct or Relayed, from the sending connection's selected candidate pair. */
  private async readLink(): Promise<void> {
    const pc = this.send?.pc
    if (!pc || pc.connectionState !== 'connected') return
    try {
      const stats = await pc.getStats()
      let pairId: string | undefined
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId
      })
      let relayed = false
      let found = false
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.id === pairId) {
          found = true
          for (const id of [r.localCandidateId, r.remoteCandidateId]) {
            const c = stats.get(id)
            if (c?.candidateType === 'relay') relayed = true
          }
        }
      })
      if (found) this.set({ link: relayed ? 'relayed' : 'direct' })
    } catch {
      // Statistics are a convenience.
    }
  }

  /** Packet counters for the live check (scripts/live.ts): what this tab has sent and received. */
  async debugStats(): Promise<{
    sentVideoBytes: number
    sentAudioBytes: number
    recvVideoPackets: number
    recvAudioPackets: number
    recvAudioBytes: number
    recvScreenFrames: number
    link: Link
  }> {
    const out = {
      sentVideoBytes: 0,
      sentAudioBytes: 0,
      recvVideoPackets: 0,
      recvAudioPackets: 0,
      recvAudioBytes: 0,
      recvScreenFrames: 0,
      link: this.view.link,
    }
    const send = await this.send?.pc.getStats()
    send?.forEach((r) => {
      if (r.type === 'outbound-rtp') {
        if (r.kind === 'video') out.sentVideoBytes += r.bytesSent ?? 0
        else out.sentAudioBytes += r.bytesSent ?? 0
      }
    })
    const recv = await this.recv?.pc.getStats()
    recv?.forEach((r) => {
      if (r.type === 'inbound-rtp') {
        if (r.kind === 'video') {
          out.recvVideoPackets += r.packetsReceived ?? 0
          out.recvScreenFrames += r.framesDecoded ?? 0
        } else {
          out.recvAudioPackets += r.packetsReceived ?? 0
          out.recvAudioBytes += r.bytesReceived ?? 0
        }
      }
    })
    return out
  }
}
