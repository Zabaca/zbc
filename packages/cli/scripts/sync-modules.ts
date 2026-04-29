#!/usr/bin/env bun
/**
 * Copy packages/infra/modules/<name>/ → packages/cli/modules/<name>/
 * for each module that ships a registry.json. Run before `bun publish`.
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

const cliPkgDir = path.resolve(import.meta.dir, '..')
const repoRoot = path.resolve(cliPkgDir, '../..')
const sourceRoot = path.join(repoRoot, 'packages/infra/modules')
const destRoot = path.join(cliPkgDir, 'modules')

async function rm(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(s, d)
    } else {
      await fs.copyFile(s, d)
    }
  }
}

async function main() {
  await rm(destRoot)
  await fs.mkdir(destRoot, { recursive: true })

  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const moduleDir = path.join(sourceRoot, entry.name)
    const registryPath = path.join(moduleDir, 'registry.json')
    if (!(await Bun.file(registryPath).exists())) {
      console.log(`  skip ${entry.name} (no registry.json)`)
      continue
    }
    const destDir = path.join(destRoot, entry.name)
    await copyDir(moduleDir, destDir)
    console.log(`  sync ${entry.name}`)
    count++
  }

  console.log(`\n✓ synced ${count} module(s) to ${path.relative(repoRoot, destRoot)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
