/**
 * The socket shell.
 *
 * A Durable Object because the sockets have to live somewhere with an identity:
 * a Worker isolate is per-request and cannot hold a connection open, and a
 * pushed ref has to reach subscribers that connected to some other isolate,
 * possibly some other colo. One named instance is the rendezvous.
 *
 * It carries NO decisions. Whether a credential is good, what a `watch` message
 * means, which sockets an announcement reaches and what goes on the wire are
 * all `shared/events.ts`, which is pure and tested. What is left here — accept,
 * remember, send, forget — is the part that cannot be unit-tested without a
 * runtime, so there is deliberately nothing else in it.
 *
 * Sockets are accepted with `ctx.acceptWebSocket`, the hibernation API: an idle
 * subscription evicts the isolate from memory and keeps the TCP connection, so
 * a client that watches a quiet repository for a week costs storage, not
 * duration. `serializeAttachment` is what survives that — an in-memory Map of
 * subscriptions would be silently empty on the wake, and the socket would then
 * be connected and permanently deaf.
 */

import { getContainer } from '@cloudflare/containers'
import { DurableObject } from 'cloudflare:workers'

import {
  type RefEvent,
  type WatchEntry,
  encode,
  handshake,
  parseAnnounce,
  parseWatch,
  watchCovers,
  watchedRepos,
} from '../shared/events'
import { Outbox } from '../shared/outbox'
import { INTERNAL_HEADER, REFS_PATH } from '../shared/protocol'
import { RefCache } from '../shared/ref-cache'

/** Only the bindings this object touches — the Worker's Env is a superset. */
export interface EventsEnv {
  // biome-ignore lint/suspicious/noExplicitAny: the container class is defined
  // in index.ts, which imports this file; naming it here would be a cycle.
  WALGIT_CONTAINER: DurableObjectNamespace<any>
}

/** The Worker's internal call to fan an announcement out. Never client-reachable. */
export const BROADCAST_PATH = '/broadcast'

/**
 * One instance serves every subscriber, addressed by this name.
 *
 * A single object is the simplest thing that can work and is not a ceiling
 * worth pre-empting: a fan-out is one message per socket, and the push rate of
 * a git host is bounded by pushes, not by subscribers.
 */
export const EVENTS_OBJECT_NAME = 'events'

export class WalgitEvents extends DurableObject<EventsEnv> {
  /**
   * What this object remembers about refs, so a connect for a repository it has
   * already seen does not wake the container to be told what it just announced.
   *
   * In memory, never in storage (shared/ref-cache.ts): hibernation drops it,
   * and the cost of that is one container round-trip on the next connect. The
   * Index stays the source of truth.
   */
  private readonly refs = new RefCache()

  /**
   * One outbound queue per live socket.
   *
   * In memory, and not serialized onto the socket: a queue only exists while a
   * reader is behind, and a reader that is behind is not an idle subscription,
   * so hibernation cannot strike mid-backlog. If it somehow did, losing the
   * queue costs nothing — the client's next handshake is current state, which
   * is what the queue was converging to anyway.
   */
  private readonly outboxes = new WeakMap<WebSocket, Outbox>()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === BROADCAST_PATH) {
      const parsed = parseAnnounce(await request.json().catch(() => null))
      if (!parsed.ok) return new Response(`${parsed.error}\n`, { status: 400 })
      // Fold into the cache first: an announcement is the Index's own report of
      // a ref that has already been made durable, which is exactly what a later
      // handshake would go and read.
      this.refs.apply(parsed.value)
      const delivered = this.broadcast(parsed.value)
      return Response.json({ ok: true, delivered })
    }

    // The subscribe path. The Worker has already checked the credential — it
    // holds the token list, and re-checking here would be a second copy of the
    // gate for the two to drift apart on.
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade\n', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    // Hibernation-aware accept: the handlers below are called on a fresh
    // isolate after an idle period, rather than the isolate being kept alive.
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * A client naming what it watches.
   *
   * The answer is current state — from this object's own copy where it has one,
   * and otherwise from the Index through the container, which is the source of
   * truth for refs (docs/adr/0007). Either way a subscriber's first message
   * tells it where it stands and it never has to fetch to find out.
   * Sending it before the subscription is recorded would open a window in which
   * a push is in neither the handshake nor the stream, so the order here is:
   * read, record, answer.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const parsed = parseWatch(raw)
    if (!parsed.ok) {
      ws.send(encode({ error: parsed.error }))
      return
    }

    let refsByRepo: Record<string, Record<string, string>>
    try {
      refsByRepo = await this.currentRefs(watchedRepos(parsed.value))
    } catch (error) {
      ws.send(
        encode({
          error: `could not read current refs: ${(error as Error).message}`,
        }),
      )
      return
    }

    ws.serializeAttachment(parsed.value)
    ws.send(encode(handshake(parsed.value, refsByRepo)))
  }

  webSocketClose(ws: WebSocket): void {
    this.outboxes.delete(ws)
  }

  webSocketError(ws: WebSocket): void {
    this.outboxes.delete(ws)
    // Nothing to clean up beyond the socket itself: the subscription lives on
    // the socket's attachment, so it goes when the socket goes.
    try {
      ws.close(1011, 'walgit: socket error')
    } catch {
      // Already gone.
    }
  }

  /** Send one announcement to every socket that asked for it. */
  private broadcast(events: readonly RefEvent[]): number {
    let delivered = 0
    for (const ws of this.ctx.getWebSockets()) {
      const watch = readWatch(ws)
      if (!watch) continue
      const wanted = events.filter((event) => watchCovers(watch, event))
      if (wanted.length === 0) continue
      // Through the outbox rather than straight to the socket: it decides what
      // a backed-up reader gets (the newest sha per ref, once) and when a
      // reader that will not drain is closed instead of buffered. A socket that
      // has gone away mid-fan-out must not stop the ones behind it, which is
      // why the outbox never throws.
      delivered += this.outbox(ws).offer(wanted).sent
    }
    return delivered
  }

  /** This socket's queue, created on the first event it is owed. */
  private outbox(ws: WebSocket): Outbox {
    const existing = this.outboxes.get(ws)
    if (existing) return existing
    const created = new Outbox(ws)
    this.outboxes.set(ws, created)
    return created
  }

  /**
   * The Index's ref state for each repository — from memory where possible.
   *
   * A repository this object already knows is answered here and the container
   * is never touched, which is the point: a fan-out that has been announcing
   * pushes for a repository all day already holds its ref state, and waking a
   * sleeping container to re-read it would be paying for an answer twice.
   *
   * A miss goes to the container rather than to the object store directly,
   * because the store's credentials are the container's, not the Worker's
   * (shared/container-env.ts) — and because `index.json` is the only place refs
   * are authoritative.
   */
  private async currentRefs(repos: string[]): Promise<Record<string, Record<string, string>>> {
    for (const repo of this.refs.missing(repos)) {
      this.refs.fill(repo, await this.fetchRefs(repo))
    }
    return this.refs.read(repos)
  }

  /** One repository's ref state, read from the Index through the container. */
  private async fetchRefs(repo: string): Promise<Record<string, string>> {
    const request = new Request(
      `https://walgit.internal${REFS_PATH}?repo=${encodeURIComponent(repo)}`,
      { headers: { [INTERNAL_HEADER]: '1' } },
    )
    const response = await getContainer(this.env.WALGIT_CONTAINER).fetch(request)
    if (!response.ok) throw new Error(`refs lookup for ${repo}: ${response.status}`)
    const body = (await response.json()) as { refs?: Record<string, string> }
    return body.refs ?? {}
  }
}

/** The subscription a socket carries, or null if it never sent a valid one. */
function readWatch(ws: WebSocket): WatchEntry[] | null {
  try {
    const attachment = ws.deserializeAttachment() as WatchEntry[] | null
    return Array.isArray(attachment) ? attachment : null
  } catch {
    return null
  }
}
