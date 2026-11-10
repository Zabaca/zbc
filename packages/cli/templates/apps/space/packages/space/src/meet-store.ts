// The operator's four for a move of meet's stores (the space's ADR 0016): a bookmark, a restart and a restore of one of
// the two long-lived objects, the Workspace object (every channel and chat) or the usage ledger (the Room object that indexes the calls), and a read of how many rows each holds (the counts that must be equal after a move).
//
// Not screens of the Meet tab: POSTs the owner's signed-in browser makes at the sitting, each a single call to meet's part in this Worker, which admits the owner only (and refuses an object that is not one of the two).
// A bookmark is a read of Cloudflare's history marker; a restart ends with the object reset under the call, which the part answers as done; a restore is armed and then restarts the object, and drops everything written
// since the bookmark. They touch no message, no call and no person. The answers are `ViewAnswer`s, as the knowledge store's are (knowledge.ts).

import { MEET_BOOKMARK, MEET_OBJECTS, type MeetBookmark, type MeetCounts, type MeetRestarted, type MeetRestoring, WRITE_WITHIN_MS, ANSWER_WITHIN_MS } from '@space/workspace'
import { isRecord, isText } from './guards'
import type { Asking } from './list'
import { notConnected, reach, reachWrite } from './reach'
import { answerOf, type ViewAnswer } from './views'

const PART = 'Chat'

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const isObjectName = (v: unknown): v is (typeof MEET_OBJECTS)[number] => typeof v === 'string' && (MEET_OBJECTS as readonly string[]).includes(v)
const NAME_HELP = 'Name the object: {"object": "workspace"} or {"object": "ledger"}.'

const isBookmarkReply = (v: unknown): v is MeetBookmark => isRecord(v) && isObjectName(v.object) && isText(v.bookmark) && MEET_BOOKMARK.test(v.bookmark)
const isRestarted = (v: unknown): v is MeetRestarted => isRecord(v) && isObjectName(v.object) && v.restarted === true
const isRestoring = (v: unknown): v is MeetRestoring => isRecord(v) && isObjectName(v.object) && v.restoring === true
const isCounts = (v: unknown): v is MeetCounts => isRecord(v) && isObjectName(v.object) && isRecord(v.counts) && Object.values(v.counts).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)

export async function meetBookmark(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<MeetBookmark>>> {
  if (!isRecord(body) || !isObjectName(body.object)) return { ok: false, message: NAME_HELP }
  const { meet } = ask.apps
  if (!meet) return { ok: true, value: answerOf(notConnected(PART)) }
  const object = body.object
  return { ok: true, value: answerOf(await reach(PART, () => meet.storeBookmark(ask.signedIn, object), isBookmarkReply, ask.answerWithinMs ?? ANSWER_WITHIN_MS)) }
}

export async function meetRestart(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<MeetRestarted>>> {
  if (!isRecord(body) || !isObjectName(body.object)) return { ok: false, message: NAME_HELP }
  const { meet } = ask.apps
  if (!meet) return { ok: true, value: { result: 'failed', message: 'Chat is not connected to the space. Nothing was done.' } }
  const object = body.object
  return { ok: true, value: answerOf(await reachWrite(PART, () => meet.restartStore(ask.signedIn, object), isRestarted, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

export async function meetRestore(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<MeetRestoring>>> {
  if (!isRecord(body) || !isObjectName(body.object) || !isText(body.bookmark) || !MEET_BOOKMARK.test(body.bookmark)) {
    return { ok: false, message: 'Send the object and the bookmark to go back to, as {"object": "workspace", "bookmark": "..."}.' }
  }
  const { meet } = ask.apps
  if (!meet) return { ok: true, value: { result: 'failed', message: 'Chat is not connected to the space. Nothing was done.' } }
  const { object, bookmark } = { object: body.object, bookmark: body.bookmark }
  return { ok: true, value: answerOf(await reachWrite(PART, () => meet.restoreStore(ask.signedIn, object, bookmark), isRestoring, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

export async function meetCounts(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<MeetCounts>>> {
  if (!isRecord(body) || !isObjectName(body.object)) return { ok: false, message: NAME_HELP }
  const { meet } = ask.apps
  if (!meet) return { ok: true, value: answerOf(notConnected(PART)) }
  const object = body.object
  return { ok: true, value: answerOf(await reach(PART, () => meet.storeCounts(ask.signedIn, object), isCounts, ask.answerWithinMs ?? ANSWER_WITHIN_MS)) }
}
