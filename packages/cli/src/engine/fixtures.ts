import { z } from 'zod'
import { defineModule } from '../../templates/infra/src/define-module'
import type {
  ActionDeclaration,
  ApplyContext,
  ModuleInstance,
  ReadinessDeclaration,
} from '../../templates/infra/src/types'

/**
 * A module whose `apply`/`destroy` are whatever the test needs.
 *
 * The engine had no tests at all until this file: `resolve.ts` is pure and was
 * never run outside a real `zbc apply`, which meant the two rules it now owns —
 * dependency order, and what a context answers — were verified by deploying.
 */
export interface FakeModuleOptions {
  apply?: (config: Record<string, unknown>, ctx: ApplyContext) => Promise<Record<string, unknown>>
  destroy?: (config: Record<string, unknown>, ctx: ApplyContext) => Promise<void>
  /** Outputs schema; defaults to "any record of anything" — an output is
   * whatever the emitting module says it is, strings included. */
  outputs?: z.ZodType
  withDestroy?: boolean
  /** What proves this fake's resource usable. Absent on almost every fake —
   * the gate must cost a module that declares nothing exactly nothing. */
  ready?: ReadinessDeclaration<Record<string, unknown>, Record<string, unknown>>
  /** Operator-invoked verbs this fake declares. Absent on almost every one. */
  actions?: Record<string, ActionDeclaration<Record<string, unknown>>>
}

export function fakeModule(name: string, opts: FakeModuleOptions = {}) {
  return defineModule({
    name,
    configSchema: z.record(z.unknown()).default({}),
    outputs: (opts.outputs ?? z.record(z.unknown())) as z.ZodType<Record<string, unknown>>,
    apply: opts.apply ?? (async () => ({})),
    ...(opts.destroy || opts.withDestroy ? { destroy: opts.destroy ?? (async () => {}) } : {}),
    ...(opts.ready ? { ready: opts.ready } : {}),
    ...(opts.actions ? { actions: opts.actions } : {}),
  })
}

/** One instance of a throwaway module, named, with the given imports. */
export function fakeInstance(
  name: string,
  opts: FakeModuleOptions & {
    imports?: ModuleInstance[]
    config?: Record<string, unknown>
    ephemeral?: boolean
  } = {},
): ModuleInstance {
  return fakeModule(`mod-${name}`, opts).instance({
    name,
    config: opts.config ?? {},
    imports: opts.imports ?? [],
    ...(opts.ephemeral === undefined ? {} : { ephemeral: opts.ephemeral }),
  })
}

export const names = (instances: ModuleInstance[]): string[] => instances.map((i) => i.name)
