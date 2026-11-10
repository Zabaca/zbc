// How the page asks the Worker for the inbox's other views (src/views.ts): a read, a write, and a hook that keeps what a screen shows and says so when it
// could not be had. The words for each way an answer can end are here, once, so every screen of Settings says them the same way.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewAnswer } from '../views'
import { read, write, writeForm } from './api'

/** What a page holds of a read: nothing yet, the value, or why there is none. */
export type Loaded<T> = { kind: 'loading' } | { kind: 'value'; value: T } | { kind: 'said'; say: Said } | { kind: 'signin' }

/** A way a call ended that is not a value, in words a person reads. */
export interface Said {
  tone: 'warn' | 'bad'
  text: string
  /** True where trying again is honest: a read that did not answer. Never a write that may have been done. */
  again: boolean
  /** The inbox refused because the thing changed since it was shown: what was typed over the old version was NOT saved. */
  conflict?: boolean
}

/** What to say for an answer that has no value. */
export function said(answer: Exclude<ViewAnswer<unknown>, { result: 'ok' }>): Said {
  switch (answer.result) {
    case 'refused':
      return {
        tone: 'warn',
        text: answer.reason === 'conflict' ? `${answer.message} The screen has been read again.` : answer.reason === 'not-admitted' ? 'This is not open to you.' : answer.message,
        again: false,
        ...(answer.reason === 'conflict' && { conflict: true }),
      }
    case 'failed':
      return { tone: 'bad', text: answer.message, again: false }
    case 'unreachable':
      return { tone: 'warn', text: `${answer.message} It will be tried again when you ask.`, again: true }
    case 'outcome-unknown':
      return { tone: 'bad', text: `${answer.message} It may have been done: look, and do not press it again until you have.`, again: false }
  }
}

const SIGNED_OUT: Said = { tone: 'warn', text: 'Your sign-in may have ended. Reload the page to sign in again.', again: false }
const OFFLINE: Said = { tone: 'warn', text: 'The space could not be reached just now.', again: true }

/**
 * Where a view lives: the inbox's other views at `/api/inbox/<name>`, the knowledge base, which is the knowledge app's and not the inbox's, at `/api/knowledge`, and meet's calls
 * (`meet/cards`, `meet/huddle`, ...) at `/api/meet/<name>`, and the calendar's (`calendar/agenda`, `calendar/event`, `calendar/accounts`, `calendar/shown`, `calendar/sync`) at `/api/calendar/<name>`, and the Clients part's (`clients/list`, `clients/one`, `clients/make`, `clients/edit`, `clients/archive`, `clients/put-back`) at `/api/clients/<name>`. All answer a `ViewAnswer`, so the rest of this file does not care which it asked.
 */
const viewUrl = (name: string): string => (name === 'knowledge' ? '/api/knowledge' : name.startsWith('meet/') || name.startsWith('calendar/') || name.startsWith('clients/') ? `/api/${name}` : `/api/inbox/${name}`)

/** A read of one view. */
export async function getView<T>(name: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<Loaded<T>> {
  const qs = new URLSearchParams(query).toString()
  const got = await read<ViewAnswer<T>>(`${viewUrl(name)}${qs === '' ? '' : `?${qs}`}`, signal)
  if (!got.ok) return got.problem === 'signin' ? { kind: 'signin' } : { kind: 'said', say: got.message ? { tone: 'warn', text: got.message, again: true } : OFFLINE }
  return got.value.result === 'ok' ? { kind: 'value', value: got.value.value } : { kind: 'said', say: said(got.value) }
}

/** What a write came to: the value, or what to say. */
export type Done<T> = { ok: true; value: T } | { ok: false; say: Said }

/**
 * A write. Never retried: a connection that fails before an answer is read as `outcome-unknown`, because the write may have reached the inbox, and a
 * sign-in that ended says so (nothing was sent, since the Worker refuses before it asks).
 */
export async function postView<T>(name: string, body: unknown): Promise<Done<T>> {
  return doneOf<T>(await write(viewUrl(name), body))
}

/** A write whose request is a form with files (a picture put on a draft): the same answer and the same words as `postView`, never retried. */
export async function postViewForm<T>(url: string, body: unknown, files: readonly File[]): Promise<Done<T>> {
  return doneOf<T>(await writeForm(url, body, files))
}

/** What a write's response came to, in the page's words. */
function doneOf<T>(got: Awaited<ReturnType<typeof write>>): Done<T> {
  if (got === 'network') return { ok: false, say: said({ result: 'outcome-unknown', message: 'The space did not say whether that went through.' }) }
  if (got.type === 'opaqueredirect' || got.status === 401) return { ok: false, say: SIGNED_OUT }
  const answer = got.body as ViewAnswer<T> | { error?: string } | null
  if (got.status !== 200 || answer === null || !('result' in answer)) {
    const message = answer && 'error' in answer && typeof answer.error === 'string' ? answer.error : `The space answered ${got.status}.`
    return { ok: false, say: { tone: 'bad', text: message, again: false } }
  }
  return answer.result === 'ok' ? { ok: true, value: answer.value } : { ok: false, say: said(answer) }
}

/**
 * A view kept on screen: read when mounted and whenever `key` changes, read again on `reload`. The last value stays up while it is read again, and a read that
 * fails after one has been had is `problem`, to be said beside it rather than replacing it.
 */
export function useView<T>(name: string, query: Record<string, string> = {}, enabled = true): { state: Loaded<T>; reload(): void; reading: boolean; problem: Said | null } {
  const [state, setState] = useState<Loaded<T>>({ kind: 'loading' })
  const [reading, setReading] = useState(true)
  const [problem, setProblem] = useState<Said | null>(null)
  const [tick, setTick] = useState(0)
  const key = `${name}?${new URLSearchParams(query).toString()}`
  const held = useRef(state)
  held.current = state
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the name and the query; `tick` is a reload.
  useEffect(() => {
    // A view of a part the install does not have is not asked for (the Worker would answer it as a path that is not there).
    if (!enabled) return
    const ctl = new AbortController()
    setReading(true)
    void getView<T>(name, query, ctl.signal).then((got) => {
      if (ctl.signal.aborted) return
      setReading(false)
      // A read that fails with a value already on screen keeps the value; the screen says so in a notice of its own.
      if (got.kind === 'said' && held.current.kind === 'value') return setProblem(got.say)
      setProblem(null)
      setState(got)
    })
    return () => ctl.abort()
  }, [key, tick, enabled])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { state, reload, reading, problem }
}
