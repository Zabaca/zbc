import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { cleanupProjects, makeProject, runCli } from './fixtures'

/**
 * `zbc apply --json` — the apply result as data.
 *
 * The `cloudflare` module emits `deployUrl`; to post it on a pull request a
 * consumer had to `grep -Eo` it back out of `tee`'d apply logs. The value was
 * in the engine all along and left only as prose.
 */

const FIXTURES = path.join(import.meta.dir, '../engine/fixtures.ts')

function twoInstances(): Record<string, string> {
  return {
    'web.ts': `
      import { fakeModule } from '${FIXTURES}'
      import mainDb from './main-db'
      export default fakeModule('cloudflare', {
        apply: async () => ({ deployUrl: 'https://web-pr-7.workers.dev' }),
      }).instance({ name: 'web', config: {}, imports: [mainDb] })
    `,
    'main-db.ts': `
      import { fakeModule } from '${FIXTURES}'
      export default fakeModule('turso', {
        apply: async () => ({ databaseUrl: 'libsql://db-pr-7' }),
      }).instance({ name: 'main-db', config: {} })
    `,
  }
}

afterEach(() => {
  cleanupProjects()
})

describe('zbc apply --json', () => {
  test('writes the applied instances and their outputs, in dependency order', async () => {
    const root = makeProject({ env: 'preview', instances: twoInstances() })

    const result = await runCli(root, ['apply', 'preview', '--json', 'result.json'])

    expect(result.exitCode).toBe(0)
    const document = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'))
    expect(document).toEqual({
      env: 'preview',
      instances: [
        { name: 'main-db', module: 'turso', outputs: { databaseUrl: 'libsql://db-pr-7' } },
        {
          name: 'web',
          module: 'cloudflare',
          outputs: { deployUrl: 'https://web-pr-7.workers.dev' },
        },
      ],
    })
  })

  test('the document is a file, so module and build chatter on stdout cannot corrupt it', async () => {
    const root = makeProject({
      env: 'preview',
      instances: {
        'web.ts': `
          import { fakeModule } from '${FIXTURES}'
          export default fakeModule('cloudflare', {
            apply: async () => {
              console.log('Deployed: https://noise.workers.dev')
              return { deployUrl: 'https://web-pr-7.workers.dev' }
            },
          }).instance({ name: 'web', config: {} })
        `,
      },
    })

    const result = await runCli(root, ['apply', 'preview', '--json', 'out/result.json'])

    expect(result.exitCode).toBe(0)
    // the human log is untouched — `--json` adds a channel, it does not take one away
    expect(result.stdout).toContain('Deployed: https://noise.workers.dev')
    const document = JSON.parse(fs.readFileSync(path.join(root, 'out/result.json'), 'utf8'))
    expect(document.instances[0].outputs.deployUrl).toBe('https://web-pr-7.workers.dev')
  })

  test('a scoped apply reports only what it applied', async () => {
    const root = makeProject({ env: 'preview', instances: twoInstances() })

    const result = await runCli(root, ['apply', 'preview', 'main-db', '--json', 'result.json'])

    expect(result.exitCode).toBe(0)
    const document = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'))
    expect(document.instances.map((i: { name: string }) => i.name)).toEqual(['main-db'])
  })

  test('a document that cannot be written says the apply already happened', async () => {
    const root = makeProject({ env: 'preview', instances: twoInstances() })
    // A directory where the document should go: the write fails, the apply does not.
    fs.mkdirSync(path.join(root, 'result.json'))

    const result = await runCli(root, ['apply', 'preview', '--json', 'result.json'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Applied preview')
  })

  test('a failed apply writes no document rather than a half-true one', async () => {
    const root = makeProject({
      env: 'preview',
      instances: {
        'boom.ts': `
          import { fakeModule } from '${FIXTURES}'
          export default fakeModule('explodes', {
            apply: async () => { throw new Error('wrangler exploded') },
          }).instance({ name: 'boom', config: {} })
        `,
      },
    })

    const result = await runCli(root, ['apply', 'preview', '--json', 'result.json'])

    expect(result.exitCode).not.toBe(0)
    expect(fs.existsSync(path.join(root, 'result.json'))).toBe(false)
  })
})
