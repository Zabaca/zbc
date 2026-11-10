// The operator's three for the Clients store (used when the store is deployed): a bookmark, a restart and the counts of the store's one Durable Object.
//
// Not screens of Settings: POSTs the owner's signed-in browser makes at the sitting, each a single call to the Clients part in this Worker, which admits the owner only. A bookmark is a read of Cloudflare's history
// marker; a restart ends with the object reset under the call, which the part answers as done; the counts are numbers under names and nothing of a Client's words, and they are what the source's own list is compared
// with after its full send. There is no restore here: a restore is armed from inside the object, and this file gives it none (the store keeps Cloudflare's 30 days of history).
//
// Nothing here reads the Clients for a screen, and nothing asks any source: a source's Clients arrive through the Clients door (src/clients-door.ts).

import { ANSWER_WITHIN_MS, CLIENTS_BOOKMARK, type ClientsBookmark, type ClientsCounts, WRITE_WITHIN_MS } from '@space/workspace'
import { isCount, isRecord, isText } from './guards'
import type { Asking } from './list'
import { notConnected, reach, reachWrite } from './reach'
import { answerOf, type ViewAnswer } from './views'

const PART = 'Clients'

const isBookmarkReply = (v: unknown): v is ClientsBookmark => isRecord(v) && isText(v.bookmark) && CLIENTS_BOOKMARK.test(v.bookmark)
const isRestarted = (v: unknown): v is { restarted: true } => isRecord(v) && v.restarted === true
const COUNT_FIELDS = ['clients', 'active', 'archived', 'fromSource', 'madeHere', 'gone', 'highest', 'schema'] as const
const isCounts = (v: unknown): v is ClientsCounts =>
  isRecord(v) &&
  COUNT_FIELDS.every((k) => isCount(v[k])) &&
  (v.source === null ||
    (isRecord(v.source) && isText(v.source.name) && (v.source.lastPushAt === null || isCount(v.source.lastPushAt)) && (v.source.lastSyncAt === null || isCount(v.source.lastSyncAt)) && (v.source.syncedCount === null || isCount(v.source.syncedCount))))

export async function clientsBookmark(ask: Asking): Promise<ViewAnswer<ClientsBookmark>> {
  const { clients } = ask.apps
  if (!clients) return answerOf(notConnected(PART))
  return answerOf(await reach(PART, () => clients.storeBookmark(ask.signedIn), isBookmarkReply, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}

export async function clientsRestart(ask: Asking): Promise<ViewAnswer<{ restarted: true }>> {
  const { clients } = ask.apps
  if (!clients) return { result: 'failed', message: 'Clients is not connected to the space. Nothing was done.' }
  return answerOf(await reachWrite(PART, () => clients.restartStore(ask.signedIn), isRestarted, ask.writeWithinMs ?? WRITE_WITHIN_MS))
}

export async function clientsCounts(ask: Asking): Promise<ViewAnswer<ClientsCounts>> {
  const { clients } = ask.apps
  if (!clients) return answerOf(notConnected(PART))
  return answerOf(await reach(PART, () => clients.storeCounts(ask.signedIn), isCounts, ask.answerWithinMs ?? ANSWER_WITHIN_MS))
}
