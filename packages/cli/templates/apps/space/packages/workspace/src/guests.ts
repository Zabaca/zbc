// The paths of the space's host that need NO sign-in (the space's ADR 0018).
//
// Three prefixes, one per kind of outsider, and nothing else of the host is public. They are the layer's, not the declaration's: an install that has guests has these, and the Access
// bypass applications (the install's own guest declarations), the Worker's router (packages/space/src/guests.ts) and the build that puts each bundle where its
// prefix serves it all read THIS list, so the edge, the Worker and the files cannot disagree about which paths are open.
//
//   /r/  a call: its page `/r/<name>`, its API `/r/api/...` (the SFU and the relay), Telnyx's webhook `/r/api/phone/webhook`, and the call page's own files `/r/_/...`
//   /w/  channel guests: the page `/w/`, the API `/w/api/...` (the emailed-code sign-in, their channels, their live socket `/w/api/socket`)
//   /s/  a signer: the page `/s/<token>`, forms' public API `/s/api/...` (the signer's calls and a client's logo) and the page's own files `/s/_/...`
//
// Each path under a prefix is answered by its own part, which authenticates the request itself with the credential that path takes (a call's name, meet's session cookie or a socket
// ticket, a signer's token) and with nothing else; the team's sign-in (the Access assertion) is never read on one.

export const GUEST_PREFIXES = ['/r', '/w', '/s'] as const
export type GuestPrefix = (typeof GUEST_PREFIXES)[number]

/** The folder under a prefix that holds that prefix's page bundle: `/r/_/assets/...`. No call, token or API segment can be this name. */
export const GUEST_BUNDLE_DIR = '_'

/** The folder under a prefix where its API is: `/r/api/...`. */
export const GUEST_API_DIR = 'api'

/**
 * The Access application's `domain` for a prefix: the host and the prefix's own subtree, `space.northfield.example/r/*`. The wildcard form is deliberate: it can match nothing
 * but `/r/...`, never the team's own `/recover` or `/sw.js` the way a bare `/r` or `/s` could if Access matched by raw prefix.
 */
export const guestAccessDomain = (host: string, prefix: GuestPrefix): string => `${host}${prefix}/*`

/** Which prefix a path is under, or null. `/w` alone counts (the Worker sends it on to `/w/`); `/wx` and `/work` do not. */
export function guestPrefixOf(pathname: string): GuestPrefix | null {
  for (const prefix of GUEST_PREFIXES) if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix
  return null
}
