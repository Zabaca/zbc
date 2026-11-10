// The browser's pure side of chat: where the links are in a message, how new
// messages join the ones held, and what counts as unread. No page, so each can
// be checked with literal input (test/browser.test.ts).
//
// A message is text. It is never put into the page as HTML: the components render
// the parts below as text nodes and, for a link, an <a> whose address is one this
// file has parsed as an http or https URL.

import type { ChatMessage } from '../../model'

/**
 * A link's `text` is what was typed (the parts always add back up to the message); `label` is what the reader is
 * shown: the same, unless the host is not plain ASCII, when it is the address the link really opens.
 */
export type Part = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string; label: string }

const CANDIDATE = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"'])
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/** The end of a URL as people write it in a sentence: not the full stop after it, nor a bracket they opened before it. */
function trimEnd(candidate: string): string {
  let s = candidate
  for (;;) {
    const last = s.at(-1) as string
    if (TRAILING.has(last)) s = s.slice(0, -1)
    else if (last in CLOSERS && (s.split(last).length - 1) > (s.split(CLOSERS[last] as string).length - 1)) s = s.slice(0, -1)
    else return s
  }
}

/** A link only if it is an http(s) address with a host and no embedded sign-in (`https://bank.example@evil.test` is a known disguise). */
function asLink(text: string): string | null {
  try {
    const u = new URL(text)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password || !u.hostname) return null
    return u.href
  } catch {
    return null
  }
}

/**
 * A host written with letters outside ASCII can be a lookalike (a Cyrillic "а" in https://аpple.example): the browser
 * would open its punycode form (xn--pple-43d.example) while the message showed apple.com. Such a link shows the
 * address it really opens.
 */
function label(typed: string, href: string): string {
  const host = /^https?:\/\/([^/?#]*)/i.exec(typed)?.[1] ?? ''
  return /[^\u0000-\u007f]/.test(host) ? href : typed
}

/** Split a message into plain text and links. Joining every part's `text` gives the message back exactly. */
export function linkify(message: string): Part[] {
  const parts: Part[] = []
  let at = 0
  const push = (kind: 'text', text: string) => {
    if (text === '') return
    const last = parts.at(-1)
    if (last?.kind === 'text') last.text += text
    else parts.push({ kind, text })
  }
  for (const match of message.matchAll(CANDIDATE)) {
    const start = match.index as number
    const text = trimEnd(match[0])
    const href = asLink(text)
    if (!href) continue
    push('text', message.slice(at, start))
    parts.push({ kind: 'link', text, href, label: label(text, href) })
    at = start + text.length
  }
  push('text', message.slice(at))
  return parts
}

/** The held messages plus the new ones, each id once, oldest first. The same array comes back when nothing is new. */
export function mergeMessages(held: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const known = new Set(held.map((m) => m.id))
  const fresh = incoming.filter((m) => !known.has(m.id))
  if (fresh.length === 0) return held
  return [...held, ...fresh].sort((a, b) => a.id - b.id)
}

/**
 * Messages from other people that you have not read: newer than everything the call held when you arrived
 * (`baseline`, so catching up on history is not "unread") and newer than the last you saw with the panel open.
 */
export function unreadCount(messages: ChatMessage[], mine: ReadonlySet<string>, baseline: number, readUpTo: number): number {
  const after = Math.max(baseline, readUpTo)
  return messages.filter((m) => m.id > after && !mine.has(m.memberId)).length
}

/**
 * The member ids this person has had in this call. A person dropped for 30 s silence and let back in with the same
 * token gets a NEW member id (the old one was deleted), so their earlier messages carry an id the call no longer
 * knows. The tab keeps every id it has had, in session storage next to the token, so those messages stay "yours"
 * (your colour, never unread) after the drop and after a refresh.
 */
export function rememberMine(room: string, id: string): Set<string> {
  const key = `meet.ids.${room}`
  let held: string[] = []
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '[]')
    held = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    // Storage blocked: only the ids this page load has had.
  }
  const mine = new Set([...held, id])
  try {
    sessionStorage.setItem(key, JSON.stringify([...mine].slice(-20)))
  } catch {}
  return mine
}

/** Hours and minutes, in the viewer's own clock and format. */
export const formatTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** A day and a time, for the start page's list. */
export const formatWhen = (at: number): string =>
  new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
