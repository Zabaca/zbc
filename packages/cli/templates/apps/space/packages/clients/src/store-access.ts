import type { ClientsCounts, LiveBinding } from '@space/workspace'
import type { ClientsDO } from './durable'
import type { StoreApi, StoreMethod } from './store'

/**
 * How a Worker reaches the Clients store: the object's name and the typed face of its untyped `call`. No runtime import (`ClientsDO` is a type here), so `bun test` loads it, and it is the one place the name lives for
 * the callers: the space's Worker (its parts, src/parts.ts, and the Clients door, src/clients-door.ts) and the tests.
 *
 * ── ONE OBJECT, NAMED BY A CONSTANT ──────────────────────────────────────
 * One list of Clients per install, in one object. Renaming the constant is a new, empty list beside the stored one. Unlike the calendar's store, nothing here is a copy that can be read again: a Client made in the
 * space is only here, so the object's identity (the space's Worker, class `ClientsDO`) and this name never change.
 */
export const CLIENTS_NAME = 'clients'

/** The binding a Worker reaches the store through: the space's own class, declared as new in its wrangler file. */
export interface ClientsEnv {
  /** The company's live object (the space's `LIVE`), told after a change is stored. Absent where none is bound; nothing is then told. */
  LIVE?: LiveBinding
  CLIENTS_STORE: DurableObjectNamespace<ClientsDO>
}

/** The object's three operator methods (src/durable.ts), as a stub answers them. */
export interface ClientsObject {
  bookmark(): Promise<string>
  /** Always ends with the object reset under the caller: an error is the expected answer. */
  restart(): Promise<void>
  counts(): Promise<ClientsCounts>
}

/** The object itself, for the operator's three. A fresh stub per call, like the store's. */
export const objectFor = (env: Pick<ClientsEnv, 'CLIENTS_STORE'>): ClientsObject => ({
  bookmark: () => stubOf(env).bookmark(),
  restart: () => stubOf(env).restart(),
  counts: () => stubOf(env).counts(),
})

const stubOf = (env: Pick<ClientsEnv, 'CLIENTS_STORE'>): ClientsObject =>
  env.CLIENTS_STORE.get(env.CLIENTS_STORE.idFromName(CLIENTS_NAME)) as unknown as ClientsObject

/**
 * The typed face of the object's untyped `call`. A fresh stub for EVERY call: a stub whose object was reset or aborted (the owner's restart route does that) is broken for good, and this face is held for as long as the
 * object that holds it lives (the inbox's, once it reads Clients here), so a stub kept here would fail every call after a restart of the Clients store until the holder itself restarted. Getting a stub is cheap.
 */
export const storeFor = (env: Pick<ClientsEnv, 'CLIENTS_STORE'>): StoreApi => ({
  call: (method, ...args) =>
    (env.CLIENTS_STORE.get(env.CLIENTS_STORE.idFromName(CLIENTS_NAME)) as unknown as { call(method: StoreMethod, args: unknown[]): Promise<unknown> }).call(method, args) as never,
})
