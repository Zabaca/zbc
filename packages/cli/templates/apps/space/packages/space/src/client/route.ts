// Which tab a path is on, and which conversation. The Worker redirects "/" to the home tab, so the page sees "/" only if that was bypassed; it
// answers the home tab then too rather than a blank page. A path under a tab ("/inbox/ana@x.example") is on that tab.
import type { TabId } from '@space/workspace'
import type { MouseEvent } from 'react'
import type { Scope } from '../conversations'
import type { TabView } from '../me'
import type { GlyphName } from './icons'

export function tabAt(pathname: string, tabs: readonly TabView[], home: TabId): TabId | null {
  if (pathname === '/' || pathname === '') return home
  const hit = tabs.find((t) => pathname === t.path || pathname.startsWith(`${t.path}/`))
  return hit ? hit.id : null
}

/** A click inside the space moves without reloading, unless it means "open it somewhere else" (a modified click, a middle button). */
export function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: (path: string) => void): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

// ── The Inbox and Meet: a conversation is the tab's path and its key (the Worker's `scope`: `mail` is the Inbox, `chat` is Meet) ────────────────────────────────────────────────────────────────

export const INBOX = '/inbox'
export const MEET = '/meet'

/** The path of a scope's tab. */
export const tabPathOf = (scope: Scope): string => (scope === 'mail' ? INBOX : MEET)

/** The name a scope's tab goes by. */
export const tabNameOf = (scope: Scope): string => (scope === 'mail' ? 'Inbox' : 'Meet')

/** Where a row's conversation lives in a tab: its key (an address, or one of the list's synthetic keys) as one path segment. */
export const conversationPath = (scope: Scope, key: string): string => `${tabPathOf(scope)}/${encodeURIComponent(key)}`

/** A person's email conversation, in the Inbox. */
export const inboxPath = (key: string): string => conversationPath('mail', key)

/** A channel, a direct message, a call or the Phone, in Meet. */
export const meetPath = (key: string): string => conversationPath('chat', key)

/** The Phone conversation's address. */
export const PHONE_PATH = `${MEET}/phone`

/** A call's own screen (its saved chat), in Meet. */
export const callPath = (name: string): string => meetPath(`call:${name}`)

/** The key a path names in a tab, or null when it names none (the list itself, another tab, a segment that is not text). */
export function conversationKey(pathname: string, scope: Scope): string | null {
  const base = tabPathOf(scope)
  if (!pathname.startsWith(`${base}/`)) return null
  const segment = pathname.slice(base.length + 1).replace(/\/+$/, '')
  if (segment === '' || segment.includes('/')) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** The segment before a draft's id: `/inbox/draft/<id>`, the address of a draft that sits on no conversation (an outside tool's links and the drafting skill's). */
const DRAFT = 'draft'

/** Where a draft lives: its id as one path segment after `/inbox/draft/`. A draft that has a conversation opens that conversation from here. */
export const draftPath = (id: string): string => `${INBOX}/${DRAFT}/${encodeURIComponent(id)}`

/** The id a path names as a draft, or null when it names none (a conversation's key is one segment; this is two). */
export function draftIdAt(pathname: string): string | null {
  const prefix = `${INBOX}/${DRAFT}/`
  if (!pathname.startsWith(prefix)) return null
  const segment = pathname.slice(prefix.length).replace(/\/+$/, '')
  if (segment === '' || segment.includes('/')) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** The Drafts view of the Inbox's list, where a draft's page goes back to. */
export const draftListPath = (): string => `${INBOX}?view=drafts`

// ── People: a person's page is the tab's path and their key ──────────────────────────────────────────────────────────────────────────

const PEOPLE = '/people'

/** Where a person's page lives: their key (People's, `PeopleEntry.key`) as one path segment. */
export const peoplePath = (key: string): string => `${PEOPLE}/${encodeURIComponent(key)}`

/** The key a path names, or null when it names none (the directory itself, another tab, a segment that is not text). */
export function personKey(pathname: string): string | null {
  if (!pathname.startsWith(`${PEOPLE}/`)) return null
  const segment = pathname.slice(PEOPLE.length + 1).replace(/\/+$/, '')
  if (segment === '' || segment.includes('/')) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// ── The Calendar tab: an event's card is the tab's path and its key ──────────────────────────────────────────────────────────────

export const CALENDAR = '/calendar'
const EVENT = 'event'

/** Where an event's card lives: its key (the calendar app's, `CalendarEvent.id`) as one path segment after `/calendar/event/`. */
export const eventPath = (id: string): string => `${CALENDAR}/${EVENT}/${encodeURIComponent(id)}`

/** The key a path names as an event's card, or null when it names none (the agenda itself, another tab, a segment that is not text). */
export function eventKeyAt(pathname: string): string | null {
  const prefix = `${CALENDAR}/${EVENT}/`
  if (!pathname.startsWith(prefix)) return null
  const segment = pathname.slice(prefix.length).replace(/\/+$/, '')
  if (segment === '' || segment.includes('/')) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// ── Settings: the menu of what the inbox had that the Inbox tab does not ───────────────────────────────────────────────

/** The Settings menu, in the order it is drawn. Notifications come first: they are what moves from the inbox's app to the space's. */
export const SECTIONS = [
  { id: 'notifications', label: 'Notifications', glyph: 'chat' },
  { id: 'claude', label: 'Claude’s sending', glyph: 'note' },
  { id: 'mailboxes', label: 'Mailboxes and spam check', glyph: 'mail' },
  { id: 'calendars', label: 'Calendars', glyph: 'calendar' },
  { id: 'clients', label: 'Clients', glyph: 'person' },
  { id: 'chat', label: 'Chat', glyph: 'chat' },
  { id: 'calls', label: 'Calls', glyph: 'video' },
  { id: 'phone', label: 'Phone', glyph: 'phone' },
  { id: 'restore', label: 'Restore', glyph: 'lock' },
] as const satisfies readonly { id: string; label: string; glyph: GlyphName }[]

export type SectionId = (typeof SECTIONS)[number]['id']

/**
 * Whether the install has the part a Settings section is about (a switch is on, or a tab is there): Claude's sending needs Claude's script, Calendars a Google account, Calls and Phone their own switches, and Mailboxes and Restore
 * (the inbox's store) the Inbox tab. Notifications, Clients and Chat are every install's.
 */
export function sectionHeld(id: SectionId, switches: Record<string, boolean>, tabs: readonly { id: string }[]): boolean {
  const inbox = tabs.some((t) => t.id === 'inbox')
  switch (id) {
    case 'claude':
      return switches.claudeScript === true
    case 'mailboxes':
    case 'restore':
      return inbox
    case 'calendars':
      return switches.gmail === true
    case 'calls':
      return switches.calls === true
    case 'phone':
      return switches.phone === true
    default:
      return true
  }
}

export const SETTINGS = '/settings'

/** Whether a path is on the Settings screen, which is not one of the four tabs (the menu is reached from the gear under them). */
export const onSettings = (pathname: string): boolean => pathname === SETTINGS || pathname.startsWith(`${SETTINGS}/`)

export const settingsPath = (section: SectionId): string => `${SETTINGS}/${section}`

/** The section a path is on: `/settings` is the first, a path under a section is that section, anything else is none. */
export function settingsSection(pathname: string): SectionId | null {
  if (pathname === SETTINGS || pathname === `${SETTINGS}/`) return SECTIONS[0].id
  const id = pathname.slice(SETTINGS.length + 1).split('/')[0]
  return SECTIONS.find((s) => s.id === id)?.id ?? null
}

/** The one thing under a section a path names (`/settings/clients/7`), decoded, or null. */
export function settingsItem(pathname: string, section: SectionId): string | null {
  const prefix = `${settingsPath(section)}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
  if (rest === '' || rest.includes('/')) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

export const settingsItemPath = (section: SectionId, item: string | number): string => `${settingsPath(section)}/${encodeURIComponent(String(item))}`

// ── The Knowledge tab: the business chosen is in the address ─────────────────────────────────────────────────────────────────────

const BUSINESS_ID = /^[a-z0-9][a-z0-9-]{0,60}$/

/** The business a Knowledge address chose (`?business=northfield-works`), or null for All, and for anything that is not a business id. */
export function knowledgeBusiness(search: string): string | null {
  const id = new URLSearchParams(search).get('business')
  return id !== null && BUSINESS_ID.test(id) ? id : null
}

/** The address of the Knowledge tab, with a business chosen or (null) all. */
export const knowledgePath = (tabPath: string, business: string | null): string => (business === null ? tabPath : `${tabPath}?business=${encodeURIComponent(business)}`)
