import type { ModuleInstance } from '../../templates/infra/src/types'
import type { InstanceRunOptions } from './apply'
import { discoverInstances } from './discover'
import { withOnDemandImports } from './on-demand'
import { createReadinessGate } from './readiness'
import { resolveOrder } from './resolve'
import { createSecretOutputRegistry, redactError } from './secret-outputs'
import { loadSecrets } from './secrets'

export interface DestroyInstancesOptions extends InstanceRunOptions {
  /** Destroy only this instance — see the comment on the filter below. */
  target?: string
  /** Where the instances came from, for error messages. */
  envLabel?: string
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
  // …and so is the proof that it works. Same gate for the same reason — and the
  // same registry, because this path APPLIES instances on demand and so mints
  // exactly the credentials the apply path does.
  const registry = opts.secretOutputs ?? createSecretOutputRegistry()
  const runOpts: DestroyInstancesOptions = {
    ...opts,
    secretOutputs: registry,
    gate: opts.gate ?? createReadinessGate({ redact: (text) => registry.redactText(text) }),
  }

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
    // Every failure that leaves this call — the module's own, and an on-demand
    // apply's — can be carrying a credential this run just minted. They leave
    // through one place so each is scrubbed.
    try {
      await withOnDemandImports(
        instance,
        runOpts,
        outputs,
        {
          onDemand: !opts.target,
          asker: `${instance.name}'s destroy`,
          refuse: (ref, field) =>
            `${field} references instance "${ref.from}", whose outputs a targeted destroy will not create. ` +
            `Run \`zbc destroy <env>\` for the whole environment, which applies "${ref.from}" only to tear ` +
            `it down again, or apply "${ref.from}" yourself first.`,
          afterApply: (name) =>
            `✓ ${name} applied — this destroy created it; the run tears it down below`,
        },
        (ctx) => destroy(validatedConfig, ctx),
      )
    } catch (err) {
      throw redactError(registry, err)
    }

    console.log(`✓ ${instance.moduleName}:${instance.name} destroyed`)
  }
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
