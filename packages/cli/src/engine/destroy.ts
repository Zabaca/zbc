import { createApplyContext } from '../../templates/infra/src/context'
import type {
  ApplyContext,
  ModuleInstance,
  OutputOptions,
  OutputRef,
} from '../../templates/infra/src/types'
import { applyInstance } from './apply'
import { discoverInstances } from './discover'
import { resolveOrder } from './resolve'
import { loadSecrets } from './secrets'

export interface DestroyInstancesOptions {
  secrets: Record<string, string>
  projectRoot: string
  /** Destroy only this instance — see the comment on the filter below. */
  target?: string
  /** Where the instances came from, for error messages. */
  envLabel?: string
}

/**
 * Raised by a destroy context's `output` for an import that has not been
 * applied yet in this run. `destroyInstances` catches it, applies that
 * instance, and re-runs the destroy.
 *
 * Re-running is what buys a SYNCHRONOUS `ctx.output` — the same call, with the
 * same three error messages, in `apply` and in `destroy` — and it is safe for
 * exactly one reason, which every module in core already honours and which this
 * note is here to keep true: **a destroy resolves everything it reads from
 * imports before it performs its first side effect.** The credential is the
 * first line of every `destroy` in core. A module that deleted something and
 * then asked for an import would delete it twice.
 *
 * The other way to break it is to CATCH this — the shape the old `cloudflare`
 * destroy had, and therefore the shape a consumer's fork most likely copied.
 * Nothing in JavaScript survives a bare `catch`, so instead the engine notices
 * afterwards and says so: see `warnIfSignalSwallowed`.
 */
class ImportNotYetApplied extends Error {
  constructor(readonly instanceName: string) {
    super(`import "${instanceName}" is not applied yet`)
    this.name = 'ImportNotYetApplied'
  }
}

/** The graph half of `zbc destroy`: pure over in-memory instances. */
export async function destroyInstances(
  instances: ModuleInstance[],
  opts: DestroyInstancesOptions,
): Promise<void> {
  const sorted = resolveOrder(instances, { envLabel: opts.envLabel, assertImports: false })
  let reversed = [...sorted].reverse()

  // Targeted destroy: tear down ONLY the named instance. Unlike apply, we do
  // NOT pull in the dependency closure, since a thing's dependencies are
  // usually shared infra you don't want destroyed alongside it. Without this filter,
  // `zbc destroy <env> <instance>` silently ignored the instance arg and
  // destroyed the entire environment.
  if (opts.target) {
    const found = reversed.find((i) => i.name === opts.target)
    if (!found) {
      throw new Error(
        `Instance "${opts.target}" not found. Available: ${instances.map((i) => i.name).join(', ')}`,
      )
    }
    reversed = [found]
  }

  // Outputs of instances applied on demand, shared across the whole run: a
  // credential minted for one teardown is the same credential for the next.
  const outputs = new Map<string, unknown>()

  for (const instance of reversed) {
    const { destroy } = instance._definition
    if (!destroy) {
      console.log(`⊘ ${instance.moduleName}:${instance.name} has no destroy — skipping`)
      continue
    }

    const validatedConfig = instance._definition.configSchema.parse(instance.config)

    console.log(`\n→ ${instance.moduleName}:${instance.name}`)

    // On-demand apply is a FULL-environment privilege. In that run whatever it
    // applies is guaranteed to be torn down later in the same pass: an import
    // sorts before its importer, so it sorts after it in reverse. A targeted
    // destroy has no such pass — it would provision shared infra and walk away.
    const ctx = destroyContext(instance, opts, outputs, { onDemand: !opts.target })

    // One extra pass per import, at most: each retry applies an instance that
    // was not applied before, and the set of imports is finite.
    for (;;) {
      try {
        await destroy(validatedConfig, ctx.value)
        break
      } catch (err) {
        if (!(err instanceof ImportNotYetApplied)) throw err
        await ctx.provide(err.instanceName)
      }
    }

    ctx.warnIfSignalSwallowed()

    console.log(`✓ ${instance.moduleName}:${instance.name} destroyed`)
  }
}

/**
 * The context a `destroy` gets: the same two methods, with `output` reporting
 * an import it can still fetch rather than failing on one the engine used to
 * refuse to look up at all (it passed `imports: {}`, and `cloudflare` carried a
 * swallowed catch and a secrets.yaml fallback to work around it).
 *
 * Opt-by-use: a destroy that never calls `output` applies nothing.
 */
function destroyContext(
  instance: ModuleInstance,
  opts: DestroyInstancesOptions,
  outputs: Map<string, unknown>,
  mode: { onDemand: boolean },
) {
  const declared = new Map(instance.imports.map((dep) => [dep.name, dep]))
  const importOutputs: Record<string, unknown> = {}
  for (const dep of instance.imports) {
    if (outputs.has(dep.name)) importOutputs[dep.name] = outputs.get(dep.name)
  }
  /** Imports this destroy asked for. Compared against what was provided, below. */
  const signalled = new Set<string>()

  const base = createApplyContext({
    secrets: opts.secrets,
    imports: importOutputs,
    projectRoot: opts.projectRoot,
  })

  const value: ApplyContext = {
    ...base,
    output(ref: OutputRef, field: string, outputOpts?: OutputOptions): string {
      // `ref.output` is checked here too, so a half-written ref is reported as
      // the typo it is instead of provisioning an instance and THEN failing.
      if (ref.from && ref.output && declared.has(ref.from) && !(ref.from in importOutputs)) {
        if (!mode.onDemand) {
          throw new Error(
            `${field} references instance "${ref.from}", whose outputs a targeted destroy will not create. ` +
              `Run \`zbc destroy <env>\` for the whole environment, which applies "${ref.from}" only to tear ` +
              `it down again, or apply "${ref.from}" yourself first.`,
          )
        }
        signalled.add(ref.from)
        throw new ImportNotYetApplied(ref.from)
      }
      return base.output(ref, field, outputOpts)
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

    await ensureApplied(dep, `${instance.name}'s destroy`, opts, outputs)
    importOutputs[name] = outputs.get(name)
  }

  /**
   * A `destroy` that wraps `ctx.output` in a try/catch swallows the engine's
   * signal, applies nothing, and takes its fallback branch — which is exactly
   * the shape the old `cloudflare` destroy had, and therefore the shape a
   * consumer's fork is most likely to be carrying. Silence there looks like
   * success, so say it.
   */
  function warnIfSignalSwallowed(): void {
    for (const name of signalled) {
      if (name in importOutputs) continue
      console.log(
        `⚠ ${instance.name}'s destroy asked for import "${name}" and then swallowed the error — ` +
          `"${name}" was NOT applied, and whatever the destroy used instead is not its output.`,
      )
    }
  }

  return { value, provide, warnIfSignalSwallowed }
}

/** Apply an instance and its transitive imports, once per run. */
async function ensureApplied(
  instance: ModuleInstance,
  neededBy: string,
  opts: DestroyInstancesOptions,
  outputs: Map<string, unknown>,
): Promise<void> {
  if (outputs.has(instance.name)) return
  // `neededBy` is the immediate asker, not the instance being destroyed: a
  // transitive dependency is needed by the import that reads it, and saying
  // otherwise points at a file that never mentions it.
  for (const dep of instance.imports) {
    await ensureApplied(dep, instance.name, opts, outputs)
  }
  console.log(`→ applying ${instance.name} (needed by ${neededBy})`)
  await applyInstance(instance, opts, outputs)
  console.log(`✓ ${instance.name} applied — this destroy created it; the run tears it down below`)
}

/** The I/O half: discover the environment's instances, decrypt its secrets, destroy. */
export async function destroyEnvironment(
  projectRoot: string,
  envDir: string,
  target?: string,
): Promise<void> {
  const instances = await discoverInstances(envDir)
  const secrets = await loadSecrets(envDir)
  await destroyInstances(instances, { secrets, projectRoot, target, envLabel: envDir })
}
