import { importJWK, SignJWT } from 'jose'
import { b64url, bytesOf } from './base64url'

/**
 * Web Push from the inbox's side, written here over WebCrypto alone: the payload encrypted to one device (RFC 8291,
 * in the aes128gcm content coding of RFC 8188) and the request signed with the inbox's own key (VAPID, RFC 8292).
 *
 * ── WHY NOT A LIBRARY ────────────────────────────────────────────────────
 * The best known one needs Node's crypto, which a Worker does not have, and the WebCrypto ones would put an outside
 * dependency on the one path that holds the private key. RFC 8291 publishes a worked example with every key, the salt
 * and the result, so code written here is checked against it byte for byte (test/webpush.test.ts), and a round trip
 * through a decrypt written in the test support proves the other direction. What only a real delivery proves is that
 * the Workers runtime's ECDH and HKDF behave as bun's do (the runbook's hand test).
 *
 * ── WHAT IS ENCRYPTED, AND TO WHOM ───────────────────────────────────────
 * Each device gave the inbox a public key (`p256dh`) and a secret (`auth`) when the owner turned notifications on. A
 * payload is encrypted to that pair with a fresh key pair and salt of the inbox's for every message, so Google's push
 * service, which carries it, sees its size and never its text. One record, padded only by the delimiter: the payload
 * is a few hundred bytes and the push service takes 4096.
 *
 * ── THE KEY ──────────────────────────────────────────────────────────────
 * One ECDSA P-256 key pair, kept as a JSON Web Key holding both halves (`INBOX_VAPID_KEY`), so the public half the
 * browser needs is derived from it and the two cannot disagree. Where it lives, why it fails closed and what replacing
 * it does are in the inbox's ADR 0001.
 */

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** WebCrypto takes a BufferSource; a Uint8Array is one, whatever buffer type TypeScript infers for it. */
const buf = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource

/** The inbox's VAPID key: the JWK (both halves) and its public half as the browser takes it (65 bytes, base64url). */
export interface VapidKey {
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string }
  publicKey: string
}

/**
 * The secret as the Worker holds it, checked, or null when it is missing or is not a P-256 key with both halves (and
 * then nothing is ever sent: the routes say notifications are not set up). Nothing is imported into WebCrypto here, so
 * this runs at the Durable Object's construction without awaiting anything.
 */
export function parseVapidKey(raw: string | undefined | null): VapidKey | null {
  if (!raw || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const k = parsed as Record<string, unknown>
  if (k.kty !== 'EC' || k.crv !== 'P-256') return null
  const part = (v: unknown) => (typeof v === 'string' ? bytesOf(v) : null)
  const [x, y, d] = [part(k.x), part(k.y), part(k.d)]
  if (x?.length !== 32 || y?.length !== 32 || d?.length !== 32) return null
  return {
    jwk: { kty: 'EC', crv: 'P-256', x: k.x as string, y: k.y as string, d: k.d as string },
    publicKey: b64url(concat(new Uint8Array([4]), x, y)),
  }
}

/** A fresh VAPID key as the secret holds it: a JWK with both halves, as JSON. scripts/vapid-key.ts is its one caller. */
export async function generateVapidKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d })
}

/** The record size written in the header. A push service is required to take 4096 octets, and nothing here is near it. */
export const RECORD_SIZE = 4096

/** The padding delimiter of the last (and only) record (RFC 8188). */
const LAST_RECORD = 2

/** HKDF over SHA-256, extract and expand in one: `length` bytes. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
      key,
      length * 8,
    ),
  )
}

/**
 * The content key and nonce for one message (RFC 8291 section 3.4, then RFC 8188 section 2.2), from the ECDH secret
 * between the inbox's one-off key and the device's.
 */
async function keysFor(
  shared: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  authSecret: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: CryptoKey; nonce: Uint8Array }> {
  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32)
  const cekBytes = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const cek = await crypto.subtle.importKey('raw', buf(cekBytes), 'AES-GCM', false, ['encrypt'])
  return { cek, nonce }
}

export interface EncryptInput {
  plaintext: Uint8Array
  /** The device's `p256dh`: its public key, 65 bytes uncompressed. */
  uaPublic: Uint8Array
  /** The device's `auth`: 16 bytes. */
  authSecret: Uint8Array
  /** Injected only by the test that reproduces the RFC's example; otherwise fresh for every message. */
  ephemeral?: CryptoKeyPair
  salt?: Uint8Array
}

/** The body of a push request: the aes128gcm header (salt, record size, the sender's public key) and one record. */
export async function encryptPayload(input: EncryptInput): Promise<Uint8Array> {
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const pair =
    input.ephemeral ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const device = await crypto.subtle.importKey(
    'raw',
    buf(input.uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: device } as EcdhKeyDeriveParams, pair.privateKey, 256),
  )
  const { cek, nonce } = await keysFor(shared, input.uaPublic, asPublic, input.authSecret, salt)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(nonce) },
      cek,
      buf(concat(input.plaintext, new Uint8Array([LAST_RECORD]))),
    ),
  )
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed)
}

/** How long a VAPID token is good for. RFC 8292 allows a day; half of one is the option's. */
export const VAPID_LIFETIME_S = 12 * 60 * 60

/**
 * Who the push service may contact about the inbox's requests: the install's space address (where the notifications open, `InboxOwner.spaceOrigin`), never the owner's email. RFC 8292 makes it a contact and not
 * part of the key, so devices that were turned on under the inbox's old address keep working.
 */

/**
 * The Authorization header for one request to `endpoint` (RFC 8292): a JWT signed with the inbox's key, whose audience
 * is the push service's origin, and the public key that verifies it.
 */
export async function vapidAuthorization(
  key: VapidKey,
  endpoint: string,
  nowMs: number,
  subject: string,
): Promise<string> {
  const signing = await importJWK({ ...key.jwk }, 'ES256')
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(Math.floor(nowMs / 1000) + VAPID_LIFETIME_S)
    .setSubject(subject)
    .sign(signing)
  return `vapid t=${token}, k=${key.publicKey}`
}
