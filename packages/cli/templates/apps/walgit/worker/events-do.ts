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

import { DurableObject } from 'cloudflare:workers'

import { capabilitiesFrom } from '../shared/capabilities'
import {
  type RefEvent,
  type TokensRevoked,
  type WatchEntry,
  authorizeSubscribe,
  encode,
  handshake,
  parseAnnounce,
  parseWatch,
  watchCovers,
  watchedRepos,
} from '../shared/events'
import { Outbox } from '../shared/outbox'
import { parseTokens } from '../shared/credentials'
import { scopedAccessOf, scopedTokenExpired, scopedWatchRefusal } from '../shared/scoped-token'
import { INTERNAL_HEADER, READ_VERDICT_PATH, REFS_PATH } from '../shared/protocol'
import { RefCache } from '../shared/ref-cache'
import { s3StoreFrom } from '../shared/store'
import { revocationOf, TokenRevocationReader, tokenRevoked } from '../shared/token-revocation'
import { AwsClient } from 'aws4fetch'
import { type ContainerBindings, containerFor } from './container-binding'

/** Only the bindings this object touches — the Worker's Env is a superset. */
export interface EventsEnv extends ContainerBindings {
  /**
   * The announce secret, presented to the container when this object asks
   * whether a subscriber may read what it watches (docs/adr/0013).
   */
  WALGIT_EVENTS_TOKEN?: string
  /**
   * Read gating, read here ONLY through `capabilitiesFrom` — the same
   * derivation the route, the documents and the container's boot use, so a
   * deployment cannot be Private in one place and not in another. Without it
   * this object asks the container nothing and costs nothing new.
   */
  WALGIT_PRIVATE_REPOS?: string
  WALGIT_SIGNER_LISTS?: string
  WALGIT_PUSH_CERT_SEED?: string
  /**
   * Scoped tokens (docs/adr/0021): the keys a watch's credential is verified
   * against, and the deployment's own secrets, which are never judged as one.
   */
  WALGIT_TOKEN_PUBLIC_KEYS?: string
  WALGIT_HTTP_TOKENS?: string
  /**
   * The object store, read for one thing only: whether a scoped token's
   * repository has revoked its tokens since it was issued
   * (`shared/token-revocation.ts`). The same variables the Worker reads it by.
   */
  WALGIT_S3_ENDPOINT?: string
  WALGIT_S3_BUCKET?: string
  WALGIT_S3_ACCESS_KEY_ID?: string
  WALGIT_S3_SECRET_ACCESS_KEY?: string
  WALGIT_S3_REGION?: string
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
   * In memory, and not serialized onto the socket: an entry only exists inside
   * a ref's coalesce window, which is a few hundred milliseconds after an
   * announcement — activity, not the idleness hibernation waits for. If the
   * object were evicted mid-window anyway the queued event would go with it,
   * and the cost is one notification the client's next handshake corrects.
   * Serializing it would trade that for storage writes on every push.
   */
  private readonly outboxes = new WeakMap<WebSocket, Outbox>()

  /** Revocation reads for watches on scoped tokens (`shared/token-revocation.ts`). */
  private readonly revocations = new TokenRevocationReader()

  /**
   * The newest revocation announced per repository, in memory. A watch judged
   * against the Index in flight while a revoke was announced read the old
   * Index and was skipped by `revokeTokens` (it had no watch yet); this is
   * checked, with no await between it and the attachment, to close that gap.
   * Losing it on hibernation is harmless: no watch is in flight then.
   */
  private readonly announcedRevocations = new Map<string, string>()

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === BROADCAST_PATH) {
      const parsed = parseAnnounce(await request.json().catch(() => null))
      if (!parsed.ok) return new Response(`${parsed.error}\n`, { status: 400 })
      // Fold into the cache first: an announcement is the Index's own report of
      // a ref that has already been made durable, which is exactly what a later
      // handshake would go and read.
      this.refs.apply(parsed.value.events)
      // A scoped socket is re-judged against its repository's Index before it
      // is sent anything (docs/adr/0021), so a revocation whose announcement
      // was lost still stops delivery: a socket is never served an event after
      // its token was revoked, whichever way the news arrived.
      await this.closeRevokedWatching(parsed.value.events)
      const delivered = this.broadcast(parsed.value.events)
      // A socket that outlives a revocation is a leak (docs/adr/0013), so the
      // sockets reading on the strength of the Reader List this push replaced
      // are re-judged before the announcement is acknowledged — the push path
      // bounds its own wait, and a revocation deferred to a timer is one that
      // may never run on an object about to hibernate.
      await this.revoke(parsed.value.readersChanged)
      // The same, for a repository whose scoped tokens an admin just revoked
      // (docs/adr/0021): the sockets watching on one issued before it close
      // now, rather than at the token's `exp`.
      for (const { repo, since } of parsed.value.tokensRevoked) {
        const known = this.announcedRevocations.get(repo)
        if (known === undefined || Date.parse(since) > Date.parse(known)) {
          this.announcedRevocations.set(repo, since)
        }
      }
      this.revokeTokens(parsed.value.tokensRevoked)
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
    // The credential is presented at the upgrade and the repositories are
    // named later, in a `watch` message — so it is kept on the socket, which
    // is the one thing that survives hibernation. Kept VERBATIM and never
    // judged here: what it proves is the container's answer (docs/adr/0013),
    // and this object still makes no decision.
    server.serializeAttachment({
      credential: request.headers.get('authorization'),
      watch: null,
    } satisfies Subscription)
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * A client naming what it watches.
   *
   * The answer is current state — from this object's own copy where it has one,
   * and otherwise from the Index through the container, which is the source of
   * truth for refs (docs/adr/0007). Either way a subscriber's first message
   * tells it where it stands and it never has to fetch to find out.
   *
   * The order is RECORD, read, answer, and both halves of that matter because
   * reading can take a container round-trip and a push can land inside it:
   *
   *   - recorded first, so a push during the read reaches this socket as an
   *     event rather than being fanned out to a socket that is not yet
   *     subscribed and therefore skipped;
   *   - and `RefCache` brackets the read, so the snapshot that lands cannot be
   *     older than an event already sent on this socket.
   *
   * Recording first means a subscriber can see an event before its handshake.
   * That is harmless — both carry the same sha, and latest-state has no order
   * to violate — where the reverse, a handshake claiming a sha older than the
   * event already delivered, would leave the client believing it is current
   * when it is a push behind.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const parsed = parseWatch(raw)
    if (!parsed.ok) {
      ws.send(encode({ error: parsed.error }))
      return
    }

    const credential = readSubscription(ws).credential

    // A scoped token (docs/adr/0021) may watch its own repository and nothing
    // else. Judged here, on the message that names the repositories, with the
    // same verifier the edge ran at the upgrade — and refused whole, like the
    // Private gate below, because a subscriber silently narrowed waits forever.
    const scoped = await scopedAccessOf(credential, {
      keys: this.env.WALGIT_TOKEN_PUBLIC_KEYS,
      known: [
        ...parseTokens(this.env.WALGIT_HTTP_TOKENS),
        ...(this.env.WALGIT_EVENTS_TOKEN ? [this.env.WALGIT_EVENTS_TOKEN] : []),
      ],
    })
    let scopeRefused = scopedWatchRefusal(scoped, watchedRepos(parsed.value))
    // Revoked since it was issued (`shared/token-revocation.ts`): read from
    // the Index here too, because the watch can arrive long after the upgrade
    // the Worker judged. Unreadable is refused, never read as valid.
    if (!scopeRefused && scoped.kind === 'scoped') {
      const verdict = await revocationOf(
        scoped.claims,
        s3StoreFrom(this.env, (credentials) => new AwsClient(credentials)),
        this.revocations,
      )
      if (verdict.kind === 'unknown') {
        // Not a verdict on the token: the client may retry, so the socket
        // stays open, and nothing is attached or served.
        ws.send(encode({ error: verdict.reason.replace(/^walgit: /, '') }))
        return
      }
      if (verdict.kind === 'revoked') {
        ws.send(encode({ error: 'unauthorized' }))
        try {
          ws.close(1008, 'walgit: token revoked')
        } catch {
          // Already gone.
        }
        return
      }
    }
    if (scopeRefused) {
      ws.send(encode({ error: scopeRefused }))
      try {
        ws.close(1008, "walgit: outside this token's scope")
      } catch {
        // Already gone.
      }
      return
    }

    // The Private gate, on the only transport that can ask it here: the
    // container verifies the signature and answers per repository, and
    // `authorizeSubscribe` turns that into one verdict for the whole watch.
    // Refused WHOLE and BEFORE the subscription is recorded, so a handshake
    // never names a ref of a repository this key may not read.
    if (capabilitiesFrom(this.env).namesCanBePrivate) {
      let readable: Record<string, boolean>
      try {
        readable = await this.readVerdicts(credential, watchedRepos(parsed.value))
      } catch (error) {
        // Never read as permission. A verdict that did not arrive is not a
        // verdict of yes, and the client may retry.
        ws.send(encode({ error: `could not check read access: ${(error as Error).message}` }))
        return
      }
      const allowed = authorizeSubscribe({
        // The deployment credential was already checked at the upgrade, by the
        // Worker that holds the token list (`worker/index.ts`); re-checking it
        // here would be the second copy of that gate this object exists not to
        // have. What is decided here is only the Reader List question.
        authorization: credential,
        tokens: [],
        isPublic: true,
        watch: parsed.value,
        readable,
      })
      if (!allowed) {
        ws.send(encode({ error: 'unauthorized' }))
        // Closed rather than left open: the subscription was refused whole, so
        // there is nothing this socket could still be told.
        try {
          ws.close(1008, 'walgit: unauthorized')
        } catch {
          // Already gone.
        }
        return
      }
    }

    // A revoke announced while this watch was being judged: the Index read
    // above may predate it, and `revokeTokens` skipped this socket because it
    // had no watch yet. Checked with no await before the attachment below.
    if (scoped.kind === 'scoped') {
      const announced = this.announcedRevocations.get(scoped.claims.repo)
      if (announced !== undefined && tokenRevoked(scoped.claims.iat, announced)) {
        ws.send(encode({ error: 'unauthorized' }))
        try {
          ws.close(1008, 'walgit: token revoked')
        } catch {
          // Already gone.
        }
        return
      }
    }

    // A scoped token's `exp` rides on the socket, so the fan-out below stops
    // serving it when the token would have stopped being accepted anywhere else.
    ws.serializeAttachment({
      credential,
      watch: parsed.value,
      ...(scoped.kind === 'scoped'
        ? { expires: scoped.claims.exp, issued: scoped.claims.iat, scopedRepo: scoped.claims.repo }
        : {}),
    } satisfies Subscription)

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

  /**
   * Close the sockets a Reader List change no longer permits.
   *
   * Only sockets watching a repository named in `readersChanged` are asked
   * about, and only about that repository: a subscriber watching something
   * else is not re-judged, does not pay a round trip, and sees nothing.
   *
   * A verdict the container could not give closes the socket too. The
   * alternative is holding a socket open across a revocation on the strength
   * of an answer nobody gave, and a client whose connection drops reconnects
   * and is judged again.
   */
  private async revoke(readersChanged: readonly string[]): Promise<void> {
    if (readersChanged.length === 0) return
    // A deployment with Signer Lists but no seed gates no reads, so its pushes
    // to `refs/walgit/signers` revoke nothing — and the verdict route does not
    // exist there. Without this line every such push would ask a route that
    // answers 404 and close the sockets watching that repository.
    if (!capabilitiesFrom(this.env).namesCanBePrivate) return
    for (const ws of this.ctx.getWebSockets()) {
      const { watch, credential } = readSubscription(ws)
      if (!watch) continue
      const affected = watchedRepos(watch).filter((repo) => readersChanged.includes(repo))
      if (affected.length === 0) continue
      let stillAllowed = false
      try {
        const readable = await this.readVerdicts(credential, affected)
        stillAllowed = affected.every((repo) => readable[repo] === true)
      } catch {
        stillAllowed = false
      }
      if (stillAllowed) continue
      try {
        ws.send(encode({ error: 'unauthorized' }))
        ws.close(1008, 'walgit: read access revoked')
      } catch {
        // Already gone; nothing to close.
      }
    }
  }

  /**
   * Before a fan-out: close every scoped socket an event is about to reach
   * whose token its repository's Index now revokes. One conditional read per
   * repository, and only on a deployment with scoped sockets watching it. An
   * Index that cannot be read closes the socket too — the client reconnects
   * and is judged afresh — because delivering on an unknown verdict would be
   * the fail-open this whole check exists to avoid.
   */
  private async closeRevokedWatching(events: readonly RefEvent[]): Promise<void> {
    if (events.length === 0) return
    const verdicts = new Map<string, string | null | 'unknown'>()
    for (const ws of this.ctx.getWebSockets()) {
      const { watch, expires, issued, scopedRepo } = readSubscription(ws)
      if (!watch || expires === undefined) continue
      if (!events.some((event) => watchCovers(watch, event))) continue
      // A socket attached before `issued` was recorded cannot be judged here;
      // the announcement path closes it on any revocation.
      if (issued === undefined || scopedRepo === undefined) continue
      if (!verdicts.has(scopedRepo)) {
        const store = s3StoreFrom(this.env, (credentials) => new AwsClient(credentials))
        let since: string | null | 'unknown' = 'unknown'
        if (store) {
          try {
            since = await this.revocations.validSince(store, scopedRepo)
          } catch {
            since = 'unknown'
          }
        }
        verdicts.set(scopedRepo, since)
      }
      const since = verdicts.get(scopedRepo)!
      if (since === null) continue
      if (since !== 'unknown' && !tokenRevoked(issued, since)) continue
      try {
        ws.send(
          encode({
            error: since === 'unknown' ? 'could not check token revocation' : 'unauthorized',
          }),
        )
        ws.close(1008, since === 'unknown' ? 'walgit: try again' : 'walgit: token revoked')
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Close every socket watching on a scoped token that one of these
   * revocations covers: issued before `since`, for that repository. A scoped
   * socket accepted before this code shipped carries neither field, and is
   * closed by any revocation — the client reconnects and is judged afresh,
   * which costs it a reconnect and never lets it outlive one.
   */
  private revokeTokens(revoked: readonly TokensRevoked[]): void {
    if (revoked.length === 0) return
    for (const ws of this.ctx.getWebSockets()) {
      const { watch, expires, issued, scopedRepo } = readSubscription(ws)
      // Unscoped sockets carry no `expires`; a scoped one always does.
      if (!watch || expires === undefined) continue
      const hit = revoked.some(
        (r) =>
          (scopedRepo === undefined || scopedRepo === r.repo) &&
          (issued === undefined || tokenRevoked(issued, r.since)),
      )
      if (!hit) continue
      try {
        ws.send(encode({ error: 'unauthorized' }))
        ws.close(1008, 'walgit: token revoked')
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Which of these repositories the presented credential may read, from the
   * container — the only half that can verify an SSH signature.
   *
   * Authenticated with the announce secret, the mirror of the call the push
   * path makes in the other direction (`READ_VERDICT_PATH`). A non-answer
   * throws rather than returning an empty map, so no caller can mistake "the
   * container did not say" for "nothing is readable" and then for a verdict.
   */
  private async readVerdicts(
    credential: string | null,
    repos: string[],
  ): Promise<Record<string, boolean>> {
    const request = new Request(`https://walgit.internal${READ_VERDICT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.env.WALGIT_EVENTS_TOKEN ?? ''}`,
      },
      body: JSON.stringify({ credential, repos }),
    })
    const response = await containerFor(this.env).fetch(request)
    if (!response.ok) {
      // Cancelled, not dropped: the container's object counts a request in
      // flight until its body is over, and an unread body may never be — which
      // would hold the idle stop off (worker/durable-container.ts).
      await response.body?.cancel()
      throw new Error(`read verdict: ${response.status}`)
    }
    const body = (await response.json()) as { verdicts?: Record<string, boolean> }
    if (!body.verdicts) throw new Error('read verdict: no verdicts in the answer')
    return body.verdicts
  }

  /** Send one announcement to every socket that asked for it. */
  private broadcast(events: readonly RefEvent[]): number {
    let delivered = 0
    for (const ws of this.ctx.getWebSockets()) {
      const { watch, expires } = readSubscription(ws)
      if (!watch) continue
      // A scoped token that has expired since its watch was accepted
      // (docs/adr/0021): told, closed, and sent nothing. The client
      // reconnects with a fresh token and is judged again.
      if (expires !== undefined && scopedTokenExpired(expires)) {
        try {
          ws.send(encode({ error: 'token expired' }))
          ws.close(1008, 'walgit: token expired')
        } catch {
          // Already gone.
        }
        continue
      }
      const wanted = events.filter((event) => watchCovers(watch, event))
      if (wanted.length === 0) continue
      // Through the outbox rather than straight to the socket: it holds each
      // socket to at most one message per ref per window, so a ref that moves
      // in a burst costs one message carrying the newest sha rather than one
      // per push. A socket that has gone away mid-fan-out must not stop the
      // ones behind it, which is why the outbox never throws.
      //
      // `sent` counts what went out on THIS call. An event held for its window
      // leaves on the outbox's own timer and is not counted here — the number
      // is a fan-out receipt, not a delivery guarantee, and the announcer only
      // logs it.
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
      // Bracketed: anything announced while the container is answering is
      // replayed over the snapshot rather than lost behind it.
      this.refs.beginFill(repo)
      try {
        this.refs.endFill(repo, await this.fetchRefs(repo))
      } catch (error) {
        // Left unknown rather than filled empty: the next connect pays another
        // round-trip, which is cheaper than answering confidently with nothing.
        this.refs.abortFill(repo)
        throw error
      }
    }
    return this.refs.read(repos)
  }

  /** One repository's ref state, read from the Index through the container. */
  private async fetchRefs(repo: string): Promise<Record<string, string>> {
    const request = new Request(
      `https://walgit.internal${REFS_PATH}?repo=${encodeURIComponent(repo)}`,
      { headers: { [INTERNAL_HEADER]: '1' } },
    )
    const response = await containerFor(this.env).fetch(request)
    if (!response.ok) {
      // Cancelled for the reason `readVerdicts` cancels its own.
      await response.body?.cancel()
      throw new Error(`refs lookup for ${repo}: ${response.status}`)
    }
    const body = (await response.json()) as { refs?: Record<string, string> }
    return body.refs ?? {}
  }
}

/**
 * What a socket carries across hibernation: what it watches, and the
 * credential it presented at the upgrade.
 *
 * Both, because the two are needed at different moments — the watch on every
 * fan-out, the credential whenever the container has to be asked again — and
 * an in-memory map of either would be silently empty after an eviction.
 */
interface Subscription {
  credential: string | null
  /** Null until the client sends a valid `watch`. */
  watch: WatchEntry[] | null
  /** A scoped token's `exp`, in seconds, when the watch was accepted on one. */
  expires?: number
  /** Its `iat`, in seconds — what a revocation is compared with. */
  issued?: number
  /** Its claimed repository — the one Index whose revocation applies to it. */
  scopedRepo?: string
}

/** What this socket carries, whatever vintage of this code attached it. */
function readSubscription(ws: WebSocket): Subscription {
  try {
    const attachment = ws.deserializeAttachment() as unknown
    // A bare array is the pre-0013 attachment, still on any socket that was
    // hibernating across the deploy that shipped this. Read as a watch with no
    // credential — which, on a Private deployment, is an unproven reader.
    if (Array.isArray(attachment)) return { credential: null, watch: attachment as WatchEntry[] }
    if (attachment && typeof attachment === 'object') {
      const { credential, watch, expires, issued, scopedRepo } = attachment as Partial<Subscription>
      return {
        credential: typeof credential === 'string' ? credential : null,
        watch: Array.isArray(watch) ? watch : null,
        ...(typeof expires === 'number' ? { expires } : {}),
        ...(typeof issued === 'number' ? { issued } : {}),
        ...(typeof scopedRepo === 'string' ? { scopedRepo } : {}),
      }
    }
  } catch {
    // Nothing attached, or something this version cannot read.
  }
  return { credential: null, watch: null }
}
