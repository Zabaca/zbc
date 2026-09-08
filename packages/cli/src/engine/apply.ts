import { createApplyContext } from '../../templates/infra/src/context'
import { legacyConfigEphemeral } from '../../templates/infra/src/define-module'
import type { ApplyContext, ModuleInstance } from '../../templates/infra/src/types'
import { discoverInstances } from './discover'
import { createReadinessGate, type ReadinessGate } from './readiness'
import {
  assertEphemeralDestroyable,
  assertRotationSafe,
  isEphemeral,
  resolveOrder,
} from './resolve'
import {
  createSecretOutputRegistry,
  redactError,
  type SecretOutputRegistry,
} from './secret-outputs'
import { loadSecrets } from './secrets'

/** What one instance's apply needs, whichever path called it. */
export interface InstanceRunOptions {
  secrets: Record<string, string>
  projectRoot: string
  /**
   * The run's readiness gate. Optional so a caller with a single instance and
   * no imports need not build one; both engine paths pass theirs, because the
   * memo of "already proven" is per RUN and a fresh gate per instance would
   * re-probe a dependency once per importer.
   */
  gate?: ReadinessGate
  /**
   * The run's credential registry. Run-scoped for the same reason the gate is:
   * a credential minted by one instance can be echoed back in an error raised
   * by another, several instances later.
   */
  secretOutputs?: SecretOutputRegistry
}

export interface ApplyInstancesOptions extends InstanceRunOptions {
  /** Apply only these instances and their transitive imports. */
  target?: string | string[]
  /** Where the instances came from, for error messages. */
  envLabel?: string
}

/**
 * Apply one instance and record its outputs.
 *
 * Split out so the destroy path can reach it: a `destroy` that reads an
 * imported instance's output needs that instance applied, and the alternative
 * — every module carrying a fallback for the outputs it cannot see — is what
 * this replaced.
 */
export async function applyInstance(
  instance: ModuleInstance,
  opts: InstanceRunOptions,
  outputs: Map<string, unknown>,
): Promise<unknown> {
  const ctx = await instanceContext(instance, opts, outputs)

  const validatedConfig = instance._definition.configSchema.parse(instance.config)

  const result = await instance._definition.apply(validatedConfig, ctx)

  instance._definition.outputsSchema.parse(result)

  outputs.set(instance.name, result)
  // Before anything else can print or persist this instance's outputs.
  opts.secretOutputs?.record(instance, result)
  // Recorded, not probed. Whether this instance's resource has to prove itself
  // usable is decided by whoever imports it — see `readiness.ts`.
  opts.gate?.record(instance, validatedConfig, result, ctx)
  return result
}

/**
 * The context for one instance on the apply path: its imports are whatever the
 * instances ahead of it in the sort emitted, which is the whole of the ordering
 * guarantee.
 */
async function instanceContext(
  instance: ModuleInstance,
  opts: InstanceRunOptions,
  outputs: Map<string, unknown>,
): Promise<ApplyContext> {
  const importOutputs: Record<string, unknown> = {}
  for (const dep of instance.imports) {
    // THE EDGE. Everything this instance is about to read from `dep` is held
    // here until `dep`'s own module says its resource is usable.
    await opts.gate?.ensureReady(dep.name)
    importOutputs[dep.name] = outputs.get(dep.name)
  }
  return createApplyContext({
    secrets: opts.secrets,
    imports: importOutputs,
    projectRoot: opts.projectRoot,
  })
}

/**
 * Destroy an ephemeral instance so the apply that follows starts from nothing.
 *
 * The engine adds NO catch of its own. The three modules that used to do this
 * inline each swallowed the failure — `catch {}` twice, `allowFailure: true`
 * once — which turned "the delete was refused" into "the resource is clean",
 * and the resource then persisted across every preview run. Each of those
 * modules' own `destroy` treats an absent resource as success, so nothing here
 * needs a catch to survive the first-ever apply.
 *
 * What a module's OWN `destroy` swallows is still swallowed — `r2`'s logs a
 * refused delete and returns, deliberately, so that `zbc destroy` does not abort
 * the whole environment on one non-empty bucket. See its `destroy` doc: an
 * ephemeral `r2` instance is only as clean as the bucket the app left behind.
 */
async function destroyEphemeral(
  instance: ModuleInstance,
  opts: InstanceRunOptions,
  outputs: Map<string, unknown>,
): Promise<void> {
  // `assertEphemeralDestroyable` has already run over the whole graph.
  const destroy = instance._definition.destroy!
  const validatedConfig = instance._definition.configSchema.parse(instance.config)
  await destroy(validatedConfig, await instanceContext(instance, opts, outputs))
}

/** The graph half of `zbc apply`: pure over in-memory instances, no I/O of its own. */
export async function applyInstances(
  instances: ModuleInstance[],
  opts: ApplyInstancesOptions,
): Promise<Map<string, unknown>> {
  const sorted = resolveOrder(instances, { target: opts.target, envLabel: opts.envLabel })
  assertEphemeralDestroyable(sorted)
  assertRotationSafe(sorted)
  const outputs = new Map<string, unknown>()
  const registry = opts.secretOutputs ?? createSecretOutputRegistry()
  const runOpts: InstanceRunOptions = {
    ...opts,
    secretOutputs: registry,
    gate: opts.gate ?? createReadinessGate({ redact: (text) => registry.redactText(text) }),
  }

  for (const instance of sorted) {
    console.log(`\n→ ${instance.moduleName}:${instance.name}`)
    // Every failure below this line leaves through one place, because every one
    // of them can be carrying a minted credential: a provider echoing the
    // Authorization header it refused, a probe's last failure, a module's own
    // `throw new Error(\`... ${token}\`)`.
    try {
      if (isEphemeral(instance)) {
        if (legacyConfigEphemeral(instance.moduleName, instance.config)) {
          console.log(
            `  ⚠ ${instance.name}: config.ephemeral is deprecated — set ephemeral: true on the instance`,
          )
        }
        console.log(`  ephemeral: destroying before re-apply`)
        await destroyEphemeral(instance, runOpts, outputs)
      }
      await applyInstance(instance, runOpts, outputs)
    } catch (err) {
      throw redactError(registry, err)
    }
    console.log(`✓ ${instance.moduleName}:${instance.name} applied`)
  }

  return outputs
}

/** One instance that was applied, and what it emitted. */
export interface AppliedInstance {
  name: string
  /** The module behind the instance — the outputs mean nothing without it. */
  module: string
  outputs: unknown
}

export interface ApplyEnvironmentResult {
  /** Outputs by instance name, in apply order. */
  outputs: Map<string, unknown>
  /** The same, as a list a caller can serialize: name, module, outputs. */
  instances: AppliedInstance[]
}

/** The I/O half: discover the environment's instances, decrypt its secrets, apply. */
export async function applyEnvironment(
  projectRoot: string,
  envDir: string,
  target?: string | string[],
): Promise<ApplyEnvironmentResult> {
  const instances = await discoverInstances(envDir)
  const secrets = await loadSecrets(envDir)
  const secretOutputs = createSecretOutputRegistry()
  const outputs = await applyInstances(instances, {
    secrets,
    projectRoot,
    target,
    envLabel: envDir,
    secretOutputs,
  })

  // `outputs` is written once per instance as the sorted loop runs, so its
  // insertion order IS the apply order — which is what a reader of the result
  // wants, and what a re-sort here would have to reconstruct.
  const byName = new Map(instances.map((instance) => [instance.name, instance]))
  const applied: AppliedInstance[] = Array.from(outputs, ([name, value]) => {
    const instance = byName.get(name)
    return {
      name,
      module: instance?.moduleName ?? 'unknown',
      // `instances` is what a caller SERIALIZES — `zbc apply --json` writes it
      // to a file. A declared credential does not go there. `outputs` (the map)
      // is the in-memory half and keeps the real values, because that is the
      // channel `ctx.output` reads.
      outputs: instance ? secretOutputs.redactOutputs(instance, value) : value,
    }
  })

  return { outputs, instances: applied }
}
