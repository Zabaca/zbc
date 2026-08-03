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
import { isVendorMode, VENDOR_PREFIX } from '../utils/subtree'

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
  /** app only: generate this instance file under environments/<env>/ after
   *  scaffolding, substituting {{ACCOUNT_ID}} / {{PROJECT_NAME}}. Keeps the
   *  one-command flow declarative: files land in the repo, `zbc apply`
   *  converges (CONTEXT.md: scaffold freely, deploy only through the graph). */
  instanceFile?: string
  instanceTemplate?: string
}

interface ResolvedModule {
  dir: string
  /** true → the module lives in this project's vendor/zbc subtree (no copy). */
  vendored: boolean
}

/** Vendor-mode projects resolve modules from vendor/zbc first — the vendored
 *  copy is version-matched to the project. Apps stay CLI-bundled either way
 *  (the core split carries only the infra engine + modules). */
async function resolveModuleSource(projectRoot: string, name: string): Promise<ResolvedModule> {
  if (await isVendorMode(projectRoot)) {
    const dir = path.join(projectRoot, VENDOR_PREFIX, 'modules', name)
    if (await Bun.file(path.join(dir, 'registry.json')).exists()) {
      return { dir, vendored: true }
    }
  }
  for (const candidate of [...bundledModulesCandidates(), ...bundledAppsCandidates()]) {
    const dir = path.join(candidate, name)
    const registry = path.join(dir, 'registry.json')
    if (await Bun.file(registry).exists()) return { dir, vendored: false }
  }
  throw new Error(
    `"${name}" not found in built-in registry. Available: cloudflare, cloudflare-email, cloudflare-token, r2, turso, systemd-unit, host-file, docker-compose-stack, inbox, secret-relay, warehouse.`,
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

/** Make a module usable: vendor-mode modules already live in vendor/zbc (only
 *  their dependencies install); copy mode vendors into packages/infra/modules/
 *  as before. Skips if already copied. */
async function installModule(
  moduleName: string,
  projectRoot: string,
  infraDir: string,
  opts: { quietSkip?: boolean } = {},
): Promise<RegistryManifest | null> {
  const source = await resolveModuleSource(projectRoot, moduleName)

  const registry = (await Bun.file(
    path.join(source.dir, 'registry.json'),
  ).json()) as RegistryManifest

  if (registry.kind === 'app') {
    throw new Error(`"${moduleName}" is an app template, not an infra module`)
  }

  if (source.vendored) {
    console.log(
      `zbc add: ${moduleName} (already vendored at ${VENDOR_PREFIX}/modules/${moduleName}/ — installing dependencies only)`,
    )
    if (registry.dependencies) await bunAdd(infraDir, registry.dependencies)
    if (registry.devDependencies) await bunAdd(infraDir, registry.devDependencies, '--dev')
    if (registry.optionalDependencies) {
      await bunAdd(infraDir, registry.optionalDependencies, '--optional')
    }
    return registry
  }

  const destDir = path.join(infraDir, 'modules', moduleName)

  if (await Bun.file(path.join(destDir, 'registry.json')).exists()) {
    if (!opts.quietSkip) {
      console.log(
        `✓ ${moduleName} already installed at packages/infra/modules/${moduleName}/ — skipping`,
      )
    }
    return null
  }

  console.log(`zbc add: ${moduleName}`)

  await fs.mkdir(destDir, { recursive: true })
  for (const f of registry.files ?? []) {
    await copyTemplateFile(path.join(source.dir, f.path), path.join(destDir, f.path))
  }
  // Always copy registry.json (used as install marker + future upgrade ref)
  await copyTemplateFile(path.join(source.dir, 'registry.json'), path.join(destDir, 'registry.json'))

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
    const depRegistry = await installModule(dep, projectRoot, infraDir, { quietSkip: true })
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
  //    `.wrangler` is local miniflare state (SQLite DO/KV files) that appears the moment
  //    anyone runs `wrangler dev` in the template dir. It is gitignored so it never gets
  //    committed, but npm's default-ignore list doesn't cover it, so it ships in the
  //    published tarball — and copyTemplateFile reads through `.text()`, so those binary
  //    files would land in the consumer's package mangled by a UTF-8 round-trip.
  //    `.DS_Store` is the same class of debris.
  await copyTemplateDir(sourceDir, destDir, {
    vars: { PROJECT_NAME: project },
    exclude: ['registry.json', 'node_modules', '.wrangler', '.DS_Store'],
  })

  // 3. Install workspace deps (the app ships its own package.json).
  await run(projectRoot, 'bun', ['install'])

  printPostInstall(registry)
}

/** Generate an app's declared instance file. Files only — convergence stays
 *  with `zbc apply` (never deploys from here). */
async function generateInstanceFile(
  registry: RegistryManifest,
  projectRoot: string,
  opts: { accountId?: string; env: string },
): Promise<void> {
  if (!registry.instanceFile || !registry.instanceTemplate) return

  const instancePath = path.join(
    projectRoot,
    'packages/infra/environments',
    opts.env,
    registry.instanceFile,
  )
  const instanceName = registry.instanceFile.replace(/\.ts$/, '')

  if (await Bun.file(instancePath).exists()) {
    console.log(`✓ instance file already exists at ${path.relative(projectRoot, instancePath)}`)
    return
  }
  if (registry.instanceTemplate.includes('{{ACCOUNT_ID}}') && !opts.accountId) {
    console.log('')
    console.log(
      `No --account-id given — create the instance file yourself, or re-run: zbc add ${registry.name} --account-id <cloudflare account id>`,
    )
    return
  }

  const { project } = await loadConfig(projectRoot)
  const content = registry.instanceTemplate
    .replaceAll('{{ACCOUNT_ID}}', opts.accountId ?? '')
    .replaceAll('{{PROJECT_NAME}}', project)
  await fs.mkdir(path.dirname(instancePath), { recursive: true })
  await Bun.write(instancePath, content)
  console.log(`✓ instance file generated: ${path.relative(projectRoot, instancePath)}`)
  console.log('')
  console.log(`Deploy it with: zbc apply ${opts.env} ${instanceName}`)
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Vendor a built-in infra module or app template into this project',
  },
  args: {
    module: {
      type: 'positional',
      description:
        'Module or app name (e.g. turso, cloudflare, cloudflare-email, r2, inbox, secret-relay, warehouse)',
      required: true,
    },
    'account-id': {
      type: 'string',
      description: 'Cloudflare account id — lets app templates generate their instance file',
    },
    env: {
      type: 'string',
      description: 'Environment for the generated instance file (default: production)',
      default: 'production',
    },
    prompt: {
      type: 'boolean',
      description: 'Collect missing registry-declared secrets via a Secret Request (default: true)',
      default: true,
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

    const source = await resolveModuleSource(projectRoot, name)
    const registry = (await Bun.file(
      path.join(source.dir, 'registry.json'),
    ).json()) as RegistryManifest

    if (registry.kind === 'app') {
      await installApp(registry, source.dir, projectRoot, infraDir)
      await generateInstanceFile(registry, projectRoot, {
        accountId: args['account-id'],
        env: args.env,
      })
      await collectDeclaredSecrets(registry, projectRoot, args.env, args.prompt)
      return
    }

    const installed = await installModule(name, projectRoot, infraDir)
    if (installed) {
      printPostInstall(installed)
      const importPath = source.vendored
        ? `../../../${VENDOR_PREFIX}/modules/${name}`
        : `../../modules/${name}`
      console.log('')
      console.log(
        `Next: create an instance file under packages/infra/environments/<env>/ that imports from ${importPath}.`,
      )
    }
    await collectDeclaredSecrets(registry, projectRoot, args.env, args.prompt)
  },
})

/** Post-install: collect the registry's declared secrets via a Secret Request.
 *  A missing relay downgrades to instructions — `add` itself still succeeds. */
async function collectDeclaredSecrets(
  registry: RegistryManifest,
  projectRoot: string,
  env: string,
  prompt: boolean,
): Promise<void> {
  const keys = registry.secrets ?? []
  if (keys.length === 0) return
  if (!prompt) {
    console.log('')
    console.log(`Secrets required in ${env}/secrets.yaml (skipped --no-prompt): ${keys.join(', ')}`)
    return
  }
  const { collectSecrets } = await import('./secret')
  try {
    await collectSecrets({
      projectRoot,
      env,
      keys,
      reason: `required by the ${registry.name} module`,
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes('no Secret Relay found')) {
      console.log('')
      console.log(`Secrets still needed in ${env}/secrets.yaml: ${keys.join(', ')}`)
      console.log('(no Secret Relay deployed — `zbc add secret-relay` enables browser collection)')
      return
    }
    throw err
  }
}
