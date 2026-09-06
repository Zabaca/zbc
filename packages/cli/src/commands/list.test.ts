import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { cleanupProjects, makeProject, runCli } from './fixtures'

/**
 * `zbc list` — what an environment declares, as data.
 *
 * The engine has always known the answer (it discovers and topologically sorts
 * the instances on every apply) and has never had a way to say it. foothill's
 * orphan reconciler needs exactly this set to compare live provider state
 * against, and had to enumerate providers to guess it.
 */

const FIXTURES = path.join(import.meta.dir, '../engine/fixtures.ts')

/** An environment whose `web` imports `main-db`, written in dependency-reverse file order. */
function twoInstances(): Record<string, string> {
  return {
    'web.ts': `
      import { fakeModule } from '${FIXTURES}'
      import mainDb from './main-db'
      export default fakeModule('cloudflare', {
        apply: async () => ({ deployUrl: 'https://web.workers.dev' }),
      }).instance({ name: 'web', config: {}, imports: [mainDb] })
    `,
    'main-db.ts': `
      import { fakeModule } from '${FIXTURES}'
      export default fakeModule('turso', {
        withDestroy: true,
        apply: async () => ({ databaseUrl: 'libsql://db' }),
      }).instance({ name: 'main-db', config: {}, ephemeral: true })
    `,
  }
}

afterEach(() => {
  cleanupProjects()
})

describe('zbc list', () => {
  test('emits every instance in dependency order, with what the engine knows about it', async () => {
    const root = makeProject({ env: 'preview', instances: twoInstances() })

    const result = await runCli(root, ['list', 'preview', '--json'])

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      env: 'preview',
      instances: [
        {
          name: 'main-db',
          module: 'turso',
          ephemeral: true,
          destroyable: true,
          imports: [],
        },
        {
          name: 'web',
          module: 'cloudflare',
          ephemeral: false,
          destroyable: false,
          imports: ['main-db'],
        },
      ],
    })
  })

  test('the human form names the same instances and their modules', async () => {
    const root = makeProject({ env: 'preview', instances: twoInstances() })

    const result = await runCli(root, ['list', 'preview'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('main-db')
    expect(result.stdout).toContain('turso')
    expect(result.stdout).toContain('web')
    expect(result.stdout).toContain('cloudflare')
    expect(result.stdout).toContain('ephemeral')
  })

  test('listing runs nothing — a module whose apply would throw still lists', async () => {
    const root = makeProject({
      env: 'preview',
      instances: {
        'boom.ts': `
          import { fakeModule } from '${FIXTURES}'
          export default fakeModule('explodes', {
            apply: async () => { throw new Error('provider called') },
          }).instance({ name: 'boom', config: {} })
        `,
      },
    })

    const result = await runCli(root, ['list', 'preview', '--json'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain('provider called')
    expect(JSON.parse(result.stdout).instances).toHaveLength(1)
  })

  test('an environment directory that does not exist says so, rather than raising ENOENT', async () => {
    const root = makeProject({ env: 'preview' })
    fs.rmSync(path.join(root, 'packages/infra/environments/preview'), { recursive: true })

    const result = await runCli(root, ['list', 'preview'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('packages/infra/environments/preview')
    expect(result.stderr).not.toContain('ENOENT')
  })

  test('an environment the project does not declare is refused by name', async () => {
    const root = makeProject({ env: 'preview' })

    const result = await runCli(root, ['list', 'staging'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('staging')
  })
})
