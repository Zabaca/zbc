#!/usr/bin/env bun
/**
 * Sync CLI canonical sources → dogfood location.
 *
 * `packages/cli/templates/` and `packages/cli/modules/` are the source of
 * truth. `packages/infra/` is zbc's own consumption of the templates — the
 * dogfood instance — and stays in lockstep with the canonical sources.
 *
 * Runs:
 *   - prepublishOnly (ensures published tarball is consistent)
 *   - manually whenever CLI canonical sources change
 *
 * Direction:
 *   packages/cli/templates/infra/src/*         → packages/infra/src/*
 *   packages/cli/modules/<name>/               → packages/infra/modules/<name>/
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

const cliPkgDir = path.resolve(import.meta.dir, '..')
const repoRoot = path.resolve(cliPkgDir, '../..')

const templateSrcDir = path.join(cliPkgDir, 'templates/infra/src')
const cliModulesDir = path.join(cliPkgDir, 'modules')

const infraSrcDir = path.join(repoRoot, 'packages/infra/src')
const infraModulesDir = path.join(repoRoot, 'packages/infra/modules')

async function rmrf(dir: string): Promise<void> {
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

async function syncSrc() {
  console.log('Syncing infra src primitives:')
  await rmrf(infraSrcDir)
  await copyDir(templateSrcDir, infraSrcDir)
  const files = await fs.readdir(infraSrcDir)
  for (const f of files) console.log(`  sync ${f}`)
}

async function syncModules() {
  console.log('\nSyncing infra modules:')
  if (
    !(await Bun.file(path.join(cliModulesDir, '.'))
      .exists()
      .catch(() => false))
  ) {
    // Bun.file().exists() doesn't work on dirs; use fs
  }
  let entries: { name: string; isDirectory: () => boolean }[] = []
  try {
    entries = await fs.readdir(cliModulesDir, { withFileTypes: true })
  } catch {
    console.log(`  (no canonical modules at ${path.relative(repoRoot, cliModulesDir)})`)
    return
  }

  await rmrf(infraModulesDir)
  await fs.mkdir(infraModulesDir, { recursive: true })

  let count = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const moduleDir = path.join(cliModulesDir, entry.name)
    const registryPath = path.join(moduleDir, 'registry.json')
    if (!(await Bun.file(registryPath).exists())) {
      console.log(`  skip ${entry.name} (no registry.json)`)
      continue
    }
    await copyDir(moduleDir, path.join(infraModulesDir, entry.name))
    console.log(`  sync ${entry.name}`)
    count++
  }
  console.log(`\n✓ ${count} module(s) synced to ${path.relative(repoRoot, infraModulesDir)}`)
}

async function main() {
  await syncSrc()
  await syncModules()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
