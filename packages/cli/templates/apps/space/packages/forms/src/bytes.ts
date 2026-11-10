// Bytes to text and back, and SHA-256: the helpers the rest of the app shared in four copies. Web Crypto and atob only, so
// it runs in the Worker, in bun and in the scripts alike.

/** Lowercase hex of a buffer or a view. */
export function hex(b: ArrayBuffer | Uint8Array): string {
  const view = b instanceof Uint8Array ? b : new Uint8Array(b)
  let out = ''
  for (const x of view) out += x.toString(16).padStart(2, '0')
  return out
}

/** SHA-256, lowercase hex: the fingerprint recorded at every step. A string is hashed as its UTF-8 bytes. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
}

/** Base64, standard or URL alphabet, padded or not, to bytes. Throws on anything else. */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(std + (std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4))))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Base64 in the URL alphabet, with no padding. */
export function toBase64Url(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
