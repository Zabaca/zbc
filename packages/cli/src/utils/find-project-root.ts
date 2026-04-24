import * as path from 'node:path'

export async function findProjectRoot(from?: string): Promise<string> {
  let dir = from ?? process.cwd()

  while (true) {
    const configPath = path.join(dir, 'zbc.config.ts')
    if (await Bun.file(configPath).exists()) {
      return dir
    }

    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error('Could not find zbc.config.ts in any parent directory')
    }
    dir = parent
  }
}
