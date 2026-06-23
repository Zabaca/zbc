import type { ApplyContext } from '../infra-types'
import { discoverInstances } from './discover'
import { resolveOrder } from './resolve'
import { loadSecrets } from './secrets'

export async function destroyEnvironment(
  projectRoot: string,
  envDir: string,
  target?: string,
): Promise<void> {
  const instances = await discoverInstances(envDir)
  const sorted = resolveOrder(instances)
  let reversed = [...sorted].reverse()

  // Targeted destroy: tear down ONLY the named instance. Unlike apply, we do
  // NOT pull in the dependency closure, since a thing's dependencies are
  // usually shared infra you don't want destroyed alongside it. Without this filter,
  // `zbc destroy <env> <instance>` silently ignored the instance arg and
  // destroyed the entire environment.
  if (target) {
    const found = reversed.find((i) => i.name === target)
    if (!found) {
      throw new Error(
        `Instance "${target}" not found. Available: ${instances.map((i) => i.name).join(', ')}`,
      )
    }
    reversed = [found]
  }

  const secrets = await loadSecrets(envDir)

  for (const instance of reversed) {
    const { destroy } = instance._definition
    if (!destroy) {
      console.log(`⊘ ${instance.moduleName}:${instance.name} has no destroy — skipping`)
      continue
    }

    const ctx: ApplyContext = { secrets, imports: {}, projectRoot }

    const validatedConfig = instance._definition.configSchema.parse(instance.config)

    console.log(`\n→ ${instance.moduleName}:${instance.name}`)

    await destroy(validatedConfig, ctx)

    console.log(`✓ ${instance.moduleName}:${instance.name} destroyed`)
  }
}
