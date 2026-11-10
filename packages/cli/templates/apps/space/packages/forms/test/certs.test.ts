// The seal's certificates: a root and a seal certificate it issues, loaded the way the Worker loads them. Nothing here
// touches sops (test/seal-certs-cli.test.ts does that, against a throwaway file).
import * as pkijs from 'pkijs'
import { describe, expect, test } from 'bun:test'
import { ROOT_NAME, SEAL_NAME, makeSealCerts, reissueSeal, sealNamesFromRoot, sealNamesOf } from '../scripts/certs'
import { SealerUnconfigured, loadSealer } from '../src/seal/sealer'
import { pemBlocks } from '../src/seal/pem'
import { testCerts } from './seal-fixture'
import { BRIGHTWATER_WORDS, NORTHFIELD_WORDS } from './words'

const parse = (der: Uint8Array) => pkijs.Certificate.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer)
const cn = (c: pkijs.Certificate, which: 'subject' | 'issuer') => (c[which].typesAndValues.find((t) => t.type === '2.5.4.3')!.value as { valueBlock: { value: string } }).valueBlock.value

describe('the certificates', () => {
  test('a serial number is a minimal DER integer even when the random bytes start with 0x00', async () => {
    // Every 16-byte random draw is zero but for its second byte (below 0x80), the case that made pdfsig call a seal invalid.
    const real = crypto.getRandomValues.bind(crypto)
    const draw = ((a: ArrayBufferView) => {
      if (a.byteLength !== 16) return real(a as never)
      const bytes = a as Uint8Array
      bytes.fill(0)
      bytes[1] = 0x10
      return a
    }) as typeof crypto.getRandomValues
    crypto.getRandomValues = draw
    let certs: Awaited<ReturnType<typeof makeSealCerts>>
    try {
      certs = await makeSealCerts(new Date(), 1024)
    } finally {
      crypto.getRandomValues = real
    }
    for (const der of [certs.root.certDer, certs.seal.certDer]) {
      const serial = new Uint8Array(parse(der).serialNumber.valueBlock.valueHexView)
      expect(serial.length).toBeGreaterThan(1)
      expect(serial[0], 'the first content byte is not a redundant zero').not.toBe(0)
      expect(serial[0]! & 0x80, 'the integer is positive').toBe(0)
    }
  })

  test('a root signs itself, a seal certificate chains to it, and neither can be mistaken for the other', async () => {
    const { root, seal } = await testCerts()
    const r = parse(root.certDer)
    const s = parse(seal.certDer)
    expect(cn(r, 'subject')).toBe(ROOT_NAME)
    expect(cn(r, 'issuer')).toBe(ROOT_NAME)
    expect(cn(s, 'subject')).toBe(SEAL_NAME)
    expect(cn(s, 'issuer')).toBe(ROOT_NAME)
    expect(await r.verify(r)).toBe(true)
    expect(await s.verify(r)).toBe(true)
    expect(await r.verify(s)).toBe(false)
    const ext = (c: pkijs.Certificate, oid: string) => c.extensions?.find((e) => e.extnID === oid)
    expect((ext(r, '2.5.29.19')!.parsedValue as pkijs.BasicConstraints).cA).toBe(true)
    expect((ext(s, '2.5.29.19')!.parsedValue as pkijs.BasicConstraints).cA ?? false).toBe(false)
    expect(ext(r, '2.5.29.15')).toBeDefined()
    expect(ext(s, '2.5.29.15')).toBeDefined()
  })

  test('the seal lasts three years and the root ten', async () => {
    const { root, seal } = await makeSealCerts(new Date('2026-10-31T20:00:00Z'), 2048)
    const years = (c: pkijs.Certificate) => (c.notAfter.value.getTime() - c.notBefore.value.getTime()) / (365.25 * 86_400_000)
    expect(years(parse(seal.certDer))).toBeCloseTo(3, 1)
    expect(years(parse(root.certDer))).toBeCloseTo(10, 1)
  })

  test('a renewal is a new key and a new certificate under the same root, which still verifies', async () => {
    const { root, seal } = await testCerts()
    const renewed = await reissueSeal(root.keyPem, root.certPem, new Date('2029-06-01T00:00:00Z'))
    expect(renewed.keyPem).not.toBe(seal.keyPem)
    expect(renewed.fingerprint).not.toBe(seal.fingerprint)
    const s = parse(renewed.certDer)
    expect(await s.verify(parse(root.certDer))).toBe(true)
    expect(cn(s, 'issuer')).toBe(ROOT_NAME)
    expect(s.notAfter.value.getUTCFullYear()).toBe(2032)
  })
})

const org = (c: pkijs.Certificate, which: 'subject' | 'issuer') => (c[which].typesAndValues.find((t) => t.type === '2.5.4.10')!.value as { valueBlock: { value: string } }).valueBlock.value

describe('the certificates carry the names of the install they are made for', () => {
  test('Northfield’s are the ones it has always had: "Northfield Forms Root" and "Northfield Forms Seal", organisation "Northfield Works LLC"', async () => {
    expect(sealNamesOf(NORTHFIELD_WORDS)).toEqual({ root: 'Northfield Forms Root', seal: 'Northfield Forms Seal', organization: 'Northfield Works LLC' })
    const { root, seal } = await testCerts()
    for (const [c, name] of [[parse(root.certDer), 'Northfield Forms Root'], [parse(seal.certDer), 'Northfield Forms Seal']] as const) {
      expect([cn(c, 'subject'), org(c, 'subject'), org(c, 'issuer')]).toEqual([name, 'Northfield Works LLC', 'Northfield Works LLC'])
    }
  })

  test('another company’s are named for its own service and run-by, with nothing of Northfield’s, and a renewal keeps them', async () => {
    const names = sealNamesOf(BRIGHTWATER_WORDS)
    expect(names).toEqual({ root: 'Brightwater Forms Root', seal: 'Brightwater Forms Seal', organization: 'Brightwater Builders Inc.' })
    const { root, seal } = await makeSealCerts(new Date('2026-11-09T00:00:00Z'), 1024, names)
    const renewed = await reissueSeal(root.keyPem, root.certPem, new Date('2028-01-01T00:00:00Z'), names)
    for (const der of [root.certDer, seal.certDer, renewed.certDer]) {
      const c = parse(der)
      expect(org(c, 'subject')).toBe('Brightwater Builders Inc.')
      expect(org(c, 'issuer')).toBe('Brightwater Builders Inc.')
      expect(Buffer.from(der).toString('latin1')).not.toMatch(/northfield/i)
    }
    expect([cn(parse(root.certDer), 'subject'), cn(parse(seal.certDer), 'subject'), cn(parse(seal.certDer), 'issuer'), cn(parse(renewed.certDer), 'issuer')]).toEqual(['Brightwater Forms Root', 'Brightwater Forms Seal', 'Brightwater Forms Root', 'Brightwater Forms Root'])
    expect(await parse(renewed.certDer).verify(parse(root.certDer))).toBe(true)
  })
})

describe('a renewal takes its names from the root certificate', () => {
  test('whatever company’s it is, the seal’s names and organisation are the root’s, and a root that does not say them is refused', async () => {
    const northfield = await testCerts()
    expect(sealNamesFromRoot(northfield.root.certPem)).toEqual({ root: 'Northfield Forms Root', seal: 'Northfield Forms Seal', organization: 'Northfield Works LLC' })
    const names = sealNamesOf(BRIGHTWATER_WORDS)
    const theirs = await makeSealCerts(new Date('2026-11-09T00:00:00Z'), 1024, names)
    expect(sealNamesFromRoot(theirs.root.certPem)).toEqual(names)
    // A certificate whose subject is not "<service name> Root" (a seal certificate stands in) cannot name a seal.
    expect(() => sealNamesFromRoot(theirs.seal.certPem)).toThrow(/is not "<service name> Root"/)
  })
})

describe('a seal certificate never outlives its root', () => {
  test('renewed late in the root\'s life, it ends with the root and says how short that is', async () => {
    const { root, seal } = await makeSealCerts(new Date('2026-10-31T20:00:00Z'), 2048)
    const rootEnds = parse(root.certDer).notAfter.value
    // Nine and a half years in: three more years would pass the root's end.
    const late = new Date(rootEnds.getTime() - 0.5 * 365.25 * 86_400_000)
    const renewed = await reissueSeal(root.keyPem, root.certPem, late)
    expect(renewed.notAfter.getTime()).toBe(rootEnds.getTime())
    expect(parse(renewed.certDer).notAfter.value.getTime()).toBe(rootEnds.getTime())
    expect((renewed.notAfter.getTime() - late.getTime()) / 86_400_000).toBeLessThan(200)
    // And early in its life it is the full three years, unclamped.
    expect(seal.notAfter.getTime()).toBeLessThan(rootEnds.getTime())
    expect((seal.notAfter.getTime() - Date.parse('2026-10-31T20:00:00Z')) / (365.25 * 86_400_000)).toBeCloseTo(3, 1)
  })
})

describe('the Worker loads them', () => {
  test('from the two secrets, with real newlines or with \\n escapes (a .dev.vars line)', async () => {
    const { root, seal } = await testCerts()
    const chain = seal.certPem + root.certPem
    const a = await loadSealer({ FORMS_SEAL_KEY: seal.keyPem, FORMS_SEAL_CERT_CHAIN: chain })
    const b = await loadSealer({ FORMS_SEAL_KEY: seal.keyPem.replace(/\n/g, '\\n'), FORMS_SEAL_CERT_CHAIN: chain.replace(/\n/g, '\\n') })
    for (const s of [a, b]) {
      expect(s.subject).toBe(SEAL_NAME)
      expect(s.rootFingerprint).toBe(root.fingerprint)
      expect(s.certFingerprint).toBe(seal.fingerprint)
      expect(Date.parse(s.notAfter)).toBeGreaterThan(Date.now() + 1000 * 86_400_000)
      expect(s.timestampAuthority).toBeUndefined()
      expect(s.signer.keyType).toBe('RSA')
    }
  })

  test('says exactly what is missing, and a chain without the root is not enough', async () => {
    const { root, seal } = await testCerts()
    await expect(loadSealer({})).rejects.toThrow(/FORMS_SEAL_KEY is missing/)
    await expect(loadSealer({ FORMS_SEAL_KEY: seal.keyPem })).rejects.toThrow(/FORMS_SEAL_CERT_CHAIN is missing/)
    await expect(loadSealer({ FORMS_SEAL_KEY: root.certPem, FORMS_SEAL_CERT_CHAIN: seal.certPem + root.certPem })).rejects.toThrow(/no PKCS#8 private key/)
    await expect(loadSealer({ FORMS_SEAL_KEY: seal.keyPem, FORMS_SEAL_CERT_CHAIN: seal.certPem })).rejects.toThrow(SealerUnconfigured)
  })

  test('a signature made with the loaded signer verifies against the seal certificate\'s public key', async () => {
    const { root, seal } = await testCerts()
    const s = await loadSealer({ FORMS_SEAL_KEY: seal.keyPem, FORMS_SEAL_CERT_CHAIN: seal.certPem + root.certPem })
    const data = new TextEncoder().encode('what was sealed')
    const sig = await s.signer.sign(data, 'SHA-256')
    const key = await parse(seal.certDer).getPublicKey({ algorithm: { algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, usages: ['verify'] } })
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig as unknown as ArrayBuffer, data)).toBe(true)
  })

  test('PEM blocks read in order and ignore what is between them', () => {
    const blocks = pemBlocks('junk\n-----BEGIN CERTIFICATE-----\nAAEC\n-----END CERTIFICATE-----\nmore junk\n-----BEGIN PRIVATE KEY-----\nAwQF\n-----END PRIVATE KEY-----\n')
    expect(blocks.map((b) => [b.label, [...b.der]])).toEqual([['CERTIFICATE', [0, 1, 2]], ['PRIVATE KEY', [3, 4, 5]]])
  })
})
