// Asking an app and getting an answer the page can use, whatever the app does.
//
// An app answers a `SpaceReply` (a value, a refusal or a fault). The SPACE adds the three ways there is no answer at all, which
// an app cannot say for itself (packages/workspace/src/asking.ts, `Unanswered`): the binding threw or the app is not deployed
// (`unreachable`), nothing came within `ANSWER_WITHIN_MS` (`timed-out`, READS ONLY), or what came is not the shape the contract
// says (`not-understood`, never half read). That is what lets Conversations keep one part's rows on screen and say what the other
// could not do.

import {
  DOCUMENT_STATES,
  DELIVERY_STATES,
  DRAFT_AUTHORS,
  type Documents,
  type InboxCloseResult,
  type InboxContact,
  type InboxContactProfile,
  type InboxContacts,
  type InboxDraft,
  type InboxDraftAt,
  type InboxHandSent,
  type InboxHistory,
  type InboxMerged,
  type InboxPeople,
  type InboxReadResult,
  type InboxReopenResult,
  type InboxSearch,
  type InboxSendResolved,
  type InboxSent,
  type InboxSpamResult,
  type InboxSplitDone,
  type InboxUnmerged,
  MAIL_KINDS,
  isConversationRef,
  CALL_KINDS,
  type MeetCall,
  type MeetCallChat,
  type MeetCallPage,
  type MeetHistory,
  type MeetLiveCall,
  type MeetMessage,
  type MeetOverview,
  type MeetPerson,
  type MeetPhone,
  type MeetPosted,
  type MeetRead,
  type MeetUsage,
  type Reached,
  type ReachedWrite,
  type SpaceReply,
  type WriteReply,
  unanswered,
} from '@space/workspace'
import { isCount, isList, isRecord, isText } from './guards'

/** The words for a part that did not answer, by what happened. `part` is the name a person knows it by. */
const WORDS = {
  unreachable: (part: string) => `${part} could not be reached.`,
  'timed-out': (part: string) => `${part} took too long to answer.`,
  'not-understood': (part: string) => `${part} answered in a way the space could not read.`,
} as const

/**
 * Ask an app for a READ and wait up to `ms`. Never throws and never waits longer: a binding that throws, hangs or answers with a
 * shape that is not `valid` is an `Unanswered`. A refusal or a fault the app itself answers comes through untouched, because the
 * app knew who was asking and decided (a refusal), or knew what failed (`broken`), which the page shows differently from silence.
 */
export async function reach<T>(part: string, ask: () => Promise<SpaceReply<T>>, valid: (value: unknown) => value is T, ms: number): Promise<Reached<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gone = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  try {
    // A call that throws synchronously (a missing method on a stub) is as unreachable as one that rejects.
    const answer = await Promise.race([Promise.resolve().then(ask), gone])
    if (answer === 'late') return unanswered('timed-out', WORDS['timed-out'](part))
    if (!isReply(answer)) return unanswered('not-understood', WORDS['not-understood'](part))
    if (answer.ok && !valid(answer.value)) return unanswered('not-understood', WORDS['not-understood'](part))
    return answer as Reached<T>
  } catch (err) {
    // The message is not shown: an error thrown across a binding is a string with its fields gone, and may name internals.
    console.warn(`space: ${part} threw: ${err instanceof Error ? err.message : String(err)}`)
    return unanswered('unreachable', WORDS.unreachable(part))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask an app for a WRITE (a send, a post) and wait for as long as the contract says (`WRITE_WITHIN_MS`, a little past the slowest thing an
 * app waits on). Never throws, and NEVER RETRIES: whatever is not a clear answer is `outcome-unknown`, because the thing may have been done.
 *
 * - The binding throws, or nothing comes within `ms`: `outcome-unknown`. (A read that did this would be `unreachable` or `timed-out`; for a
 *   write the word is different, because the page says "check Sent" and offers no second try.)
 * - What comes is not the shape the contract says: also `outcome-unknown`. An app that sent and then answered nonsense has still sent.
 * - A refusal, a fault (`broken`, which the contract allows only when nothing went out) or a `Repeated` the app itself answers comes through
 *   untouched, with the success value checked by `valid`.
 */
export async function reachWrite<T>(part: string, ask: () => Promise<WriteReply<T>>, valid: (value: unknown) => value is T, ms: number): Promise<ReachedWrite<T>> {
  const unknown = (why: string) => unanswered('outcome-unknown', `${part} did not say whether it went through (${why}).`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const gone = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  try {
    const answer = await Promise.race([Promise.resolve().then(ask), gone])
    if (answer === 'late') return unknown('no answer in time')
    if (!isReply(answer)) return unknown('an answer the space could not read')
    if (answer.ok && !valid(answer.value)) return unknown('an answer the space could not read')
    if (!answer.ok && (answer.reason as string) === 'repeated' && !isRepeated(answer)) return unknown('an answer the space could not read')
    return answer as ReachedWrite<T>
  } catch (err) {
    console.warn(`space: ${part} threw on a write: ${err instanceof Error ? err.message : String(err)}`)
    return unknown('the connection failed')
  } finally {
    clearTimeout(timer)
  }
}

/** A part that is not wired to this Worker at all (a local `vite dev`, or a deploy without the binding). */
export const notConnected = (part: string) => unanswered('unreachable', `${part} is not connected to the space.`)

// ── The shapes read from an answer ────────────────────────────────────────────────────────────────────────────────────────


function isReply(v: unknown): v is SpaceReply<unknown> {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return false
  if (v.ok) return 'value' in v
  return (v.kind === 'refused' || v.kind === 'failed') && isText(v.reason) && isText(v.message)
}

// The contract's one list of kinds, not a copy of it: a kind added there is read here, not refused as an answer that cannot be understood.
const mailKinds = new Set<string>(MAIL_KINDS)

function isThreadLine(v: unknown): boolean {
  return (
    isRecord(v) &&
    isText(v.conversationId) &&
    isText(v.subject) &&
    isText(v.kind) &&
    mailKinds.has(v.kind) &&
    isCount(v.at) &&
    isText(v.snippet) &&
    (v.direction === 'in' || v.direction === 'out') &&
    typeof v.unread === 'boolean' &&
    typeof v.open === 'boolean' &&
    typeof v.bulk === 'boolean' &&
    (v.mailbox === null || (isRecord(v.mailbox) && isText(v.mailbox.id) && isText(v.mailbox.name))) &&
    isList(v.alsoOn) &&
    v.alsoOn.every((p) => isRecord(p) && isText(p.contactId) && isText(p.name) && (p.address === null || isText(p.address))) &&
    // Which person the thread is listed under, in the lists and in a Client's list.
    typeof v.listed === 'boolean' &&
    typeof v.listedInClient === 'boolean' &&
    // Additive: a Telegram group or channel, and for a group whether it is waiting on the owner.
    isTelegramChat(v.telegramChat) &&
    (v.needsReply === undefined || typeof v.needsReply === 'boolean')
  )
}

/** A Telegram group or channel; ABSENT from everything else and from an inbox that predates it. */
const isTelegramChat = (v: unknown): boolean => v === undefined || v === 'group' || v === 'channel'

/** The Telegram groups a person writes in, when the inbox says any (additive). */
const isGroupRef = (g: unknown): boolean => isRecord(g) && isText(g.contactId) && isText(g.name) && isCount(g.lastWroteAt)

const isClientRef = (c: unknown): boolean => isRecord(c) && isCount(c.id) && isText(c.name) && typeof c.listed === 'boolean'

/** The inbox's `people`, as far as the merge reads it. */
export function isInboxPeople(v: unknown): v is InboxPeople {
  return (
    isRecord(v) &&
    typeof v.more === 'boolean' &&
    isList(v.people) &&
    v.people.every(
      (p) =>
        isRecord(p) &&
        isText(p.contactId) &&
        isText(p.name) &&
        isList(p.addresses) &&
        p.addresses.every(isText) &&
        (p.client === null || isClientRef(p.client)) &&
        // The Client the inbox only suggests: ABSENT from an inbox that predates it, read as none.
        (p.suggestedClient === undefined || p.suggestedClient === null || isClientRef(p.suggestedClient)) &&
        isList(p.conversations) &&
        p.conversations.every(isThreadLine),
    )
  )
}

const isNewest = (v: unknown): boolean =>
  v === null || (isRecord(v) && isCount(v.messageId) && isCount(v.at) && isText(v.text) && isText(v.authorName) && typeof v.mine === 'boolean')

/** A person of meet's workspace, as any of its answers names one (channel admin's, messages' and settings' share this reading). */
export const isMeetPerson = (v: unknown): v is MeetPerson =>
  isRecord(v) && isText(v.id) && isText(v.name) && (v.kind === 'teammate' || v.kind === 'guest') && (v.address === null || isText(v.address))

/** Meet's `conversations`, as far as the merge reads it. */
export function isMeetOverview(v: unknown): v is MeetOverview {
  return (
    isRecord(v) &&
    isList(v.direct) &&
    v.direct.every(
      (d) =>
        isRecord(d) &&
        isCount(d.conversationId) &&
        isCount(d.unread) &&
        isNewest(d.newest) &&
        isRecord(d.person) &&
        isText(d.person.id) &&
        isText(d.person.name) &&
        (d.person.kind === 'teammate' || d.person.kind === 'guest') &&
        (d.person.address === null || isText(d.person.address)),
    ) &&
    isList(v.channels) &&
    v.channels.every(
      (c) =>
        isRecord(c) && isCount(c.conversationId) && isText(c.name) && (c.privacy === 'open' || c.privacy === 'private') && isCount(c.memberCount) && isCount(c.unread) && isNewest(c.newest),
    ) &&
    // Both are additive: a meet that predates them leaves them out, and the list then has no Phone row and no row for a New call.
    (v.phone === undefined ||
      v.phone === null ||
      (isRecord(v.phone) && isCount(v.phone.conversationId) && isCount(v.phone.unread) && (v.phone.newest === null || (isRecord(v.phone.newest) && isCount(v.phone.newest.at) && isText(v.phone.newest.text))))) &&
    (v.calls === undefined || (isList(v.calls) && v.calls.every((c) => isRecord(c) && isText(c.name) && isText(c.link) && (c.title === null || isText(c.title)) && isCount(c.madeAt))))
  )
}

/** The inbox's `search`. */
export function isInboxSearch(v: unknown): v is InboxSearch {
  return (
    isRecord(v) &&
    typeof v.more === 'boolean' &&
    isList(v.terms) &&
    isList(v.hits) &&
    v.hits.every(
      (h) =>
        isRecord(h) &&
        isText(h.conversationId) &&
        isText(h.subject) &&
        isText(h.kind) &&
        mailKinds.has(h.kind) &&
        isCount(h.at) &&
        isText(h.snippet) &&
        (h.match === null || isText(h.match)) &&
        typeof h.unread === 'boolean' &&
        typeof h.open === 'boolean' &&
        typeof h.bulk === 'boolean' &&
        (h.mailbox === null || (isRecord(h.mailbox) && isText(h.mailbox.name))) &&
        isList(h.people) &&
        h.people.every((p) => isRecord(p) && isText(p.name)),
    )
  )
}

// ── Today ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Meet's `liveCalls`. `why` is read as any text: meet may add reasons (invited, in their conversation) and be deployed before the space, so a reason this
 * space does not know must not make the whole answer unreadable. Such a call is still the person's and is listed; Today's row does not depend on why.
 */
export function isMeetLiveCalls(v: unknown): v is MeetLiveCall[] {
  return isList(v) && v.every((c) => isRecord(c) && isText(c.name) && isCount(c.startedAt) && isCount(c.present) && c.present > 0 && isText(c.why))
}

const documentStates = new Set<string>(DOCUMENT_STATES)
const isTime = (v: unknown): boolean => v === null || isCount(v)

/** Forms' `documents`: a list of envelopes, each with its title and state, when it moved and the names of those who have not signed. */
export function isDocuments(v: unknown): v is Documents {
  return (
    isRecord(v) &&
    typeof v.more === 'boolean' &&
    isList(v.documents) &&
    v.documents.every(
      (d) =>
        isRecord(d) &&
        isText(d.id) &&
        isText(d.title) &&
        isText(d.state) &&
        documentStates.has(d.state) &&
        isCount(d.createdAt) &&
        isTime(d.sentAt) &&
        isTime(d.completedAt) &&
        isCount(d.signers) &&
        isCount(d.signed) &&
        isList(d.notSigned) &&
        d.notSigned.every(isText) &&
        // Additive: a forms that predates conversations sends none; one that has them sends null or the pair.
        (d.conversation === undefined || d.conversation === null || isConversationRef(d.conversation)),
    )
  )
}

// ── A person's conversation ───────────────────────────────────────────────────────────────────────────────────────────────

const isParty = (p: unknown): boolean => isRecord(p) && isText(p.contactId) && isText(p.name) && (p.address === null || isText(p.address))
const draftAuthors = new Set<string>(DRAFT_AUTHORS)
const deliveryStates = new Set<string>(DELIVERY_STATES)
/** A file on a message, as the inbox lists it (additive: the answer of an inbox that predates files has none). */
const isAttachment = (a: unknown): boolean =>
  isRecord(a) &&
  isText(a.name) &&
  isCount(a.size) &&
  isText(a.type) &&
  typeof a.picture === 'boolean' &&
  typeof a.download === 'boolean' &&
  (a.play === undefined || typeof a.play === 'boolean') &&
  (a.video === undefined || typeof a.video === 'boolean') &&
  (a.seconds === undefined || isCount(a.seconds)) &&
  (a.note === undefined || isText(a.note))
/** What Cloudflare reported of one recipient (additive, like the files). A state this space does not know makes the answer unreadable, never half drawn. */
const isDeliveryNote = (n: unknown): boolean =>
  isRecord(n) && isText(n.recipient) && isText(n.state) && deliveryStates.has(n.state) && isText(n.reason) && isCount(n.at)

/** The inbox's `messagesWith`: the person's conversations, and a page of their messages. */
export function isInboxHistory(v: unknown): v is InboxHistory {
  return (
    isRecord(v) &&
    typeof v.more === 'boolean' &&
    isList(v.threads) &&
    v.threads.every(
      (t) =>
        isRecord(t) &&
        isText(t.conversationId) &&
        isText(t.subject) &&
        isText(t.kind) &&
        mailKinds.has(t.kind) &&
        isCount(t.through) &&
        typeof t.unread === 'boolean' &&
        typeof t.open === 'boolean' &&
        typeof t.bulk === 'boolean' &&
        (t.mailbox === null || (isRecord(t.mailbox) && isText(t.mailbox.id) && isText(t.mailbox.name))) &&
        isList(t.alsoOn) &&
        t.alsoOn.every(isParty) &&
        typeof t.canReply === 'boolean' &&
        (t.canAttach === undefined || typeof t.canAttach === 'boolean') &&
        (t.canPicture === undefined || typeof t.canPicture === 'boolean') &&
        (t.canMarkSpam === undefined || typeof t.canMarkSpam === 'boolean') &&
        isTelegramChat(t.telegramChat),
    ) &&
    isList(v.messages) &&
    v.messages.every(
      (m) =>
        isRecord(m) &&
        isText(m.id) &&
        isText(m.conversationId) &&
        isText(m.subject) &&
        (m.direction === 'in' || m.direction === 'out') &&
        isCount(m.at) &&
        isText(m.from) &&
        isText(m.text) &&
        typeof m.textCut === 'boolean' &&
        // Both are additive: an inbox that predates them leaves them out, and the page then draws the text whole.
        (m.read === undefined || (isRecord(m.read) && isText(m.read.visible) && isText(m.read.quoted))) &&
        (m.to === undefined || isText(m.to)) &&
        (m.attachments === undefined || (isList(m.attachments) && m.attachments.every(isAttachment))) &&
        (m.delivery === undefined || (isList(m.delivery) && m.delivery.every(isDeliveryNote))) &&
        (m.sentByHand === undefined || typeof m.sentByHand === 'boolean') &&
        (m.edited === undefined || typeof m.edited === 'boolean') &&
        (m.deleted === undefined || typeof m.deleted === 'boolean') &&
        isList(m.alsoOn) &&
        m.alsoOn.every(isParty),
    )
  )
}

/** One draft as the inbox lists it (`drafts`, and the answer of `editDraft`). */
export function isInboxDraft(d: unknown): d is InboxDraft {
  return (
    isRecord(d) &&
    isText(d.id) &&
    (d.conversationId === null || isText(d.conversationId)) &&
    isText(d.contactId) &&
    isText(d.toName) &&
    isText(d.to) &&
    // `cc` may be ABSENT (an inbox that predates it: the space then does not offer to send the draft as it stands); when present it is a list of people.
    (d.cc === undefined || (isList(d.cc) && d.cc.every((c) => isRecord(c) && isText(c.name) && isText(c.address)))) &&
    isText(d.subject) &&
    isText(d.text) &&
    isCount(d.rev) &&
    isText(d.author) &&
    draftAuthors.has(d.author) &&
    typeof d.stuck === 'boolean' &&
    isCount(d.at) &&
    // Additive: an inbox that predates them leaves them out, and the card then shows no reason, no editor and no way to copy everyone.
    (d.why === undefined || isText(d.why)) &&
    (d.editedBy === undefined || d.editedBy === null || (isText(d.editedBy) && draftAuthors.has(d.editedBy))) &&
    (d.canCopyEveryone === undefined || typeof d.canCopyEveryone === 'boolean') &&
    (d.kind === undefined || (isText(d.kind) && mailKinds.has(d.kind))) &&
    (d.sentFrom === undefined || isText(d.sentFrom)) &&
    (d.refusal === undefined || isText(d.refusal)) &&
    (d.picture === undefined || (isRecord(d.picture) && isText(d.picture.type) && isCount(d.picture.size))) &&
    (d.sending === undefined || typeof d.sending === 'boolean') &&
    (d.sendsFrom === undefined || isSendsFrom(d.sendsFrom))
  )
}

/** An account a draft or a new email goes out from: its name (the pill) and its address. */
const isSendsFrom = (v: unknown): boolean => isRecord(v) && isText(v.name) && isText(v.address)

/** The inbox's `drafts`. */
export function isInboxDrafts(v: unknown): v is InboxDraft[] {
  return isList(v) && v.every(isInboxDraft)
}

/** The inbox's `draftAt`: the draft as it stands, or the person and conversation it was filed on. */
export function isInboxDraftAt(v: unknown): v is InboxDraftAt {
  return isRecord(v) && ((v.state === 'draft' && isInboxDraft(v.draft)) || (v.state === 'filed' && isText(v.contactId) && isText(v.conversationId)))
}

/** The inbox's `setSpam`: where the conversation stands after the call, and why. */
export function isInboxSpamResult(v: unknown): v is InboxSpamResult {
  return isRecord(v) && isText(v.conversationId) && typeof v.spam === 'boolean' && typeof v.bulk === 'boolean' && isList(v.reasons) && v.reasons.every(isText)
}

/** What the inbox answers a send that went out, or that Gmail never confirmed. */
export function isInboxSent(v: unknown): v is InboxSent {
  return isRecord(v) && isText(v.messageId) && isText(v.conversationId) && (v.status === 'sent' || v.status === 'sending')
}

/** The inbox's `markRead`. */
export function isInboxReadResult(v: unknown): v is InboxReadResult {
  return (
    isRecord(v) &&
    isList(v.read) &&
    v.read.every(isText) &&
    isList(v.notRead) &&
    v.notRead.every((n) => isRecord(n) && isText(n.conversationId) && isReply(n.outcome) && n.outcome.ok === false)
  )
}

const isEachNotDone = (list: unknown[]): boolean => list.every((n) => isRecord(n) && isText(n.conversationId) && isReply(n.outcome) && n.outcome.ok === false)

/** The inbox's `closeConversations`. */
export function isInboxCloseResult(v: unknown): v is InboxCloseResult {
  return isRecord(v) && isList(v.closed) && v.closed.every(isText) && isList(v.notClosed) && isEachNotDone(v.notClosed)
}

/** The inbox's `reopenConversations`. */
export function isInboxReopenResult(v: unknown): v is InboxReopenResult {
  return isRecord(v) && isList(v.reopened) && v.reopened.every(isText) && isList(v.notReopened) && isEachNotDone(v.notReopened)
}

export const isMeetMessage = (m: unknown): m is MeetMessage =>
  isRecord(m) &&
  isCount(m.id) &&
  isCount(m.conversationId) &&
  isText(m.authorId) &&
  isText(m.authorName) &&
  isText(m.text) &&
  isCount(m.at) &&
  (m.editedAt === null || isCount(m.editedAt)) &&
  typeof m.mine === 'boolean' &&
  // The call a huddle's message announces: additive, absent from a meet that predates it.
  (m.huddle === undefined || isText(m.huddle)) &&
  // What the person may do with it: additive, absent from a meet that predates it (no buttons are then drawn).
  (m.may === undefined || (isRecord(m.may) && typeof m.may.edit === 'boolean' && typeof m.may.delete === 'boolean'))

/** Meet's `history`. */
export function isMeetHistory(v: unknown): v is MeetHistory {
  return isRecord(v) && typeof v.more === 'boolean' && isList(v.messages) && v.messages.every(isMeetMessage)
}

/** Meet's `post`. */
export function isMeetPosted(v: unknown): v is MeetPosted {
  return isRecord(v) && isCount(v.conversationId) && isMeetMessage(v.message)
}

/** Meet's `markRead`. */
export function isMeetRead(v: unknown): v is MeetRead {
  return isRecord(v) && isCount(v.conversationId) && isCount(v.upTo)
}

// ── People ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One contact as the directory lists it (`InboxContact`). */
export function isInboxContact(v: unknown): v is InboxContact {
  return (
    isRecord(v) &&
    isText(v.contactId) &&
    isText(v.name) &&
    isList(v.identities) &&
    v.identities.every((i) => isRecord(i) && isText(i.id) && isText(i.kind) && mailKinds.has(i.kind) && isText(i.address)) &&
    isList(v.addresses) &&
    v.addresses.every(isText) &&
    (v.client === null || isClientRef(v.client)) &&
    (v.suggestedClient === null || isClientRef(v.suggestedClient)) &&
    isText(v.business) &&
    isText(v.role) &&
    isCount(v.conversations) &&
    isCount(v.rev) &&
    // Additive: an inbox that predates it leaves it out (read as null).
    (v.sendsFrom === undefined || v.sendsFrom === null || isSendsFrom(v.sendsFrom)) &&
    typeof v.automated === 'boolean' &&
    (v.groups === undefined || (isList(v.groups) && v.groups.every(isGroupRef)))
  )
}

/** The inbox's `contacts`. */
export function isInboxContacts(v: unknown): v is InboxContacts {
  return isRecord(v) && isCount(v.automated) && isList(v.contacts) && v.contacts.every(isInboxContact)
}

/** The inbox's `contact`, and what a save of the three fields answers: a contact with its note. */
export function isInboxContactProfile(v: unknown): v is InboxContactProfile {
  return isInboxContact(v) && isText((v as { notes?: unknown }).notes)
}

/** The inbox's `mergeContacts`. */
export function isInboxMerged(v: unknown): v is InboxMerged {
  return isRecord(v) && isCount(v.mergeId) && isInboxContactProfile(v.survivor) && isText(v.absorbedName) && isList(v.moved) && v.moved.every(isText)
}

/** The inbox's `resolveSend`: the message, and where the stuck send stands now. */
export function isInboxSendResolved(v: unknown): v is InboxSendResolved {
  return isRecord(v) && isText(v.id) && (v.status === 'removed' || v.status === 'draft' || v.status === 'sent')
}

/** The inbox's `markDraftSent` and `unmarkSent`: the message, and its conversation (null for a draft on none). */
export function isInboxHandSent(v: unknown): v is InboxHandSent {
  return isRecord(v) && isText(v.messageId) && (v.conversationId === null || isText(v.conversationId))
}

/** The inbox's `splitAddress`: the contact the address came off, and the new one it is on. */
export function isInboxSplitDone(v: unknown): v is InboxSplitDone {
  return isRecord(v) && isInboxContactProfile(v.from) && isInboxContactProfile(v.contact)
}

/** The inbox's `undoContactMerge`. */
export function isInboxUnmerged(v: unknown): v is InboxUnmerged {
  return isRecord(v) && isInboxContactProfile(v.survivor) && isInboxContactProfile(v.restored)
}

/** A `Repeated` as the contract has it: a refusal that says how the first use went. */
function isRepeated(v: unknown): boolean {
  if (!isRecord(v) || v.reason !== 'repeated' || !isRecord(v.earlier)) return false
  if (v.earlier.state === 'in-progress') return true
  return v.earlier.state === 'done' && isReply(v.earlier.reply)
}

// ── Calls ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const callKinds = new Set<string>(CALL_KINDS)

/** A call as a card or a row draws it: its link, who made it, and its state. A kind this space does not know is not understood, and so is a link that is not a link. */
export function isMeetCall(v: unknown): v is MeetCall {
  return (
    isRecord(v) &&
    isText(v.name) &&
    isText(v.link) &&
    /^https?:\/\//.test(v.link) &&
    isText(v.kind) &&
    callKinds.has(v.kind) &&
    (v.title === null || isText(v.title)) &&
    isRecord(v.madeBy) &&
    isText(v.madeBy.name) &&
    typeof v.madeBy.mine === 'boolean' &&
    isCount(v.madeAt) &&
    (v.conversationId === null || isCount(v.conversationId)) &&
    (v.home === null || isText(v.home)) &&
    (v.startsAt === null || isCount(v.startsAt)) &&
    isList(v.invitees) &&
    v.invitees.every((i) => isRecord(i) && isText(i.name) && (i.address === null || isText(i.address))) &&
    isCount(v.present) &&
    isCount(v.people) &&
    isCount(v.messages) &&
    (v.endedAt === null || isCount(v.endedAt)) &&
    // Additive: a meet that predates it leaves it out, and the card then says the call ended without how long it ran.
    (v.openedAt === undefined || v.openedAt === null || isCount(v.openedAt))
  )
}

export const isMeetCalls = (v: unknown): v is MeetCall[] => isList(v) && v.every(isMeetCall)

export function isMeetCallPage(v: unknown): v is MeetCallPage {
  return isRecord(v) && isMeetCalls(v.calls) && (v.next === null || isText(v.next))
}

export function isMeetCallChat(v: unknown): v is MeetCallChat {
  return isRecord(v) && isMeetCall(v.call) && isList(v.messages) && v.messages.every((m) => isRecord(m) && isCount(m.id) && isText(m.name) && isText(m.text) && isCount(m.at))
}

export function isMeetUsage(v: unknown): v is MeetUsage {
  return isRecord(v) && typeof v.usedGb === 'number' && typeof v.freeGb === 'number' && typeof v.tripGb === 'number' && typeof v.paused === 'boolean' && (v.pausedUntil === null || isText(v.pausedUntil))
}

export function isMeetPhone(v: unknown): v is MeetPhone {
  return (
    isRecord(v) &&
    isCount(v.conversationId) &&
    isCount(v.unread) &&
    typeof v.more === 'boolean' &&
    isList(v.items) &&
    v.items.every(
      (i) =>
        isRecord(i) &&
        isCount(i.id) &&
        isCount(i.at) &&
        (i.kind === 'voicemail' || i.kind === 'missed' || i.kind === 'emergency') &&
        isText(i.text) &&
        (i.number === null || isText(i.number)) &&
        (i.display === null || isText(i.display)) &&
        (i.seconds === null || isCount(i.seconds)),
    )
  )
}
