import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { cleanupProjects, makeProject, runCli } from './fixtures'

/**
 * `zbc run` — the third verb.
 *
 * varnick's `client-domain` can detect a domain registration and structurally
 * cannot perform one: the purchase lives in a `purchase.ts` that `index.ts`
 * imports from nowhere, behind a closure test asserting the import does not
 * exist, reachable only as an npm script. There was no verb for it — `apply` is
 * the wrong home for a one-shot irreversible act, and the alternative was to
 * put it outside zbc entirely, where the graph, the secrets and the imports are
 * not.
 */

const FIXTURES = path.join(import.meta.dir, '../engine/fixtures.ts')

/** An instance whose module has a `purchase` action that leaves a trace on disk. */
function domainInstance(extra = ''): string {
  return `
    import { fakeModule } from '${FIXTURES}'
    import * as fs from 'node:fs'
    export default fakeModule('client-domain', {
      apply: async (_c, ctx) => {
        fs.writeFileSync(ctx.projectRoot + '/applied.txt', 'apply ran')
        return { domain: 'example.com' }
      },
      actions: {
        purchase: {
          description: 'Buy the domain, once, with an ephemeral registrar token',
          irreversible: true,
          run: async (_c, ctx) => {
            fs.writeFileSync(ctx.projectRoot + '/purchased.txt', 'purchase ran')
          },
        },
        report: {
          description: 'Print what the registrar thinks it holds',
          run: async (_c, ctx) => {
            fs.writeFileSync(ctx.projectRoot + '/reported.txt', 'report ran')
          },
        },
      },
    }).instance({ name: 'domain', config: {}${extra} })
  `
}

afterEach(() => {
  cleanupProjects()
})

const wrote = (root: string, file: string) => fs.existsSync(path.join(root, file))

describe('zbc run', () => {
  test('runs the named action and nothing else', async () => {
    const root = makeProject({ instances: { 'domain.ts': domainInstance() } })

    const result = await runCli(root, ['run', 'production', 'domain', 'report'])

    expect(result.exitCode).toBe(0)
    expect(wrote(root, 'reported.txt')).toBe(true)
    // The instance's own apply is not part of running an action.
    expect(wrote(root, 'applied.txt')).toBe(false)
    expect(wrote(root, 'purchased.txt')).toBe(false)
  })

  test('an irreversible action refuses without --yes, and runs nothing', async () => {
    const root = makeProject({ instances: { 'domain.ts': domainInstance() } })

    const result = await runCli(root, ['run', 'production', 'domain', 'purchase'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('purchase')
    expect(result.stderr).toContain('--yes')
    expect(wrote(root, 'purchased.txt')).toBe(false)
  })

  test('--yes runs it', async () => {
    const root = makeProject({ instances: { 'domain.ts': domainInstance() } })

    const result = await runCli(root, ['run', 'production', 'domain', 'purchase', '--yes'])

    expect(result.exitCode).toBe(0)
    expect(wrote(root, 'purchased.txt')).toBe(true)
  })

  test('no action names lists what the instance declares, with its descriptions', async () => {
    const root = makeProject({ instances: { 'domain.ts': domainInstance() } })

    const result = await runCli(root, ['run', 'production', 'domain'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('purchase')
    expect(result.stdout).toContain('Buy the domain, once, with an ephemeral registrar token')
    expect(result.stdout).toContain('irreversible')
    expect(result.stdout).toContain('report')
  })

  test('an unknown action fails, listing the ones that exist', async () => {
    const root = makeProject({ instances: { 'domain.ts': domainInstance() } })

    const result = await runCli(root, ['run', 'production', 'domain', 'purcahse'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('purcahse')
    expect(result.stderr).toMatch(/purchase, report/)
  })

  test('an instance whose module declares no actions says so', async () => {
    const root = makeProject({
      instances: {
        'db.ts': `
          import { fakeModule } from '${FIXTURES}'
          export default fakeModule('turso', {}).instance({ name: 'db', config: {} })
        `,
      },
    })

    const result = await runCli(root, ['run', 'production', 'db', 'anything'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('turso')
    expect(result.stderr).toContain('no actions')
  })

  test("an action reads an import's output, applying it on demand", async () => {
    const root = makeProject({
      instances: {
        'acct.ts': `
          import { fakeModule } from '${FIXTURES}'
          export default fakeModule('client-account', {
            apply: async () => ({ nameServers: ['ada.ns.example', 'bob.ns.example'] }),
          }).instance({ name: 'acct', config: {} })
        `,
        'domain.ts': `
          import { fakeModule } from '${FIXTURES}'
          import * as fs from 'node:fs'
          import acct from './acct'
          export default fakeModule('client-domain', {
            actions: {
              delegate: {
                description: 'Point the registrar at the account nameservers',
                run: async (_c, ctx) => {
                  const ns = ctx.outputValue({ from: 'acct', output: 'nameServers' }, 'delegate')
                  fs.writeFileSync(ctx.projectRoot + '/delegated.txt', JSON.stringify(ns))
                },
              },
            },
          }).instance({ name: 'domain', config: {}, imports: [acct] })
        `,
      },
    })

    const result = await runCli(root, ['run', 'production', 'domain', 'delegate'])

    expect(result.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(root, 'delegated.txt'), 'utf8')).toBe(
      '["ada.ns.example","bob.ns.example"]',
    )
  })
})
