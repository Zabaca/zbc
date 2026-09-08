// The third verb's graph half: run ONE action on ONE instance.
//
// `apply` converges the world and `destroy` tears it down; neither is a home
// for a one-shot irreversible act an operator performs deliberately (buy this
// domain, rotate this key, send this verification mail). Consumers put those
// outside zbc — in varnick's case in a `purchase.ts` no module imports, guarded
// by a test asserting it stays unimported — which is also outside the graph,
// the decrypted secrets, and the imports edge that the act needs.

import type { ApplyContext, ModuleInstance } from '../../templates/infra/src/types'
import type { InstanceRunOptions } from './apply'
import { discoverInstances } from './discover'
import { withOnDemandImports } from './on-demand'
import { createReadinessGate } from './readiness'
import { resolveOrder } from './resolve'
import { loadSecrets } from './secrets'

export interface RunActionOptions extends InstanceRunOptions {
  /** The instance to act on. Required — an action is never fanned out. */
  instance: string
  /** The action's name. */
  action: string
  /** The operator typed `--yes`. Required for an `irreversible` action. */
  confirmed?: boolean
  /** Where the instances came from, for error messages. */
  envLabel?: string
}

/** One action as `zbc run` and `zbc list` report it. */
export interface ListedAction {
  name: string
  description: string
  irreversible: boolean
}

/** What an instance's module declares, in declaration order. Empty for most. */
export function listActions(instance: ModuleInstance): ListedAction[] {
  return Object.entries(instance._definition.actions ?? {}).map(([name, action]) => ({
    name,
    description: action.description,
    irreversible: action.irreversible === true,
  }))
}

/** Find an instance by name, or throw naming what the environment does declare. */
export function findInstance(instances: ModuleInstance[], name: string): ModuleInstance {
  const found = instances.find((instance) => instance.name === name)
  if (!found) {
    throw new Error(
      `Instance "${name}" not found. Available: ${instances.map((i) => i.name).join(', ')}`,
    )
  }
  return found
}

/**
 * Run one action.
 *
 * Deliberately NOT an apply: the instance's own `apply` does not run, because
 * an action is not a converge and the operator asked for one specific thing.
 * Its imports are another matter — the act needs them, and they are resolved
 * exactly as a full-environment `destroy` resolves its own: on demand, applied
 * when the body asks. Unlike a destroy's, what an action applies is left
 * standing, which is what `zbc apply <env> <instance>` would have done anyway.
 */
export async function runAction(
  instances: ModuleInstance[],
  opts: RunActionOptions,
): Promise<void> {
  // Sorted for the same reason `destroy` sorts: a cycle or a missing import is
  // a graph error, and finding it here beats finding it mid-action.
  const sorted = resolveOrder(instances, { envLabel: opts.envLabel, assertImports: false })
  const instance = findInstance(sorted, opts.instance)
  const available = listActions(instance)

  if (available.length === 0) {
    throw new Error(
      `Instance "${instance.name}" has no actions — module "${instance.moduleName}" declares none.`,
    )
  }
  const action = instance._definition.actions?.[opts.action]
  if (!action) {
    throw new Error(
      `Module "${instance.moduleName}" has no action "${opts.action}". ` +
        `Available: ${available.map((a) => a.name).join(', ')}`,
    )
  }
  // The gate is here, before the config parse and before any import is applied:
  // an irreversible action must not have provisioned anything by the time it
  // refuses.
  if (action.irreversible && !opts.confirmed) {
    throw new Error(
      `Action "${opts.action}" on "${instance.name}" is irreversible: ${action.description}. ` +
        `Re-run with --yes to confirm.`,
    )
  }

  const validatedConfig = instance._definition.configSchema.parse(instance.config)
  const runOpts: InstanceRunOptions = { ...opts, gate: opts.gate ?? createReadinessGate() }
  const outputs = new Map<string, unknown>()

  console.log(`\n→ ${instance.moduleName}:${instance.name} ${opts.action}`)
  await withOnDemandImports(
    instance,
    runOpts,
    outputs,
    { onDemand: true, asker: `${instance.name}'s action "${opts.action}"` },
    (ctx: ApplyContext) => action.run(validatedConfig, ctx),
  )
  console.log(`✓ ${instance.moduleName}:${instance.name} ${opts.action} done`)
}

/** The I/O half: discover the environment's instances, decrypt its secrets, run. */
export async function runEnvironmentAction(
  projectRoot: string,
  envDir: string,
  opts: { instance: string; action: string; confirmed?: boolean },
): Promise<void> {
  const instances = await discoverInstances(envDir)
  const secrets = await loadSecrets(envDir)
  await runAction(instances, { ...opts, secrets, projectRoot, envLabel: envDir })
}

/** The I/O half of "what can this instance do": no secrets, no provider, no run. */
export async function listInstanceActions(
  envDir: string,
  instanceName: string,
): Promise<ListedAction[]> {
  const instances = await discoverInstances(envDir)
  return listActions(findInstance(instances, instanceName))
}
