// The page's live connection: one WebSocket, opened with a single-use ticket from the guest's own door, kept open
// by reconnecting, and caught up on every open.
//
// The decisions are pure (`backoffMs`, `afterTicketFailure`) and checked in test/workspace-client.test.ts; `Connection`
// is the thin part that owns the socket and the timers, and is checked by the live check (scripts/workspace.ts).
//
// An open starts with `hello` carrying the number of the last change the page holds; the server answers with every
// change after it that this person may see (or the word to reload), and pushes from then on. So a dropped
// connection loses nothing: the next one asks for what it missed.

import { GUEST_API } from '../../model'
import { CLOSE_REMOVED, CLOSE_SIGNED_OUT, type ClientFrame, type ServerFrame } from '../../workspace-model'

/** A dropped socket tries again after 1 second, then 2, 4, 8, 16, then every 30. */
export const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt))

/** What to do when a ticket could not be had. */
export type AfterTicketFailure = 'signin' | 'retry'

/**
 * A ticket that is refused (401 or 403) means the guest's session has ended, and they are shown the sign-in. A network failure is only
 * a bad moment (a train, a sleeping phone): try again with the backoff.
 */
export function afterTicketFailure(failure: { status: number } | { network: true }): AfterTicketFailure {
  if ('network' in failure) return 'retry'
  if (failure.status === 401 || failure.status === 403) return 'signin'
  return 'retry'
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting'

export interface ConnectionHooks {
  /** A fresh ticket, or the reason there is none. Throws `TicketFailure`. */
  ticket(): Promise<string>
  /** The newest change the page holds. */
  since(): number
  frame(frame: ServerFrame): void
  status(status: ConnectionStatus): void
  /** The sign-in ended: show the guest the sign-in. */
  signedOut(): void
  /** This person was removed from the workspace. */
  removed(): void
}

/** Thrown by `ticket()`. */
export class TicketFailure extends Error {
  constructor(readonly outcome: AfterTicketFailure) {
    super(outcome)
  }
}

export class Connection {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private opening = false

  constructor(private readonly hooks: ConnectionHooks) {
    document.addEventListener('visibilitychange', this.wake)
    window.addEventListener('online', this.wake)
  }

  /** Coming back to the page, or the network coming back, is a reason to try now rather than wait out the backoff. */
  private wake = () => {
    if (this.stopped || (document.visibilityState === 'hidden' && !navigator.onLine)) return
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING || this.opening) return
    if (this.timer) clearTimeout(this.timer)
    this.attempt = 0
    void this.open()
  }

  start(): void {
    void this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.keepalive) clearInterval(this.keepalive)
    document.removeEventListener('visibilitychange', this.wake)
    window.removeEventListener('online', this.wake)
    this.ws?.close(1000, 'leaving')
  }

  send(frame: ClientFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  private retryLater(): void {
    if (this.stopped) return
    this.hooks.status('reconnecting')
    this.timer = setTimeout(() => void this.open(), backoffMs(this.attempt++))
  }

  private async open(): Promise<void> {
    if (this.stopped || this.opening) return
    this.opening = true
    try {
      this.hooks.status(this.attempt === 0 ? 'connecting' : 'reconnecting')
      let ticket: string
      try {
        ticket = await this.hooks.ticket()
      } catch (err) {
        const outcome = err instanceof TicketFailure ? err.outcome : 'retry'
        if (outcome === 'retry') return this.retryLater()
        this.stopped = true
        return this.hooks.signedOut()
      }
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${scheme}://${location.host}${GUEST_API}/socket?ticket=${encodeURIComponent(ticket)}`)
      this.ws = ws
      ws.onopen = () => {
        this.attempt = 0
        this.hooks.status('open')
        ws.send(JSON.stringify({ t: 'hello', since: this.hooks.since() } satisfies ClientFrame))
        // The runtime answers this without waking the workspace; it keeps a quiet connection from being dropped on the way.
        if (this.keepalive) clearInterval(this.keepalive)
        this.keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000)
      }
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data === 'pong') return
        try {
          this.hooks.frame(JSON.parse(e.data) as ServerFrame)
        } catch {
          // Not a frame; nothing to do.
        }
      }
      ws.onclose = (e) => {
        if (this.keepalive) clearInterval(this.keepalive)
        if (this.ws !== ws) return
        this.ws = null
        if (this.stopped) return
        if (e.code === CLOSE_REMOVED) {
          this.stopped = true
          return this.hooks.removed()
        }
        if (e.code === CLOSE_SIGNED_OUT) {
          this.stopped = true
          return this.hooks.signedOut()
        }
        this.retryLater()
      }
    } finally {
      this.opening = false
    }
  }
}
