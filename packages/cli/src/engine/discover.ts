import { existsSync } from 'node:fs'
import * as path from 'node:path'
import type { ModuleInstance } from '../../templates/infra/src/types'

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
  // A directory that isn't there is a real, ordinary state — an environment
  // named in zbc.config.ts before anyone added an instance to it — and the
  // ENOENT it used to raise named the path inside a stack trace from `native:1`,
  // which reads like a bug in the CLI rather than a missing directory.
  if (!existsSync(envDir)) {
    throw new Error(`Environment directory ${envDir} does not exist — nothing to discover`)
  }

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
