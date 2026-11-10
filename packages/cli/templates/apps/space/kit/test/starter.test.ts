import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { INSTANCE_NAMES, buildSpaceInstall, type KitInstance } from '../instances'

/**
 * THE STARTING FILES OF A NEW INSTALL. `zbc add space` writes them into a project from the folder's manifest (zbc-app.json): a declaration, an install file and a content file for a company to fill in, the
 * glue that hands the kit the project's modules, and one instance file per instance. What is held here is that they are a whole install as they stand: the kit takes the pair, and the instance files
 * written are exactly the instances it makes, so a first `zbc list` shows a deploy and not an error.
 */
const folder = fileURLToPath(new URL('../../', import.meta.url))
const json = (path: string) => JSON.parse(readFileSync(`${folder}${path}`, 'utf8'))
const manifest = json('zbc-app.json') as { workspaces: string[]; modules: string[]; starter: { from: string; to: string }[] }

/** Sorted, without changing what it is given. */
const sorted = (names: string[]) => [...names].sort()

const standIn = (moduleName: string) => ({ instance: (options: { name: string }): KitInstance & { moduleName: string } => ({ name: options.name, moduleName }) })
const made = buildSpaceInstall({
  declaration: json('starter/environment/workspace.json'),
  installFile: json('starter/environment/workspace-install.json'),
  sopsNames: [],
  modules: { worker: standIn('worker'), access: standIn('access'), queue: standIn('queue'), bucket: standIn('bucket'), database: standIn('database') },
  paths: { worker: 'vendor/space/packages/space', formsMigrations: 'vendor/space/packages/forms/migrations', declaration: 'packages/infra/environments/production/workspace.json' },
})

describe('the starting files of a new install', () => {
  test('every file the manifest names is in the folder, and lands inside the project', () => {
    expect(manifest.starter.length).toBeGreaterThan(5)
    for (const entry of manifest.starter) {
      expect(existsSync(`${folder}${entry.from}`), entry.from).toBe(true)
      expect(entry.to.startsWith('packages/infra/'), entry.to).toBe(true)
      expect(entry.to.includes('..'), entry.to).toBe(false)
    }
  })

  test('the manifest’s workspace folders are the folder’s own', () => {
    expect(manifest.workspaces).toEqual(json('package.json').workspaces)
  })

  test('the pair is a whole small install: Forms, chat and Clients behind one sign-in, with no mail and no calls', () => {
    expect(sorted(made.all.map((instance) => instance.name))).toEqual(['forms-bucket', 'forms-database', 'space', 'space-access', 'space-forms-access', 'space-guest-chat', 'space-guest-signing'])
    expect(made.install.has('gmail')).toBe(false)
    expect(made.install.has('calls')).toBe(false)
    expect(made.settings.name).toBe('yourcompany-space')
  })

  test('one instance file is written per instance the pair makes, each exporting that instance by its key', () => {
    const files = readdirSync(`${folder}starter/environment`).filter((file) => file.endsWith('.ts.template'))
    expect(sorted(files.map((file) => file.replace('.ts.template', '')))).toEqual(sorted(made.all.map((instance) => instance.name)))
    for (const file of files) {
      const key = /spaceInstance\('(\w+)'\)/.exec(readFileSync(`${folder}starter/environment/${file}`, 'utf8'))?.[1]
      expect(INSTANCE_NAMES[key as keyof typeof INSTANCE_NAMES], file).toBe(file.replace('.ts.template', '') as never)
      // Written into the project, each is named in the manifest.
      expect(manifest.starter.some((entry) => entry.from === `starter/environment/${file}`), file).toBe(true)
    }
  })

  test('the modules the manifest asks zbc to install are the five the glue imports', () => {
    const glue = readFileSync(`${folder}starter/glue/modules.ts.template`, 'utf8')
    const imported = [...glue.matchAll(/from '\{\{MODULES\}\}\/([a-z0-9-]+)'/g)].map((m) => m[1]!)
    expect(sorted(imported)).toEqual(sorted(manifest.modules))
  })
})
