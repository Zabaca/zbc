// The seven tabs' icons, drawn for the space.
import type { ReactNode } from 'react'
import type { TabId } from '@space/workspace'

const PATHS: Record<TabId, ReactNode> = {
  today: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 1.5" />
    </>
  ),
  // An envelope: email. Meet is a speech bubble, as the one Conversations tab was.
  inbox: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="m3 5.5 7 5.5 7-5.5" />
    </>
  ),
  meet: <path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3h0a2 2 0 0 1-2-2z" />,
  // A page of days: the calendar.
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 2.8v3M13 2.8v3" />
    </>
  ),
  forms: (
    <>
      <path d="M5.5 2.5h6l3.5 3.5v10.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" />
      <path d="M11.5 2.5V6H15M7 10.5h6M7 13.5h4" />
    </>
  ),
  people: (
    <>
      <circle cx="7.5" cy="7" r="2.6" />
      <path d="M2.5 16c.6-3 2.6-4.4 5-4.4s4.4 1.4 5 4.4" />
      <circle cx="14" cy="7.5" r="2" />
      <path d="M14.5 11.8c1.6.2 2.6 1.4 3 3.4" />
    </>
  ),
  // An open book: what the assistants may say, written down once.
  knowledge: (
    <>
      <path d="M10 5.2C8.6 4 6.4 3.4 3.5 3.5v11.2c2.9-.1 5.1.5 6.5 1.7 1.4-1.2 3.6-1.8 6.5-1.7V3.5c-2.9-.1-5.1.5-6.5 1.7z" />
      <path d="M10 5.2v11.2" />
    </>
  ),
}

export function TabIcon({ tab, size = 18 }: { tab: TabId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[tab]}
    </svg>
  )
}

// The small marks the Inbox's and Meet's lists use: how an item came, a channel, search, and the two kinds of notice.
const GLYPHS = {
  mail: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <path d="m3 5.5 7 5.5 7-5.5" />
    </>
  ),
  chat: <path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3h0a2 2 0 0 1-2-2z" />,
  hash: <path d="M7.5 3 6 17M14 3l-1.5 14M3.5 7.5h13M3 12.5h13" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 3.8 3.8" />
    </>
  ),
  phone: <path d="M5.5 3h2.2l1.2 3.3-1.6 1.1a8.5 8.5 0 0 0 4.3 4.3l1.1-1.6 3.3 1.2v2.2a1.8 1.8 0 0 1-1.9 1.8A12.5 12.5 0 0 1 3.7 4.9 1.8 1.8 0 0 1 5.5 3z" />,
  note: (
    <>
      <path d="m4 16 .8-3.2L13.5 4a1.6 1.6 0 0 1 2.3 2.3L7.2 15z" />
      <path d="M11.8 5.7l2.5 2.5" />
    </>
  ),
  x: <path d="m5 5 10 10M15 5 5 15" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  warn: (
    <>
      <path d="M10 3.2 17.5 16H2.5z" />
      <path d="M10 8v3.6M10 14v.1" />
    </>
  ),
  back: <path d="M12 4 6 10l6 6" />,
  forward: <path d="m8 4 6 6-6 6" />,
  person: (
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5c.7-3 3-4.5 6-4.5s5.3 1.5 6 4.5" />
    </>
  ),
  video: (
    <>
      <rect x="2.5" y="5.5" width="10.5" height="9" rx="2" />
      <path d="m13 9 4.5-2.5v7L13 11" />
    </>
  ),
  // A chain: a call's link. A plus: something new. A calendar: a meeting with a time.
  link: <path d="M8.2 11.8a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9M11.8 8.2a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l.9-.9" />,
  plus: <path d="M10 4v12M4 10h12" />,
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 2.8v3M13 2.8v3" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1.8" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </>
  ),
  gear: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type GlyphName = keyof typeof GLYPHS

export function Glyph({ name, size = 12 }: { name: GlyphName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  )
}
