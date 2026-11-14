// What the space's service worker does with a notification, as pure functions: reading the payload, what is shown, whether to stay quiet, and where a tap
// goes. sw.ts is the glue to the browser's events. The payload is the inbox's (packages/inbox/src/notify/rule.ts; its shape for a SPACE device is
// `SpacePushPayload` in packages/workspace/src/inbox-views.ts), encrypted to this device, so it is shown with nothing fetched, and so with the sign-in lapsed too.
//
// THE POINT OF THE SPACE'S WORKER, rather than the inbox's: a tap opens THE PERSON'S CONVERSATION IN THE SPACE. The space's conversations are one per person,
// so the inbox sends a space device the sender's address (`person`) and the tap opens `/inbox/<address>`; a summary and the test carry none, and
// open the Inbox list. The inbox's own devices are sent what they always were and open the inbox.
//
// THIS FILE IMPORTS NOTHING BUT TYPES: sw.js is built as one file that imports nothing (vite.config.ts), so the few facts the page also knows are written here
// again and held to the page's by test/notify.test.ts: the messages between the worker and a window (notify.ts `WINDOW_MESSAGES`) and the path a conversation
// is opened at (route.ts `inboxPath`).

import type { SpacePushPayload } from '@space/workspace'

/** The payload version this worker reads (the inbox's PAYLOAD_VERSION). */
export const READS_VERSION = 1

/** What the page and the worker say to each other (notify.ts holds the page's copy). */
export const MESSAGES = {
  /** The worker asks a window which conversation it has open; the window answers on the port it was given, with the addresses of the person it shows. */
  ask: 'space:which-conversation',
  /** The worker tells a window to open a path (a tap, with the space already open). */
  open: 'space:open',
  /** The worker tells a window to read its lists again (a notification kept quiet because that window shows it). */
  refresh: 'space:refresh',
} as const

/** How long the worker waits for windows to say what they have open. */
export const ASK_WAIT_MS = 400

export const ICON = '/icons/icon-192.png'
export const BADGE = '/icons/badge-96.png'

/** The Inbox list: where a summary, the test and a payload that names no one open. */
export const LIST_PATH = '/inbox'

/** The path a person's email conversation lives at (route.ts `inboxPath`, held to it by a test). */
export const conversationPathOf = (address: string): string => `${LIST_PATH}/${encodeURIComponent(address)}`

/** The payload a push carried, or null when it cannot be read as one this worker knows. */
export function readPayload(text: string | null | undefined): SpacePushPayload | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.v !== READS_VERSION || (p.kind !== 'message' && p.kind !== 'summary' && p.kind !== 'test')) return null
  if (typeof p.title !== 'string' || typeof p.body !== 'string' || typeof p.messageId !== 'string') return null
  if (p.conversationId !== null && typeof p.conversationId !== 'string') return null
  const person = typeof p.person === 'string' && p.person.trim() !== '' && p.person.length <= 320 ? p.person.trim().toLowerCase() : undefined
  return {
    v: READS_VERSION,
    kind: p.kind,
    conversationId: p.conversationId,
    ...(person !== undefined && { person }),
    messageId: p.messageId,
    title: p.title,
    body: p.body,
    at: typeof p.at === 'string' ? p.at : '',
  }
}

export interface Shown {
  title: string
  options: {
    body: string
    icon: string
    badge: string
    tag?: string
    timestamp?: number
    data: { person: string | null }
  }
}

/** The notification for a payload, or the plain "New mail" for one that could not be read (Chrome expects a notification for every push). */
export function notificationFor(payload: SpacePushPayload | null): Shown {
  if (payload === null) return { title: 'New mail', options: { body: '', icon: ICON, badge: BADGE, data: { person: null } } }
  const at = Date.parse(payload.at)
  return {
    title: payload.title,
    options: {
      body: payload.body,
      icon: ICON,
      badge: BADGE,
      tag: payload.messageId,
      ...(Number.isNaN(at) ? {} : { timestamp: at }),
      data: { person: payload.kind === 'message' ? (payload.person ?? null) : null },
    },
  }
}

/**
 * Whether to show nothing: a visible window of the space has THIS PERSON'S conversation open. Quiet for that person only, so a message from anyone else is news
 * even while the owner is in the space. A notification that names no one (a summary, the test) is always shown. `openInVisibleWindows` is, for each visible window,
 * the addresses of the person it shows (every address the conversation holds, so a person who wrote from another of theirs is still recognised).
 */
export function stayQuiet(person: string | null, openInVisibleWindows: readonly (readonly string[])[]): boolean {
  return person !== null && openInVisibleWindows.some((addresses) => addresses.includes(person))
}

/**
 * Whether this browser takes away a site's permission when a push shows nothing, so the worker must show every one: Apple's (Safari on an iPhone, an iPad or a Mac, and
 * the app added to the Home Screen) does, and says so. Chrome lets a push stay unshown while a window of the site is visible. A Mac's Chrome, Edge, Opera and Firefox say
 * so in their User-Agent; an iPhone's or iPad's browser is WebKit whatever it is called, and an iPad's app says Macintosh with a `Mobile/` mark.
 */
export const showsEveryPush = (userAgent: string): boolean => /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && !/Chrome\/|Chromium\/|Firefox\/|Edg\/|OPR\//.test(userAgent))

/** The path a tap opens: the person's conversation, or the Inbox list. */
export const tapPath = (person: string | null): string => (person === null ? LIST_PATH : conversationPathOf(person))

/** Whether a window is a page of the space itself, and not an API answer (a finished PDF opened in its own tab is one) or one of Access's pages on the same origin. */
export function isAppWindow(url: string, origin: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === origin && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/cdn-cgi/') && !u.pathname.startsWith('/forms/api/') && !u.pathname.startsWith('/forms/logo/')
  } catch {
    return false
  }
}

/**
 * Where a tap goes: a window of the space (the focused one first) is brought forward and told to open the path, with no reload. With none, a new window
 * opens at the path itself, which survives Access's sign-in if it has lapsed (the path is the address).
 */
export function tapTarget(
  person: string | null,
  windows: readonly { url: string; focused: boolean }[],
  origin: string,
): { kind: 'focus'; index: number; path: string } | { kind: 'open'; url: string } {
  const path = tapPath(person)
  const apps = windows.map((w, index) => ({ ...w, index })).filter((w) => isAppWindow(w.url, origin))
  const target = apps.find((w) => w.focused) ?? apps[0]
  return target ? { kind: 'focus', index: target.index, path } : { kind: 'open', url: path }
}
