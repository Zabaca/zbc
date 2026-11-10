// Small things the routers share (app.ts for calls, workspace-routes.ts for the guests' workspace): who is on localhost,
// the cross-site refusal, and the hashes.

import type { Context } from 'hono'

export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export const isLocal = (c: Context): boolean => LOCAL_HOSTS.has(new URL(c.req.url).hostname)

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A random URL-safe token: what a cookie or a socket ticket carries. The workspace keeps only its hash. */
export function newToken(random: (n: number) => Uint8Array, bytes = 32): string {
  return btoa(String.fromCharCode(...random(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,64}$/

/** The browser sends the Access or session cookie along on a request from any page, so a write from another site is refused. */
export const crossSite = (c: Context): boolean => {
  const origin = c.req.header('origin')
  return c.req.header('sec-fetch-site') === 'cross-site' || Boolean(origin && origin !== new URL(c.req.url).origin)
}
