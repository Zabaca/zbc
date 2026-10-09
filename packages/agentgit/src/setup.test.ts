/**
 * `agentgit setup` — the two config lines, written once.
 *
 * The assertions are about the config git ends up holding, because that is the
 * whole deliverable: a line one character off is a helper git never calls, and
 * the symptom is a password prompt rather than an error.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { CloneDiscovery } from './clone'
import { git } from './git'
import { type SetupDeps, realSetupDeps, runSetup } from './setup'

const inClone: CloneDiscovery = {
  kind: 'clone',
  root: '/w/clone',
  remoteName: 'origin',
  host: 'agentgit.zabaca.com',
  origin: 'https://agentgit.zabaca.com',
  repo: 'demo',
  ref: 'refs/heads/main',
}

const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
  discover: () => inClone,
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
    // The empty helper first: it clears every helper configured before it for
    // this origin, so a storing one from the system config is never asked.
    expect(written).toEqual([
      ['config', '--global', '--replace-all', 'credential.https://agentgit.zabaca.com.helper', ''],
      [
        'config',
        '--global',
        '--add',
        'credential.https://agentgit.zabaca.com.helper',
        '!agentgit credential',
      ],
    ])
    // Printed, so a run in CI leaves a record of what it changed.
    expect(result.stdout).toContain('credential.https://agentgit.zabaca.com.helper')
  })

  test('a named host does not need a clone, and keeps a scheme and port when given one', async () => {
    const bare = recording({ discover: () => ({ kind: 'no-repository' }) })
    await runSetup({ host: 'walgit.example.com', global: true }, bare.deps)
    expect(bare.written.map((args) => args[3])).toEqual([
      'credential.https://walgit.example.com.helper',
      'credential.https://walgit.example.com.helper',
    ])

    const local = recording({ discover: () => ({ kind: 'no-repository' }) })
    await runSetup({ host: 'http://127.0.0.1:8787', global: true }, local.deps)
    expect(local.written[0]?.[3]).toBe('credential.http://127.0.0.1:8787.helper')
  })

  test('--local writes it in the clone rather than in the home directory', async () => {
    const { written, deps: d } = recording()
    await runSetup({ host: null, global: false }, d)
    expect(written.map((args) => args[1])).toEqual(['--local', '--local'])
  })

  test('outside a clone with no host, it says what to pass instead of guessing', async () => {
    const { written, deps: d } = recording({ discover: () => ({ kind: 'no-repository' }) })
    const result = await runSetup({ host: null, global: true }, d)

    expect(result.code).not.toBe(0)
    expect(written).toEqual([])
    expect(result.stderr).toContain('agentgit setup')
  })

  // A checkout whose remotes are all foreign is not "no remote here": there IS
  // one, and what setup cannot do is address its host. Said apart, because the
  // fix is different — name the host, rather than go and find a clone.
  test('a clone whose remotes it cannot address is refused in those words', async () => {
    const { written, deps: d } = recording({
      discover: () => ({
        kind: 'no-remote',
        root: '/w/clone',
        ref: 'refs/heads/main',
        remotes: [{ name: 'origin', url: 'git@github.com:you/thing.git' }],
      }),
    })
    const result = await runSetup({ host: null, global: true }, d)

    expect(result.code).not.toBe(0)
    expect(written).toEqual([])
    expect(result.stderr).toContain('git@github.com:you/thing.git')
    expect(result.stderr).toContain('agentgit setup')
  })

  test('a clone with no remotes at all is refused as having none', async () => {
    const { deps: d } = recording({
      discover: () => ({ kind: 'no-remote', root: '/w/clone', ref: null, remotes: [] }),
    })
    const result = await runSetup({ host: null, global: true }, d)

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('no remotes')
  })

  test('a git config that refuses the write fails loudly', async () => {
    const result = await runSetup(
      { host: null, global: true },
      deps({ writeConfig: () => ({ code: 4, stderr: 'could not lock config file' }) }),
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('could not lock config file')
  })

  test('a failure on the second write is reported, not swallowed', async () => {
    let calls = 0
    const result = await runSetup(
      { host: null, global: true },
      deps({
        writeConfig: () =>
          ++calls === 2 ? { code: 4, stderr: 'disk full' } : { code: 0, stderr: '' },
      }),
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--add')
    expect(result.stderr).toContain('disk full')
  })
})

/**
 * Against real git, because the failure is in how git walks its helper list
 * and not in anything this client says (Zabaca/zbc#188).
 *
 * Homebrew's git sets `credential.helper=osxkeychain` in its system config. A
 * helper configured after it for one origin is asked SECOND, and git runs
 * `store` on every helper on success, so the keychain kept the signature and
 * answered every later `get` with it until the host stopped accepting it. The
 * system helper here records each time it is asked; `agentgit` is a stand-in
 * on PATH that answers like the real one.
 */
describe('agentgit setup, as git reads it', () => {
  const ORIGIN = 'https://agentgit.zabaca.com'

  function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-setup-'))
    const asked = path.join(root, 'system-helper-asked')
    const systemHelper = path.join(root, 'system-helper')
    fs.writeFileSync(systemHelper, `#!/bin/sh\necho "$1" >> '${asked}'\n`, { mode: 0o755 })
    const systemConfig = path.join(root, 'gitconfig-system')
    fs.writeFileSync(systemConfig, `[credential]\n\thelper = !'${systemHelper}'\n`)
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, 'agentgit'),
      '#!/bin/sh\ncat >/dev/null\n[ "$2" = get ] && printf "username=SHA256:fp\\npassword=fresh\\n"\nexit 0\n',
      { mode: 0o755 },
    )
    const clone = path.join(root, 'clone')
    fs.mkdirSync(clone)
    expect(git(clone, ['init', '-q']).code).toBe(0)

    const fill = () =>
      spawnSync('git', ['-C', clone, 'credential', 'fill'], {
        encoding: 'utf8',
        input: 'protocol=https\nhost=agentgit.zabaca.com\n\n',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          GIT_CONFIG_SYSTEM: systemConfig,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      })
    const askedOf = () => (fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8') : '')
    const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
    return { clone, fill, askedOf, cleanup }
  }

  test('the helper it writes is the only one git asks for the origin', async () => {
    const box = sandbox()
    try {
      const result = await runSetup({ host: ORIGIN, global: false }, realSetupDeps(box.clone))
      expect(result.code).toBe(0)

      const filled = box.fill()
      expect(filled.status).toBe(0)
      expect(filled.stdout).toContain('password=fresh')
      expect(box.askedOf()).toBe('')
    } finally {
      box.cleanup()
    }
  })

  test('the single line it used to write leaves the system helper asked first', () => {
    const box = sandbox()
    try {
      git(box.clone, ['config', '--local', `credential.${ORIGIN}.helper`, '!agentgit credential'])
      box.fill()
      expect(box.askedOf()).toContain('get')
    } finally {
      box.cleanup()
    }
  })

  test('running it twice succeeds and leaves the same two values', async () => {
    const box = sandbox()
    try {
      // A plain `git config key value` refuses a key with two values, so this
      // is the run that would fail if setup ever went back to one.
      for (let run = 0; run < 2; run++) {
        const result = await runSetup({ host: ORIGIN, global: false }, realSetupDeps(box.clone))
        expect(result.code).toBe(0)
      }
      const values = git(box.clone, [
        'config',
        '--local',
        '--get-all',
        `credential.${ORIGIN}.helper`,
      ])
      expect(values.stdout).toBe('\n!agentgit credential\n')
    } finally {
      box.cleanup()
    }
  })
})
