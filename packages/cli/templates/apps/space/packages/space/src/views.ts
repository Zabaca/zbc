// The inbox's other views in the space: Settings (notifications, Claude's sending, the mailboxes and the spam check,
// Gmail, restore), Clients, and the draft chat. (The knowledge base is the knowledge app's: knowledge.ts.) What the page asks of the Worker, and how the inbox behind it is asked.
//
// Each view is one call to the inbox's entrypoint (packages/workspace/src/inbox-for-space.ts, shapes in inbox-views.ts) with the assertion this
// request arrived with, which the inbox verifies again against the space application's audience: the inbox decides who may do what (its owner
// alone), and the space only carries the question. Nothing is stored here.
//
// READS wait `ANSWER_WITHIN_MS` and are `unreachable` when the inbox does not answer. WRITES wait `WRITE_WITHIN_MS` and are NEVER retried: one the
// space lost track of is `outcome-unknown`, and the page says so and offers no second try (asking.ts). None of these writes sends anything or needs a
// compose key (inbox-views.ts says what makes each safe to repeat). An answer that is not the shape the contract says is never half read.

import {
  ANSWER_WITHIN_MS,
  DEVICE_ORIGINS,
  GMAIL_STATES,
  type InboxFile,
  JMAP_PUSH_STATES,
  JMAP_STATES,
  MAILBOX_ID,
  profileLimitMessage,
  type RefusalReason,
  type Reached,
  type ReachedWrite,
  type Repeated,
  type SpaceReply,
  TELEGRAM_STATES,
  WRITE_WITHIN_MS,
} from '@space/workspace'
import { isBool, isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { isInboxContactProfile, isInboxDraft, isInboxHandSent, isInboxMerged, isInboxSendResolved, isInboxSpamResult, isInboxSplitDone, isInboxUnmerged, notConnected, reach, reachWrite } from './reach'

// ── What the page is given ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How a view's call ended, in the words the page needs.
 *
 * - `ok`: the value.
 * - `refused`: the inbox said no and changed nothing, in its own words (`conflict`: the thing changed since it was shown; read it again).
 * - `failed`: the inbox could not do it and knows nothing was changed.
 * - `unreachable`: a READ the inbox did not answer in time, or at all, or in a shape the space cannot read.
 * - `outcome-unknown`: a WRITE the space lost track of. It may have been done. The page says to look, and offers no retry.
 */
export type ViewAnswer<T> =
  | { result: 'ok'; value: T }
  | { result: 'refused'; reason: RefusalReason; message: string }
  | { result: 'failed'; message: string }
  | { result: 'unreachable'; message: string }
  | { result: 'outcome-unknown'; message: string }

export function answerOf<T>(reached: Reached<T> | ReachedWrite<T>): ViewAnswer<T> {
  if (reached.ok) return { result: 'ok', value: reached.value }
  if (reached.kind === 'failed') {
    if (reached.reason === 'broken') return { result: 'failed', message: reached.message }
    return reached.reason === 'outcome-unknown' ? { result: 'outcome-unknown', message: reached.message } : { result: 'unreachable', message: reached.message }
  }
  if (reached.reason === 'repeated') return { result: 'refused', reason: 'conflict', message: (reached as Repeated<T>).message }
  // The space has just signed this person in, so an inbox that says it is not signed in is misconfigured, not the person's sign-in.
  if (reached.reason === 'not-signed-in') {
    console.error('space: the inbox refused a person the space had signed in; a part in this Worker should never say so')
    return { result: 'refused', reason: 'not-signed-in', message: 'The inbox could not check your sign-in.' }
  }
  return { result: 'refused', reason: reached.reason, message: reached.message }
}

// ── The shapes read from an answer ────────────────────────────────────────────────────────────────────────────────────────

const textOrNull = (v: unknown): boolean => v === null || isText(v)
const countOrNull = (v: unknown): boolean => v === null || isCount(v)
const each = (v: unknown, ok: (x: unknown) => boolean): boolean => isList(v) && v.every(ok)

const isMailboxMark = (v: unknown): boolean => isRecord(v) && isText(v.id) && isText(v.name) && isText(v.address)

const isSpamCheck = (v: unknown): boolean => isRecord(v) && isBool(v.enabled) && countOrNull(v.changedAt) && textOrNull(v.changedBy) && isCount(v.judged)

const isBusinessMailbox = (v: unknown): boolean =>
  isMailboxMark(v) &&
  isRecord(v) &&
  countOrNull(v.lastArrivalAt) &&
  textOrNull(v.lastFilingError) &&
  isCount(v.messages) &&
  isCount(v.conversations) &&
  isCount(v.open) &&
  isCount(v.unreadOpen) &&
  isSpamCheck(v.spamCheck) &&
  each(v.reasons, isText)

const gmailStates = new Set<string>(GMAIL_STATES)
const deviceOrigins = new Set<string>(DEVICE_ORIGINS)

const isGmail = (v: unknown): boolean =>
  isRecord(v) &&
  isText(v.id) &&
  isText(v.address) &&
  isText(v.name) &&
  isBool(v.connected) &&
  isText(v.state) &&
  gmailStates.has(v.state) &&
  countOrNull(v.lapsedAt) &&
  countOrNull(v.lastPushAt) &&
  countOrNull(v.lastSyncAt) &&
  countOrNull(v.watchExpiry) &&
  isCount(v.messages) &&
  isCount(v.conversations) &&
  isCount(v.open) &&
  isCount(v.unreadOpen) &&
  each(v.reasons, isText)

const telegramStates = new Set<string>(TELEGRAM_STATES)
const jmapStates = new Set<string>(JMAP_STATES)
const jmapPushStates = new Set<string>(JMAP_PUSH_STATES)

/** A mailbox on the mail server in the menu; the list is ABSENT from an inbox that predates them. */
const isJmapNav = (v: unknown): boolean =>
  v === undefined ||
  each(v, (m) => isMailboxMark(m) && isRecord(m) && isNavCount(m) && isText(m.state) && jmapStates.has(m.state) && countOrNull(m.lastSyncAt) && textOrNull(m.reason))

/** A mailbox on the mail server on its Settings card; the list is ABSENT from an inbox that predates them. */
const isJmapCards = (v: unknown): boolean =>
  v === undefined ||
  each(
    v,
    (m) =>
      isMailboxMark(m) &&
      isRecord(m) &&
      isBool(m.declared) &&
      isText(m.state) &&
      jmapStates.has(m.state) &&
      countOrNull(m.refusedAt) &&
      isText(m.push) &&
      jmapPushStates.has(m.push) &&
      countOrNull(m.lastPushAt) &&
      countOrNull(m.lastSyncAt) &&
      textOrNull(m.lastError) &&
      countOrNull(m.lastErrorAt) &&
      isCount(m.messages) &&
      isCount(m.conversations) &&
      isCount(m.open) &&
      isCount(m.unreadOpen) &&
      each(m.reasons, isText),
  )

/** The Telegram mailbox in the menu or on its card; ABSENT or null from an inbox that has none (or that predates it). */
const isTelegramNav = (v: unknown): boolean =>
  v === undefined || v === null || (isMailboxMark(v) && isRecord(v) && isNavCount(v) && isText(v.state) && telegramStates.has(v.state) && countOrNull(v.checkedInAt) && countOrNull(v.lastPushAt))

const isTelegramCard = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (isMailboxMark(v) &&
    isRecord(v) &&
    isText(v.state) &&
    telegramStates.has(v.state) &&
    countOrNull(v.reportedAt) &&
    countOrNull(v.checkedInAt) &&
    countOrNull(v.lastPushAt) &&
    isBool(v.filled) &&
    isCount(v.messages) &&
    isCount(v.conversations) &&
    isCount(v.open) &&
    isCount(v.unreadOpen))

const isDevice = (v: unknown): boolean =>
  isRecord(v) &&
  isText(v.id) &&
  isText(v.label) &&
  isText(v.origin) &&
  deviceOrigins.has(v.origin) &&
  isText(v.endpoint) &&
  isCount(v.addedAt) &&
  countOrNull(v.lastDeliveredAt) &&
  countOrNull(v.lastFailedAt) &&
  textOrNull(v.lastFailure) &&
  isBool(v.refused) &&
  isCount(v.delivered) &&
  isCount(v.failed)

const isClientSummary = (v: unknown): boolean =>
  isRecord(v) &&
  isCount(v.id) &&
  isText(v.name) &&
  isBool(v.listed) &&
  textOrNull(v.legalEntity) &&
  isCount(v.contacts) &&
  isCount(v.conversations) &&
  isCount(v.open) &&
  textOrNull(v.adminUrl) &&
  isBool(v.archived)

const isDirectory = (v: unknown): boolean => isRecord(v) && isBool(v.available) && textOrNull(v.error)
const isClientContact = (v: unknown): boolean => isRecord(v) && isText(v.contactId) && isText(v.name) && each(v.addresses, isText)

const isTurn = (v: unknown): boolean => isRecord(v) && isCount(v.seq) && isCount(v.at) && textOrNull(v.instruction) && isText(v.note) && isBool(v.revised)

// One guard per view. Each is `v is unknown` in effect (the Worker hands the checked value on to the page as JSON and reads no field of it), so they are
// plain predicates; `reach` only needs to know whether to trust the answer.
const guard =
  <T>(ok: (v: unknown) => boolean) =>
  (v: unknown): v is T =>
    ok(v)

const isNavCount = (v: unknown): boolean => isRecord(v) && isCount(v.count) && isCount(v.unread)
const isNav = guard(
  (v) =>
    isRecord(v) &&
    isRecord(v.views) &&
    ['inbox', 'unread', 'drafts', 'bulk', 'closed'].every((k) => isNavCount((v.views as Record<string, unknown>)[k])) &&
    each(v.mailboxes, (m) => isMailboxMark(m) && isNavCount(m) && isRecord(m) && countOrNull(m.lastArrivalAt) && textOrNull(m.reason)) &&
    each(v.clients, (c) => isRecord(c) && isCount(c.id) && isText(c.name) && isBool(c.listed) && isNavCount(c)) &&
    isCount(v.contacts) &&
    isTelegramNav(v.telegram) &&
    isJmapNav(v.jmap) &&
    each(v.gmailAccounts, (g) => isRecord(g) && isText(g.id) && isText(g.name) && isText(g.address) && isBool(g.connected) && isText(g.state) && gmailStates.has(g.state) && (g.sendsByDefault === undefined || isBool(g.sendsByDefault)) && countOrNull(g.lastPushAt) && textOrNull(g.reason)),
)
const isClaudeSending = guard((v) => isRecord(v) && isBool(v.enabled) && countOrNull(v.changedAt))
const isMailboxes = guard((v) => isRecord(v) && each(v.gmailAccounts, isGmail) && each(v.mailboxes, isBusinessMailbox) && isTelegramCard(v.telegram) && isJmapCards(v.jmap) && isBool(v.assistantKey) && (v.capabilities === undefined || each(v.capabilities, isText)))
const isSpamCheckAnswer = guard(isSpamCheck)
const isGmailChanged = guard((v) => isRecord(v) && (v.change === 'sync' || v.change === 'disconnect') && (v.revoked === null || isBool(v.revoked)))
const isNotifications = guard(
  (v) => isRecord(v) && textOrNull(v.publicKey) && each(v.devices, isDevice) && isRecord(v.week) && isCount(v.week.sent) && isCount(v.week.dropped),
)
const isDeviceAnswer = guard(isDevice)
const isRemoved = guard((v) => isRecord(v) && isText(v.id))
const isTestSent = guard((v) => isRecord(v) && isText(v.outcome) && ['delivered', 'gone', 'refused', 'too-large', 'failed'].includes(v.outcome) && countOrNull(v.status))
const isRestoreReport = guard(
  (v) =>
    isRecord(v) &&
    isText(v.current) &&
    textOrNull(v.restoresError) &&
    each(
      v.restores,
      (r) => isRecord(r) && (r.kind === 'prepared' || r.kind === 'restored') && isText(r.id) && isText(r.at) && isText(r.actor) && isText(r.target) && textOrNull(r.targetTime) && textOrNull(r.undoBookmark),
    ),
)
const isRestorePlan = guard((v) => isRecord(v) && isText(v.target) && textOrNull(v.targetTime) && isText(v.token) && isText(v.expiresAt))
const isRestoreDone = guard((v) => isRecord(v) && isText(v.restoredTo) && textOrNull(v.targetTime) && isText(v.undoBookmark))
export const isClients = guard((v) => isRecord(v) && isDirectory(v.directory) && each(v.clients, isClientSummary))
export const isClientPage = guard(
  (v) =>
    isRecord(v) &&
    isDirectory(v.directory) &&
    isClientSummary(v.client) &&
    each(v.contacts, isClientContact) &&
    each(v.suggestions, (s) => isClientContact(s) && isRecord(s) && (s.reason === 'address' || s.reason === 'domain') && isText(s.via)),
)
const isLinked = guard((v) => isRecord(v) && isText(v.contactId) && (v.clientId === null || isCount(v.clientId)))
const isDraftAnswer = guard(isInboxDraft)
const isSpamAnswer = guard(isInboxSpamResult)
const isResolvedAnswer = guard(isInboxSendResolved)
const isHandSentAnswer = guard(isInboxHandSent)
const isSplitAnswer = guard(isInboxSplitDone)
const isTurns = guard((v) => each(v, isTurn))
const isChatAnswer = guard((v) => isRecord(v) && isText(v.draftId) && isCount(v.rev) && isText(v.text) && isText(v.subject) && isTurn(v.turn))

// ── What the inbox says it can do ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether the inbox says it can do something an older inbox would IGNORE rather than refuse (the contract's `INBOX_CAPABILITIES`), asked of the answer the New email box reads anyway (`mailboxes`).
 * `yes`; `no`, in the inbox's silence (an answer that does not list it, which is what an inbox that predates it gives); or the words for an inbox that could not be asked. Nothing that depends
 * on a capability is sent on anything but `yes`.
 */
export async function inboxCan(ask: Asking, capability: string): Promise<{ can: true } | { can: false; message: string }> {
  const { inbox } = ask.apps
  if (!inbox) return { can: false, message: 'Email is not connected to the space.' }
  const got = await reach('Email', () => inbox.mailboxes(ask.signedIn), isMailboxes, ask.answerWithinMs ?? ANSWER_WITHIN_MS)
  if (!got.ok) return { can: false, message: `${got.message} The space could not tell whether the inbox can do this.` }
  return (got.value as { capabilities?: string[] }).capabilities?.includes(capability) === true ? { can: true } : { can: false, message: NOT_UPDATED }
}

/** What is said when the inbox does not list a capability: it would send from the wrong mailbox, or leave files out, and not say so. */
export const NOT_UPDATED = 'The inbox has not been updated to send a new email from a mailbox you choose or with files: it would send from the mailbox the person last wrote to and leave the files out.'

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The longest id, address or token a request names (a mailbox has its own pattern, the contract's `MAILBOX_ID`): a path-shaped or enormous string never reaches the inbox. */
const SHORT = /^[A-Za-z0-9@._:+-]{1,200}$/

export type ReadName = 'navigation' | 'claude-sending' | 'mailboxes' | 'notifications' | 'restore' | 'clients' | 'client' | 'draft-chat'

export const READ_NAMES: readonly ReadName[] = ['navigation', 'claude-sending', 'mailboxes', 'notifications', 'restore', 'clients', 'client', 'draft-chat']

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

async function read<T>(ask: Asking, call: (inbox: NonNullable<Asking['apps']['inbox']>) => Promise<SpaceReply<T>>, valid: (v: unknown) => v is T): Promise<ViewAnswer<T>> {
  const { inbox } = ask.apps
  return answerOf(inbox ? await reach('Email', () => call(inbox), valid, ask.answerWithinMs ?? ANSWER_WITHIN_MS) : notConnected('Email'))
}

/** A read the page asked for by name, with the query it sent. A name or a query that is none of the above is a 400 at the route. */
export async function readView(ask: Asking, name: ReadName, query: URLSearchParams): Promise<Parsed<ViewAnswer<unknown>>> {
  const a = ask.signedIn
  switch (name) {
    case 'navigation':
      return { ok: true, value: await read(ask, (i) => i.navigation(a), isNav) }
    case 'claude-sending':
      return { ok: true, value: await read(ask, (i) => i.claudeSending(a), isClaudeSending) }
    case 'mailboxes':
      return { ok: true, value: await read(ask, (i) => i.mailboxes(a), isMailboxes) }
    case 'notifications':
      return { ok: true, value: await read(ask, (i) => i.notifications(a), isNotifications) }
    case 'restore':
      return { ok: true, value: await read(ask, (i) => i.restoreReport(a), isRestoreReport) }
    case 'clients':
      return { ok: true, value: await read(ask, (i) => i.clients(a), isClients) }
    case 'client': {
      const id = Number(query.get('id'))
      if (!Number.isSafeInteger(id) || id < 1) return { ok: false, message: 'Ask for one Client: id=<number>.' }
      return { ok: true, value: await read(ask, (i) => i.client(a, id), isClientPage) }
    }
    case 'draft-chat': {
      const conversation = query.get('conversation') ?? ''
      const draft = query.get('draft') ?? ''
      if (!SHORT.test(conversation) || !SHORT.test(draft)) return { ok: false, message: 'Ask for one draft’s chat: conversation=<id>&draft=<id>.' }
      return { ok: true, value: await read(ask, (i) => i.draftChat(a, conversation, draft), isTurns) }
    }
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WriteName =
  | 'claude-sending'
  | 'spam-check'
  | 'gmail'
  | 'device-add'
  | 'device-remove'
  | 'device-test'
  | 'restore-prepare'
  | 'restore-confirm'
  | 'client-link'
  | 'chat'
  | 'contact-profile'
  | 'contact-merge'
  | 'contact-unmerge'
  | 'draft-edit'
  | 'spam'
  | 'resolve-send'
  | 'draft-sent'
  | 'draft-unsent'
  | 'contact-rename'
  | 'contact-split'

export const WRITE_NAMES: readonly WriteName[] = [
  'claude-sending',
  'spam-check',
  'gmail',
  'device-add',
  'device-remove',
  'device-test',
  'restore-prepare',
  'restore-confirm',
  'client-link',
  'chat',
  'contact-profile',
  'contact-merge',
  'contact-unmerge',
  'draft-edit',
  'spam',
  'resolve-send',
  'draft-sent',
  'draft-unsent',
  'contact-rename',
  'contact-split',
]

/** The longest chat instruction or restore bookmark taken: the inbox applies its own, shorter limits. */
const TEXT_MAX = 20_000

/** The longest subject or draft body an edit is taken with: far past what anyone writes (the inbox's own send limit is 100 000 characters). */
const DRAFT_MAX = 100_000
/** The most addresses one draft's Cc may be sent here with: a send takes at most 20 people, and a longer list is refused before it reaches the inbox. */
const CC_MAX = 50

async function write<T>(ask: Asking, call: (inbox: NonNullable<Asking['apps']['inbox']>) => Promise<SpaceReply<T>>, valid: (v: unknown) => v is T): Promise<Parsed<ViewAnswer<unknown>>> {
  const { inbox } = ask.apps
  if (!inbox) return { ok: true, value: { result: 'failed', message: 'Email is not connected to the space. Nothing was changed.' } }
  return { ok: true, value: answerOf(await reachWrite('Email', () => call(inbox), valid, ask.writeWithinMs ?? WRITE_WITHIN_MS)) }
}

const bad = (message: string): Parsed<never> => ({ ok: false, message })

/**
 * ONE picture put on a Telegram draft, or put over the one it has, at the revision the card shows: the form `/api/draft-picture` takes (`json`: the draft and the revision; one `file`). The inbox checks the
 * file by its own first bytes and the draft's chat; an edit of the draft like an edit of its words (`conflict` when it has moved on), so it takes no compose key. The answer is the same view answer a draft edit gives.
 */
export async function putDraftPictureView(ask: Asking, draft: { draftId: unknown; rev: unknown }, file: InboxFile): Promise<Parsed<ViewAnswer<unknown>>> {
  if (!isText(draft.draftId) || !SHORT.test(draft.draftId)) return bad('Name the draft: draftId.')
  if (!isCount(draft.rev)) return bad('Say which revision of the draft you were shown (rev).')
  const put = { draftId: draft.draftId, rev: draft.rev, picture: file }
  return write(ask, (i) => i.putDraftPicture(ask.signedIn, put), isDraftAnswer)
}

/** A write the page made by name, with the JSON body it sent and the browser's own name (for a device). */
export async function writeView(ask: Asking, name: WriteName, body: unknown, userAgent: string | null): Promise<Parsed<ViewAnswer<unknown>>> {
  const a = ask.signedIn
  if (!isRecord(body)) return bad('Send a JSON object.')
  switch (name) {
    case 'claude-sending':
      if (!isBool(body.enabled)) return bad('Say which: {"enabled": true} or {"enabled": false}.')
      return write(ask, (i) => i.setClaudeSending(a, body.enabled as boolean), isClaudeSending)
    case 'spam-check':
      if (!isText(body.mailboxId) || !MAILBOX_ID.test(body.mailboxId) || !isBool(body.enabled)) return bad('Name the mailbox and say which: mailboxId, enabled.')
      return write(ask, (i) => i.setSpamCheck(a, body.mailboxId as string, body.enabled as boolean), isSpamCheckAnswer)
    case 'gmail': {
      if (body.change !== 'sync' && body.change !== 'disconnect') return bad('Gmail can be synced or disconnected.')
      // The account (`InboxGmail.id`): needed to disconnect, and for a sync it narrows it to that account (none syncs every one).
      const account = body.mailboxId
      if (account !== undefined && (!isText(account) || !MAILBOX_ID.test(account))) return bad('Name the Gmail account by its id (mailboxId).')
      if (body.change === 'disconnect' && account === undefined) return bad('Name the Gmail account to disconnect (mailboxId).')
      return write(ask, (i) => i.changeGmail(a, body.change as 'sync' | 'disconnect', account as string | undefined), isGmailChanged)
    }
    case 'device-add': {
      const keys = body.keys
      if (!isText(body.endpoint) || body.endpoint.length > 1024 || !isRecord(keys) || !isText(keys.p256dh) || !isText(keys.auth)) {
        return bad('Send the device as the browser gives it: endpoint and keys.')
      }
      const device = { endpoint: body.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
      return write(ask, (i) => i.addDevice(a, device, userAgent), isDeviceAnswer)
    }
    case 'device-remove':
      if (!isText(body.id) || !SHORT.test(body.id)) return bad('Name the device: id.')
      return write(ask, (i) => i.removeDevice(a, body.id as string), isRemoved)
    case 'device-test':
      if (!isText(body.id) || !SHORT.test(body.id)) return bad('Name the device: id.')
      return write(ask, (i) => i.testDevice(a, body.id as string), isTestSent)
    case 'restore-prepare': {
      const choice = isText(body.time) ? { time: body.time } : isText(body.bookmark) ? { bookmark: body.bookmark } : null
      if (choice === null || (body.time !== undefined && body.bookmark !== undefined)) return bad('Say a time, or a bookmark, and not both.')
      return write(ask, (i) => i.prepareRestore(a, choice), isRestorePlan)
    }
    case 'restore-confirm':
      // The second step needs what the first answered, so a restore cannot be made from a stale screen or in one press.
      if (!isText(body.token) || !isText(body.bookmark)) return bad('Send back the token and the bookmark the preparation named.')
      return write(ask, (i) => i.confirmRestore(a, { token: body.token as string, bookmark: body.bookmark as string }), isRestoreDone)
    case 'client-link': {
      const client = body.clientId
      if (!isText(body.contactId) || !SHORT.test(body.contactId) || !(client === null || (Number.isSafeInteger(client) && (client as number) > 0))) return bad('Name the person and the Client, or null to take them out.')
      return write(ask, (i) => i.linkClient(a, body.contactId as string, client as number | null), isLinked)
    }
    // People. The three fields name the revision the person was shown, and a merge names the revision of each: the inbox refuses a write over a person who has moved on.
    case 'contact-profile': {
      if (!isText(body.contactId) || !SHORT.test(body.contactId)) return bad('Name the person: contactId.')
      if (!isCount(body.rev)) return bad('Say which revision of the person you were shown (rev).')
      if (!isText(body.business) || !isText(body.role) || !isText(body.notes)) return bad('Send the business, the role and the note, as text.')
      const tooLong = profileLimitMessage({ business: body.business, role: body.role, notes: body.notes })
      if (tooLong !== null) return bad(tooLong)
      const edit = { contactId: body.contactId, rev: body.rev, business: body.business, role: body.role, notes: body.notes }
      return write(ask, (i) => i.saveContactProfile(a, edit), isInboxContactProfile)
    }
    case 'contact-merge': {
      if (!isText(body.survivorId) || !SHORT.test(body.survivorId) || !isText(body.absorbedId) || !SHORT.test(body.absorbedId)) return bad('Name the two people: survivorId, absorbedId.')
      if (body.survivorId === body.absorbedId) return bad('A person cannot be merged into themselves.')
      if (!isCount(body.survivorRev) || !isCount(body.absorbedRev)) return bad('Say which revision of each person you were shown.')
      const merge = { survivorId: body.survivorId, survivorRev: body.survivorRev, absorbedId: body.absorbedId, absorbedRev: body.absorbedRev }
      return write(ask, (i) => i.mergeContacts(a, merge), isInboxMerged)
    }
    case 'contact-unmerge': {
      if (!isCount(body.mergeId)) return bad('Name the merge: mergeId.')
      const mergeId = body.mergeId
      return write(ask, (i) => i.undoContactMerge(a, mergeId), isInboxUnmerged)
    }
    // A draft's words, at the revision the card shows (the inbox's own draft edit). It sends nothing and takes no key: a repeat names a revision that has moved, so it is `conflict`.
    case 'draft-edit': {
      if (!isText(body.draftId) || !SHORT.test(body.draftId)) return bad('Name the draft: draftId.')
      if (!isCount(body.rev)) return bad('Say which revision of the draft you were shown (rev).')
      if ((body.subject !== undefined && !isText(body.subject)) || (body.text !== undefined && !isText(body.text))) return bad('The subject and the words are text.')
      if (body.copyEveryone !== undefined && !isBool(body.copyEveryone)) return bad('copyEveryone is yes or no.')
      // `cc` is the whole list of addresses the draft copies (it replaces the draft's), as typed; the inbox decides which are addresses and refuses the rest with nothing changed.
      if (body.cc !== undefined && !(isList(body.cc) && body.cc.length <= CC_MAX && body.cc.every((a) => isText(a) && a.length <= 320))) return bad('cc is a list of email addresses.')
      if (body.takeOutPicture !== undefined && body.takeOutPicture !== true) return bad('takeOutPicture is true, or left out.')
      if (body.subject === undefined && body.text === undefined && body.copyEveryone === undefined && body.cc === undefined && body.takeOutPicture === undefined) return bad('Change the subject, the words, who is copied or the picture.')
      if ((body.subject?.length ?? 0) > DRAFT_MAX || (body.text?.length ?? 0) > DRAFT_MAX) return bad('That is longer than a draft can be.')
      const edit = { draftId: body.draftId, rev: body.rev, ...(body.subject !== undefined && { subject: body.subject }), ...(body.text !== undefined && { text: body.text }), ...(body.copyEveryone !== undefined && { copyEveryone: body.copyEveryone }), ...(body.cc !== undefined && { cc: body.cc as string[] }), ...(body.takeOutPicture === true && { takeOutPicture: true }) }
      return write(ask, (i) => i.editDraft(a, edit), isDraftAnswer)
    }
    // A conversation called spam, or not: the inbox's own Mark as spam and Move to the Inbox. A boolean is required, so an empty body can never mean either.
    case 'spam': {
      if (!isText(body.conversationId) || !SHORT.test(body.conversationId)) return bad('Name the conversation: conversationId.')
      if (!isBool(body.spam)) return bad('Say which: {"spam": true} or {"spam": false}.')
      const mark = { conversationId: body.conversationId, spam: body.spam }
      return write(ask, (i) => i.setSpam(a, mark), isSpamAnswer)
    }
    // The last five things the inbox's own page did. None sends mail, so none carries a compose key: a settled send, a mark and a rename or split at a revision are each
    // refused the second time, never applied twice.
    //
    // How a send Gmail never confirmed went, said by the person who looked in Gmail Sent. A boolean is required, so an empty body can never mean either.
    case 'resolve-send': {
      if (!isText(body.draftId) || !SHORT.test(body.draftId)) return bad('Name the message: draftId.')
      if (!isBool(body.sent)) return bad('Say whether it went out: {"sent": true} or {"sent": false}.')
      const resolution = { draftId: body.draftId, sent: body.sent }
      return write(ask, (i) => i.resolveSend(a, resolution), isResolvedAnswer)
    }
    // A text or a direct message draft, sent by hand and filed on the person's conversation; and "Not sent after all", its undo.
    case 'draft-sent': {
      if (!isText(body.draftId) || !SHORT.test(body.draftId)) return bad('Name the draft: draftId.')
      const draftId = body.draftId
      return write(ask, (i) => i.markDraftSent(a, draftId), isHandSentAnswer)
    }
    case 'draft-unsent': {
      if (!isText(body.messageId) || !SHORT.test(body.messageId)) return bad('Name the message: messageId.')
      const messageId = body.messageId
      return write(ask, (i) => i.unmarkSent(a, messageId), isHandSentAnswer)
    }
    // A contact renamed, and an address split off one, each at the revision of the contact the person was shown. The inbox's own refusals (an empty name, a contact's only address) are its words.
    case 'contact-rename': {
      if (!isText(body.contactId) || !SHORT.test(body.contactId)) return bad('Name the person: contactId.')
      if (!isCount(body.rev)) return bad('Say which revision of the person you were shown (rev).')
      if (!isText(body.name)) return bad('A name is text.')
      const rename = { contactId: body.contactId, rev: body.rev, name: body.name }
      return write(ask, (i) => i.renameContact(a, rename), isInboxContactProfile)
    }
    case 'contact-split': {
      if (!isText(body.contactId) || !SHORT.test(body.contactId) || !isText(body.identityId) || !SHORT.test(body.identityId)) return bad('Name the person and the address: contactId, identityId.')
      if (!isCount(body.rev)) return bad('Say which revision of the person you were shown (rev).')
      const split = { contactId: body.contactId, rev: body.rev, identityId: body.identityId }
      return write(ask, (i) => i.splitAddress(a, split), isSplitAnswer)
    }
    case 'chat': {
      if (!isText(body.conversationId) || !SHORT.test(body.conversationId) || !isText(body.draftId) || !SHORT.test(body.draftId)) return bad('Name the draft and its conversation.')
      if (!Number.isSafeInteger(body.rev) || (body.rev as number) < 0) return bad('Say which revision of the draft you were shown (rev).')
      if (!isText(body.instruction) || body.instruction.trim() === '' || body.instruction.length > TEXT_MAX) return bad('Say what you want the assistant to do.')
      const chat = { conversationId: body.conversationId, draftId: body.draftId, rev: body.rev as number, instruction: body.instruction }
      return write(ask, (i) => i.chat(a, chat), isChatAnswer)
    }
  }
}
