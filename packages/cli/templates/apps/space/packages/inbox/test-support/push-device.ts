import { compactVerify, importJWK } from 'jose'
import { base64Bytes } from '../src/gmail/parse'

/**
 * A device, as the push service and the browser see the inbox's requests: its own key pair and auth secret (what a
 * browser hands over when notifications are turned on), a decrypt of what the inbox sends it, and a check of the
 * VAPID header. Written from RFC 8291, RFC 8188 and RFC 8292 directly and NOT through src/notify/webpush.ts, so a
 * round trip is two implementations agreeing, not one agreeing with itself.
 */

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const hmac = async (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource))
}

/** HKDF by hand (RFC 5869), extract then one block of expand: every length here is at most 32. */
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, length)

export interface TestDevice {
  endpoint: string
  /** What the browser gives the inbox: `p256dh` and `auth`, base64url. */
  keys: { p256dh: string; auth: string }
  privateKey: CryptoKey
  publicRaw: Uint8Array
  auth: Uint8Array
}

/** A new device at a Chrome push address. */
export async function newDevice(token: string = crypto.randomUUID()): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${token}`,
    keys: { p256dh: b64url(publicRaw), auth: b64url(auth) },
    privateKey: pair.privateKey,
    publicRaw,
    auth,
  }
}

/** What the device reads out of a push body (aes128gcm, one record), as text. Throws on anything that does not decrypt. */
export async function decrypt(device: Pick<TestDevice, 'privateKey' | 'publicRaw' | 'auth'>, body: Uint8Array) {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLength = body[20] as number
  const asPublic = body.slice(21, 21 + idLength)
  const sender = await crypto.subtle.importKey(
    'raw',
    asPublic as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: sender } as EcdhKeyDeriveParams, device.privateKey, 256),
  )
  const te = new TextEncoder()
  const ikm = await hkdf(device.auth, shared, cat(te.encode('WebPush: info\0'), device.publicRaw, asPublic), 32)
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, body.slice(21 + idLength)),
  )
  // One record, whose last non-zero octet is the delimiter 0x02 (zero octets after it are padding).
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end -= 1
  if (padded[end] !== 2) throw new Error('the record does not end in the last-record delimiter')
  return { text: new TextDecoder().decode(padded.slice(0, end)), rs, salt, asPublic }
}

/**
 * Check a VAPID Authorization header as a push service does: `vapid t=<jwt>, k=<key>`, the JWT verifying under `k`,
 * and answer its claims.
 */
export async function verifyVapid(header: string): Promise<{ claims: Record<string, unknown>; key: string }> {
  const match = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header)
  if (!match) throw new Error(`not a vapid header: ${header}`)
  const [, token, key] = match as unknown as [string, string, string]
  const raw = base64Bytes(key)
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('k is not an uncompressed P-256 key')
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33)) }
  const verified = await compactVerify(token, await importJWK(jwk, 'ES256'))
  if (verified.protectedHeader.alg !== 'ES256') throw new Error('not ES256')
  return { claims: JSON.parse(new TextDecoder().decode(verified.payload)), key }
}

/** One request the inbox made to a push service, as the service received it. */
export interface PushRequest {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array
}

/**
 * Google's push service, standing in: it records every request and answers whatever status a test sets for an
 * address (201 by default), or no answer at all (`null`). It decrypts nothing itself; a test reads a request with the
 * device's own key (`decrypt`).
 */
export class FakePushService {
  readonly requests: PushRequest[] = []
  private readonly answers = new Map<string, number | null>()

  /** What the service answers for this address from now on: a status, or `null` for no answer. */
  answer(endpoint: string, status: number | null): void {
    this.answers.set(endpoint, status)
  }

  async send(
    endpoint: string,
    init: { headers: Record<string, string>; body: Uint8Array },
  ): Promise<{ status: number }> {
    this.requests.push({ endpoint, headers: { ...init.headers }, body: init.body })
    const status = this.answers.has(endpoint) ? this.answers.get(endpoint) : 201
    if (status === null || status === undefined) throw new Error('connection reset')
    return { status }
  }

  /** The requests to one address. */
  to(endpoint: string): PushRequest[] {
    return this.requests.filter((r) => r.endpoint === endpoint)
  }
}
