// The page's one live connection (the space's ADR 0019): a WebSocket to the company's live object, opened on the space's own address, kept open by
// reconnecting, and used for one thing: to learn that a PART moved (mail, chat, calls, documents, knowledge), so the screens that draw it read again. A frame never carries what changed, and nothing here edits a screen.
//
// One connection per tab, held by the shell (`LiveProvider`, liveHub.tsx), whatever tab the person is on. The screens do not open sockets: each says which parts it draws (`useLive`) and is called when one moves. The
// decisions are pure and checked in test/live.test.ts: `LiveLink` owns the socket and the timers with its browser pieces passed in so a fake socket drives it, and `LiveHub` routes a frame to the screens that draw its part.
//
// A MESSAGE CAN BE LOST (the socket was down, the object restarted), so every screen also reads again when the connection comes back, when the page is shown again, and every ten minutes (notify.ts SAFETY_NET_MS).

import { LIVE_CLOSE_SIGNED_OUT, LIVE_SOCKET_PATH, type LivePart, parseLiveFrame } from '@space/workspace'

/** What the socket closes with when the sign-in has ended: the page goes quiet, and the screens' own reads show the sign-in notice. */
export const CLOSE_SIGNED_OUT = LIVE_CLOSE_SIGNED_OUT

/** A dropped socket tries again after 1 second, then 2, 4, 8, 16, then every 30. */
export const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))

/** How often the page tells the socket it is there, so a quiet connection is not dropped on the way. The runtime answers it without waking the object. */
export const KEEPALIVE_MS = 30_000

/** The address to open: the page's own host, at the live socket's path. */
export function socketUrl(page: { protocol: string; host: string }): string {
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}${LIVE_SOCKET_PATH}`
}

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'off'

export interface SocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
}

export interface LiveDeps {
  open(url: string): SocketLike
  page: { protocol: string; host: string }
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** A part moved. */
  told(frame: { part: LivePart; conversation?: string }): void
  /** The connection is back after a gap: whatever was said meanwhile was missed, so everything on view is read again. */
  reconnected(): void
  status(status: LiveStatus): void
}

const OPEN = 1

export class LiveLink {
  private socket: SocketLike | null = null
  private attempt = 0
  private retry: unknown = null
  private keepalive: unknown = null
  private stopped = false
  /** True once the connection has been lost or failed to open: the next time it opens, messages may have been missed. */
  private gap = false
  /** True once the socket has opened at all: a connection that never does (no live object here) stays quiet. */
  private everOpened = false

  constructor(private readonly d: LiveDeps) {}

  start(): void {
    this.open()
  }

  /**
   * The page is shown again, or the network is back: try now rather than wait out the backoff. A socket that is open, or still connecting, is left alone: a second socket would leave the first one running with
   * nothing to close it.
   */
  wake(): void {
    if (this.stopped || (this.socket !== null && this.socket.readyState <= OPEN)) return
    if (this.retry !== null) this.d.clearTimer(this.retry)
    this.retry = null
    this.attempt = 0
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retry !== null) this.d.clearTimer(this.retry)
    if (this.keepalive !== null) this.d.clearTimer(this.keepalive)
    this.socket?.close(1000, 'leaving')
    this.socket = null
  }

  private retryLater(): void {
    if (this.stopped) return
    this.gap = true
    // Before the first time it ever opened (no live object here: the dev server, a deploy mid-move) it says nothing; once it has been up, a drop is "reconnecting".
    this.d.status(this.everOpened ? 'reconnecting' : 'off')
    this.retry = this.d.setTimer(() => {
      this.retry = null
      this.open()
    }, backoffMs(this.attempt++))
  }

  private end(): void {
    this.stopped = true
    this.d.status('off')
  }

  private open(): void {
    if (this.stopped) return
    this.d.status(this.everOpened ? 'reconnecting' : 'connecting')
    const socket = this.d.open(socketUrl(this.d.page))
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.everOpened = true
      this.d.status('open')
      if (this.gap) {
        this.gap = false
        this.d.reconnected()
      }
      if (this.keepalive !== null) this.d.clearTimer(this.keepalive)
      const ping = () => {
        if (this.socket !== socket) return
        if (socket.readyState === OPEN) socket.send('ping')
        this.keepalive = this.d.setTimer(ping, KEEPALIVE_MS)
      }
      this.keepalive = this.d.setTimer(ping, KEEPALIVE_MS)
    }
    socket.onmessage = (e) => {
      if (this.socket !== socket) return // a socket the page has let go of says nothing to the screens
      if (typeof e.data !== 'string') return
      const frame = parseLiveFrame(e.data)
      if (frame) this.d.told(frame)
    }
    socket.onclose = (e) => {
      // Only the current socket's ping is this one's to stop: an older socket closing must not stop the newer one's.
      if (this.socket !== socket) return
      if (this.keepalive !== null) this.d.clearTimer(this.keepalive)
      this.socket = null
      if (this.stopped) return
      // The sign-in ended: asking again would be refused. The screens' own reads show the sign-in notice.
      if (e.code === CLOSE_SIGNED_OUT) return this.end()
      this.retryLater()
    }
  }
}

/** The browser's pieces: a WebSocket on this page's address, and the timers. */
export function browserLink(handlers: Pick<LiveDeps, 'told' | 'reconnected' | 'status'>): LiveLink {
  return new LiveLink({
    open: (url) => new WebSocket(url) as unknown as SocketLike,
    page: window.location,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    ...handlers,
  })
}

// ── Which screens a frame is for ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a screen is told. `part` is the one that moved, or null when everything may have (the connection came back). `named` is the conversations the messages named: null when one named none, which means "any of
 * them may have changed", so a screen reads its open conversation again; a set when every message named a conversation, so a screen reads its open conversation again only if it is one of them.
 */
export interface LiveEvent {
  part: LivePart | null
  named: ReadonlySet<string> | null
}

/** Whether a screen showing `openKey` (the conversation open, or null for none) reads the conversation again for this event. */
export const readsOpen = (e: LiveEvent, openKey: string | null): boolean => openKey !== null && (e.named === null || e.named.has(openKey))

/** A burst of messages is one read: a screen is called at most once this long after the first of them. */
export const DEBOUNCE_MS = 300

interface Subscriber {
  parts: ReadonlySet<LivePart>
  fn(event: LiveEvent): void
  /** What has been said since this subscriber was last called, held until the timer fires. */
  pending: { parts: Set<LivePart>; named: Set<string>; none: boolean; everything: boolean } | null
  timer: unknown
}

export class LiveHub {
  private readonly subscribers = new Set<Subscriber>()
  private current: LiveStatus = 'off'
  private readonly listeners = new Set<() => void>()

  constructor(private readonly timers: { setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }) {}

  /** The screens that draw `parts` are called when one of them moves. Returns the way to stop. */
  subscribe(parts: readonly LivePart[], fn: (event: LiveEvent) => void): () => void {
    const s: Subscriber = { parts: new Set(parts), fn, pending: null, timer: null }
    this.subscribers.add(s)
    return () => {
      this.subscribers.delete(s)
      if (s.timer !== null) this.timers.clearTimer(s.timer)
    }
  }

  /** A part moved: every screen that draws it is called, once for a burst. */
  told(frame: { part: LivePart; conversation?: string }): void {
    for (const s of this.subscribers) {
      if (!s.parts.has(frame.part)) continue
      this.hold(s, frame.part, frame.conversation)
    }
  }

  /** The connection came back after a gap: every screen is called, with nothing named, whatever it draws. */
  everything(): void {
    for (const s of this.subscribers) this.hold(s, null, undefined)
  }

  private hold(s: Subscriber, part: LivePart | null, conversation: string | undefined): void {
    const pending = (s.pending ??= { parts: new Set(), named: new Set(), none: false, everything: false })
    if (part !== null) pending.parts.add(part)
    else pending.everything = true
    if (conversation === undefined) pending.none = true
    else pending.named.add(conversation)
    if (s.timer !== null) return
    s.timer = this.timers.setTimer(() => {
      s.timer = null
      const p = s.pending
      s.pending = null
      if (!p || !this.subscribers.has(s)) return
      // Everything (a reconnect) or messages from more than one part: the screen reads all it draws, and `part` says which only when it is one.
      const parts = [...p.parts]
      s.fn({ part: parts.length === 1 && !p.everything ? (parts[0] as LivePart) : null, named: p.none ? null : p.named })
    }, DEBOUNCE_MS)
  }

  get status(): LiveStatus {
    return this.current
  }

  setStatus(status: LiveStatus): void {
    if (status === this.current) return
    this.current = status
    for (const l of this.listeners) l()
  }

  onStatus(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
