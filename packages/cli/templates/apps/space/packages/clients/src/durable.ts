import { DurableObject } from 'cloudflare:workers'
import { type ClientsCounts, liveOf, ownersOf, tellLive } from '@space/workspace'
import { migrate } from './schema'
import type { ClientsEnv } from './store-access'
import { ClientsStore, STORE_METHODS, type StoreMethod } from './store'
import { bundledInstall } from './workspace'

/**
 * The Clients store's Durable Object. The one file of this package that touches the Workers runtime.
 *
 * The space's Worker (packages/space) OWNS the store and runs Settings, the inbox's reads and the Clients door in-process over it. It is a NEW class, declared as new under `exports` in the space's Worker settings (the install kit's output) with
 * nothing transferred: it starts empty. Unlike the calendar's, nothing in it can be read again from elsewhere: a Client made in the space is only here, so the class, the Worker and the object's name never change.
 *
 * It makes no request to anything: it holds no binding to a source, and a source's Clients arrive as pushes through the Clients door, which hands them to `call` as `upsertExternal`, `markGone` and `syncExternal`.
 */
export class ClientsDO extends DurableObject<ClientsEnv> {
  private readonly store: ClientsStore

  constructor(ctx: DurableObjectState, env: ClientsEnv) {
    super(ctx, env)
    // Before a single request is served, and on every wake from hibernation. A store a newer build migrated throws here.
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
    })
    console.log('clients: the store object started')
    const door = bundledInstall.clientsDoor()
    this.store = new ClientsStore({
      sql: ctx.storage.sql,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => new Date(),
      owners: bundledInstall.people.filter((p) => bundledInstall.isOwner(p)).map((p) => p.address),
      ownerName: bundledInstall.owner().name,
      sources: door ? [door.source] : [],
    })
  }

  /**
   * The only way in to the store, and only to the store's own face (STORE_METHODS). Meant to be called by the Worker that owns the class alone, but nothing in the code enforces that: another Worker in the account
   * could bind this class by `script_name` and call it. The real boundary is who may deploy to the account (the deploy token and the sops file behind it), as for every Worker here; the store's own rules (who may
   * write) still apply to whatever is asked, and an actor it does not know is refused.
   */
  call(method: StoreMethod, args: unknown[]): unknown {
    if (!(STORE_METHODS as readonly string[]).includes(method)) throw new Error(`No such method: ${method}`)
    const before = this.store.changeCount
    const answer = (this.store[method] as (...a: unknown[]) => unknown).apply(this.store, args)
    // Something has been stored: tell the live object, who tells the owners' open pages to read the Clients again. After the store, and never part of it: a message that cannot be delivered changes nothing here
    // (packages/workspace/src/live.ts, `tellLive`). A call that changed nothing (a read, a refusal, a push that was already there) tells no one.
    if (this.store.changeCount !== before) tellLive(liveOf(this.env), { part: 'clients', people: ownersOf(bundledInstall) })
    return answer
  }

  // THE OPERATOR'S THREE, for the sitting of an apply and the comparison with the source's own list. Like `call` they are meant for the Worker that owns the class alone, and the only caller that reaches them for a
  // person is the space's owner-only routes (packages/space/src/clients.ts). They touch no Client. test/durable.test.ts pins this class's methods.

  /** Cloudflare's bookmark of this object's history now: what a restore goes back to (the object keeps 30 days). */
  bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark()
  }

  /** Drop this object's in-memory state; its next call starts it afresh under the code of the Worker that owns the class. The caller sees an error (the object was reset under it), which is the answer. */
  restart(): void {
    this.ctx.abort('restarted on the owner’s word')
  }

  /** How many Clients the store holds, of which kinds, and when the source was last heard from: what is compared with the source's own list. */
  counts(): ClientsCounts {
    return this.store.counts()
  }
}
