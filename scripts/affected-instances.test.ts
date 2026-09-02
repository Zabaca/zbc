import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { type InstancePaths, affectedInstances, readEnvironment } from './affected-instances'

const web: InstancePaths = {
  name: 'web',
  imports: ['bucket'],
  paths: [
    'packages/infra/environments/production/web.ts',
    'packages/cli/templates/infra/modules/cloudflare/',
    'packages/web/',
  ],
}
const bucket: InstancePaths = {
  name: 'bucket',
  imports: [],
  paths: [
    'packages/infra/environments/production/bucket.ts',
    'packages/cli/templates/infra/modules/r2/',
  ],
}
const unrelated: InstancePaths = {
  name: 'unrelated',
  imports: [],
  paths: [
    'packages/infra/environments/production/unrelated.ts',
    'packages/cli/templates/infra/modules/dns/',
  ],
}
const graph = [web, bucket, unrelated]

describe('affectedInstances', () => {
  test('a change inside one workdir scopes to that instance', () => {
    expect(affectedInstances(['packages/web/src/index.ts'], graph)).toEqual({
      kind: 'scoped',
      instances: ['web'],
    })
  })

  test('a changed dependency carries its dependents, which read its outputs', () => {
    // The reason this direction exists: `web` wires the bucket's NAME into the
    // deployed worker. Redeploying only the bucket would leave the worker
    // pointing at whatever the last apply gave it.
    expect(affectedInstances(['packages/cli/templates/infra/modules/r2/index.ts'], graph)).toEqual({
      kind: 'scoped',
      instances: ['bucket', 'web'],
    })
  })

  test('two targets sharing a dependency name it once', () => {
    const result = affectedInstances(
      ['packages/web/src/index.ts', 'packages/infra/environments/production/bucket.ts'],
      graph,
    )
    expect(result).toEqual({ kind: 'scoped', instances: ['bucket', 'web'] })
  })

  test('prose and board state deploy nothing', () => {
    expect(
      affectedInstances(['README.md', 'docs/adr/0008.md', '.claude/settings.json'], graph),
    ).toEqual({ kind: 'none' })
  })

  // The four ways this widens instead of narrowing. Each is a missed deploy if
  // it ever stops holding, which is the failure this file exists to prevent.
  test('a shared input widens to the whole environment', () => {
    const result = affectedInstances(['packages/cli/src/engine/apply.ts'], graph)
    expect(result.kind).toBe('all')
  })

  test('an unattributable file widens rather than being dropped', () => {
    // A package no instance names — a new one, or one that moved. The map
    // cannot see it, and silently deploying nothing is the expensive answer.
    const result = affectedInstances(['packages/brand-new/src/index.ts'], graph)
    expect(result).toEqual({
      kind: 'all',
      reason: 'packages/brand-new/src/index.ts maps to no instance',
    })
  })

  test('an empty file list is a broken diff, not a quiet push', () => {
    expect(affectedInstances([], graph).kind).toBe('all')
  })

  test('an inert prefix does not swallow the workflow that runs the deploy', () => {
    // `.github/` is inert, but production.yml decides HOW the apply runs, so it
    // is listed as a shared input ahead of that prefix. Order-dependent, hence
    // pinned here.
    const result = affectedInstances(['.github/workflows/production.yml'], graph)
    expect(result.kind).toBe('all')
    expect(affectedInstances(['.github/workflows/core-tests.yml'], graph)).toEqual({ kind: 'none' })
  })
})

describe('readEnvironment', () => {
  const projectRoot = path.resolve(import.meta.dir, '..')

  test("this repo's production environment maps every instance to real paths", async () => {
    const instances = await readEnvironment(
      projectRoot,
      path.join(projectRoot, 'packages', 'infra', 'environments', 'production'),
    )

    expect(instances.length).toBeGreaterThan(0)
    for (const instance of instances) {
      expect(instance.paths.length).toBeGreaterThanOrEqual(2)
    }
  })

  test('a symlinked workdir is mapped to where git reports it', async () => {
    // `packages/walgit` is a symlink into `packages/cli/templates/apps/walgit`.
    // A push never contains the symlink path, so a map built on it would match
    // nothing and this script would answer ALL forever without failing.
    const instances = await readEnvironment(
      projectRoot,
      path.join(projectRoot, 'packages', 'infra', 'environments', 'production'),
    )
    const walgit = instances.find((i) => i.name === 'walgit-public')

    expect(walgit?.paths).toContain('packages/cli/templates/apps/walgit/')
  })
})
