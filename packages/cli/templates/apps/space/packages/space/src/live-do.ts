// The live object (the space's ADR 0019): ONE Durable Object per company, named `LIVE_NAME`, holding the one socket of every open team page.
//
// It holds NO STORE. Nothing here is a copy of anything: it knows which people have the space open and, when a store tells it a change has been stored (`tell`), sends each of those people's pages a frame naming the
// part and perhaps the conversation, never what changed (packages/workspace/src/live.ts). The page reads the screens it is showing again, through the Worker, which applies every rule. So a restart of this object, or
// a message lost on the way, costs a page one late read (it reads again on reconnecting, on being shown again and every ten minutes), and never data.
//
// HIBERNATING, as meet's are (packages/meet/src/workspace-do.ts): `acceptWebSocket` hands the socket to the runtime, which keeps it open while the object sleeps, and wakes the object for a message, a close, the
// alarm or a call. An idle page costs nothing; the page's ping is answered by the runtime without waking it. What must outlive a sleep is on the socket (its attachment) and nothing is in a field.
//
// THE SIGN-IN CHECK IS THE ONE PER REQUEST (packages/workspace/docs/adr/0003): the Worker verified the Access assertion on the upgrade request and set the two headers read here; this object trusts them because only the
// Worker reaches it (it is not bound to any other). The socket CLOSES WHEN THE SIGN-IN ENDS: the alarm cuts off every socket whose assertion's expiry has passed (`LIVE_CLOSE_SIGNED_OUT`), and a frame from a page whose
// sign-in has ended is answered the same way.
//
// Channel guests are not here: they keep their own connection on meet's workspace object, unchanged.

import { DurableObject } from 'cloudflare:workers'
import { LIVE_CLOSE_SIGNED_OUT, liveFrame, parseLiveMessage } from '@space/workspace'
import { type LiveAttachment, attachmentOf, audience, nextExpiry, peopleOpen, signInEnded } from './live-sockets'

export class LiveDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    // The page's keep-alive ping is answered by the runtime, without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /** The Worker's upgrade request for a page whose sign-in it has checked (src/app.ts, `LIVE_SOCKET_PATH`). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('A socket upgrade is needed.', { status: 426 })
    const who = attachmentOf(request.headers)
    if (!who) return new Response('Bad request.', { status: 400 })
    // A sign-in that has already ended opens nothing: the alarm only waits for sign-ins that have not.
    if (signInEnded(who, Date.now())) return new Response('Your sign-in ended.', { status: 401 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(who satisfies LiveAttachment)
    await this.scheduleExpiry()
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * A store tells this object a change has been stored (an RPC method: the stores call it through their binding). The message is read as untrusted, and the answer is how many pages were told. It never throws:
   * the stores do not wait on it, and a refusal here is a message nobody hears.
   */
  tell(raw: unknown): number {
    const message = parseLiveMessage(raw)
    if (!message) return 0
    const frame = liveFrame(message)
    let told = 0
    for (const ws of audience(this.sockets(), message, Date.now())) {
      try {
        ws.socket.send(frame)
        told++
      } catch {
        // Closing or closed: it will not hear this, and reconnecting reads everything again.
      }
    }
    return told
  }

  /** The people with the space open right now, by sign-in address: what meet's nudge rule asks, so a direct message does not become an email while its reader is on any tab. */
  openPeople(): string[] {
    return peopleOpen(this.sockets(), Date.now())
  }

  // A page sends only its ping, which the runtime answers by itself. Anything that does reach here is a page that may have outlived its sign-in: that is all this checks.
  webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): void {
    if (signInEnded(ws.deserializeAttachment() as LiveAttachment, Date.now())) this.cut(ws)
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // Already closed.
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'error')
    } catch {
      // Already closed.
    }
  }

  /** The alarm: cut off the sockets whose sign-in has ended, and set it again for the next one. */
  async alarm(): Promise<void> {
    const now = Date.now()
    for (const { socket, ...a } of this.sockets()) if (signInEnded(a, now)) this.cut(socket)
    await this.scheduleExpiry()
  }

  private cut(ws: WebSocket): void {
    try {
      ws.close(LIVE_CLOSE_SIGNED_OUT, 'Your sign-in ended.')
    } catch {
      // Already closing.
    }
  }

  private sockets(): (LiveAttachment & { socket: WebSocket })[] {
    return this.ctx.getWebSockets().map((socket) => ({ ...(socket.deserializeAttachment() as LiveAttachment), socket }))
  }

  private async scheduleExpiry(): Promise<void> {
    const at = nextExpiry(this.sockets(), Date.now())
    if (at !== null) await this.ctx.storage.setAlarm(at)
  }
}
