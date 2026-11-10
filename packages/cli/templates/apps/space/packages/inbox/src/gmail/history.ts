import { type HistoryRecord, inPlay } from './types'

/**
 * One page of Gmail's change history becoming what to do about it: which
 * messages to fetch, and which label changes to apply to messages already held.
 * Pure, so every shape of history is a table test.
 *
 * ── A PUSH IS A HINT, THE HISTORY IS THE TRUTH ───────────────────────────
 * The inbox never reads a message id out of a push. It asks Gmail what changed
 * since its cursor and this turns the answer into work. Three kinds of event
 * matter:
 *
 *   - a message ADDED: fetch it, unless it is already stored (a duplicate push,
 *     or the echo of the fill) or its labels say it never belongs (spam, trash,
 *     a draft).
 *   - a label ADDED or REMOVED: if the message is held, its labels change by
 *     that delta; if it is not held, it is a CANDIDATE to fetch, because a label
 *     change is how a message that was filed away (or sat in Spam) arrives in the
 *     Inbox. The fetch gets its current labels and the store decides.
 *   - a message DELETED: ignored. Nothing is ever removed from the store.
 *
 * ── WHY DELTAS AND NOT A SNAPSHOT ────────────────────────────────────────
 * A label event names the labels that changed, and the `message.labelIds` beside
 * it is not documented to be the labels AFTER the change, so it is not relied on.
 * Applying the deltas in order is correct whatever state the message was fetched
 * in: the last event touching a label decides that label, and replaying the same
 * events on top of a state that already includes them leaves every label where it
 * was. That is the property that lets a message be fetched mid-page and have the
 * page's later deltas applied to it anyway.
 */

export interface LabelDelta {
  gmailId: string
  add: string[]
  remove: string[]
}

export interface HistoryPlan {
  /** Messages to fetch, in the order the history first names them. */
  candidates: { id: string; threadId: string }[]
  /** Label changes in history order, for every message they name (held or not). */
  deltas: LabelDelta[]
  /** The newest record id on this page, or null for an empty page. */
  lastRecordId: string | null
}

const newer = (a: string, b: string): boolean => {
  try {
    return BigInt(a) > BigInt(b)
  } catch {
    return a > b
  }
}

export function planHistory(records: HistoryRecord[], isStored: (gmailId: string) => boolean): HistoryPlan {
  const candidates = new Map<string, { id: string; threadId: string }>()
  const deltas: LabelDelta[] = []
  let lastRecordId: string | null = null

  const consider = (ref: { id: string; threadId: string; labelIds?: string[] }, trustLabels: boolean) => {
    if (isStored(ref.id) || candidates.has(ref.id)) return
    // A message ADDED as spam, trash or a draft: nothing to fetch. Only ever an
    // optimization, and only for an added message, whose labels are the ones it
    // arrived with. On a label event they may be the labels from before or after
    // the change (undocumented), and a message moving OUT of Spam must not be
    // skipped for the label it is leaving.
    if (trustLabels && ref.labelIds && !inPlay(ref.labelIds)) return
    candidates.set(ref.id, { id: ref.id, threadId: ref.threadId })
  }

  for (const record of records) {
    if (lastRecordId === null || newer(record.id, lastRecordId)) lastRecordId = record.id
    for (const added of record.messagesAdded ?? []) consider(added.message, true)
    for (const change of record.labelsAdded ?? []) {
      deltas.push({ gmailId: change.message.id, add: [...change.labelIds], remove: [] })
      consider(change.message, false)
    }
    for (const change of record.labelsRemoved ?? []) {
      deltas.push({ gmailId: change.message.id, add: [], remove: [...change.labelIds] })
      consider(change.message, false)
    }
  }

  return { candidates: [...candidates.values()], deltas, lastRecordId }
}
