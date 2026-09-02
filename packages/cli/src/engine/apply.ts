import { createApplyContext } from '../../templates/infra/src/context'
import type { ModuleInstance } from '../../templates/infra/src/types'
import { discoverInstances } from './discover'
import { resolveOrder } from './resolve'
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
  const importOutputs: Record<string, unknown> = {}
  for (const dep of instance.imports) {
    importOutputs[dep.name] = outputs.get(dep.name)
  }

  const ctx = createApplyContext({
    secrets: opts.secrets,
    imports: importOutputs,
    projectRoot: opts.projectRoot,
  })

  const validatedConfig = instance._definition.configSchema.parse(instance.config)

  const result = await instance._definition.apply(validatedConfig, ctx)

  instance._definition.outputsSchema.parse(result)

  outputs.set(instance.name, result)
  return result
}

/** The graph half of `zbc apply`: pure over in-memory instances, no I/O of its own. */
export async function applyInstances(
  instances: ModuleInstance[],
  opts: ApplyInstancesOptions,
): Promise<Map<string, unknown>> {
  const sorted = resolveOrder(instances, { target: opts.target, envLabel: opts.envLabel })
  const outputs = new Map<string, unknown>()

  for (const instance of sorted) {
    console.log(`\n→ ${instance.moduleName}:${instance.name}`)
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
