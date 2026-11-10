import { afterEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  addVendoredApp,
  describeAppAudit,
  newestTag,
  updateVendoredApp,
  type VendoredApp,
} from './vendored-app'
import { readAppStamps, readStamp, writeStamp } from './vendor-stamp'

/**
 * Real-git tests, as the engine's vendoring has (`subtree.test.ts`): a
 * throwaway repository stands in for the app's public copy (a local path in
 * place of the URL), and a throwaway project pulls it. No network.
 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function write(root: string, file: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), body)
}

function commit(dir: string, message: string): void {
  sh(dir, `git add -A && git commit -qm ${JSON.stringify(message)}`)
}

function makeRepo(dir: string): void {
  sh(dir, 'git init -q -b main')
  sh(dir, 'git config user.email t@t && git config user.name t && git config commit.gpgsign false')
}

/** A stand-in for the app's public copy: two packages, a manifest, two starter files, tagged v0.1.0. */
function makeUpstream(): string {
  const dir = tmpdir('zbc-app-upstream-')
  makeRepo(dir)
  write(dir, 'package.json', JSON.stringify({ name: 'demo', workspaces: ['packages/*', 'kit'] }))
  write(dir, 'packages/one/package.json', JSON.stringify({ name: '@demo/one' }))
  write(dir, 'packages/one/src/index.ts', 'export const one = 1\n')
  write(dir, 'kit/package.json', JSON.stringify({ name: '@demo/kit' }))
  write(dir, 'kit/instances.ts', 'export const kit = 1\n')
  write(
    dir,
    'zbc-app.json',
    JSON.stringify({
      name: 'demo',
      workspaces: ['packages/*', 'kit'],
      modules: [],
      starter: [
        { from: 'starter/install.json', to: 'packages/infra/environments/{{ENV}}/install.json' },
        { from: 'starter/glue.ts.template', to: 'packages/infra/demo/{{ENV}}.ts' },
      ],
    }),
  )
  write(dir, 'starter/install.json', '{ "environment": "{{ENV}}" }\n')
  write(
    dir,
    'starter/glue.ts.template',
    "import { kit } from '{{APP}}/kit/instances'\nimport { r2Module } from '{{MODULES}}/r2'\nimport type { ModuleInstance } from '{{ENGINE}}/types'\n",
  )
  commit(dir, 'the app')
  sh(dir, 'git tag v0.1.0')
  return dir
}

/** A project as `zbc init` leaves one, in copy mode: a root manifest, packages/infra, one commit. */
function makeProject(): string {
  const dir = tmpdir('zbc-app-project-')
  makeRepo(dir)
  write(
    dir,
    'package.json',
    `${JSON.stringify({ name: 'project', workspaces: ['packages/*'] }, null, 2)}\n`,
  )
  write(dir, 'packages/infra/package.json', JSON.stringify({ name: 'infra' }))
  commit(dir, 'init')
  return dir
}

const appAt = (url: string): VendoredApp => ({ name: 'demo', url, prefix: 'vendor/demo' })

describe('newestTag', () => {
  test('is the highest version read as numbers, not as text', () => {
    const upstream = makeUpstream()
    sh(upstream, 'git tag v0.9.0 && git tag v0.10.0 && git tag not-a-version')
    expect(newestTag(upstream)).toBe('v0.10.0')
  })

  test('a repository with no version tag says to name a ref', () => {
    const upstream = tmpdir('zbc-app-untagged-')
    makeRepo(upstream)
    write(upstream, 'a.txt', 'a')
    commit(upstream, 'a')
    expect(() => newestTag(upstream)).toThrow(/no version tag.*--ref main/)
  })
})

describe('zbc add <vendored app>', () => {
  test('pulls the newest tag as one squashed commit, adds the workspace folders, writes the starting files and the stamp', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    const result = await addVendoredApp(project, appAt(upstream), { env: 'production' })

    expect(result.ref).toBe('v0.1.0')
    expect(result.commit).toBe(sh(upstream, 'git rev-parse v0.1.0').trim())
    expect(fs.existsSync(path.join(project, 'vendor/demo/packages/one/src/index.ts'))).toBe(true)
    expect(sh(project, 'git log --format=%B')).toContain('git-subtree-dir: vendor/demo')

    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'))
    expect(pkg.workspaces).toEqual(['packages/*', 'vendor/demo/packages/*', 'vendor/demo/kit'])

    expect(result.starter.written).toEqual([
      'packages/infra/environments/production/install.json',
      'packages/infra/demo/production.ts',
    ])
    expect(
      fs.readFileSync(
        path.join(project, 'packages/infra/environments/production/install.json'),
        'utf8',
      ),
    ).toBe('{ "environment": "production" }\n')
    // The glue's imports are from where the glue landed: the app's folder, and
    // a copy-mode project's own modules and engine.
    expect(fs.readFileSync(path.join(project, 'packages/infra/demo/production.ts'), 'utf8')).toBe(
      "import { kit } from '../../../vendor/demo/kit/instances'\nimport { r2Module } from '../modules/r2'\nimport type { ModuleInstance } from '../src/types'\n",
    )

    const stamps = await readAppStamps(project)
    expect(stamps.demo).toMatchObject({ url: upstream, ref: 'v0.1.0', commit: result.commit })
    // The stamp is at the project's root, never inside the prefix.
    expect(fs.existsSync(path.join(project, '.zbc-vendor.json'))).toBe(true)
    expect(fs.existsSync(path.join(project, 'vendor/demo/.zbc-vendor.json'))).toBe(false)
  })

  test('a subtree project gets imports that reach the vendored engine', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    write(project, 'vendor/zbc/src/define-module.ts', 'export const defineModule = 1\n')
    commit(project, 'the engine, vendored')
    await addVendoredApp(project, appAt(upstream), { env: 'production' })
    expect(
      fs.readFileSync(path.join(project, 'packages/infra/demo/production.ts'), 'utf8'),
    ).toContain(
      "from '../../../vendor/zbc/modules/r2'\nimport type { ModuleInstance } from '../../../vendor/zbc/src/types'",
    )
  })

  test('a named ref is pulled instead of the newest tag', async () => {
    const upstream = makeUpstream()
    write(upstream, 'packages/one/src/later.ts', 'export const later = 1\n')
    commit(upstream, 'after the tag')
    const project = makeProject()
    const result = await addVendoredApp(project, appAt(upstream), {
      env: 'production',
      ref: 'main',
    })
    expect(result.ref).toBe('main')
    expect(result.commit).toBe(sh(upstream, 'git rev-parse main').trim())
    expect(fs.existsSync(path.join(project, 'vendor/demo/packages/one/src/later.ts'))).toBe(true)
  })

  test('a starting file that is already there is kept as it is', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    write(project, 'packages/infra/environments/production/install.json', '{ "mine": true }\n')
    commit(project, 'my install file')
    const result = await addVendoredApp(project, appAt(upstream), { env: 'production' })
    expect(result.starter.kept).toEqual(['packages/infra/environments/production/install.json'])
    expect(
      fs.readFileSync(
        path.join(project, 'packages/infra/environments/production/install.json'),
        'utf8',
      ),
    ).toBe('{ "mine": true }\n')
  })

  test('a dirty tree is refused before anything is pulled', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    write(project, 'wip.txt', 'x')
    await expect(addVendoredApp(project, appAt(upstream), { env: 'production' })).rejects.toThrow(
      /uncommitted/i,
    )
    expect(fs.existsSync(path.join(project, 'vendor/demo'))).toBe(false)
  })

  test('a second add says the folder is there and points at update', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    await addVendoredApp(project, appAt(upstream), { env: 'production' })
    commit(project, 'what the add left')
    await expect(addVendoredApp(project, appAt(upstream), { env: 'production' })).rejects.toThrow(
      /already there.*zbc update demo/,
    )
  })

  test('a starter path that climbs out of the project is refused', async () => {
    const upstream = makeUpstream()
    write(
      upstream,
      'zbc-app.json',
      JSON.stringify({
        name: 'demo',
        starter: [{ from: 'starter/install.json', to: '../outside.json' }],
      }),
    )
    commit(upstream, 'a bad manifest')
    const project = makeProject()
    await expect(
      addVendoredApp(project, appAt(upstream), { env: 'production', ref: 'main' }),
    ).rejects.toThrow(/outside the project/)
  })
})

describe('a pull that landed and a step after it that failed', () => {
  test('says the app was pulled and committed, and how to start over', async () => {
    const upstream = makeUpstream()
    write(
      upstream,
      'zbc-app.json',
      JSON.stringify({
        name: 'demo',
        starter: [{ from: '../../package.json', to: 'packages/infra/stolen.json' }],
      }),
    )
    commit(upstream, 'a manifest that reaches out of its folder')
    const project = makeProject()
    const failed = addVendoredApp(project, appAt(upstream), { env: 'production', ref: 'main' })
    await expect(failed).rejects.toThrow(/was pulled and committed \(main\)/)
    await expect(failed).rejects.toThrow(/outside its own folder/)
    await expect(failed).rejects.toThrow(/git reset --hard HEAD~1.*git status/)
    // The pull is there, and nothing was copied from outside the app's folder.
    expect(fs.existsSync(path.join(project, 'vendor/demo/kit/instances.ts'))).toBe(true)
    expect(fs.existsSync(path.join(project, 'packages/infra/stolen.json'))).toBe(false)
  })

  test('a stamp file that cannot be read stops the add before anything is pulled', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    write(project, '.zbc-vendor.json', '{ not json')
    commit(project, 'a broken stamp')
    await expect(addVendoredApp(project, appAt(upstream), { env: 'production' })).rejects.toThrow(
      /\.zbc-vendor\.json is not valid JSON/,
    )
    expect(fs.readFileSync(path.join(project, '.zbc-vendor.json'), 'utf8')).toBe('{ not json')
    // Refused before the pull: nothing was committed and nothing was written.
    expect(fs.existsSync(path.join(project, 'vendor/demo'))).toBe(false)
    expect(sh(project, 'git status --porcelain')).toBe('')
  })
})

describe('zbc update <vendored app>', () => {
  async function added(): Promise<{ upstream: string; project: string; app: VendoredApp }> {
    const upstream = makeUpstream()
    const project = makeProject()
    const app = appAt(upstream)
    await addVendoredApp(project, app, { env: 'production' })
    commit(project, 'what the add left')
    return { upstream, project, app }
  }

  test('pulls the newest tag, keeps the project’s own edit and its own file, and names both', async () => {
    const { upstream, project, app } = await added()
    // The project's edit to a shipped file, and a file of its own in the folder.
    write(project, 'vendor/demo/kit/instances.ts', 'export const kit = 1\nexport const mine = 2\n')
    write(project, 'vendor/demo/NOTES.md', 'ours\n')
    commit(project, 'our changes to the app')
    // Upstream moves on in a different file, and cuts a version.
    write(upstream, 'packages/one/src/index.ts', 'export const one = 2\n')
    write(upstream, 'packages/two/package.json', JSON.stringify({ name: '@demo/two' }))
    commit(upstream, 'a newer app')
    sh(upstream, 'git tag v0.2.0')

    const result = await updateVendoredApp(project, app, {})
    expect(result.ref).toBe('v0.2.0')
    expect(result.commit).toBe(sh(upstream, 'git rev-parse v0.2.0').trim())
    expect(
      fs.readFileSync(path.join(project, 'vendor/demo/packages/one/src/index.ts'), 'utf8'),
    ).toBe('export const one = 2\n')
    expect(fs.existsSync(path.join(project, 'vendor/demo/packages/two/package.json'))).toBe(true)
    expect(fs.readFileSync(path.join(project, 'vendor/demo/kit/instances.ts'), 'utf8')).toContain(
      'export const mine = 2',
    )
    expect(result.audit).toEqual({ own: ['NOTES.md'], edited: ['kit/instances.ts'], removed: [] })
    const said = describeAppAudit(app, result.audit).join('\n')
    expect(said).toContain('vendor/demo/NOTES.md')
    expect(said).toContain('vendor/demo/kit/instances.ts')

    expect((await readAppStamps(project)).demo).toMatchObject({
      ref: 'v0.2.0',
      commit: result.commit,
    })
    // An update writes no starting file: the environment is the project's.
    expect(result.starter).toEqual({ written: [], kept: [] })
  })

  test('an untouched folder is reported as the pulled copy, file for file', async () => {
    const { upstream, project, app } = await added()
    write(upstream, 'packages/one/src/index.ts', 'export const one = 3\n')
    commit(upstream, 'newer')
    const result = await updateVendoredApp(project, app, { ref: 'main' })
    expect(result.audit).toEqual({ own: [], edited: [], removed: [] })
    expect(describeAppAudit(app, result.audit).join('\n')).toContain('file for file')
  })

  test('a dirty tree is refused', async () => {
    const { project, app } = await added()
    write(project, 'wip.txt', 'x')
    await expect(updateVendoredApp(project, app, {})).rejects.toThrow(/uncommitted/i)
  })

  test('with no folder it points at add', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    await expect(updateVendoredApp(project, appAt(upstream), {})).rejects.toThrow(/zbc add demo/)
  })
})

describe('the stamp', () => {
  test('the engine’s stamp and an app’s share the file, and writing one keeps the other', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    await writeStamp(project, { mode: 'copy', cliVersion: '0.24.0' })
    commit(project, 'the engine stamp')
    await addVendoredApp(project, appAt(upstream), { env: 'production' })
    expect(await readStamp(project)).toMatchObject({ mode: 'copy', cliVersion: '0.24.0' })
    expect((await readAppStamps(project)).demo?.ref).toBe('v0.1.0')
    // An engine update later rewrites its half and must not forget the app.
    await writeStamp(project, { mode: 'copy', cliVersion: '0.25.0' })
    expect((await readAppStamps(project)).demo?.ref).toBe('v0.1.0')
    expect((await readStamp(project))?.cliVersion).toBe('0.25.0')
  })

  test('a project with no engine stamp gets a file that still reads as an unknown engine', async () => {
    const upstream = makeUpstream()
    const project = makeProject()
    await addVendoredApp(project, appAt(upstream), { env: 'production' })
    expect(await readStamp(project)).toBeNull()
    expect(Object.keys(await readAppStamps(project))).toEqual(['demo'])
  })
})
