// A draft by itself: how one is drawn, the ones that sit on no conversation (a first email to a new address, a first LinkedIn message to a new contact), and what a draft's own address opens.
//
// Nothing is stored here. A draft on a conversation is drawn inside that conversation (conversation.ts); one on none has no conversation to be drawn in, so it is listed under the Inbox's
// Drafts view and opened at `/inbox/draft/<id>`, by the inbox's `drafts` and `draftAt`. Every action on it is the one a draft in a conversation has (a send names a compose key and the
// revision shown, an edit names the revision, Mark sent files it), asked of the inbox, which admits the owner alone.

import { ANSWER_WITHIN_MS, type InboxDraft } from '@space/workspace'
import type { DraftView, ThreadView } from './conversation'
import { isHandDraft } from './guards'
import type { Asking } from './list'
import { isInboxDraftAt, notConnected, reach } from './reach'

/**
 * A draft as the page draws it. `thread` is the conversation it sits on as this answer holds it (its `through` is what a send names), or null for a draft on no conversation, which a send
 * names no position for. Not sendable when stuck, when it goes by hand (a text or a direct message), when the inbox did not say who it copies, or when it sits on a thread this answer does not hold.
 */
export function draftViewOf(d: InboxDraft, thread: Pick<ThreadView, 'through' | 'canReply'> | null): DraftView {
  // An inbox that does not say who a draft copies (an answer without `cc`) may be sending to people the card cannot show: not sendable from here.
  const cc = Array.isArray(d.cc) ? d.cc : null
  return {
    id: d.id,
    conversationId: d.conversationId,
    subject: d.subject,
    text: d.text,
    rev: d.rev,
    author: d.author,
    stuck: d.stuck,
    at: d.at,
    why: d.why ?? '',
    editedBy: d.editedBy ?? null,
    canCopyEveryone: d.canCopyEveryone === true,
    kind: d.kind ?? null,
    sentFrom: d.sentFrom ?? null,
    sendsFrom: d.sendsFrom ?? null,
    to: d.to,
    toName: d.toName,
    cc,
    through: thread?.through ?? null,
    refusal: d.refusal ?? null,
    ...(d.picture !== undefined && { picture: { type: d.picture.type, size: d.picture.size } }),
    sending: d.sending === true,
    // A text or a direct message is never sent from here: the inbox cannot send on that channel, so the card offers Mark sent instead of Send. A Telegram draft is sent through the bridge in a chat the
    // inbox says can be answered (a one-to-one chat or a group, not a channel), and only from the conversation it answers: one on no conversation has no chat to go to.
    sendable:
      !d.stuck &&
      d.sending !== true &&
      !isHandDraft(d.kind) &&
      cc !== null &&
      (d.kind === 'telegram' ? d.conversationId !== null && thread !== null && thread.canReply : d.conversationId === null || thread !== null),
  }
}

/**
 * A draft that sits on no conversation, as the page lists it under Drafts: the same view of a draft as the one in a conversation, with the contact it is to so the card can open their conversation once it is sent.
 */
export interface LooseDraft extends DraftView {
  contactId: string
}

const looseOf = (d: InboxDraft): LooseDraft => ({ ...draftViewOf(d, null), contactId: d.contactId })

/** The drafts that sit on no conversation, newest first, from the inbox's `drafts`. */
export const looseDraftsOf = (drafts: readonly InboxDraft[]): LooseDraft[] =>
  drafts
    .filter((d) => d.conversationId === null)
    .map(looseOf)
    .sort((a, b) => b.at - a.at)

/** What a draft's address opens: the draft (on no conversation, or on one), or the conversation a draft that is no longer one was filed on. */
export type DraftOpened =
  | { ok: true; value: { state: 'draft'; draft: LooseDraft } | { state: 'conversation'; key: string } }
  | { ok: false; status: 400 | 403 | 404 | 503; message: string }

/** The inbox's own shape of an id. */
const DRAFT_ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * Open a draft by its id, the address `/inbox/draft/<id>` names (an outside tool's links and the drafting skill's). Asked of the inbox with this request's assertion, which admits the owner alone.
 * A draft on no conversation is the card itself. A draft on a conversation, or one that was sent or marked sent since the link was made, is the person's conversation (their `mail:<contact id>` key,
 * which the list opens by too), so the link a draft had keeps working. A draft that was deleted, or an id that is none, is a 404 in words.
 */
export async function openDraft(ask: Asking, id: string): Promise<DraftOpened> {
  if (!DRAFT_ID.test(id)) return { ok: false, status: 400, message: 'That is not a draft the space knows how to open.' }
  const { inbox } = ask.apps
  if (!inbox) return { ok: false, status: 503, message: notConnected('Email').message }
  const got = await reach('Email', () => inbox.draftAt(ask.signedIn, id), isInboxDraftAt, ask.answerWithinMs ?? ANSWER_WITHIN_MS)
  if (got.ok) {
    if (got.value.state === 'filed') return { ok: true, value: { state: 'conversation', key: `mail:${got.value.contactId}` } }
    const d = got.value.draft
    return d.conversationId === null
      ? { ok: true, value: { state: 'draft', draft: looseOf(d) } }
      : { ok: true, value: { state: 'conversation', key: `mail:${d.contactId}` } }
  }
  if (got.kind === 'refused') {
    if (got.reason === 'not-found') return { ok: false, status: 404, message: 'That draft is gone: it was deleted, it never was one, or it was sent from Gmail and the email itself, in the person’s conversation, is now the record.' }
    if (got.reason === 'not-admitted' || got.reason === 'not-signed-in') return { ok: false, status: 403, message: 'This is not open to you.' }
    return { ok: false, status: 400, message: got.message }
  }
  return { ok: false, status: 503, message: got.message }
}
