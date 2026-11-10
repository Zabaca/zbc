import type { LiveBinding } from '@space/workspace'
import type { KnowledgeDO } from './durable'
import type { StoreApi, StoreMethod } from './store'

/**
 * How a Worker reaches the knowledge store: the object's name and the typed face of its untyped `call`. No runtime import (`KnowledgeDO` is a type here), so
 * `bun test` loads it, and it is the one place the name lives for the three callers: this package's own Worker (src/worker.ts), the space's Worker, which owns
 * the store since the transfer and calls it in-process, and the tests.
 *
 * ── ONE OBJECT, NAMED BY A CONSTANT ──────────────────────────────────────
 * One knowledge base per install, in one object. Renaming the constant is a new, empty knowledge base. A transfer between Workers keeps it found by the same name.
 */
export const KNOWLEDGE_NAME = 'knowledge'

/** The binding a Worker reaches the store through: its own class, or (this package's Worker, after the transfer) the space's, bound by `script_name`. */
export interface KnowledgeEnv {
  /** The company's live object (the space's `LIVE`), told after a change is stored. Absent where none is bound; nothing is then told. */
  LIVE?: LiveBinding
  KNOWLEDGE: DurableObjectNamespace<KnowledgeDO>
}

/** The object's three operator methods (src/durable.ts), as a stub answers them. */
export interface KnowledgeObject {
  bookmark(): Promise<string>
  restoreTo(bookmark: string): Promise<string>
  /** Always ends with the object reset under the caller: an error is the expected answer. */
  restart(): Promise<void>
}

/** The object itself, for the operator's three. */
export const objectFor = (env: KnowledgeEnv): KnowledgeObject =>
  env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(KNOWLEDGE_NAME)) as unknown as KnowledgeObject

/**
 * The typed face of the object's untyped `call`. A fresh stub for EVERY call: a stub whose object was reset or aborted (the owner's restart route does that) is broken for good, and this face is held for as long as the
 * inbox's object lives (packages/space/src/inbox-knowledge.ts), so a stub kept here would fail every call after a restart of the knowledge store until the holder itself restarted. Getting a stub is cheap.
 */
export const storeFor = (env: KnowledgeEnv): StoreApi => ({
  call: (method, ...args) =>
    (env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName(KNOWLEDGE_NAME)) as unknown as { call(method: StoreMethod, args: unknown[]): Promise<unknown> }).call(method, args) as never,
})
