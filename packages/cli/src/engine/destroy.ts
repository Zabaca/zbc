import type { ApplyContext } from '../infra-types'
import { discoverInstances } from './discover'
import { resolveOrder } from './resolve'
import { loadSecrets } from './secrets'

export async function destroyEnvironment(projectRoot: string, envDir: string): Promise<void> {
  const instances = await discoverInstances(envDir)
  const sorted = resolveOrder(instances)
  const reversed = [...sorted].reverse()
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
