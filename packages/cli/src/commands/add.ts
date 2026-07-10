import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
import { bundledModulesCandidates, copyTemplateFile } from '../utils/copy-template'

interface RegistryFile {
  path: string
}

interface RegistryManifest {
  name: string
  description?: string
  files: RegistryFile[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  secrets?: string[]
  signupUrl?: string
  tokenUrl?: string
  instructions?: string
}

async function resolveBundledModuleDir(name: string): Promise<string> {
  for (const candidate of bundledModulesCandidates()) {
    const dir = path.join(candidate, name)
    const registry = path.join(dir, 'registry.json')
    if (await Bun.file(registry).exists()) return dir
  }
  throw new Error(`Module "${name}" not found in built-in registry. Available: cloudflare, turso.`)
}

function bunAdd(
  cwd: string,
  deps: Record<string, string>,
  flag?: '--dev' | '--optional',
): Promise<void> {
  const entries = Object.entries(deps)
  if (entries.length === 0) return Promise.resolve()

  const args = ['add']
  if (flag) args.push(flag)
  for (const [name, version] of entries) {
    args.push(`${name}@${version}`)
  }

  console.log(`  bun ${args.join(' ')}  (in ${path.relative(process.cwd(), cwd) || '.'})`)

  return new Promise((resolve, reject) => {
    const proc = spawn('bun', args, { cwd, stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`bun add exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Vendor a built-in infra module into packages/infra/modules/',
  },
  args: {
    module: {
      type: 'positional',
      description: 'Module name (e.g. turso, cloudflare)',
      required: true,
    },
  },
  async run({ args }) {
    const moduleName = args.module
    const projectRoot = await findProjectRoot()
    const infraDir = path.join(projectRoot, 'packages/infra')

    if (!(await Bun.file(path.join(infraDir, 'package.json')).exists())) {
      console.error('✗ packages/infra/ not found. Run `zbc init` first.')
      process.exit(1)
    }

    const sourceDir = await resolveBundledModuleDir(moduleName)
    const destDir = path.join(infraDir, 'modules', moduleName)

    if (await Bun.file(path.join(destDir, 'registry.json')).exists()) {
      console.log(
        `✓ ${moduleName} already installed at packages/infra/modules/${moduleName}/ — skipping`,
      )
      return
    }

    const registry = (await Bun.file(
      path.join(sourceDir, 'registry.json'),
    ).json()) as RegistryManifest

    console.log(`zbc add: ${moduleName}`)

    // Copy module files
    await fs.mkdir(destDir, { recursive: true })
    for (const f of registry.files) {
      await copyTemplateFile(path.join(sourceDir, f.path), path.join(destDir, f.path))
    }
    // Always copy registry.json (used as install marker + future upgrade ref)
    await copyTemplateFile(
      path.join(sourceDir, 'registry.json'),
      path.join(destDir, 'registry.json'),
    )

    // Install deps in packages/infra
    if (registry.dependencies) {
      await bunAdd(infraDir, registry.dependencies)
    }
    if (registry.devDependencies) {
      await bunAdd(infraDir, registry.devDependencies, '--dev')
    }
    if (registry.optionalDependencies) {
      await bunAdd(infraDir, registry.optionalDependencies, '--optional')
    }

    // Post-install message
    console.log('')
    console.log(`✓ ${moduleName} installed`)
    console.log('')
    if (registry.secrets && registry.secrets.length > 0) {
      console.log('Required secrets:')
      for (const s of registry.secrets) console.log(`  - ${s}`)
    }
    if (registry.signupUrl) console.log(`Sign up:  ${registry.signupUrl}`)
    if (registry.tokenUrl) console.log(`Get token: ${registry.tokenUrl}`)
    if (registry.instructions) {
      console.log('')
      console.log(registry.instructions)
    }
    console.log('')
    console.log(
      `Next: create an instance file under packages/infra/environments/<env>/ that imports from ../../modules/${moduleName}.`,
    )
  },
})
