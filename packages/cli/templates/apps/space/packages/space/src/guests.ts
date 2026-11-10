// The guests' and signers' door: three prefixes of the space's host that need NO sign-in (the space's ADR 0018).
//
//   /r/  a call:           the page /r/<name>, its API /r/api/... (meet's call routes and Telnyx's webhook), the page's files /r/_/...
//   /w/  channel guests:   the page /w/, their API /w/api/... (the emailed-code sign-in, their channels, their live socket), served by the same bundle as /r/
//   /s/  a signer:         the page /s/<token>, forms' public API /s/api/... (the signer's calls and a client's logo), the page's files /s/_/...
//
// The list of prefixes is the layer's (`GUEST_PREFIXES`, packages/workspace/src/guests.ts), the same one the Access bypass applications (the install kit) and the build read, so the edge, this router and the files
// cannot disagree about which paths are open.
//
// ANSWERED FIRST, BEFORE THE PERSON CHECK, AND NEVER BY IT. app.ts calls this ahead of Claude's door and of `whoIsAsking`; a path that is not under a prefix gets `null` and goes on as ever, and a path that is
// gets an answer from here and nothing else. So nothing on a guest path is checked against the team's sign-in, and no team path is reachable by a guest credential: every API under a prefix is handed the request
// WITHOUT the Access assertion, the Access cookies or the service token's headers (`asGuest`), so a part could not mistake a signed-in browser for the credential it takes (a call's name and member token, meet's
// session cookie or a socket ticket, a signer's private link). The parts authenticate and refuse in their own words; this file decides only which part a path is.
//
// WHAT A GUEST PAGE CANNOT REACH. A guest page is served on the team's origin, so a signed-in person's browser would send the team's cookie to anything the page asked of the host. The content policy
// (`policyFor`) is what keeps a page to its own paths: no inline script, no script from anywhere but its bundle's folder (`/r/_/`, `/s/_/`), and every place the page may connect, load an image or a font from, or open
// a worker from is a PATH of this host (the bundle's folder and the guest API), never the host as a whole; no frames, no forms, no `<base>`, no plugins. The page draws no HTML an outsider supplied (React text only,
// pinned by a test over the bundles' sources), so there is no way to put a script in it either. The pages' files are their own bundles, served from the folders above and from nowhere else, so the team page's files
// (`/assets/...`) still need the sign-in.
//
// The bundles are built by the space's build (vite.guest-meet.config.ts, vite.guest-forms.config.ts) into dist/client/r/_/ and dist/client/s/_/, each page marked with `<meta name="guest-bundle">` so that a missing
// bundle (the asset router's fallback is the TEAM page) is a 503 and never the team's page under a guest's headers.
//
// Nothing here imports the Workers runtime, so `bun test` drives it.

import { GUEST_API_DIR, GUEST_BUNDLE_DIR, type GuestPrefix, type Install, type WaitUntil, guestPrefixOf } from '@space/workspace'

/** The two bundles: meet's page (calls at /r/, channel guests at /w/) and forms' signer page (/s/). */
export type GuestBundle = 'meet' | 'forms'

export interface GuestParts {
  /** Meet's guest side: the call API and Telnyx's webhook (`/r/api/...`) and the channel guests' API with its live socket (`/w/api/...`). Absent where meet's stores are not bound. */
  meet?: ((req: Request) => Promise<Response>) | undefined
  /** Forms' public API (`/s/api/...`): the signer's calls and a client's logo. Absent where forms' database and bucket are not bound. */
  signer?: ((req: Request, wait?: WaitUntil) => Promise<Response>) | undefined
}

export interface GuestEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export type GuestPartsFor = (env: never) => GuestParts

/** The folder a bundle's files are served from, under the prefix that owns it: `/r/_/` for meet's (the workspace page at `/w/` loads from it too) and `/s/_/` for forms'. */
export const BUNDLE_FOLDER: Record<GuestBundle, string> = { meet: `/r/${GUEST_BUNDLE_DIR}/`, forms: `/s/${GUEST_BUNDLE_DIR}/` }

/** The tag every guest page carries and the door looks for, so the team's page can never be served in its place. */
export const bundleMark = (bundle: GuestBundle): string => `<meta name="guest-bundle" content="${bundle}">`

/** A call's name in a path: the page for anything that is one path segment after /r/, which the page itself judges (a name that is not one shows its home). */
const ONE_SEGMENT = /^\/[^/]+\/?$/
/** A signer's private link: 43 characters of URL-safe base64, the length of a 256-bit token. */
const SIGNER_TOKEN = /^\/[A-Za-z0-9_-]{43}\/?$/

const notFound = () => Response.json({ error: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } })
const notAllowed = () => Response.json({ error: 'Method not allowed' }, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } })
const unavailable = () => Response.json({ error: 'This is not available right now.' }, { status: 503, headers: { 'cache-control': 'no-store' } })

/**
 * The request as a part of the guest side gets it: the same URL, method and body, and none of what the team's sign-in or Claude's door is made of. Access puts the assertion on a request it admitted, and the
 * browser sends the Access cookies to anything on the host, so both go (the cookies by name, any others kept: the guest's own session cookie is one of them).
 */
export function asGuest(req: Request): Request {
  const headers = new Headers(req.headers)
  for (const name of ['cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret', 'authorization']) headers.delete(name)
  const cookie = headers.get('cookie')
  if (cookie !== null) {
    const kept = cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c !== '' && !/^CF_(Authorization|AppSession|Binding)\b/i.test(c))
    if (kept.length > 0) headers.set('cookie', kept.join('; '))
    else headers.delete('cookie')
  }
  // A request made afresh from the URL, not `new Request(req, { headers })`: with every header removed an empty `headers` can be read as "no override", and the original would come back whole.
  return new Request(req.url, { method: req.method, headers, body: req.body, redirect: 'manual', ...(req.body ? { duplex: 'half' } : {}) } as RequestInit)
}

/**
 * The content policy of a bundle's pages and scripts, for the host they are served from. Every source is a path of this host, never the host: a page may load its own folder and call its own API and nothing
 * else of the origin (CSP matches a source that ends in a slash against every path under it), and it may open a socket to its own API alone. `'wasm-unsafe-eval'` is for the call page's noise suppression and blur (WebAssembly,
 * not script) and for pdf.js's decoders; there is no `'unsafe-eval'` and no `'unsafe-inline'` for script. Styles keep `'unsafe-inline'` because the pages set style attributes; a style cannot run code.
 */
export function policyFor(bundle: GuestBundle, origin: string): string {
  const here = new URL(origin)
  const at = (path: string) => `${here.origin}${path}`
  const socket = (path: string) => `wss://${here.host}${path}`
  const own = at(BUNDLE_FOLDER[bundle])
  const connect = bundle === 'meet' ? [own, at(`/r/${GUEST_API_DIR}/`), at(`/w/${GUEST_API_DIR}/`), socket(`/w/${GUEST_API_DIR}/`)] : [own, at(`/s/${GUEST_API_DIR}/`)]
  const images = bundle === 'meet' ? [own, 'data:', 'blob:'] : [own, at(`/s/${GUEST_API_DIR}/`), 'data:', 'blob:']
  return [
    "default-src 'none'",
    `script-src ${own} 'wasm-unsafe-eval'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${images.join(' ')}`,
    `font-src ${own} data:`,
    `connect-src ${connect.join(' ')}`,
    `worker-src ${own} blob:`,
    "media-src blob: mediastream:",
    "manifest-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** What every guest page carries: the policy, no referrer (a signing link and a call's name are in the path), no framing, no indexing, and never a cached page. */
function pageHeaders(bundle: GuestBundle, origin: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': policyFor(bundle, origin),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-robots-tag': 'noindex, nofollow',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), payment=(), usb=()',
  }
}

/** A bundle's page, from the assets: its index file, which must carry the bundle's mark. */
async function page(env: GuestEnv, req: Request, bundle: GuestBundle): Promise<Response> {
  const url = new URL(req.url)
  const res = await env.ASSETS.fetch(new Request(new URL(BUNDLE_FOLDER[bundle], url), { method: 'GET' }))
  if (!res.ok) return unavailable()
  const html = await res.text()
  if (!html.includes(bundleMark(bundle))) {
    console.error(`the ${bundle} guest bundle is not in the assets: the asset router answered with another page`)
    return unavailable()
  }
  return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: pageHeaders(bundle, url.origin) })
}

/** A file of a bundle: served as the assets hold it, with the bundle's policy on a script (a worker is governed by the policy of its own response), and never an HTML page in place of a missing file. */
async function file(env: GuestEnv, req: Request, bundle: GuestBundle): Promise<Response> {
  // The asset router decodes the path, so an encoded slash or dot (`..%2f..%2fassets/x.js`) would climb out of the guest folder to the
  // team page's files. A guest file's path is plain: refuse any escape, any dot segment and any backslash before asking for it.
  const raw = new URL(req.url).pathname
  if (/%|\\/.test(raw) || raw.split('/').some((seg) => seg === '..' || seg === '.')) return notFound()
  const res = await env.ASSETS.fetch(new Request(req.url, { method: 'GET' }))
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  // The asset router answers a missing file with the TEAM page; that is a 404 here, whatever it says.
  if (!res.ok || type.startsWith('text/html')) return notFound()
  const out = new Response(req.method === 'HEAD' ? null : res.body, res)
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.set('referrer-policy', 'no-referrer')
  out.headers.set('cross-origin-resource-policy', 'same-origin')
  if (/\b(java|ecma)script\b/.test(type)) out.headers.set('content-security-policy', policyFor(bundle, new URL(req.url).origin))
  return out
}

/**
 * The answer for a request under a guest prefix, or null for a request that is not under one (the person check then goes on as always). An unknown path under a prefix is a 404, never the team's page; a page
 * is GET and HEAD only; an API is whatever its part allows. With the install given, a call's page is answered only where its `calls` switch is on.
 */
export async function guestAnswer(req: Request, env: GuestEnv, guests: GuestParts, wait?: WaitUntil, install?: Install): Promise<Response | null> {
  const url = new URL(req.url)
  const prefix: GuestPrefix | null = guestPrefixOf(url.pathname)
  if (prefix === null) return null
  const rest = url.pathname.slice(prefix.length)
  const read = req.method === 'GET' || req.method === 'HEAD'
  const api = `/${GUEST_API_DIR}/`
  const bundleFolder = `/${GUEST_BUNDLE_DIR}/`

  if (prefix === '/w') {
    // `/w` alone is the page without its slash: the edge opens `/w/*`, so the address that is sent is `/w/`.
    if (rest === '') {
      if (!read) return notAllowed()
      url.pathname = '/w/'
      return Response.redirect(url.toString(), 308)
    }
    if (rest === '/') return read ? page(env, req, 'meet') : notAllowed()
    if (rest.startsWith(api)) return guests.meet ? guests.meet(asGuest(req)) : unavailable()
    return notFound()
  }

  if (prefix === '/r') {
    if (rest.startsWith(api)) return guests.meet ? guests.meet(asGuest(req)) : unavailable()
    if (rest.startsWith(bundleFolder)) return read ? file(env, req, 'meet') : notAllowed()
    // A call's page is a switch's: an install without calls has no call to open (its call API answers none either, packages/meet/src/space-guests.ts).
    if (ONE_SEGMENT.test(rest) && rest.split('/')[1] !== GUEST_API_DIR && rest.split('/')[1] !== GUEST_BUNDLE_DIR) return install && !install.has('calls') ? notFound() : read ? page(env, req, 'meet') : notAllowed()
    return notFound()
  }

  // /s
  if (rest.startsWith(api)) return guests.signer ? guests.signer(asGuest(req), wait) : unavailable()
  if (rest.startsWith(bundleFolder)) return read ? file(env, req, 'forms') : notAllowed()
  if (SIGNER_TOKEN.test(rest)) return read ? page(env, req, 'forms') : notAllowed()
  return notFound()
}
