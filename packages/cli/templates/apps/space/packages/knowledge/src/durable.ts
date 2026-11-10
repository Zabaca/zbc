import { DurableObject } from 'cloudflare:workers'
import { liveOf, ownersOf, tellLive } from '@space/workspace'
import { migrate } from './schema'
import type { KnowledgeEnv } from './store-access'
import { CHANGING_METHODS, KnowledgeStore, STORE_METHODS, type StoreMethod } from './store'
import { bundledInstall } from './workspace'

/**
 * The knowledge store's Durable Object. The one file of this package that touches the Workers runtime.
 *
 * The space's Worker (packages/space) OWNS the store and runs the Knowledge tab and the inbox's
 * assistants' reads in-process over it. This package has no Worker of its own: the Worker that once held the class had to keep it in its code while Cloudflare's transfer to the space's Worker was under way,
 * and was deleted after. The object is found by `KNOWLEDGE_NAME` (src/store-access.ts).
 */
export class KnowledgeDO extends DurableObject<KnowledgeEnv> {
  private readonly store: KnowledgeStore

  constructor(ctx: DurableObjectState, env: KnowledgeEnv) {
    super(ctx, env)
    // Before a single request is served, and on every wake from hibernation. A store a newer build migrated throws here.
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage.sql)
    })
    // The line the move's check reads in `wrangler tail space`: a moved object keeps running its old Worker's code until it restarts, so the first
    // start under the space's code is the proof it has (the space's ADR 0015).
    console.log('knowledge: the store object started')
    this.store = new KnowledgeStore({
      sql: ctx.storage.sql,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
      businesses: bundledInstall.businesses().map((b) => b.id),
      owners: bundledInstall.people.filter((p) => bundledInstall.isOwner(p)).map((p) => p.address),
      ownerName: bundledInstall.owner().name,
    })
  }

  /**
   * The only way in to the store, and only to the store's own face (STORE_METHODS). Meant to be called by the Workers that own or bind the class
   * alone, but nothing in the code enforces that: another Worker in the account could bind this class by `script_name` and call it.
   * The real boundary is who may deploy to the account (the deploy token and the sops file behind it), as for every Worker here; the
   * store's own rules (who may write) still apply to whatever is asked, and an actor it does not know is refused.
   */
  call(method: StoreMethod, args: unknown[]): unknown {
    if (!(STORE_METHODS as readonly string[]).includes(method)) throw new Error(`No such method: ${method}`)
    const answer = (this.store[method] as (...a: unknown[]) => unknown).apply(this.store, args)
    // A change has been stored: tell the live object, who tells the owners' open pages to read the knowledge base again. After the store, and never part of it: a message that cannot be delivered
    // changes nothing here (packages/workspace/src/live.ts, `tellLive`).
    if ((CHANGING_METHODS as readonly string[]).includes(method)) tellLive(liveOf(this.env), { part: 'knowledge', people: ownersOf(bundledInstall) })
    return answer
  }

  // THE OPERATOR'S THREE, for a move of this class between Workers. Like `call` they are meant for the Workers that own or bind the class alone, and
  // the only caller that reaches them for a person is the space's owner-only routes (packages/space/src/knowledge.ts). They touch no entry. test/worker.test.ts pins this class's methods.

  /** Cloudflare's bookmark of this object's history now: what a restore goes back to. */
  bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark()
  }

  /** Arm a restore to `bookmark` for the object's next start. Nothing changes until the object restarts (`restart`). */
  restoreTo(bookmark: string): Promise<string> {
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
  }

  /**
   * Drop this object's in-memory state; its next call starts it afresh under the code of the Worker that owns the class. The caller sees an error (the object was reset under it), which is the answer.
   * A move to the new Worker, and the rehearsal of the way back, both used an abort to put an object onto its new Worker's code.
   */
  restart(): void {
    this.ctx.abort('restarted on the owner’s word')
  }
}
