// The Knowledge tab's base, asked of the knowledge app (packages/knowledge), which runs in this Worker over the store it owns (parts.ts).
//
// One read (the whole base, or one business's entries) and one write (a change: add, edit, remove, put back, approve, reject), each a single call with the
// person this request's one sign-in check named (packages/workspace/docs/adr/0003), whom the knowledge app admits only if they are the install's owner. The
// knowledge app decides who may do what and every rule of the base; the space only carries the question and refuses an answer that is not the shape the contract says.
//
// A READ waits `ANSWER_WITHIN_MS` and is `unreachable` when the app does not answer, so the tab says "Knowledge could not be reached" while the other tabs
// keep working. A WRITE waits `WRITE_WITHIN_MS` and is NEVER retried: one the space lost track of is `outcome-unknown`. Both answer a `ViewAnswer`, the
// same words the inbox's other views use (views.ts), so the tab says every way a call can end as Settings does.

import { ANSWER_WITHIN_MS, KNOWLEDGE_BOOKMARK, KNOWLEDGE_ENTRY_STATUSES, type KnowledgeBase, type KnowledgeBookmark, type KnowledgeChange, type KnowledgeEntry, WRITE_WITHIN_MS } from '@space/workspace'
import { isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { notConnected, reach, reachWrite } from './reach'
import { answerOf, type ViewAnswer } from './views'

const PART = 'Knowledge'

const statuses = new Set<string>(KNOWLEDGE_ENTRY_STATUSES)
const textOrNull = (v: unknown): boolean => v === null || isText(v)
const countOrNull = (v: unknown): boolean => v === null || isCount(v)
const each = (v: unknown, ok: (x: unknown) => boolean): boolean => isList(v) && v.every(ok)

const isVersion = (v: unknown): boolean =>
  isRecord(v) && isCount(v.seq) && isText(v.by) && isCount(v.at) && isText(v.title) && isText(v.body) && each(v.businesses, isText)

const isEntry = (v: unknown): v is KnowledgeEntry =>
  isRecord(v) &&
  isText(v.id) &&
  isText(v.title) &&
  isText(v.body) &&
  each(v.businesses, isText) &&
  isText(v.status) &&
  statuses.has(v.status) &&
  textOrNull(v.proposedBy) &&
  textOrNull(v.replaces) &&
  countOrNull(v.replacesVersion) &&
  isCount(v.createdAt) &&
  isText(v.createdBy) &&
  isCount(v.updatedAt) &&
  isText(v.updatedBy) &&
  isCount(v.version) &&
  each(v.versions, isVersion)

const isBase = (v: unknown): v is KnowledgeBase =>
  isRecord(v) && each(v.businesses, (b) => isRecord(b) && isText(b.id) && isText(b.name)) && textOrNull(v.business) && each(v.entries, isEntry)

/** The id of a business a request names: the declaration's slugs, so a path-shaped or enormous string never reaches the app. */
const BUSINESS = /^[a-z0-9][a-z0-9-]{0,60}$/

/** The longest change taken: a title and a body at the app's caps, with room for the businesses. The app applies its own, shorter limits. */
const CHANGE_MAX = 40_000

const DOES = new Set(['add', 'edit', 'remove', 'restore', 'approve', 'reject'])

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** The base, or the one business's entries when `business` names it. A name that is not a slug is a 400 at the route. */
export async function readKnowledge(ask: Asking, business: string | null): Promise<Parsed<ViewAnswer<KnowledgeBase>>> {
  if (business !== null && !BUSINESS.test(business)) return { ok: false, message: 'Name a business by its id: lower-case letters, digits and hyphens.' }
  const { knowledge } = ask.apps
  if (!knowledge) return { ok: true, value: answerOf(notConnected(PART)) }
  const a = ask.signedIn
  return { ok: true, value: answerOf(await reach(PART, () => knowledge.knowledge(a, business ?? undefined), isBase, ask.answerWithinMs ?? ANSWER_WITHIN_MS)) }
}

/** One change of the base, by the owner, never retried. */
export async function changeKnowledge(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<KnowledgeEntry>>> {
  if (!isRecord(body)) return { ok: false, message: 'Send a JSON object.' }
  const change = body.change
  if (!isRecord(change) || !isText(change.do) || !DOES.has(change.do)) return { ok: false, message: 'A knowledge change names what to do: add, edit, remove, restore, approve or reject.' }
  if (JSON.stringify(change).length > CHANGE_MAX) return { ok: false, message: 'That entry is too long.' }
  const { knowledge } = ask.apps
  if (!knowledge) return { ok: true, value: { result: 'failed', message: 'Knowledge is not connected to the space. Nothing was changed.' } }
  const a = ask.signedIn
  return {
    ok: true,
    value: answerOf(await reachWrite(PART, () => knowledge.changeKnowledge(a, change as unknown as KnowledgeChange), isEntry, ask.writeWithinMs ?? WRITE_WITHIN_MS)),
  }
}

// ── The operator's three (a move of the knowledge store: the space's ADR 0015) ───────────────────────────────────────────────────────
// Not screens of the Knowledge tab: POSTs the owner's signed-in browser makes at the sitting, each a single call to the knowledge app, which admits the owner only. A bookmark is a read of Cloudflare's
// history marker; a restart ends with the object reset under the call, which the app answers as done; a restore is armed and then restarts the object, and drops everything written since the bookmark.

const isBookmarkReply = (v: unknown): v is KnowledgeBookmark => isRecord(v) && isText(v.bookmark) && KNOWLEDGE_BOOKMARK.test(v.bookmark)
const isRestarted = (v: unknown): v is { restarted: true } => isRecord(v) && v.restarted === true
const isRestoring = (v: unknown): v is { restoring: true } => isRecord(v) && v.restoring === true

export async function storeBookmark(ask: Asking): Promise<ViewAnswer<KnowledgeBookmark>> {
  const { knowledge } = ask.apps
  if (!knowledge) return answerOf(notConnected(PART))
  return answerOf(await reach(PART, () => knowledge.storeBookmark(ask.signedIn), isBookmarkReply, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}

export async function restartStore(ask: Asking): Promise<ViewAnswer<{ restarted: true }>> {
  const { knowledge } = ask.apps
  if (!knowledge) return { result: 'failed', message: 'Knowledge is not connected to the space. Nothing was done.' }
  return answerOf(await reachWrite(PART, () => knowledge.restartStore(ask.signedIn), isRestarted, ask.writeWithinMs ?? WRITE_WITHIN_MS))
}

export async function restoreStore(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<{ restoring: true }>>> {
  if (!isRecord(body) || !isText(body.bookmark) || !KNOWLEDGE_BOOKMARK.test(body.bookmark)) return { ok: false, message: 'Send the bookmark to go back to, as {"bookmark": "..."}.' }
  const { knowledge } = ask.apps
  if (!knowledge) return { ok: true, value: { result: 'failed', message: 'Knowledge is not connected to the space. Nothing was done.' } }
  const bookmark = body.bookmark
  return { ok: true, value: answerOf(await reachWrite(PART, () => knowledge.restoreStore(ask.signedIn, bookmark), isRestoring, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}
