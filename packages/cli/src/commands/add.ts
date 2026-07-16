import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { defineCommand } from 'citty'
import { findProjectRoot } from '../utils/find-project-root'
import { loadConfig } from '../utils/load-config'
import {
  bundledAppsCandidates,
  bundledModulesCandidates,
  copyTemplateDir,
  copyTemplateFile,
} from '../utils/copy-template'

interface RegistryFile {
  path: string
}

interface RegistryManifest {
  name: string
  /** 'module' (default): vendored into packages/infra/modules/. 'app': a full
   *  package scaffolded into targetDir (e.g. packages/inbox). */
  kind?: 'module' | 'app'
  description?: string
  files?: RegistryFile[]
  /** app only: where the package lands, relative to the project root. */
  targetDir?: string
  /** app only: infra modules this app depends on — auto-vendored first. */
  modules?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  secrets?: string[]
  signupUrl?: string
  tokenUrl?: string
  instructions?: string
}

async function resolveBundledDir(name: string): Promise<string> {
  for (const candidate of [...bundledModulesCandidates(), ...bundledAppsCandidates()]) {
    const dir = path.join(candidate, name)
    const registry = path.join(dir, 'registry.json')
    if (await Bun.file(registry).exists()) return dir
  }
  throw new Error(
    `"${name}" not found in built-in registry. Available: cloudflare, cloudflare-email, r2, turso, inbox.`,
  )
}

function run(cwd: string, cmd: string, args: string[]): Promise<void> {
  console.log(`  ${cmd} ${args.join(' ')}  (in ${path.relative(process.cwd(), cwd) || '.'})`)
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args[0]} exited with code ${code}`))
    })
    proc.on('error', reject)
  })
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
  for (const [name, version] of entries) args.push(`${name}@${version}`)
  return run(cwd, 'bun', args)
}

function printPostInstall(registry: RegistryManifest): void {
  console.log('')
  console.log(`✓ ${registry.name} installed`)
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
}

/** Vendor a module into packages/infra/modules/<name>. Skips if installed. */
async function installModule(
  moduleName: string,
  infraDir: string,
  opts: { quietSkip?: boolean } = {},
): Promise<RegistryManifest | null> {
  const sourceDir = await resolveBundledDir(moduleName)
  const destDir = path.join(infraDir, 'modules', moduleName)

  if (await Bun.file(path.join(destDir, 'registry.json')).exists()) {
    if (!opts.quietSkip) {
      console.log(
        `✓ ${moduleName} already installed at packages/infra/modules/${moduleName}/ — skipping`,
      )
    }
    return null
  }

  const registry = (await Bun.file(
    path.join(sourceDir, 'registry.json'),
  ).json()) as RegistryManifest

  if (registry.kind === 'app') {
    throw new Error(`"${moduleName}" is an app template, not an infra module`)
  }

  console.log(`zbc add: ${moduleName}`)

  await fs.mkdir(destDir, { recursive: true })
  for (const f of registry.files ?? []) {
    await copyTemplateFile(path.join(sourceDir, f.path), path.join(destDir, f.path))
  }
  // Always copy registry.json (used as install marker + future upgrade ref)
  await copyTemplateFile(path.join(sourceDir, 'registry.json'), path.join(destDir, 'registry.json'))

  if (registry.dependencies) await bunAdd(infraDir, registry.dependencies)
  if (registry.devDependencies) await bunAdd(infraDir, registry.devDependencies, '--dev')
  if (registry.optionalDependencies) {
    await bunAdd(infraDir, registry.optionalDependencies, '--optional')
  }

  return registry
}

/** Scaffold an app template (a full package) into its targetDir. */
async function installApp(
  registry: RegistryManifest,
  sourceDir: string,
  projectRoot: string,
  infraDir: string,
): Promise<void> {
  if (!registry.targetDir) {
    throw new Error(`app template "${registry.name}" is missing targetDir in registry.json`)
  }
  const destDir = path.join(projectRoot, registry.targetDir)

  if (await Bun.file(path.join(destDir, 'package.json')).exists()) {
    console.log(`✓ ${registry.name} already scaffolded at ${registry.targetDir}/ — skipping`)
    return
  }

  console.log(`zbc add: ${registry.name} (app)`)

  // 1. Auto-vendor the infra modules this app depends on.
  for (const dep of registry.modules ?? []) {
    const depRegistry = await installModule(dep, infraDir, { quietSkip: true })
    if (depRegistry) {
      console.log(`  ↳ vendored dependency module: ${dep}`)
      printPostInstall(depRegistry)
    }
  }

  // 2. Copy the package verbatim — app templates are placeholder-free (all
  //    per-project identity lives in the instance file: workerName,
  //    r2Bindings, workerVars). registry.json stays in the CLI — it's not app
  //    code. `vars` kept for future templates; a no-op with no {{}} tokens.
  const { project } = await loadConfig(projectRoot)
  await copyTemplateDir(sourceDir, destDir, {
    vars: { PROJECT_NAME: project },
    exclude: ['registry.json', 'node_modules'],
  })

  // 3. Install workspace deps (the app ships its own package.json).
  await run(projectRoot, 'bun', ['install'])

  printPostInstall(registry)
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Vendor a built-in infra module or app template into this project',
  },
  args: {
    module: {
      type: 'positional',
      description: 'Module or app name (e.g. turso, cloudflare, cloudflare-email, r2, inbox)',
      required: true,
    },
  },
  async run({ args }) {
    const name = args.module
    const projectRoot = await findProjectRoot()
    const infraDir = path.join(projectRoot, 'packages/infra')

    if (!(await Bun.file(path.join(infraDir, 'package.json')).exists())) {
      console.error('✗ packages/infra/ not found. Run `zbc init` first.')
      process.exit(1)
    }

    const sourceDir = await resolveBundledDir(name)
    const registry = (await Bun.file(
      path.join(sourceDir, 'registry.json'),
    ).json()) as RegistryManifest

    if (registry.kind === 'app') {
      await installApp(registry, sourceDir, projectRoot, infraDir)
      return
    }

    const installed = await installModule(name, infraDir)
    if (installed) {
      printPostInstall(installed)
      console.log('')
      console.log(
        `Next: create an instance file under packages/infra/environments/<env>/ that imports from ../../modules/${name}.`,
      )
    }
  },
})
