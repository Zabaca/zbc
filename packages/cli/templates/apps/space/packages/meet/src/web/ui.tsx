// Small shared pieces: the wordmark, icons, and the copy-link button.

import { useState, type ReactNode } from 'react'

export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="meet">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <rect x="2.5" y="6" width="13" height="12" rx="3" fill="currentColor" />
        <path d="M16.5 10.2 21.5 7v10l-5-3.2z" fill="currentColor" opacity="0.75" />
      </svg>
      <span>meet</span>
    </a>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export type IconName =
  | 'mic'
  | 'micOff'
  | 'cam'
  | 'camOff'
  | 'noise'
  | 'blur'
  | 'screen'
  | 'link'
  | 'leave'
  | 'check'
  | 'settings'
  | 'chat'
  | 'close'
  | 'plus'
  | 'back'
  | 'hash'
  | 'lock'
  | 'users'
  | 'send'
  | 'phone'
  | 'backspace'
  | 'keypad'

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    mic: (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" {...stroke} />
      </>
    ),
    micOff: (
      <>
        <path
          d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11c0 1-.2 1.9-.6 2.7M12 17.5V21M3 3l18 18"
          {...stroke}
        />
      </>
    ),
    cam: (
      <>
        <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" {...stroke} />
        <path d="m15.5 10.5 5-3v9l-5-3" {...stroke} />
      </>
    ),
    camOff: (
      <>
        <path
          d="M9.5 6.5H13a2.5 2.5 0 0 1 2.5 2.5v3.5M15.5 15.5v0A2.5 2.5 0 0 1 13 17.5H5.5A2.5 2.5 0 0 1 3 15V9a2.5 2.5 0 0 1 1.2-2.1M15.5 10.5l5-3v9l-3.2-1.9M3 3l18 18"
          {...stroke}
        />
      </>
    ),
    noise: <path d="M3 12h2M7 8v8M11 4v16M15 8v8M19 10v4M21 12h0" {...stroke} />,
    blur: (
      <>
        <circle cx="12" cy="9" r="3.2" {...stroke} />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" {...stroke} />
        <path d="M3 4.5h2M19 4.5h2M3 8h1.5M19.5 8H21" {...stroke} opacity="0.55" />
      </>
    ),
    screen: (
      <>
        <rect x="3" y="4.5" width="18" height="12" rx="2" {...stroke} />
        <path d="M8 20h8M12 16.5V20M12 13V8.5M9.5 10.5 12 8l2.5 2.5" {...stroke} />
      </>
    ),
    link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" {...stroke} />,
    leave: <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h10" {...stroke} />,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" {...stroke} />,
    chat: <path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H10l-4.5 3.5V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z" {...stroke} />,
    close: <path d="M6 6l12 12M18 6 6 18" {...stroke} />,
    plus: <path d="M12 5v14M5 12h14" {...stroke} />,
    back: <path d="m15 5-7 7 7 7" {...stroke} />,
    hash: <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" {...stroke} />,
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" {...stroke} />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" {...stroke} />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8.5" r="3" {...stroke} />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.8a3 3 0 0 1 0 5.4M18 14.2a5.5 5.5 0 0 1 2.5 4.8" {...stroke} />
      </>
    ),
    send: <path d="M4 12 20 4l-6 16-2.5-6.5z" {...stroke} />,
    phone: <path d="M6.6 3.5h2.7l1.4 4-1.9 1.3a11 11 0 0 0 5.4 5.4l1.3-1.9 4 1.4v2.7A2.5 2.5 0 0 1 17 18.9 14.4 14.4 0 0 1 5.1 7 2.5 2.5 0 0 1 6.6 3.5Z" {...stroke} />,
    backspace: <path d="M9 5h10a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 19 19H9l-5.5-7zM12.5 9.5l5 5M17.5 9.5l-5 5" {...stroke} />,
    keypad: <path d="M6 5.5h.01M12 5.5h.01M18 5.5h.01M6 11h.01M12 11h.01M18 11h.01M6 16.5h.01M12 16.5h.01M18 16.5h.01M12 21h.01" {...stroke} strokeWidth={3} />,
    settings: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5" {...stroke} />,
  }
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

/** Copy the link people join by. Falls back to selecting nothing and saying so when the browser refuses. */
export function CopyLink({ href, className = 'btn' }: { href: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    try {
      await navigator.clipboard.writeText(href)
      setState('copied')
    } catch {
      setState('failed')
    }
    setTimeout(() => setState('idle'), 2200)
  }
  return (
    <button type="button" className={className} onClick={() => void copy()}>
      <Icon name={state === 'copied' ? 'check' : 'link'} />
      <span>{state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy it by hand' : 'Copy link'}</span>
    </button>
  )
}

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '')
    .join('') || '?'
