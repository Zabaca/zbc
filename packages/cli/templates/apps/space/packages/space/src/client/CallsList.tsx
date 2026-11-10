// The Calls view in Meet: past calls, newest first, each as a card with its saved chat one tap away. It is the home of the calls made at /start before the
// space (they belong to no conversation) and of every call after: a huddle, a call link, a New call, a meeting. Meet decides which calls this person sees.
import type { MeetCall, MeetCallPage } from '@space/workspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Me } from '../me'
import { CallCard } from './CallCard'
import { Glyph } from './icons'
import { Say } from './settings-parts'
import { callPath } from './route'
import { type Loaded, getView } from './views'

export function CallsListView({ calls, now, me, go, more, onMore, loadingMore }: { calls: readonly MeetCall[]; now: number; me: Me; go(path: string): void; more: boolean; onMore(): void; loadingMore: boolean }) {
  if (calls.length === 0) {
    return (
      <p className="empty-line sub" data-testid="empty-calls">
        No calls yet. A huddle, a call link, a meeting and a New call are listed here once they are made, each with its chat.
      </p>
    )
  }
  return (
    <div className="calls-list" data-testid="calls-list">
      {calls.map((c) => (
        <CallCard key={c.name} call={c} now={now} zone={me.company.timeZone} name={me.name} chatHref={callPath(c.name)} onOpenChat={() => go(callPath(c.name))} />
      ))}
      {more && (
        <button type="button" className="btn" onClick={onMore} disabled={loadingMore} data-testid="calls-more">
          {loadingMore ? 'Loading' : 'Older calls'}
        </button>
      )}
    </div>
  )
}

/** The list, read when it opens and again when the page says something changed (`refreshes`). Older calls come a page at a time, by meet's own cursor. */
export function CallsList({ me, refreshes, go }: { me: Me; refreshes: number; go(path: string): void }) {
  const [state, setState] = useState<Loaded<MeetCallPage>>({ kind: 'loading' })
  const [calls, setCalls] = useState<MeetCall[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const gen = useRef(0)

  const load = useCallback(async () => {
    const mine = ++gen.current
    const got = await getView<MeetCallPage>('meet/calls')
    if (mine !== gen.current) return
    setNow(Date.now())
    if (got.kind === 'value') {
      setCalls(got.value.calls)
      setNext(got.value.next)
    }
    setState((held) => (got.kind === 'said' && held.kind === 'value' ? held : got))
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshes])

  const more = async () => {
    if (next === null || loadingMore) return
    setLoadingMore(true)
    const got = await getView<MeetCallPage>('meet/calls', { after: next })
    setLoadingMore(false)
    if (got.kind !== 'value') return setState(got)
    setCalls((held) => [...held, ...got.value.calls.filter((c) => !held.some((h) => h.name === c.name))])
    setNext(got.value.next)
  }

  return (
    <section aria-labelledby="h-calls" data-testid="calls">
      <div className="calls-head">
        <Glyph name="video" size={14} />
        <h2 id="h-calls" className="source">
          Past calls
        </h2>
      </div>
      {state.kind === 'loading' && (
        <p className="empty-line sub" role="status" data-testid="loading">
          Loading calls
        </p>
      )}
      {state.kind === 'signin' && <Say say={{ tone: 'warn', text: 'Your sign-in may have ended. Reload the page to sign in again.', again: false }} />}
      {state.kind === 'said' && <Say say={state.say} onAgain={() => void load()} />}
      {state.kind === 'value' && <CallsListView calls={calls} now={now} me={me} go={go} more={next !== null} onMore={() => void more()} loadingMore={loadingMore} />}
    </section>
  )
}
