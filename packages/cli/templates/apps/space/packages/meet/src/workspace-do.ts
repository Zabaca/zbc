// The Workspace Durable Object: one instance, under one fixed name (WORKSPACE_NAME), holding every conversation.
//
// The rules are WorkspaceCore's (workspace.ts); this file adapts storage and the sockets and nothing else
// (docs/adr/0003). It is the first object in this repo to hold WebSockets, so it uses Cloudflare's hibernation
// API: `acceptWebSocket` hands the socket to the runtime, which keeps it connected while the object sleeps, and
// wakes the object for a message, a close or the alarm. Anything that must outlive a sleep is on the socket
// (its attachment and tags) or in storage, never in a field.
//
// A socket opens with a ticket the router has already spent, so every socket here belongs to one person whose
// sign-in the router has checked. It is tagged `p:<person>` (and `s:<session>` for a guest's), which is how a
// change finds the sockets it is for and how a removal finds the ones to cut off.

import { DurableObject } from 'cloudflare:workers'
import { liveOf, openPeople, tellLive } from '@space/workspace'
import { PhoneCore, type PhoneInvokeResult, invokePhone } from './phone'
import { RoomError, type Sql, countRows } from './room'
import { BUNDLED_INSTALL } from './company'
import { type Effect, WORKSPACE_COUNTED, WorkspaceCore, type WsInvokeResult, invokeWorkspace } from './workspace'
import { CLOSE_SIGNED_OUT, type ServerFrame } from './workspace-model'
import { chatMessages } from './workspace-live'
import { type SocketAttachment, nextExpiry, parseFrame, signInEnded } from './workspace-sockets'

export class WorkspaceDO extends DurableObject {
  private readonly core: WorkspaceCore
  private readonly sql: Sql
  /** The phone's rules, over the same storage (docs/adr/0004). */
  private readonly phone: PhoneCore

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    const sql: Sql = {
      all: <T>(q: string, ...params: unknown[]) => ctx.storage.sql.exec(q, ...(params as never[])).toArray() as T[],
      run: (q: string, ...params: unknown[]) => {
        ctx.storage.sql.exec(q, ...(params as never[]))
      },
    }
    this.sql = sql
    // Every table is IF NOT EXISTS, so constructing on every boot (and every wake) is safe.
    this.core = new WorkspaceCore(sql, () => BUNDLED_INSTALL)
    this.phone = new PhoneCore(sql, () => BUNDLED_INSTALL, undefined, undefined, this.core.phoneDesk())
    // An idle socket is kept open by the runtime answering a ping for us, without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    // The line the move's check reads in `wrangler tail space` (the space's ADR 0016): a moved object keeps running its old Worker's code until it
    // restarts, so the first start under the space's code is the proof it has. A wake from hibernation prints it too; the restart is what is read.
    console.log('meet: the workspace object started')
  }

  // THE OPERATOR'S FOUR, for a move of this class between Workers. Like `invoke` they are meant for the Workers that own or bind the class alone, and the only caller that reaches
  // them for a person is the space's owner-only routes. They touch no message and no person.

  /** How many rows each table holds, and how many people and conversations of each kind: numbers under names, read before and after a move (the row counts must be equal). */
  counts(): Record<string, number> {
    return countRows(this.sql, WORKSPACE_COUNTED.tables, WORKSPACE_COUNTED.grouped)
  }

  /** Cloudflare's bookmark of this object's history now: what a restore goes back to. */
  bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark()
  }

  /** Arm a restore to `bookmark` for the object's next start. Nothing changes until the object restarts (`restart`). */
  restoreTo(bookmark: string): Promise<string> {
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
  }

  /**
   * Drop this object's in-memory state and close its sockets; its next call starts it afresh, under the code of the Worker that owns the class. The caller sees an error (the object was reset
   * under it), which is the answer. Every open page reconnects and catches up (its `hello`, with the last change it saw).
   */
  restart(): void {
    this.ctx.abort('restarted on the owner’s word')
  }

  /** The router's door into the core: a method by name, its refusal as data (as RoomDO.invoke). */
  async invoke(method: string, args: unknown[]): Promise<WsInvokeResult> {
    try {
      // The cron's question needs to know who has the page open. A guest's socket is on this object; a teammate's page is on the space's live object, on ANY of their tabs, which is asked here.
      // Not knowing (no live object bound, it is down or slow) is "nobody has it open": a nudge that should have been held back goes out, which is a nuisance and never a lost message.
      if (method === 'dueNudges' || method === 'sweep') return invokeWorkspace(this.core, method, [args[0], this.online(), await openPeople(liveOf(this.env))])
      return invokeWorkspace(this.core, method, args)
    } finally {
      this.flush()
    }
  }

  /** The same door for the phone core: one method, the core's methods by name, a refusal as data. */
  invokePhone(method: string, args: unknown[]): PhoneInvokeResult {
    try {
      return invokePhone(this.phone, method, args)
    } finally {
      // A voicemail or a missed call posted to the Phone conversation is a change like any other: pushed to the sockets now.
      this.flush()
    }
  }

  /** A socket from the router: the ticket was spent there, and the headers are the router's own, built fresh. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('A socket upgrade is needed.', { status: 426 })
    const person = request.headers.get('x-meet-person')
    const endsAt = Number(request.headers.get('x-meet-ends'))
    if (!person || !Number.isFinite(endsAt)) return new Response('Bad request.', { status: 400 })
    const session = request.headers.get('x-meet-session') || null
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [`p:${person}`, ...(session ? [`s:${session}`] : [])])
    server.serializeAttachment({ person, session, endsAt, ready: false } satisfies SocketAttachment)
    await this.scheduleExpiry()
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const a = ws.deserializeAttachment() as SocketAttachment
    const now = Date.now()
    if (signInEnded(a, now)) {
      ws.close(CLOSE_SIGNED_OUT, 'Your sign-in ended.')
      return
    }
    const frame = parseFrame(message)
    if (!frame) return this.tell(ws, { t: 'error', message: 'bad frame' })
    const actor = { via: 'socket', person: a.person } as const
    try {
      if (frame.t === 'hello') {
        const caught = this.core.catchUp(actor, frame.since, now)
        this.tell(ws, caught.reload ? { t: 'reload' } : { t: 'catchup', changes: caught.changes, seq: caught.seq })
        // From here on changes are pushed: after the catch-up, so the browser sees them in order.
        ws.serializeAttachment({ ...a, ready: true } satisfies SocketAttachment)
      } else if (frame.t === 'read') {
        this.core.markRead(actor, frame.conv, frame.upTo, now)
      }
    } catch (err) {
      if (!(err instanceof RoomError)) throw err
      if (err.status === 401) ws.close(CLOSE_SIGNED_OUT, err.message)
      else this.tell(ws, { t: 'error', message: err.message })
    } finally {
      this.flush()
    }
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
    for (const ws of this.ctx.getWebSockets()) {
      if (signInEnded(ws.deserializeAttachment() as SocketAttachment, now)) ws.close(CLOSE_SIGNED_OUT, 'Your sign-in ended.')
    }
    await this.scheduleExpiry()
  }

  private async scheduleExpiry(): Promise<void> {
    const at = nextExpiry(this.ctx.getWebSockets().map((w) => w.deserializeAttachment() as SocketAttachment))
    if (at !== null) await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000))
  }

  /** People with at least one socket open. */
  private online(): string[] {
    return [...new Set(this.ctx.getWebSockets().map((w) => (w.deserializeAttachment() as SocketAttachment).person))]
  }

  private tell(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // The socket is gone; its close will tidy up.
    }
  }

  /**
   * Do what the call just decided: push each change to its people's ready sockets, and cut off the sockets named.
   * It never throws. The call it follows has already written its change, and a socket that is closing (a removed
   * person's, cut off a moment ago) refuses a send; neither may turn a written change into an error for the caller.
   */
  private flush(): void {
    const effects = this.core.takeOutbox() as Effect[]
    // The changes are stored: tell the space's live object, for the teammates' pages (src/workspace-live.ts). Guests are pushed to below, on their own sockets.
    try {
      for (const message of chatMessages(effects, (people, conv) => this.core.liveTargets(people, conv))) tellLive(liveOf(this.env), message)
    } catch (err) {
      console.warn('live: the workspace could not name who to tell:', err instanceof Error ? err.message : String(err))
    }
    for (const e of effects) {
      if (e.t === 'deliver') {
        const text = JSON.stringify({ t: 'change', change: e.change } satisfies ServerFrame)
        for (const person of e.people) {
          for (const ws of this.ctx.getWebSockets(`p:${person}`)) {
            try {
              if ((ws.deserializeAttachment() as SocketAttachment).ready) ws.send(text)
            } catch {
              // Closing or closed: it will not hear this, and reconnecting catches it up.
            }
          }
        }
      } else {
        for (const ws of this.ctx.getWebSockets(e.session ? `s:${e.session}` : `p:${e.person}`)) {
          try {
            ws.close(e.code, e.reason)
          } catch {
            // Already closing.
          }
        }
      }
    }
  }
}
