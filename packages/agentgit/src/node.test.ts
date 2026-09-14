/**
 * The rule the types cannot state: this runs under node.
 *
 * `npx` is how an agent runs something once, and an agent that cannot run it is
 * an agent that goes back to polling — so a bun global reaching the bundle is a
 * defect, not a portability preference. Nothing in the type system catches it:
 * `@types/bun` declares `Bun.spawnSync`, `bun build --target=node` bundles it
 * happily, and the failure appears for the first time on somebody else's
 * machine.
 *
 * So the guard is the artefact itself — built the way it is published, and run
 * by the runtime it is published for.
 */

import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, test } from 'bun:test'

const OUT = new URL('../dist/agentgit.js', import.meta.url).pathname

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [new URL('./cli.ts', import.meta.url).pathname],
    target: 'node',
    banner: '#!/usr/bin/env node',
  })
  expect(built.success).toBe(true)
  await Bun.write(OUT, await built.outputs[0]!.text())
})

afterAll(() => {
  // Left on disk on purpose: `bun run build` writes the same path, and removing
  // it here would make a passing suite delete the artefact a publish needs.
})

const node = (...args: string[]) => spawnSync('node', [OUT, ...args], { encoding: 'utf8' })

test('the published bundle reaches for no bun global', async () => {
  const bundle = await Bun.file(OUT).text()
  expect(bundle).not.toMatch(/\bBun\./)
})

test('node runs it', () => {
  const help = node('--help')
  expect(help.status).toBe(0)
  expect(help.stdout).toContain('agentgit watch')
})

test('a bad flag is named, under node, with a non-zero status', () => {
  const bad = node('watch', '--follow')
  expect(bad.status).toBe(2)
  expect(bad.stderr).toContain('unknown flag --follow')
})

/**
 * The one case that would otherwise only fail in a clone: discovery runs git,
 * and a directory that is not a checkout has to say so rather than crash.
 */
test('outside a checkout it explains itself instead of throwing', () => {
  const run = spawnSync('node', [OUT, 'watch'], { encoding: 'utf8', cwd: '/' })
  expect(run.status).toBe(2)
  expect(run.stderr).toContain('not inside a git repository')
})

/**
 * The credential helper, run the way git runs it: a request on stdin, an
 * answer on stdout, under node.
 *
 * Deliberately a request no network can be involved in — git asks about an
 * `ssh` remote — so what is proven here is the plumbing (stdin drained, the
 * protocol spoken, a clean exit) rather than the signing, which
 * `credential.test.ts` covers and scenario 10 in walgit's e2e suite proves
 * against a real host.
 */
test('the credential helper drains stdin and answers, under node', () => {
  const asked = spawnSync('node', [OUT, 'credential', 'get'], {
    encoding: 'utf8',
    input: 'protocol=ssh\nhost=agentgit.zabaca.com\n\n',
  })
  expect(asked.status).toBe(0)
  expect(asked.stdout).toBe('')

  for (const operation of ['store', 'erase']) {
    const done = spawnSync('node', [OUT, 'credential', operation], {
      encoding: 'utf8',
      input: 'protocol=https\nhost=agentgit.zabaca.com\npassword=x\n\n',
    })
    expect(done.status).toBe(0)
    expect(done.stdout).toBe('')
  }
})

test('setup outside a clone names the argument rather than guessing a host', () => {
  const run = spawnSync('node', [OUT, 'setup'], { encoding: 'utf8', cwd: '/' })
  expect(run.status).toBe(2)
  expect(run.stderr).toContain('agentgit setup')
})
