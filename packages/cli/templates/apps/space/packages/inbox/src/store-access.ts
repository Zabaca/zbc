import type {
  ArrivalMethod,
  AssistantMethod,
  JmapMethod,
  MailMethod,
  NotifyMethod,
  RestoreMethod,
  SpaceMethod,
  StoreApi,
  StoreMethod,
  TelegramMediaMethod,
  TelegramMethod,
} from './app'
import type { StoreObject } from './space-gate'

/**
 * How a Worker reaches the inbox's store: the object's name and the typed face of its untyped `call`. No runtime import (the Durable Object class is src/durable.ts, which
 * imports `cloudflare:workers`), so `bun test` loads it, and it is the one place the name lives for the three callers: the space's Worker, which owns the store since the
 * transfer and calls it in-process (src/space-part.ts), the space's entrances (packages/space/src/worker.ts: Gmail's push, Cloudflare's mail, the delivery reports, the daily pass), and the tests.
 *
 * ── ONE OBJECT, NAMED BY A CONSTANT ──────────────────────────────────────
 * Every request goes to the same Durable Object, and that is the design rather than a simplification waiting to be undone. With one mailbox, ordering matters
 * more than sharding: a conditional write and the read it depends on cannot interleave, which the claim and the double press of Send both rely on. The
 * cost is that everything serialises through one object; for one inbox that is not close to a problem. Renaming the constant is a new, empty inbox. A transfer
 * between Workers keeps the object found by the same name.
 */
export const INBOX_NAME = 'inbox'

/** The binding a Worker reaches the store through: its own class, or (this package's Worker, after the transfer) the space's, bound by `script_name`. */
export interface InboxEnv {
  INBOX: DurableObjectNamespace
}

/** What the Worker asks of a stub of the store's object: the untyped `call`, and the operator's `restart` (src/durable.ts), which every version of the class since the move has had. */
export interface StoreStub {
  call(
    method:
      | StoreMethod
      | SpaceMethod
      | TelegramMethod
      | TelegramMediaMethod
      | MailMethod
      | JmapMethod
      | NotifyMethod
      | ArrivalMethod
      | AssistantMethod
      | RestoreMethod,
    args: unknown[],
  ): Promise<unknown>
  restart(): Promise<void>
}

/** True when `error` is the object's own refusal of `method`: it does not have it, so it is still running the code from before the deploy that added it (`InboxDO.call`, src/durable.ts). */
const lacksMethod = (error: unknown, method: string): boolean =>
  error instanceof Error && error.message === `No such method: ${method}`

/** What the object's own `ctx.abort` says when it restarts (`InboxDO.restart`, src/durable.ts): the expected answer to a restart, which is not a fault. */
const RESTARTED = /restarted on the owner/

/** A restart already under way in this isolate, so callers that fail together restart the object once. */
let restarting: Promise<void> | null = null

function restartOnce(stubFor: () => StoreStub, method: string): Promise<void> {
  if (!restarting) {
    console.warn(
      `inbox: the store object answered "No such method: ${method}", so it is still on the code from before the deploy; restarting it`,
    )
    restarting = (async () => {
      try {
        await stubFor().restart()
      } catch (error) {
        // The object was reset under the call, which is what was asked. Anything else is logged and the retry that follows decides.
        if (!(error instanceof Error && RESTARTED.test(error.message)))
          console.error('inbox: restarting the store object failed', error)
      }
    })().finally(() => {
      restarting = null
    })
  }
  // A promise made in another request may refuse to be awaited here; the retry that follows is the real answer either way.
  return restarting.catch(() => {})
}

/**
 * The typed face of the Durable Object's untyped `call`. The one cast in the
 * path: `StoreApi` says what each method takes and returns, and the object
 * returns exactly what the store or Mailroom returns, structured-cloned.
 *
 * A DEPLOY HEALS ITSELF (the one place this is explained; runbooks give the steps and point here). A Durable Object keeps running the code it started with, for minutes after a deploy, while the new Worker
 * already calls the methods the new code added: one deploy once meant seven minutes of "No such method: mailScope" until the operator restarted the object by hand. So when the object answers exactly
 * that for the method asked, the Worker calls once more on a fresh stub (another caller may have restarted it already) and, only if that also says so, asks the object to restart (`ctx.abort`: the next call
 * starts it afresh under the new code, migrations and settling included) and calls a last time. Callers that fail together share one restart. The method never ran, so repeating it repeats nothing. Each call
 * is on a FRESH stub, because a stub whose target was aborted is broken for good (packages/calendar/src/store-access.ts), which is why this takes a way to get a stub and not one. An object that still lacks
 * the method after its restart fails the call as before, so it never loops. What it costs: a restart resets any other call in flight on the old object, which was running the wrong code for this Worker anyway.
 * The Worker's tail shows one warning per restart. This covers the inbox's object only.
 */
export function storeOver(stubFor: () => StoreStub): StoreApi {
  return {
    call: (async (method: string, ...args: unknown[]) => {
      try {
        return await stubFor().call(method as never, args)
      } catch (error) {
        if (!lacksMethod(error, method)) throw error
      }
      try {
        return await stubFor().call(method as never, args)
      } catch (error) {
        if (!lacksMethod(error, method)) throw error
      }
      await restartOnce(stubFor, method)
      return stubFor().call(method as never, args)
    }) as never,
  }
}

export const storeFor = (env: InboxEnv): StoreApi =>
  storeOver(() => env.INBOX.get(env.INBOX.idFromName(INBOX_NAME)) as unknown as StoreStub)

/** The object itself, for the operator's three (bookmark, counts, restart: src/durable.ts). */
export const objectFor = (env: InboxEnv): StoreObject =>
  env.INBOX.get(env.INBOX.idFromName(INBOX_NAME)) as unknown as StoreObject
