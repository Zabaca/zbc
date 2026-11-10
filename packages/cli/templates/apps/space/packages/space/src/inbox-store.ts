// The operator's three for a move of the inbox's store between Workers (the space's ADR 0017): a bookmark, a restart and
// the counts of the store's one Durable Object.
//
// Not screens of the Inbox tab: POSTs the owner's signed-in browser makes at the sitting, each a single call to the inbox's part in this Worker, which admits the owner only. A bookmark is a read of
// Cloudflare's history marker; a restart ends with the object reset under the call, which the part answers as done; the counts are numbers under names and nothing of a message, a draft or a person.
// There is no restore here: the inbox has its own (`prepareRestore` and `confirmRestore`, the Settings screen), which goes back to a bookmark with a token and its own record.

import { ANSWER_WITHIN_MS, INBOX_BOOKMARK, type InboxStoreBookmark, type InboxStoreCounts, type InboxStoreRestarted, WRITE_WITHIN_MS } from '@space/workspace'
import { isRecord, isText } from './guards'
import type { Asking } from './list'
import { notConnected, reach, reachWrite } from './reach'
import { answerOf, type ViewAnswer } from './views'

const PART = 'Email'

const isBookmarkReply = (v: unknown): v is InboxStoreBookmark => isRecord(v) && isText(v.bookmark) && INBOX_BOOKMARK.test(v.bookmark)
const isRestarted = (v: unknown): v is InboxStoreRestarted => isRecord(v) && v.restarted === true
const isCounts = (v: unknown): v is InboxStoreCounts => isRecord(v) && isRecord(v.counts) && Object.values(v.counts).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)

export async function inboxBookmark(ask: Asking): Promise<ViewAnswer<InboxStoreBookmark>> {
  const { inbox } = ask.apps
  if (!inbox) return answerOf(notConnected(PART))
  return answerOf(await reach(PART, () => inbox.storeBookmark(ask.signedIn), isBookmarkReply, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}

export async function inboxRestart(ask: Asking): Promise<ViewAnswer<InboxStoreRestarted>> {
  const { inbox } = ask.apps
  if (!inbox) return { result: 'failed', message: 'Email is not connected to the space. Nothing was done.' }
  return answerOf(await reachWrite(PART, () => inbox.restartStore(ask.signedIn), isRestarted, ask.writeWithinMs ?? WRITE_WITHIN_MS))
}

export async function inboxCounts(ask: Asking): Promise<ViewAnswer<InboxStoreCounts>> {
  const { inbox } = ask.apps
  if (!inbox) return answerOf(notConnected(PART))
  return answerOf(await reach(PART, () => inbox.storeCounts(ask.signedIn), isCounts, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}
