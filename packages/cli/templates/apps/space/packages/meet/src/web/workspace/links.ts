// Links in a workspace message. The in-call chat's rules decide what is a link at all (call/chat.ts linkify: http or
// https, a host, no embedded sign-in, a lookalike address shown as what it really opens). On top of that a link to
// one of this site's calls reads "Join call", so a call link pasted in a conversation is one tap from the call.

import { normalizeRoomName } from '../../model'
import { type Part, linkify } from '../call/chat'

/** The call a link opens, when it is a link to a call on this site. */
export function callOf(href: string, siteOrigin: string): string | null {
  try {
    const u = new URL(href)
    if (u.origin !== siteOrigin) return null
    const m = /^\/r\/([^/]+)\/?$/.exec(u.pathname)
    return m?.[1] ? normalizeRoomName(decodeURIComponent(m[1])) : null
  } catch {
    return null
  }
}

/** A message as parts to draw: text, links, and a call link relabelled. Joining every part's `text` gives the message back. */
export function messageParts(text: string, siteOrigin: string): Part[] {
  return linkify(text).map((p) => (p.kind === 'link' && callOf(p.href, siteOrigin) ? { ...p, label: 'Join call' } : p))
}
