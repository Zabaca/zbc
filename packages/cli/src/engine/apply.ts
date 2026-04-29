import type { ApplyContext } from '../infra-types'
import { discoverInstances } from './discover'
import { resolveOrder } from './resolve'
import { loadSecrets } from './secrets'

export async function applyEnvironment(
  projectRoot: string,
  envDir: string,
  target?: string,
): Promise<void> {
  const instances = await discoverInstances(envDir)
  const sorted = resolveOrder(instances, target)
  const secrets = await loadSecrets(envDir)
  const outputs = new Map<string, unknown>()

  for (const instance of sorted) {
    const importOutputs: Record<string, unknown> = {}
    for (const dep of instance.imports) {
      importOutputs[dep.name] = outputs.get(dep.name)
    }

    const ctx: ApplyContext = { secrets, imports: importOutputs, projectRoot }

    const validatedConfig = instance._definition.configSchema.parse(instance.config)

    console.log(`\n→ ${instance.moduleName}:${instance.name}`)

    const result = await instance._definition.apply(validatedConfig, ctx)

    instance._definition.outputsSchema.parse(result)

    outputs.set(instance.name, result)
    console.log(`✓ ${instance.moduleName}:${instance.name} applied`)
  }
}
