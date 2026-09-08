// Reading an import OUTSIDE an apply pass.
//
// `apply` has it easy: an import sorts before its importer, so by the time a
// module asks, the answer is already in the run's outputs map. The other two
// verbs have no such pass — a `destroy` runs in reverse order, and an action is
// one instance the operator named — and the old answer was `imports: {}`, which
// pushed the judgment into every module (leeandco's `cloudflare-email` refuses
// a referenced `zoneId` outright and falls back to secrets.yaml for
// `apiToken`).
//
// So: the context resolves an import by applying it, on demand, only if asked.
// This file is that mechanism, shared by `destroy.ts` and `actions.ts` so the
// two cannot drift about what "not applied yet" means.

import { createApplyContext } from '../../templates/infra/src/context'
import type {
  ApplyContext,
  ModuleInstance,
  OutputOptions,
  OutputRef,
} from '../../templates/infra/src/types'
import { applyInstance, type InstanceRunOptions } from './apply'

/**
 * Raised by an on-demand context's `output`/`outputValue` for an import that
 * has not been applied yet in this run. `withOnDemandImports` catches it,
 * applies that instance, and re-runs the body.
 *
 * Re-running is what buys a SYNCHRONOUS `ctx.output` — the same call, with the
 * same messages, in `apply`, in `destroy` and in an action — and it is safe for
 * exactly one reason, which every module in core already honours and which this
 * note is here to keep true: **a body resolves everything it reads from imports
 * before it performs its first side effect.** The credential is the first line
 * of every `destroy` in core. A module that deleted something and then asked
 * for an import would delete it twice.
 *
 * The other way to break it is to CATCH this — the shape the old `cloudflare`
 * destroy had, and therefore the shape a consumer's fork most likely copied.
 * Nothing in JavaScript survives a bare `catch`, so instead the engine notices
 * afterwards and says so: see `warnIfSignalSwallowed`.
 */
export class ImportNotYetApplied extends Error {
  constructor(readonly instanceName: string) {
    super(`import "${instanceName}" is not applied yet`)
    this.name = 'ImportNotYetApplied'
  }
}

export interface OnDemandMode {
  /**
   * May this run apply an import that is not applied yet? A full-environment
   * destroy may (whatever it applies is torn down later in the same pass); a
   * targeted destroy may not (it would provision shared infra and walk away).
   */
  onDemand: boolean
  /** How the asker reads in log lines: `web's destroy`, `domain's action "purchase"`. */
  asker: string
  /** The error for a ref this run refuses to resolve. Required when `onDemand` is false. */
  refuse?: (ref: { from: string }, field: string) => string
  /** An extra line after an on-demand apply — a destroy says it will tear it down again. */
  afterApply?: (name: string) => string
}

/**
 * Run `body` with a context whose imports are fetched as it asks for them,
 * retrying once per import. Returns whatever `body` returned.
 */
export async function withOnDemandImports<T>(
  instance: ModuleInstance,
  opts: InstanceRunOptions,
  outputs: Map<string, unknown>,
  mode: OnDemandMode,
  body: (ctx: ApplyContext) => Promise<T>,
): Promise<T> {
  const ctx = onDemandContext(instance, opts, outputs, mode)
  // One extra pass per import, at most: each retry applies an instance that
  // was not applied before, and the set of imports is finite.
  for (;;) {
    try {
      const result = await body(ctx.value)
      ctx.warnIfSignalSwallowed()
      return result
    } catch (err) {
      if (!(err instanceof ImportNotYetApplied)) throw err
      await ctx.provide(err.instanceName)
    }
  }
}

/**
 * The context itself: the same two rules, with the import lookup able to say
 * "not yet" instead of "never".
 *
 * Opt-by-use: a body that never reads an import applies nothing.
 */
function onDemandContext(
  instance: ModuleInstance,
  opts: InstanceRunOptions,
  outputs: Map<string, unknown>,
  mode: OnDemandMode,
) {
  const declared = new Map(instance.imports.map((dep) => [dep.name, dep]))
  const importOutputs: Record<string, unknown> = {}
  for (const dep of instance.imports) {
    if (outputs.has(dep.name)) importOutputs[dep.name] = outputs.get(dep.name)
  }
  /** Imports this body asked for. Compared against what was provided, below. */
  const signalled = new Set<string>()

  const base = createApplyContext({
    secrets: opts.secrets,
    imports: importOutputs,
    projectRoot: opts.projectRoot,
  })

  /** Both spellings of the edge go through here before reaching `base`. */
  function signalIfPending(ref: OutputRef, field: string): void {
    // `ref.output` is checked here too, so a half-written ref is reported as
    // the typo it is instead of provisioning an instance and THEN failing.
    if (!ref.from || !ref.output) return
    if (!declared.has(ref.from) || ref.from in importOutputs) return
    if (!mode.onDemand) throw new Error(mode.refuse!({ from: ref.from }, field))
    signalled.add(ref.from)
    throw new ImportNotYetApplied(ref.from)
  }

  const value: ApplyContext = {
    ...base,
    output(ref: OutputRef, field: string, outputOpts?: OutputOptions): string {
      signalIfPending(ref, field)
      return base.output(ref, field, outputOpts)
    },
    outputValue(ref: OutputRef, field: string): unknown {
      signalIfPending(ref, field)
      return base.outputValue(ref, field)
    },
  }

  /** Apply `name` (and whatever it imports) so the retry can resolve it. */
  async function provide(name: string): Promise<void> {
    const dep = declared.get(name)
    // Both are unreachable through `value.output` above; a module that
    // swallowed the signal and rethrew it could still get here, and a silent
    // retry loop is worse than the original error.
    if (!dep) throw new Error(`Cannot apply "${name}": it is not among ${instance.name}'s imports`)
    if (name in importOutputs) throw new Error(`Import "${name}" was already applied`)

    await ensureApplied(dep, mode.asker, opts, outputs)
    if (mode.afterApply) console.log(mode.afterApply(name))
    // THE EDGE, again: the value this body is about to read is held until the
    // module that minted it says it is usable.
    await opts.gate?.ensureReady(name)
    importOutputs[name] = outputs.get(name)
  }

  /**
   * A body that wraps `ctx.output` in a try/catch swallows the engine's signal,
   * applies nothing, and takes its fallback branch — which is exactly the shape
   * the old `cloudflare` destroy had, and therefore the shape a consumer's fork
   * is most likely to be carrying. Silence there looks like success, so say it.
   */
  function warnIfSignalSwallowed(): void {
    for (const name of signalled) {
      if (name in importOutputs) continue
      console.log(
        `⚠ ${mode.asker} asked for import "${name}" and then swallowed the error — ` +
          `"${name}" was NOT applied, and whatever it used instead is not its output.`,
      )
    }
  }

  return { value, provide, warnIfSignalSwallowed }
}

/** Apply an instance and its transitive imports, once per run. */
async function ensureApplied(
  instance: ModuleInstance,
  neededBy: string,
  opts: InstanceRunOptions,
  outputs: Map<string, unknown>,
): Promise<void> {
  if (outputs.has(instance.name)) return
  // `neededBy` is the immediate asker, not the instance at the root: a
  // transitive dependency is needed by the import that reads it, and saying
  // otherwise points at a file that never mentions it.
  for (const dep of instance.imports) {
    await ensureApplied(dep, instance.name, opts, outputs)
  }
  console.log(`→ applying ${instance.name} (needed by ${neededBy})`)
  await applyInstance(instance, opts, outputs)
}
