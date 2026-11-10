// scripts/seal-certs.ts against a THROWAWAY sops file (its own age key, FORMS_SOPS_FILE pointing at it): the real
// command that writes the production secrets, proven not to print one, not to overwrite the master key and to renew a
// seal certificate under the same root. Skipped where sops or age is not installed, and a failure in CI (test/render.ts, `requiredInCi`).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as pkijs from 'pkijs'
import { hasTool, requiredInCi } from './render'
import { BRIGHTWATER_DECLARATION } from './words'

const available = hasTool('sops') && hasTool('age-keygen')
requiredInCi('sops and age-keygen', available)
const script = fileURLToPath(new URL('../scripts/seal-certs.ts', import.meta.url))
const northfieldDeclaration = fileURLToPath(new URL('../../workspace/northfield/workspace.json', import.meta.url))
let dir = ''
let env: Record<string, string> = {}

const run = (...args: string[]) => runWith({}, ...args)
const runWith = (extra: Record<string, string>, ...args: string[]) => {
  const r = Bun.spawnSync(['bun', script, ...args], { env: { ...process.env, ...env, ...extra }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const get = (key: string): string | null => {
  const r = Bun.spawnSync(['sops', 'decrypt', '--extract', `["${key}"]`, env.FORMS_SOPS_FILE!], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 ? r.stdout.toString() : null
}
const certs = (chain: string) => chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!

beforeAll(() => {
  if (!available) return
  dir = mkdtempSync(join(tmpdir(), 'forms-sops-'))
  Bun.spawnSync(['age-keygen', '-o', join(dir, 'key.txt')], { stderr: 'pipe' })
  const pub = /# public key: (\S+)/.exec(readFileSync(join(dir, 'key.txt'), 'utf8'))![1]!
  writeFileSync(join(dir, 'plain.yaml'), 'OTHER_SECRET: stays\n')
  const enc = Bun.spawnSync(['sops', 'encrypt', '--age', pub, '--input-type', 'yaml', '--output-type', 'yaml', join(dir, 'plain.yaml')], { stdout: 'pipe', stderr: 'pipe' })
  expect(enc.exitCode).toBe(0)
  writeFileSync(join(dir, 'secrets.yaml'), enc.stdout)
  env = { SOPS_AGE_KEY_FILE: join(dir, 'key.txt'), FORMS_SOPS_FILE: join(dir, 'secrets.yaml') }
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!available)('the seal-certs command for another install (FORMS_DECLARATION)', () => {
  test('names its certificates for that install’s service and run-by, in its own sops file, with nothing of Northfield’s', () => {
    const other = join(dir, 'other.yaml')
    const declaration = join(dir, 'declaration.json')
    writeFileSync(declaration, JSON.stringify(BRIGHTWATER_DECLARATION))
    writeFileSync(join(dir, 'plain2.yaml'), 'OTHER_SECRET: stays\n')
    const pub = /# public key: (\S+)/.exec(readFileSync(join(dir, 'key.txt'), 'utf8'))![1]!
    const enc = Bun.spawnSync(['sops', 'encrypt', '--age', pub, '--input-type', 'yaml', '--output-type', 'yaml', join(dir, 'plain2.yaml')], { stdout: 'pipe', stderr: 'pipe' })
    expect(enc.exitCode).toBe(0)
    writeFileSync(other, enc.stdout)
    const r = runWith({ FORMS_SOPS_FILE: other, FORMS_DECLARATION: declaration }, '--production')
    expect(r.code).toBe(0)
    expect(r.out).toContain('"Brightwater Forms Root" and "Brightwater Forms Seal", organisation "Brightwater Builders Inc."')
    expect(r.out + r.err).not.toMatch(/northfield/i)
    const chain = Bun.spawnSync(['sops', 'decrypt', '--extract', '["FORMS_SEAL_CERT_CHAIN"]', other], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
    const pems = certs(chain)
    const der = (p: string) => Uint8Array.from(Buffer.from(p.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64')).buffer as ArrayBuffer
    const text = (c: pkijs.Certificate) => Buffer.from(c.toSchema(true).toBER(false)).toString('latin1')
    for (const p of pems) expect(text(pkijs.Certificate.fromBER(der(p)))).not.toMatch(/northfield/i)
    expect(text(pkijs.Certificate.fromBER(der(pems[0]!)))).toContain('Brightwater Forms Seal')
    expect(text(pkijs.Certificate.fromBER(der(pems[1]!)))).toContain('Brightwater Builders Inc.')

    // A renewal takes its names from the root certificate in the file, never from a declaration: run beside Northfield's declaration (and with none) it still makes "Brightwater Forms Seal".
    const rootBefore = pems[1]!
    for (const extra of [{}, { FORMS_DECLARATION: northfieldDeclaration }] as Record<string, string>[]) {
      const renewed = runWith({ FORMS_SOPS_FILE: other, ...extra }, '--renew')
      expect(renewed.code).toBe(0)
      expect(renewed.out).toContain('"Brightwater Forms Seal", organisation "Brightwater Builders Inc."')
      const after = certs(Bun.spawnSync(['sops', 'decrypt', '--extract', '["FORMS_SEAL_CERT_CHAIN"]', other], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' }).stdout.toString())
      expect(after[1]).toBe(rootBefore)
      const sealText = text(pkijs.Certificate.fromBER(der(after[0]!)))
      expect(sealText).toContain('Brightwater Forms Seal')
      expect(sealText).toContain('Brightwater Builders Inc.')
      expect(sealText).not.toMatch(/northfield/i)
    }
  })

  test('--production takes a declaration and a sops file together: one alone is refused and writes nothing', () => {
    const lonely = join(dir, 'lonely.yaml')
    const declaration = join(dir, 'declaration.json')
    writeFileSync(join(dir, 'plain3.yaml'), 'OTHER_SECRET: stays\n')
    const pub = /# public key: (\S+)/.exec(readFileSync(join(dir, 'key.txt'), 'utf8'))![1]!
    writeFileSync(lonely, Bun.spawnSync(['sops', 'encrypt', '--age', pub, '--input-type', 'yaml', '--output-type', 'yaml', join(dir, 'plain3.yaml')], { stdout: 'pipe', stderr: 'pipe' }).stdout)
    const before = readFileSync(lonely, 'utf8')
    writeFileSync(declaration, JSON.stringify(BRIGHTWATER_DECLARATION))
    // An empty value is unset for the script, which is how a variable the harness set by default is taken away.
    for (const extra of [{ FORMS_SOPS_FILE: lonely, FORMS_DECLARATION: '' }, { FORMS_DECLARATION: declaration, FORMS_SOPS_FILE: '' }]) {
      const r = runWith(extra, '--production')
      expect(r.code).toBe(2)
      expect(r.err).toContain('so set both')
    }
    expect(readFileSync(lonely, 'utf8')).toBe(before)
  })
})

describe.skipIf(!available)('the seal-certs command', () => {
  let master = ''
  let rootKey = ''
  let sealKey = ''
  let rootCert = ''

  test('--production writes the four secrets and prints none of them, and says which file it wrote', () => {
    const r = runWith({ FORMS_DECLARATION: northfieldDeclaration }, '--production')
    expect(r.out).toContain(`to ${env.FORMS_SOPS_FILE}.`)
    expect(r.code).toBe(0)
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain('PRIVATE KEY')
      expect(text).not.toContain('BEGIN CERTIFICATE')
    }
    expect(r.out).toMatch(/root fingerprint \(SHA-256\) [0-9a-f]{64}/)
    master = get('FORMS_DATA_KEY')!
    rootKey = get('FORMS_SEAL_ROOT_KEY')!
    sealKey = get('FORMS_SEAL_KEY')!
    const chain = get('FORMS_SEAL_CERT_CHAIN')!
    rootCert = certs(chain)[1]!
    expect(Buffer.from(master, 'base64')).toHaveLength(32)
    expect(rootKey).toContain('BEGIN PRIVATE KEY')
    expect(sealKey).toContain('BEGIN PRIVATE KEY')
    expect(certs(chain)).toHaveLength(2)
    expect(get('OTHER_SECRET')).toBe('stays')
    expect(r.out).not.toContain(master.trim())
  })

  test('--production refuses a second time, because a new master key would orphan every stored record', () => {
    const before = readFileSync(env.FORMS_SOPS_FILE!, 'utf8')
    const r = runWith({ FORMS_DECLARATION: northfieldDeclaration }, '--production')
    expect(r.code).toBe(1)
    expect(r.err).toContain('orphan every stored record')
    expect(r.err).toContain(env.FORMS_SOPS_FILE!)
    expect(readFileSync(env.FORMS_SOPS_FILE!, 'utf8')).toBe(before)
  })

  test('--status reports the dates and that every key is present, with no secret', () => {
    const r = run('--status')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/valid until 20\d\d-\d\d-\d\dT.* \(\d+ days left\)/)
    for (const k of ['FORMS_DATA_KEY', 'FORMS_SEAL_KEY', 'FORMS_SEAL_CERT_CHAIN', 'FORMS_SEAL_ROOT_KEY']) expect(r.out).toContain(`${k}: present`)
    expect(r.out).not.toContain('PRIVATE KEY')
  })

  test('--renew replaces the seal key and certificate under the same root, and touches nothing else', async () => {
    const r = run('--renew')
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('PRIVATE KEY')
    expect(get('FORMS_DATA_KEY')).toBe(master)
    expect(get('FORMS_SEAL_ROOT_KEY')).toBe(rootKey)
    expect(get('OTHER_SECRET')).toBe('stays')
    const newSealKey = get('FORMS_SEAL_KEY')!
    expect(newSealKey).not.toBe(sealKey)
    const chain = certs(get('FORMS_SEAL_CERT_CHAIN')!)
    expect(chain).toHaveLength(2)
    expect(chain[1]).toBe(rootCert)
    const der = (p: string) => Uint8Array.from(Buffer.from(p.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64')).buffer as ArrayBuffer
    expect(await pkijs.Certificate.fromBER(der(chain[0]!)).verify(pkijs.Certificate.fromBER(der(chain[1]!)))).toBe(true)
  })
})
