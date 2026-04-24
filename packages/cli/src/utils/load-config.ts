import * as path from 'node:path'

interface ZbcConfig {
  project: string
  environments: string[]
}

export async function loadConfig(projectRoot: string): Promise<ZbcConfig> {
  const configPath = path.join(projectRoot, 'zbc.config.ts')
  const mod = await import(configPath)
  return mod.default as ZbcConfig
}
