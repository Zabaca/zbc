import { createApplyContext } from '../../templates/infra/src/context'
import { legacyConfigEphemeral } from '../../templates/infra/src/define-module'
import type { ApplyContext, ModuleInstance } from '../../templates/infra/src/types'
import { discoverInstances } from './discover'
import { assertEphemeralDestroyable, isEphemeral, resolveOrder } from './resolve'
import { loadSecrets } from './secrets'

export interface ApplyInstancesOptions {
  secrets: Record<string, string>
  projectRoot: string
  /** Apply only this instance and its transitive imports. */
  target?: string
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
  opts: { secrets: Record<string, string>; projectRoot: string },
  outputs: Map<string, unknown>,
): Promise<unknown> {
  const ctx = instanceContext(instance, opts, outputs)

  const validatedConfig = instance._definition.configSchema.parse(instance.config)

  const result = await instance._definition.apply(validatedConfig, ctx)

  instance._definition.outputsSchema.parse(result)

  outputs.set(instance.name, result)
  return result
}

/**
 * The context for one instance on the apply path: its imports are whatever the
 * instances ahead of it in the sort emitted, which is the whole of the ordering
 * guarantee.
 */
function instanceContext(
  instance: ModuleInstance,
  opts: { secrets: Record<string, string>; projectRoot: string },
  outputs: Map<string, unknown>,
): ApplyContext {
  const importOutputs: Record<string, unknown> = {}
  for (const dep of instance.imports) {
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
  opts: { secrets: Record<string, string>; projectRoot: string },
  outputs: Map<string, unknown>,
): Promise<void> {
  // `assertEphemeralDestroyable` has already run over the whole graph.
  const destroy = instance._definition.destroy!
  const validatedConfig = instance._definition.configSchema.parse(instance.config)
  await destroy(validatedConfig, instanceContext(instance, opts, outputs))
}

/** The graph half of `zbc apply`: pure over in-memory instances, no I/O of its own. */
export async function applyInstances(
  instances: ModuleInstance[],
  opts: ApplyInstancesOptions,
): Promise<Map<string, unknown>> {
  const sorted = resolveOrder(instances, { target: opts.target, envLabel: opts.envLabel })
  assertEphemeralDestroyable(sorted)
  const outputs = new Map<string, unknown>()

  for (const instance of sorted) {
    console.log(`\n→ ${instance.moduleName}:${instance.name}`)
    if (isEphemeral(instance)) {
      if (legacyConfigEphemeral(instance.moduleName, instance.config)) {
        console.log(
          `  ⚠ ${instance.name}: config.ephemeral is deprecated — set ephemeral: true on the instance`,
        )
      }
      console.log(`  ephemeral: destroying before re-apply`)
      await destroyEphemeral(instance, opts, outputs)
    }
    await applyInstance(instance, opts, outputs)
    console.log(`✓ ${instance.moduleName}:${instance.name} applied`)
  }

  return outputs
}

/** The I/O half: discover the environment's instances, decrypt its secrets, apply. */
export async function applyEnvironment(
  projectRoot: string,
  envDir: string,
  target?: string,
): Promise<Map<string, unknown>> {
  const instances = await discoverInstances(envDir)
  const secrets = await loadSecrets(envDir)
  return applyInstances(instances, { secrets, projectRoot, target, envLabel: envDir })
}
