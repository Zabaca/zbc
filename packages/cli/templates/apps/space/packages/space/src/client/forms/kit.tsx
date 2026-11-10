import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

/** A value loaded from the API, with its error and a way to load it again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const run = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const v = await load()
      if (mine === seq.current) (setData(v), setError(null))
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void run()
  }, [run])
  return { data, error, loading, reload: run }
}

export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export function Button({ children, kind = 'primary', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'quiet' }) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex min-h-10 items-center justify-center rounded-md px-4 text-sm font-medium disabled:opacity-50',
        kind === 'primary' ? 'bg-primary text-primary-foreground hover:bg-primary-hi' : 'border border-input bg-card hover:bg-accent',
        rest.className,
      )}
    >
      {children}
    </button>
  )
}

export function LinkButton({ href, children, kind = 'quiet' }: { href: string; children: ReactNode; kind?: 'primary' | 'quiet' }) {
  return (
    <a href={href} className={cn('inline-flex min-h-10 items-center justify-center rounded-md px-4 text-sm font-medium', kind === 'primary' ? 'bg-primary text-primary-foreground hover:bg-primary-hi' : 'border border-input bg-card hover:bg-accent')}>
      {children}
    </a>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export const INPUT = 'min-h-10 w-full rounded-md border border-input bg-card px-3 text-sm'

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const style = { error: 'border-destructive/40 bg-neg-bg', ok: 'border-pos/40 bg-pos-bg', warn: 'border-warn/40 bg-warn-bg', info: 'border-border bg-muted' }[kind]
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cn('rounded-md border px-3 py-2 text-sm', style)}>
      {children}
    </div>
  )
}

export function Card({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      {title ? (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  )
}

const BADGE: Record<string, string> = {
  draft: 'border-border bg-muted',
  sent: 'border-warn/40 bg-warn-bg',
  prepared: 'border-warn/40 bg-warn-bg',
  sealing: 'border-warn/40 bg-warn-bg',
  completed: 'border-pos/40 bg-pos-bg',
  signed: 'border-pos/40 bg-pos-bg',
  declined: 'border-destructive/40 bg-neg-bg',
  cancelled: 'border-destructive/40 bg-neg-bg',
  expired: 'border-destructive/40 bg-neg-bg',
}

const BADGE_WORDS: Record<string, string> = { sent: 'out for signature', prepared: 'out for signature', sealing: 'finishing' }

/** A status in words: its meaning is in the text, the color only helps. */
export function Badge({ status }: { status: string }) {
  return <span className={cn('inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', BADGE[status] ?? 'border-border bg-muted')}>{BADGE_WORDS[status] ?? status}</span>
}

/** A date and time in the viewer's own zone, short. */
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
