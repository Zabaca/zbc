// The small pieces every Settings screen is made of: how a way a call ended is said, a view that is loading or could not be had, a switch, a question that
// must be answered before anything is done, and the words for a time. Pure drawing: the screens own what is asked.
import { type ReactNode, useState } from 'react'
import { Glyph } from './icons'
import type { Loaded, Said } from './views'

/** What a call that came to no value says, in the tone it deserves, with a way to try again only where trying again is honest. */
export function Say({ say, onAgain }: { say: Said; onAgain?: () => void }) {
  return (
    <p className={`cnotice ${say.tone === 'bad' ? 'error' : 'warn'}`} role={say.tone === 'bad' ? 'alert' : 'status'} data-testid="say" data-tone={say.tone}>
      <Glyph name="warn" size={13} />
      <span>
        {say.text}
        {say.again && onAgain && (
          <>
            {' '}
            <button type="button" className="linkish" onClick={onAgain}>
              Try again
            </button>
          </>
        )}
      </span>
    </p>
  )
}

/** A read on screen: loading, a sign-in that ended, why there is none, or the value drawn by `children`. A failure that came after a value is `problem`, beside it. */
export function Viewed<T>({
  view,
  problem,
  reload,
  loading = 'Loading',
  children,
}: {
  view: Loaded<T>
  problem?: Said | null
  reload?: () => void
  loading?: string
  children: (value: T) => ReactNode
}) {
  if (view.kind === 'loading') {
    return (
      <p className="empty-line sub" role="status" data-testid="loading">
        {loading}
      </p>
    )
  }
  if (view.kind === 'signin') {
    return (
      <Say say={{ tone: 'warn', text: 'Your sign-in may have ended. Reload the page to sign in again.', again: false }} />
    )
  }
  if (view.kind === 'said') return <Say say={view.say} {...(reload && { onAgain: reload })} />
  return (
    <>
      {problem && <Say say={problem} {...(reload && { onAgain: reload })} />}
      {children(view.value)}
    </>
  )
}

/** A two-state switch with its words beside it; the page owns what flipping it does. */
export function Switch({ on, label, busy, onChange, testid }: { on: boolean; label: string; busy?: boolean; onChange(next: boolean): void; testid?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} className={`s-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} data-testid={testid}>
      <span aria-hidden="true" className="s-knob" />
    </button>
  )
}

/** A question asked in the page before something that is hard to undo is done, and not in a dialog (the viewer shows none). */
export function Ask({
  question,
  yes,
  no = 'Cancel',
  danger,
  busy,
  onYes,
  onNo,
  children,
}: {
  question: string
  yes: string
  no?: string
  danger?: boolean
  busy?: boolean
  onYes(): void
  onNo(): void
  children?: ReactNode
}) {
  return (
    <div className={`s-ask${danger ? ' danger' : ''}`} role="group" aria-label={question} data-testid="ask">
      <p className="s-ask-q">{question}</p>
      {children}
      <div className="s-actions">
        <button type="button" className={`btn${danger ? ' danger' : ' primary'}`} disabled={busy} onClick={onYes} data-testid="ask-yes">
          {yes}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onNo} data-testid="ask-no">
          {no}
        </button>
      </div>
    </div>
  )
}

/** A heading for a block of a screen. */
export function Block({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section className="s-block" aria-label={title} data-testid={testid}>
      <h2 className="s-h">{title}</h2>
      {children}
    </section>
  )
}

/** A line of the result of the last thing done, shown until the next. */
export function Done({ text }: { text: string | null }) {
  return text === null ? null : (
    <p className="cnotice ok" role="status" data-testid="done">
      <Glyph name="mail" size={13} />
      <span>{text}</span>
    </p>
  )
}

/** The state of an action a screen runs: whether one is running, what it said, and what it came to. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [say, setSay] = useState<Said | null>(null)
  const [done, setDone] = useState<string | null>(null)
  return {
    busy,
    say,
    done,
    clear() {
      setSay(null)
      setDone(null)
    },
    /** Run one call. `ok` is the words for it going through; a call that did not says why, and `again` is not offered for a write. */
    async run<T>(call: () => Promise<{ ok: true; value: T } | { ok: false; say: Said }>, ok: string | ((value: T) => string), after?: (value: T) => void): Promise<boolean> {
      setBusy(true)
      setSay(null)
      setDone(null)
      try {
        const got = await call()
        if (!got.ok) {
          setSay(got.say)
          return false
        }
        setDone(typeof ok === 'string' ? ok : ok(got.value))
        after?.(got.value)
        return true
      } finally {
        setBusy(false)
      }
    },
  }
}

// ── Words for times ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Nov 2, 3:04 PM": a time with its day, in the browser's zone (the screens say when, not how long ago). */
export function when(at: number | null): string {
  if (at === null) return 'never'
  const d = new Date(at)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

/** "3 min ago", "5 h ago", "12 days ago", or "never". */
export function agoText(now: number, at: number | null): string {
  if (at === null) return 'never'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/** "an actor" as a person reads it: the owner's address (`self`, the one who is reading) as "you", the assistant, Claude, an outside app (`<app>:assistant`, named by its own word). */
export function whoText(actor: string, self: string): string {
  if (actor === self) return 'you'
  if (actor === 'assistant') return 'the assistant'
  const app = /^([a-z][a-z0-9-]*):assistant$/.exec(actor)?.[1]
  if (app) return `the ${app[0]?.toUpperCase()}${app.slice(1)} app`
  if (actor.startsWith('agent:')) return 'Claude'
  return actor
}
