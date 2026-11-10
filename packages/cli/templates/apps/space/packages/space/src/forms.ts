// The Forms tab's calls, answered by forms' own app inside this Worker (parts.ts): it is
// not another Worker and not a binding.
//
// The tab's screens are the space's own page (src/client/forms, ADR 0007). What they ask forms for goes through here, under two prefixes:
//
//   /forms/api/*    forms' operator API   (forms' /admin/api/*)
//   /forms/logo/*   a client's logo       (forms' public /s/api/logo/*, so the screens' images stay on this address)
//
// Nothing else of forms' is reachable through THIS door: not the signer's pages and API, which are the guest door's (/s/, src/guests.ts: no sign-in, forms' app handed the request
// without the assertion and with no operator), and not forms' files. A path under /forms that is neither is the space's own page.
//
// The sign-in is the Forms application's, a day long (it is its own Access application on the /forms path, so the assertion
// on these requests is for ITS audience, app.ts), checked ONCE, by app.ts. Forms is handed the operator that check named and verifies nothing; neither the
// assertion nor the cookie goes along (forms never reads either here). The URL keeps the space's address, so forms' own cross-site check, which compares a
// browser's Origin with the address it was asked at, sees the same address the browser did.

import { SIGNER_API } from '@space/forms/src/paths'

/**
 * The forms path a path of the Forms tab stands for, or null when the space answers it itself. Only the two prefixes above, followed
 * by something: `/forms/api` alone and `/forms/apix` are the space's page.
 */
export function formsPathFor(pathname: string): string | null {
  if (pathname.startsWith('/forms/api/')) return `/admin/api/${pathname.slice('/forms/api/'.length)}`
  if (pathname.startsWith('/forms/logo/')) return `${SIGNER_API}/logo/${pathname.slice('/forms/logo/'.length)}`
  return null
}

/** What forms' app is handed: the request as it came, at forms' path, without the cookie and without the assertion. */
export function forwardRequest(req: Request, formsPath: string): Request {
  const url = new URL(req.url)
  url.pathname = formsPath
  const headers = new Headers(req.headers)
  headers.delete('cookie')
  headers.delete('cf-access-jwt-assertion')
  return new Request(url, { method: req.method, headers, body: req.body, redirect: 'manual', ...(req.body ? { duplex: 'half' } : {}) } as RequestInit)
}

/**
 * Forms' answer, as the space hands it on. A logo is forms' public image ("public, max-age"); here it is behind a sign-in, so it is
 * cached by the browser alone. Every other answer is forms' own, untouched.
 */
export function formsAnswer(res: Response, formsPath: string): Response {
  if (formsPath.startsWith(`${SIGNER_API}/logo/`) && res.headers.has('cache-control')) {
    const logo = new Response(res.body, res)
    logo.headers.set('cache-control', res.headers.get('cache-control')!.replace(/\bpublic\b/, 'private'))
    return logo
  }
  return res
}

/** Forms' database or bucket is not bound to this Worker (a local `vite dev`): say so, rather than serve the page. */
export const formsUnavailable = () => Response.json({ error: 'Forms is not connected to the space' }, { status: 503, headers: { 'cache-control': 'no-store' } })
