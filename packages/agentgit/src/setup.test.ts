/**
 * `agentgit setup` — the one config line, written once.
 *
 * The assertions are about the config git ends up holding, because that is the
 * whole deliverable: a line one character off is a helper git never calls, and
 * the symptom is a password prompt rather than an error.
 */

import { describe, expect, test } from 'bun:test'

import { type SetupDeps, runSetup } from './setup'

const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
  remoteOrigin: () => 'https://agentgit.zabaca.com',
  writeConfig: () => ({ code: 0, stderr: '' }),
  ...over,
})

const recording = (over: Partial<SetupDeps> = {}) => {
  const written: string[][] = []
  const d = deps({
    writeConfig: (args) => (written.push([...args]), { code: 0, stderr: '' }),
    ...over,
  })
  return { written, deps: d }
}

describe('agentgit setup', () => {
  test('writes the helper for the host of the clone it was run in', async () => {
    const { written, deps: d } = recording()
    const result = await runSetup({ host: null, global: true }, d)

    expect(result.code).toBe(0)
    expect(written).toEqual([
      [
        'config',
        '--global',
        'credential.https://agentgit.zabaca.com.helper',
        '!agentgit credential',
      ],
    ])
    // Printed, so a run in CI leaves a record of what it changed.
    expect(result.stdout).toContain('credential.https://agentgit.zabaca.com.helper')
  })

  test('a named host does not need a clone, and keeps a scheme and port when given one', async () => {
    const bare = recording({ remoteOrigin: () => null })
    await runSetup({ host: 'walgit.example.com', global: true }, bare.deps)
    expect(bare.written[0]?.[2]).toBe('credential.https://walgit.example.com.helper')

    const local = recording({ remoteOrigin: () => null })
    await runSetup({ host: 'http://127.0.0.1:8787', global: true }, local.deps)
    expect(local.written[0]?.[2]).toBe('credential.http://127.0.0.1:8787.helper')
  })

  test('--local writes it in the clone rather than in the home directory', async () => {
    const { written, deps: d } = recording()
    await runSetup({ host: null, global: false }, d)
    expect(written[0]?.[1]).toBe('--local')
  })

  test('outside a clone with no host, it says what to pass instead of guessing', async () => {
    const { written, deps: d } = recording({ remoteOrigin: () => null })
    const result = await runSetup({ host: null, global: true }, d)

    expect(result.code).not.toBe(0)
    expect(written).toEqual([])
    expect(result.stderr).toContain('agentgit setup')
  })

  test('a git config that refuses the write fails loudly', async () => {
    const result = await runSetup(
      { host: null, global: true },
      deps({ writeConfig: () => ({ code: 4, stderr: 'could not lock config file' }) }),
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('could not lock config file')
  })
})
