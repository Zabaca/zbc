import * as path from 'node:path'
import type { ModuleInstance } from '../infra-types'

function isModuleInstance(value: unknown): value is ModuleInstance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'moduleName' in value &&
    '_definition' in value &&
    'imports' in value
  )
}

export async function discoverInstances(envDir: string): Promise<ModuleInstance[]> {
  const glob = new Bun.Glob('*.ts')
  const files = Array.from(glob.scanSync({ cwd: envDir }))
  const instances: ModuleInstance[] = []

  for (const file of files) {
    const absolutePath = path.resolve(envDir, file)
    const mod = await import(absolutePath)
    const instance = mod.default

    if (!isModuleInstance(instance)) {
      throw new Error(`${file} does not export a valid module instance as its default export`)
    }

    instances.push(instance)
  }

  return instances
}
