/**
 * Asking the knowledge app (packages/knowledge, called in-process in the space's Worker through its inbox face): the one place the inbox
 * waits on it. The assistant asks it for a business's active entries before it drafts; Claude's script is handed on to it through the
 * routes in app.ts. The knowledge base is the knowledge app's alone: the inbox holds
 * none, and what it cannot get from the app it does without by saying so, never by supposing the base is empty.
 *
 * `ask` never throws and never waits longer than `ms`: a binding that throws (an error thrown across a binding arrives as a message
 * with its type gone), is not there, hangs, or answers something that is not a reply is `unreached`, with a `why` for the audit and
 * the log and never for a person. A refusal or a fault the app itself answered comes through, because the app knew what it decided.
 */

import { ANSWER_WITHIN_MS, type KnowledgeForInbox, type RefusalReason, type SpaceReply } from '@space/workspace'

/** What Claude's script is told when the knowledge app did not answer, and nothing was changed. */
export const KNOWLEDGE_UNREACHED = 'The knowledge app could not be reached. Nothing was changed. Try again in a moment.'

/** The knowledge app as the inbox holds it: the binding, or nothing in a Worker deployed without one. */
export type KnowledgePort = KnowledgeForInbox | null | undefined

export type Asked<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'refused'; reason: RefusalReason; message: string }
  | { ok: false; kind: 'failed'; message: string }
  | { ok: false; kind: 'unreached'; why: string }

export function ask<T>(
  port: KnowledgePort,
  call: (knowledge: KnowledgeForInbox) => Promise<SpaceReply<T>>,
  ms: number = ANSWER_WITHIN_MS,
): Promise<Asked<T>> {
  return askPort('the knowledge app', port, call, ms)
}

/**
 * The same wait for any other part the inbox is handed in-process (the calendar's face for Claude's script, src/app.ts): `what` is the part's name in the sentence a log line carries, and nothing else differs. A READ waits the
 * default four seconds; a WRITE is given the space's `WRITE_WITHIN_MS` by its caller, and an `unreached` from a write is an outcome that is NOT KNOWN (it may have been done), which the caller must say and never read as "nothing happened".
 */
export async function askPort<P, T>(
  what: string,
  port: P | null | undefined,
  call: (part: P) => Promise<SpaceReply<T>>,
  ms: number = ANSWER_WITHIN_MS,
): Promise<Asked<T>> {
  if (!port) return { ok: false, kind: 'unreached', why: `the Worker has no binding to ${what}` }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  try {
    const got = await Promise.race([Promise.resolve().then(() => call(port)), late])
    if (got === 'late') return { ok: false, kind: 'unreached', why: 'no answer in time' }
    if (typeof got !== 'object' || got === null || typeof got.ok !== 'boolean') {
      return { ok: false, kind: 'unreached', why: 'an answer that is not a reply' }
    }
    if (got.ok) return { ok: true, value: got.value }
    return got.kind === 'refused'
      ? { ok: false, kind: 'refused', reason: got.reason, message: got.message }
      : { ok: false, kind: 'failed', message: got.message }
  } catch (error) {
    return { ok: false, kind: 'unreached', why: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
