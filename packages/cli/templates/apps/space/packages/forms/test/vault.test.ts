// The vault: nothing read from D1 or R2 is readable without the data key, a data key is readable only with its master,
// a ciphertext opens only for the row it was made for, and deleting the wrapped key is what ends access.
import { describe, expect, test } from 'bun:test'
import { VaultUnconfigured, createVault, decryptText, encryptText, getSealed, putSealed } from '../src/vault'
import { memoryStore } from './local-d1'

const b64 = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString('base64')

describe('data keys', () => {
  test('a fresh key is wrapped by the master and opens again with it', async () => {
    const vault = createVault({ FORMS_DATA_KEY: b64(1) })
    const a = await vault.newDataKey('envelope:e1')
    expect(a.key).toHaveLength(32)
    expect(a.version).toBe(1)
    expect(a.wrapped).not.toContain(Buffer.from(a.key).toString('base64'))
    expect(await vault.unwrap(a.wrapped, 1, 'envelope:e1')).toEqual(a.key)
    const b = await vault.newDataKey('envelope:e1')
    expect(b.key).not.toEqual(a.key)
  })

  test('another master, another envelope\'s context and a damaged wrapped key all fail', async () => {
    const vault = createVault({ FORMS_DATA_KEY: b64(1) })
    const a = await vault.newDataKey('envelope:e1')
    await expect(createVault({ FORMS_DATA_KEY: b64(2) }).unwrap(a.wrapped, 1, 'envelope:e1')).rejects.toThrow()
    await expect(vault.unwrap(a.wrapped, 1, 'envelope:e2')).rejects.toThrow()
    await expect(vault.unwrap(a.wrapped.slice(0, -4) + 'AAAA', 1, 'envelope:e1')).rejects.toThrow()
    await expect(vault.unwrap('nonsense', 1, 'envelope:e1')).rejects.toThrow()
  })

  test('rotating the master: new keys use the newest, old ones still open with the version stored beside them', async () => {
    const before = createVault({ FORMS_DATA_KEY: b64(1) })
    const old = await before.newDataKey('envelope:e1')
    const after = createVault({ FORMS_DATA_KEY: b64(1), FORMS_DATA_KEY_V2: b64(2) } as never)
    expect(after.currentVersion).toBe(2)
    const fresh = await after.newDataKey('envelope:e2')
    expect(fresh.version).toBe(2)
    expect(await after.unwrap(old.wrapped, 1, 'envelope:e1')).toEqual(old.key)
    expect(await after.unwrap(fresh.wrapped, 2, 'envelope:e2')).toEqual(fresh.key)
    await expect(before.unwrap(fresh.wrapped, 2, 'envelope:e2')).rejects.toThrow(/version 2/)
  })

  test('with no master key, or a malformed one, there is no vault: nothing is stored unencrypted instead', () => {
    expect(() => createVault({})).toThrow(VaultUnconfigured)
    expect(() => createVault({ FORMS_DATA_KEY: '   ' })).toThrow(VaultUnconfigured)
    expect(() => createVault({ FORMS_DATA_KEY: Buffer.from('too short').toString('base64') })).toThrow(/32 bytes/)
  })
})

describe('values in D1', () => {
  const key = crypto.getRandomValues(new Uint8Array(32))

  test('a value round-trips, is not in the clear, and is different every time', async () => {
    const ssn = '123-45-6789'
    const a = await encryptText(key, ssn, 'e1:answer:q7')
    const b = await encryptText(key, ssn, 'e1:answer:q7')
    expect(a).toStartWith('e1.')
    expect(a).not.toContain('6789')
    expect(a).not.toBe(b)
    expect(await decryptText(key, a, 'e1:answer:q7')).toBe(ssn)
  })

  test('it opens only for the row it was made for, with the key it was made with, and unaltered', async () => {
    const sealed = await encryptText(key, 'secret', 'e1:answer:q7')
    await expect(decryptText(key, sealed, 'e1:answer:q8')).rejects.toThrow()
    await expect(decryptText(key, sealed, 'e2:answer:q7')).rejects.toThrow()
    await expect(decryptText(crypto.getRandomValues(new Uint8Array(32)), sealed, 'e1:answer:q7')).rejects.toThrow()
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA')
    await expect(decryptText(key, flipped, 'e1:answer:q7')).rejects.toThrow()
    await expect(decryptText(key, 'plain text', 'e1:answer:q7')).rejects.toThrow()
  })

  test('unicode and empty values survive', async () => {
    for (const v of ['', 'Zoë Müller 日本語', 'a'.repeat(100_000)]) expect(await decryptText(key, await encryptText(key, v, 'c'), 'c')).toBe(v)
  })
})

describe('objects in R2', () => {
  test('stored under the envelope\'s key, readable with it, refused without it or with another, and never in the clear', async () => {
    const store = memoryStore()
    const key = crypto.getRandomValues(new Uint8Array(32))
    const pdf = new TextEncoder().encode('%PDF-1.7 a finished document')
    await putSealed(store, 'envelopes/e1/finished.pdf', key, pdf, 'application/pdf')
    expect(await getSealed(store, 'envelopes/e1/finished.pdf', key)).toEqual(pdf)
    await expect(getSealed(store, 'envelopes/e1/finished.pdf', crypto.getRandomValues(new Uint8Array(32)))).rejects.toThrow()
    await expect(store.get('envelopes/e1/finished.pdf')).rejects.toThrow()
    expect(store.objects.get('envelopes/e1/finished.pdf')!.contentType).toBe('application/pdf')
    expect(await getSealed(store, 'envelopes/e1/missing.pdf', key)).toBeNull()
  })
})
