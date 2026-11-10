import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runVapidKey, SOPS_KEY_ABSENT, VAPID_SECRET, type VapidPorts } from '../scripts/vapid-key'
import { generateVapidKey, parseVapidKey } from '../src/notify/webpush'

/**
 * The command that makes the inbox's VAPID key, over fake ports: no sops, no files. That the private half is never
 * printed, that an existing key is not replaced by accident, and that the dev key goes only to .dev.vars.
 */

function ports(held: string | null = null, devVars: string | null = null) {
  const state = { secret: held, devVars, writes: 0 }
  const p: VapidPorts = {
    generate: generateVapidKey,
    readSecret: () => state.secret,
    writeSecret: (value) => {
      state.secret = value
      state.writes += 1
    },
    readDevVars: () => state.devVars,
    writeDevVars: (text) => {
      state.devVars = text
    },
  }
  return { p, state }
}

describe('production', () => {
  test('writes the key into the secrets file and prints only its public half', async () => {
    const { p, state } = ports()
    const result = await runVapidKey(['production'], p)
    expect(result.exitCode).toBe(0)
    const key = parseVapidKey(state.secret)
    expect(key).not.toBeNull()
    expect(result.output).toContain(key?.publicKey ?? 'no key')
    expect(result.output).not.toContain(JSON.parse(state.secret ?? '{}').d)
  })

  test('refuses to replace a key the file holds, and replaces it only when told to', async () => {
    const existing = await generateVapidKey()
    const { p, state } = ports(existing)
    const refused = await runVapidKey(['production'], p)
    expect(refused.exitCode).toBe(1)
    expect(refused.output).toContain('turns notifications off on every device')
    expect(state.secret).toBe(existing)
    expect(state.writes).toBe(0)
    const replaced = await runVapidKey(['production', '--replace'], p)
    expect(replaced.exitCode).toBe(0)
    expect(state.secret).not.toBe(existing)
  })

  test('public prints the public half of the key held, and says so when there is none', async () => {
    const existing = await generateVapidKey()
    expect((await runVapidKey(['public'], ports(existing).p)).output).toBe(parseVapidKey(existing)?.publicKey ?? '')
    expect((await runVapidKey(['public'], ports().p)).exitCode).toBe(1)
  })
})

describe('when sops cannot read the file', () => {
  test('it fails loudly and writes nothing, rather than reading the failure as "no key"', async () => {
    const { p, state } = ports()
    p.readSecret = () => {
      throw new Error(
        'sops could not read the production secrets file, so nothing was written: Failed to get the data key',
      )
    }
    for (const args of [['production'], ['public']]) {
      const result = await runVapidKey(args, p)
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('could not read')
    }
    expect(state.writes).toBe(0)
  })

  test("sops's word for a key the file does not hold is told apart from a failure to decrypt", () => {
    expect(SOPS_KEY_ABSENT.test("Error truncating tree: component ['INBOX_VAPID_KEY'] not found")).toBe(true)
    expect(SOPS_KEY_ABSENT.test('Failed to get the data key required to decrypt the SOPS file.')).toBe(false)
  })
})

describe('dev', () => {
  test('adds the key to .dev.vars, keeping what is there, and never touches the secrets file', async () => {
    const { p, state } = ports(null, 'OTHER=1')
    const result = await runVapidKey(['dev'], p)
    expect(result.exitCode).toBe(0)
    expect(state.writes).toBe(0)
    const lines = (state.devVars ?? '').trim().split('\n')
    expect(lines[0]).toBe('OTHER=1')
    const value = lines[1]?.match(new RegExp(`^${VAPID_SECRET}='(.*)'$`))?.[1] ?? null
    expect(parseVapidKey(value)).not.toBeNull()
  })

  test('refuses a second dev key unless told to replace it, and then replaces the line', async () => {
    const { p, state } = ports(null, `${VAPID_SECRET}='old'\nOTHER=1\n`)
    expect((await runVapidKey(['dev'], p)).exitCode).toBe(1)
    expect((await runVapidKey(['dev', '--replace'], p)).exitCode).toBe(0)
    expect(state.devVars).not.toContain("'old'")
    expect(state.devVars).toContain('OTHER=1')
    expect((state.devVars ?? '').match(new RegExp(VAPID_SECRET, 'g'))).toHaveLength(1)
  })
})

test('anything else prints the usage', async () => {
  for (const args of [[], ['nope'], ['production', '--force']]) {
    expect((await runVapidKey(args, ports().p)).exitCode).toBe(2)
  }
})

/**
 * The command itself, against a THROWAWAY sops file (its own age key): INBOX_SOPS_FILE sends `production` to another install's secrets file (Pinecrest's environment), where the key is
 * written, no other file is touched, and the private half is not printed. Skipped where sops or age is not installed.
 */
const has = (name: string) => Bun.spawnSync(['which', name]).exitCode === 0
describe.skipIf(!(has('sops') && has('age-keygen')))('INBOX_SOPS_FILE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vapid-sops-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('writes the key into the file it names and prints only the public half', () => {
    Bun.spawnSync(['age-keygen', '-o', join(dir, 'key.txt')], { stderr: 'pipe' })
    const pub = /# public key: (\S+)/.exec(readFileSync(join(dir, 'key.txt'), 'utf8'))![1]!
    writeFileSync(join(dir, 'plain.yaml'), 'OTHER_SECRET: stays\n')
    const other = join(dir, 'secrets.yaml')
    writeFileSync(
      other,
      Bun.spawnSync(
        ['sops', 'encrypt', '--age', pub, '--input-type', 'yaml', '--output-type', 'yaml', join(dir, 'plain.yaml')],
        { stdout: 'pipe', stderr: 'pipe' },
      ).stdout,
    )
    const script = fileURLToPath(new URL('../scripts/vapid-key.ts', import.meta.url))
    const env = { ...process.env, SOPS_AGE_KEY_FILE: join(dir, 'key.txt'), INBOX_SOPS_FILE: other }
    const get = (key: string) =>
      Bun.spawnSync(['sops', 'decrypt', '--extract', `["${key}"]`, other], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(get(VAPID_SECRET).exitCode).not.toBe(0)
    const r = Bun.spawnSync(['bun', script, 'production'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode).toBe(0)
    const out = r.stdout.toString()
    const held = get(VAPID_SECRET)
    expect(held.exitCode).toBe(0)
    const key = parseVapidKey(held.stdout.toString().trim())!
    expect(out).toContain(key.publicKey)
    expect(out).not.toContain(held.stdout.toString().trim())
    expect(get('OTHER_SECRET').stdout.toString()).toBe('stays')
    // A second run refuses and leaves the file alone, as it does for the production file.
    const again = Bun.spawnSync(['bun', script, 'production'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(again.exitCode).toBe(1)
    expect(get(VAPID_SECRET).stdout.toString().trim()).toBe(held.stdout.toString().trim())
  })
})
