/**
 * The vault: every envelope's answers, field values, tokens, files and PDFs are encrypted with a key of that
 * envelope's own, and the key is wrapped by a master key held as a Worker secret (and in sops).
 *
 * Cloudflare already encrypts D1 and R2 at rest. This layer means a stolen database or bucket copy, or a restored
 * backup, reads nothing without the Worker's secret; and deleting an envelope's wrapped key is what makes any copy
 * that survives in a backup unreadable, so deletion IS the retention mechanism (docs/adr/0004).
 *
 *  - The master key is 32 random bytes, base64. FORMS_DATA_KEY is version 1. Rotating means adding
 *    FORMS_DATA_KEY_V2 (and so on): new keys are wrapped by the highest version, old ones unwrap with the version
 *    stored beside them, and re-wrapping the old ones is a loop over `envelopes.wrapped_key`.
 *  - A data key is 32 random bytes. Text values are AES-256-GCM with a fresh IV and the value's CONTEXT (its
 *    envelope and what it is) as associated data, so a ciphertext cannot be moved to another row and still open.
 *  - R2 objects use R2's own customer-provided-key encryption (SSE-C) with the data key, so R2 does not keep it.
 *
 * Names and email addresses are NOT encrypted (lists and mail need them), and neither are logos, which are public.
 */

import { fromBase64, toBase64Url } from './bytes'

export class VaultUnconfigured extends Error {
  constructor(why: string) {
    super(`The vault is not configured: ${why}`)
  }
}

export interface VaultEnv {
  FORMS_DATA_KEY?: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const aes = (raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, 'AES-GCM', false, [usage])

async function seal(key: Uint8Array, plain: Uint8Array, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, await aes(key, 'encrypt'), plain as unknown as ArrayBuffer))
  return `${toBase64Url(iv)}.${toBase64Url(ct)}`
}

async function open(key: Uint8Array, sealed: string, context: string): Promise<Uint8Array> {
  const [iv, ct] = sealed.split('.')
  if (!iv || !ct) throw new Error('malformed ciphertext')
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv), additionalData: enc.encode(context) }, await aes(key, 'decrypt'), fromBase64(ct)))
}

/** A wrapped data key and the master version that wrapped it. */
export interface Wrapped {
  wrapped: string
  version: number
}

export interface Vault {
  /** The version new data keys are wrapped with. */
  readonly currentVersion: number
  /** A fresh random data key, and its wrapped form to store. */
  newDataKey(context: string): Promise<{ key: Uint8Array } & Wrapped>
  unwrap(wrapped: string, version: number, context: string): Promise<Uint8Array>
}

function masterKeys(env: VaultEnv): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>()
  const read = (name: string, version: number) => {
    const raw = (env as Record<string, unknown>)[name]
    if (typeof raw !== 'string' || raw.trim() === '') return
    let bytes: Uint8Array
    try {
      bytes = fromBase64(raw.trim())
    } catch {
      throw new VaultUnconfigured(`${name} is not base64`)
    }
    if (bytes.length !== 32) throw new VaultUnconfigured(`${name} must be 32 bytes, base64`)
    out.set(version, bytes)
  }
  read('FORMS_DATA_KEY', 1)
  for (let v = 2; v < 50; v++) read(`FORMS_DATA_KEY_V${v}`, v)
  return out
}

/** The vault, from the Worker's secrets. Throws when there is no master key: nothing may be stored unencrypted instead. */
export function createVault(env: VaultEnv): Vault {
  const masters = masterKeys(env)
  if (masters.size === 0) throw new VaultUnconfigured('FORMS_DATA_KEY is missing')
  const current = Math.max(...masters.keys())
  const master = (v: number) => {
    const m = masters.get(v)
    if (!m) throw new VaultUnconfigured(`no master key of version ${v}`)
    return m
  }
  return {
    currentVersion: current,
    async newDataKey(context) {
      const key = crypto.getRandomValues(new Uint8Array(32))
      return { key, wrapped: await seal(master(current), key, `datakey:${context}`), version: current }
    },
    async unwrap(wrapped, version, context) {
      return open(master(version), wrapped, `datakey:${context}`)
    },
  }
}

/** A text value encrypted for a row: `context` says whose it is and what it is. */
export async function encryptText(dataKey: Uint8Array, plain: string, context: string): Promise<string> {
  return `e1.${await seal(dataKey, enc.encode(plain), context)}`
}

export async function decryptText(dataKey: Uint8Array, sealed: string, context: string): Promise<string> {
  if (!sealed.startsWith('e1.')) throw new Error('not an encrypted value')
  return dec.decode(await open(dataKey, sealed.slice(3), context))
}

/** The slice of an R2 bucket the vault uses, so a test can stand in for it (test/local-d1.ts has one). */
export interface ObjectStore {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string }; ssecKey?: ArrayBuffer | string }): Promise<unknown>
  get(key: string, options?: { ssecKey?: ArrayBuffer | string }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(key: string | string[]): Promise<void>
}

const ssec = (k: Uint8Array): ArrayBuffer => k.slice().buffer as ArrayBuffer

/** Stores bytes under an envelope's data key (SSE-C): R2 holds ciphertext and never the key. */
export async function putSealed(store: ObjectStore, key: string, dataKey: Uint8Array, bytes: Uint8Array, contentType?: string): Promise<void> {
  await store.put(key, bytes, { ssecKey: ssec(dataKey), httpMetadata: contentType ? { contentType } : undefined })
}

/** The bytes, or null when the object is missing. A wrong key throws (R2 refuses it). */
export async function getSealed(store: ObjectStore, key: string, dataKey: Uint8Array): Promise<Uint8Array | null> {
  const o = await store.get(key, { ssecKey: ssec(dataKey) })
  return o ? new Uint8Array(await o.arrayBuffer()) : null
}
