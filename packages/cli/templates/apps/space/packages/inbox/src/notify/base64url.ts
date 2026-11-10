import { base64Bytes } from '../gmail/parse'

/**
 * Keys and salts as notifications write them: unpadded base64url. The Worker's side (webpush.ts, device.ts) and the
 * page's (client/notify.ts) both read and write keys this way, so both use these two. Decoding is Gmail's decoder.
 */

/** Bytes as unpadded base64url. */
export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i] as number)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url as bytes, or null when it is not base64url at all. */
export function bytesOf(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    return base64Bytes(text)
  } catch {
    return null
  }
}
