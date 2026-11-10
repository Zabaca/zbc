import { describe, expect, test } from 'bun:test'
import { base64Bytes } from '../src/gmail/parse'
import { b64url } from '../src/notify/base64url'
import {
  encryptPayload,
  generateVapidKey,
  parseVapidKey,
  RECORD_SIZE,
  VAPID_LIFETIME_S,
  vapidAuthorization,
} from '../src/notify/webpush'
import { NORTHFIELD_OWNER } from '../test-support/owner'
import { decrypt, newDevice, verifyVapid } from '../test-support/push-device'

/**
 * The encryption and the signing of a notification, as pure functions: RFC 8291's worked example reproduced to the byte with its
 * own keys and salt, a round trip through a decrypt written separately in the test support, and a VAPID token that
 * verifies as a push service checks it.
 */

/** RFC 8291 section 5 and appendix A, copied from the RFC's text (whitespace removed). */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/** A P-256 ECDH pair from an uncompressed public key and a private scalar, both base64url. */
async function ecdhPair(publicKey: string, privateKey: string): Promise<CryptoKeyPair> {
  const raw = base64Bytes(publicKey)
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33)), d: privateKey }
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' }
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk, algorithm, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', raw as BufferSource, algorithm, true, []),
  }
}

describe('the payload, encrypted to one device (RFC 8291)', () => {
  test("RFC 8291's worked example, to the byte, from its own keys and salt", async () => {
    const body = await encryptPayload({
      plaintext: new TextEncoder().encode(RFC.plaintext),
      uaPublic: base64Bytes(RFC.uaPublic),
      authSecret: base64Bytes(RFC.auth),
      ephemeral: await ecdhPair(RFC.asPublic, RFC.asPrivate),
      salt: base64Bytes(RFC.salt),
    })
    expect(b64url(body)).toBe(RFC.body)
    // The 86-octet header, the 41 octets of text with the delimiter, and the 16-octet tag. (The example's
    // Content-Length line says 145; the body it prints decodes to 144, as here.)
    expect(body.length).toBe(144)
    expect(base64Bytes(RFC.body).length).toBe(144)
  })

  test('the separate decrypt in the test support reads the RFC example back, as the device would', async () => {
    const device = await ecdhPair(RFC.uaPublic, RFC.uaPrivate)
    const read = await decrypt(
      { privateKey: device.privateKey, publicRaw: base64Bytes(RFC.uaPublic), auth: base64Bytes(RFC.auth) },
      base64Bytes(RFC.body),
    )
    expect(read.text).toBe(RFC.plaintext)
  })

  test('a round trip with fresh keys: the device reads exactly what was sent; the header is the one record size and a 65-byte key', async () => {
    const device = await newDevice()
    const payload = JSON.stringify({ v: 1, title: 'Marta Vidal', body: 'Re: Changes to the site é ✓' })
    const body = await encryptPayload({
      plaintext: new TextEncoder().encode(payload),
      uaPublic: device.publicRaw,
      authSecret: device.auth,
    })
    const read = await decrypt(device, body)
    expect(read.text).toBe(payload)
    expect(read.rs).toBe(RECORD_SIZE)
    expect(read.asPublic.length).toBe(65)
  })

  test('every message has a fresh key pair and salt, so the same text twice is two different bodies', async () => {
    const device = await newDevice()
    const send = () =>
      encryptPayload({
        plaintext: new TextEncoder().encode('same'),
        uaPublic: device.publicRaw,
        authSecret: device.auth,
      })
    const [a, b] = [await send(), await send()]
    expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16)))
    expect(b64url(a.slice(21, 86))).not.toBe(b64url(b.slice(21, 86)))
  })

  test('another device cannot read it', async () => {
    const [mine, other] = [await newDevice(), await newDevice()]
    const body = await encryptPayload({
      plaintext: new TextEncoder().encode('secret'),
      uaPublic: mine.publicRaw,
      authSecret: mine.auth,
    })
    await expect(decrypt(other, body)).rejects.toThrow()
  })
})

describe('the key, and the signature on every request (RFC 8292)', () => {
  test('a generated key is a P-256 JWK with both halves, and its public half is the 65 bytes the browser takes', async () => {
    const raw = await generateVapidKey()
    const key = parseVapidKey(raw)
    expect(key).not.toBeNull()
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y'])
    const pub = base64Bytes(key?.publicKey ?? '')
    expect(pub.length).toBe(65)
    expect(pub[0]).toBe(4)
  })

  test('anything that is not a whole P-256 key is no key at all, and then nothing is ever sent', async () => {
    const good = JSON.parse(await generateVapidKey())
    for (const raw of [
      undefined,
      '',
      '   ',
      'not json',
      '[]',
      JSON.stringify({ ...good, crv: 'P-384' }),
      JSON.stringify({ ...good, kty: 'RSA' }),
      JSON.stringify({ ...good, d: undefined }),
      JSON.stringify({ ...good, x: 'short' }),
      JSON.stringify({ ...good, y: '!!!' }),
    ]) {
      expect(parseVapidKey(raw), String(raw)).toBeNull()
    }
  })

  test('the header verifies under the key it names, for the push service origin, by the inbox, within 12 hours', async () => {
    const key = parseVapidKey(await generateVapidKey())
    if (!key) throw new Error('no key')
    const now = Date.parse('2026-10-21T12:00:00Z')
    const header = await vapidAuthorization(
      key,
      'https://fcm.googleapis.com/fcm/send/abc:def',
      now,
      NORTHFIELD_OWNER.spaceOrigin,
    )
    const { claims, key: k } = await verifyVapid(header)
    expect(k).toBe(key.publicKey)
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + VAPID_LIFETIME_S,
      sub: 'https://space.northfield.example',
    })
    expect(VAPID_LIFETIME_S).toBeLessThanOrEqual(12 * 60 * 60)
    expect(NORTHFIELD_OWNER.spaceOrigin).not.toContain('@')
  })

  test('a header signed by another key does not verify under this one', async () => {
    const [mine, other] = [parseVapidKey(await generateVapidKey()), parseVapidKey(await generateVapidKey())]
    if (!mine || !other) throw new Error('no key')
    const header = await vapidAuthorization(
      other,
      'https://fcm.googleapis.com/x',
      Date.now(),
      NORTHFIELD_OWNER.spaceOrigin,
    )
    const forged = header.replace(/k=.*$/, `k=${mine.publicKey}`)
    await expect(verifyVapid(forged)).rejects.toThrow()
  })
})
