/**
 * What the inbox answers the space: `InboxForSpace`, the
 * contract in packages/workspace/src/inbox-for-space.ts, implemented as a function over the inbox's own store. The space's
 * Worker calls it in-process (src/space-part.ts), as the Durable Object is around the store, so every rule here
 * runs under plain `bun` against the real store and the real Mailroom (test/space.test.ts).
 *
 * ── WHO IS ASKING, AND WHAT THEY MAY SEE ──────────────────────────────────
 * Every method takes the person the space's ONE sign-in check named (`SignedIn`, the company layer's ADR 0003: the check is the space's, made once per request, and this part runs in the
 * space's Worker), and applies the inbox's own rule (src/space-gate.ts): the install's owner is admitted, and so is anyone else of the install who is on at least one mailbox (the inbox's ADR 0004;
 * `roleFor` alone admits the owner and nobody else). The gate hands each method what the person may SEE (`MailScope`, src/queue.ts: the
 * mailboxes they are on), and every read below is cut to it before anything is counted, listed or searched, and every method that names a conversation or a message by its id asks `seesConversation`
 * or `seesMessage` first, so an id the person may not see answers exactly as one that does not exist. A person sends only from the mailboxes they are on, and what is checked is checked again in the
 * store (`createDraft`, `planSend`). No method takes the Access assertion the space
 * forwarded to verify it again: the one check is the space's. No service token is ever the person here: Claude's script reaches the
 * inbox on its own door (the space's agent path), with its own token, and its router is src/app.ts. A person the space merely NAMES would be a person the inbox took on faith; there is
 * no argument to name one in: only the space's check makes a `SignedIn`.
 *
 * ── CLAUDE NEVER SENDS HERE ───────────────────────────────────────────────
 * The inbox's ADR 0001: Claude drafts and the owner sends. `send` is the owner pressing Send in the space, so it is reachable
 * only as them, signed in through the space, and it acts as the owner, never as the agent. It is the SAME path as the inbox's own Send
 * (create the draft, then `Mailroom.sendDraft`), so every refusal of that path applies: a new message that arrived since the
 * thread was shown, an edited draft, an em dash, a recipient that is ours. Claude's sending switch is the agent's gate and is
 * not touched. Claude's script and the drafts path are not touched at all.
 *
 * ── A SEND GOES OUT AT MOST ONCE ──────────────────────────────────────────
 * The inbox's own checks look only at inbound mail after `through`, so a second press with the same `through` would make a second
 * draft and send a second email. Every send therefore carries the compose key the space chose, and the store keeps it
 * (src/store/space.ts `claimCompose`): a key whose first use MAY have sent something is HELD and answers `Repeated`; a first use
 * that was refused, or failed with the inbox knowing nothing went out, RELEASES it; when Gmail never said, the answer is a success
 * with status `sending` and the key stays held. There is no timer on the inbox's side of a send: it answers when Gmail has (up to
 * 25 seconds), however long the space has been waiting, and the space waits `WRITE_WITHIN_MS`, longer than that.
 *
 * ── AN ENTRYPOINT THROWS FOR NOTHING IT CAN FORESEE ───────────────────────
 * An error thrown across a service binding arrives as a message with its type gone, so each method answers a `SpaceReply`: the
 * value, a refusal (a decision) or `broken` (a fault). The one thing this file cannot be sure of after a fault is a send whose
 * answer it lost; that is answered as `sending`, never as `broken`.
 */

import {
  answered,
  COMPOSE_KEY,
  type Failed,
  type FileRange,
  failed,
  INBOX_HISTORY_PAGE,
  INBOX_MOST_FILE_BYTES,
  INBOX_MOST_FILES,
  INBOX_MOST_MARKS,
  type InboxAddress,
  type InboxAttachment,
  type InboxCloseMark,
  type InboxCloseResult,
  type InboxDeliveryNote,
  type InboxDraft,
  type InboxDraftAt,
  type InboxDraftEdit,
  type InboxDraftPicture,
  type InboxFile,
  type InboxFileOut,
  type InboxForSpace,
  type InboxFrom,
  type InboxHandSent,
  type InboxHistory,
  type InboxHistoryQuery,
  type InboxHit,
  type InboxMessage,
  type InboxParty,
  type InboxPeople,
  type InboxPerson,
  type InboxReadMark,
  type InboxReadResult,
  type InboxReopenResult,
  type InboxScope,
  type InboxSearch,
  type InboxSend,
  type InboxSendResolution,
  type InboxSendResolved,
  type InboxSent,
  type InboxSpamMark,
  type InboxSpamResult,
  type InboxThread,
  type InboxThreadLine,
  type InboxWho,
  isFileRange,
  MAILBOX_ID,
  NOT_ADMITTED,
  normalizeAddress,
  type Refused,
  readInboxFrom,
  refused,
  repeated,
  type SignedIn,
  type SpaceReply,
  type WriteReply,
} from '@space/workspace'
import { repairMojibake } from './charset'
import { type ClientsRead, clientLabel, clientsById, readClients, suggestClients } from './clients'
import { tooLargeToOpen, wantsPreview } from './image'
import { type InboxOwner, inboxOwnerOf } from './owner'
import { filesFromBusinessMailboxOnly } from './owner-words'
import type { MailScope } from './queue'
import { readText, viaGmail } from './read'
import { searchTerms } from './search'
import {
  BAD,
  FAULT,
  ID,
  isCount,
  isRecord,
  ms,
  outcomeOf,
  ownerGate,
  personGate,
  type SpaceDeps,
  seesConversation,
  seesMessage,
  spelled,
} from './space-gate'
import { createSpaceOperator } from './space-operator'
import { createSpacePeople } from './space-people'
import { createSpaceViews } from './space-views'
import { parseCcList } from './store/address'
import { type Reach, readPlace } from './store/paging'
import type { SpaceConversation, SpaceParty } from './store/space'
import type { Result } from './store/store'
import { telegramFileNote } from './telegram/media'
import {
  type AttachmentInfo,
  type ClientLabel,
  type DeliveryNote,
  type DraftPatch,
  draftAuthor,
  draftEditedBy,
  isClientId,
  isPending,
  type MessageRow,
} from './types'
import type { Install } from './workspace'

/** The most addresses one question names: a screen, not a script. (The most conversations one mark-read, close or reopen names is the contract's `INBOX_MOST_MARKS`.) */
const MOST_ADDRESSES = 100

const toParty = (p: SpaceParty): InboxParty => ({
  contactId: p.contactId,
  name: p.name,
  address: normalizeAddress(p.here) ?? spelled(p.emails)[0] ?? null,
})

/**
 * A draft's Cc header as the people it copies: one entry for each address in it, in order, with the name the header gave it, else the one the
 * inbox knows it by, else the address. An entry that is no address (an edited header that is not one) is kept as written, as its own name and
 * address, so a Cc is never shortened: what the person is shown is everything the send will copy.
 */
export async function copiedTo(
  cc: string,
  nameOf: (address: string) => Promise<string | null>,
): Promise<InboxAddress[]> {
  const out: InboxAddress[] = []
  for (const piece of splitList(cc)) {
    const angled = /^(.*?)<([^<>]*)>\s*$/.exec(piece)
    const written = (angled ? angled[2] : piece)?.trim() ?? ''
    const address = normalizeAddress(written) ?? written
    if (address === '') continue
    const label = (angled?.[1] ?? '').replace(/^["'\s]+|["'\s]+$/g, '').trim()
    const known = label === '' && normalizeAddress(address) !== null ? await nameOf(address) : null
    out.push({ name: label !== '' ? label : (known ?? address), address })
  }
  return out
}

/** A header list split on the commas that are not inside quotes or angle brackets, each piece trimmed, empty ones dropped. */
function splitList(list: string): string[] {
  const pieces: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') depth++
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1)
    else if (!quoted && depth === 0 && ch === ',') {
      pieces.push(list.slice(start, i))
      start = i + 1
    }
  }
  pieces.push(list.slice(start))
  return pieces.map((p) => p.trim()).filter((p) => p !== '')
}

type Scope = { bulk: boolean; closed: boolean }

function readInclude(raw: unknown): Scope | Refused {
  if (raw === undefined) return { bulk: false, closed: false }
  if (!Array.isArray(raw) || raw.some((x) => x !== 'bulk' && x !== 'closed')) {
    return BAD('include may name bulk and closed, and nothing else.')
  }
  return { bulk: raw.includes('bulk'), closed: raw.includes('closed') }
}

/** Whether the Sent view is asked for: absent is no, and anything but a boolean is refused. */
const readSent = (raw: unknown): boolean | Refused =>
  raw === undefined ? false : typeof raw === 'boolean' ? raw : BAD('sent is true or false.')

/** Whether the Drafts view is asked for: absent is no, and anything but a boolean is refused. */
const readDrafts = (raw: unknown): boolean | Refused =>
  raw === undefined ? false : typeof raw === 'boolean' ? raw : BAD('drafts is true or false.')

/** What a scope narrows a list to besides contacts: a mailbox, a Client, the unread ones. Absent is no narrowing; anything that is not what it names is refused. */
interface Narrowing {
  mailbox?: string
  client?: number
  unread?: true
}

function readNarrowing(scope?: InboxScope): Narrowing | Refused {
  const out: Narrowing = {}
  if (scope?.mailbox !== undefined) {
    if (typeof scope.mailbox !== 'string' || !MAILBOX_ID.test(scope.mailbox)) return BAD('mailbox is a mailbox id.')
    out.mailbox = scope.mailbox
  }
  if (scope?.client !== undefined) {
    if (!isClientId(scope.client)) return BAD('client is a Client id, a whole number from 1.')
    out.client = scope.client
  }
  if (scope?.unread !== undefined) {
    if (typeof scope.unread !== 'boolean') return BAD('unread is true or false.')
    if (scope.unread) out.unread = true
  }
  return out
}

/** How far down a list a read asks to go: the position an earlier answer gave as its `floor` and whether one more screen is asked for. Absent is the newest screen. */
function readReach(scope?: InboxScope): Reach | Refused {
  if (scope?.older !== undefined && typeof scope.older !== 'boolean') return BAD('older is true or false.')
  if (scope?.through === undefined) {
    return scope?.older === true ? BAD('older goes with through, the position the list was read down to.') : {}
  }
  const through = typeof scope.through === 'string' ? readPlace(scope.through) : null
  if (through === null) return BAD('through is a position an earlier answer gave as its floor.')
  return { through, ...(scope.older === true && { older: true }) }
}

/** What a scope asks besides contacts: `include` (Bulk, Closed), `sent` or `drafts` only when true, what it narrows to, and how far down the list it reads. */
function readFlags(scope?: InboxScope): (Scope & Narrowing & { sent?: true; drafts?: true; reach?: Reach }) | Refused {
  const include = readInclude(scope?.include)
  if ('ok' in include) return include
  const sent = readSent(scope?.sent)
  if (typeof sent !== 'boolean') return sent
  const drafts = readDrafts(scope?.drafts)
  if (typeof drafts !== 'boolean') return drafts
  const narrowing = readNarrowing(scope)
  if ('ok' in narrowing) return narrowing
  const reach = readReach(scope)
  if ('ok' in reach) return reach
  return {
    ...include,
    ...(sent && { sent }),
    ...(drafts && { drafts }),
    ...narrowing,
    ...(reach.through !== undefined && { reach }),
  }
}

type Compose = { key: string } & (
  | { how: 'draft'; draftId: string; rev: number; through: number | null }
  | {
      how: 'reply'
      conversationId: string
      through: number
      subject: string
      text: string
      copyEveryone: boolean
      files: InboxFile[]
    }
  | {
      how: 'new'
      address: string
      name: string
      subject: string
      text: string
      from: InboxFrom | undefined
      files: InboxFile[]
    }
)

function readSend(raw: unknown, owner: InboxOwner): Compose | Refused {
  if (!isRecord(raw)) return BAD('A send is an object.')
  if (typeof raw.key !== 'string' || !COMPOSE_KEY.test(raw.key)) {
    return BAD('A send carries the key chosen for this message: 16 to 128 letters, digits, _ and -.')
  }
  const named = ['draftId', 'conversationId', 'address'].filter((f) => raw[f] !== undefined)
  if (named.length !== 1)
    return BAD('A send names a draft (draftId), a conversation (conversationId) or an address (address).')
  const through = raw.through === undefined || raw.through === null ? null : raw.through
  if (through !== null && !isCount(through)) return BAD('through is how far into the conversation you read.')
  if (typeof raw.draftId === 'string') return readDraftSend(raw.key, raw, raw.draftId, through)
  if (typeof raw.conversationId === 'string') return readReplySend(raw.key, raw, raw.conversationId, through)
  return readNewSend(raw.key, raw, owner)
}

function readDraftSend(
  key: string,
  raw: Record<string, unknown>,
  draftId: string,
  through: number | null,
): Compose | Refused {
  if (!ID.test(draftId)) return refused('not-found', 'No such message.')
  if (!isCount(raw.rev)) return BAD('Say which version of the draft you are sending (rev).')
  return { key, how: 'draft', draftId, rev: raw.rev, through }
}

function readReplySend(
  key: string,
  raw: Record<string, unknown>,
  conversationId: string,
  through: number | null,
): Compose | Refused {
  if (!ID.test(conversationId)) return refused('not-found', 'No such conversation.')
  if (through === null) return BAD('Say how far into the conversation you have read (through).')
  if (typeof raw.text !== 'string') return BAD('A reply needs its words (text).')
  if (raw.subject !== undefined && typeof raw.subject !== 'string') return BAD('The subject is text.')
  if (raw.copyEveryone !== undefined && typeof raw.copyEveryone !== 'boolean') return BAD('copyEveryone is yes or no.')
  const files = readFiles(raw.attachments)
  if ('ok' in files) return files
  return {
    key,
    how: 'reply',
    conversationId,
    through,
    subject: raw.subject ?? '',
    text: raw.text,
    copyEveryone: raw.copyEveryone === true,
    files: files.files,
  }
}

/**
 * The files of a reply, as the contract names them: at most INBOX_MOST_FILES, INBOX_MOST_FILE_BYTES together, each a name, a type and real bytes (a
 * Uint8Array: a binding carries one whole). Counted here as well as where they are sent, so a send past the limit is refused before a draft is made.
 */
function readFiles(raw: unknown): { files: InboxFile[] } | Refused {
  if (raw === undefined) return { files: [] }
  if (!Array.isArray(raw)) return BAD('attachments is a list of files.')
  if (raw.length > INBOX_MOST_FILES) return BAD(`A message carries at most ${INBOX_MOST_FILES} files.`)
  let total = 0
  const files: InboxFile[] = []
  for (const f of raw) {
    if (!isRecord(f) || typeof f.name !== 'string' || typeof f.type !== 'string' || !(f.bytes instanceof Uint8Array)) {
      return BAD('A file is a name, a type and its bytes.')
    }
    if (f.bytes.length === 0) return BAD(`${f.name.slice(0, 80)} is empty.`)
    total += f.bytes.length
    if (total > INBOX_MOST_FILE_BYTES)
      return BAD(`The files come to more than ${INBOX_MOST_FILE_BYTES / (1024 * 1024)} MB together.`)
    files.push({ name: f.name, type: f.type, bytes: f.bytes })
  }
  return { files }
}

/** A draft edit: the draft, the revision shown, and the words that change. At least one of the two must. */
function readEdit(edit: unknown): { id: string; patch: DraftPatch } | Refused {
  if (!isRecord(edit)) return BAD('A draft edit is an object.')
  if (typeof edit.draftId !== 'string' || !ID.test(edit.draftId)) return refused('not-found', 'No such message.')
  if (!isCount(edit.rev)) return BAD('Say which version of the draft you were shown (rev).')
  if (edit.subject !== undefined && typeof edit.subject !== 'string') return BAD('The subject is text.')
  if (edit.text !== undefined && typeof edit.text !== 'string') return BAD('The words are text.')
  if (edit.copyEveryone !== undefined && typeof edit.copyEveryone !== 'boolean')
    return BAD('copyEveryone is yes or no.')
  if (edit.cc !== undefined) {
    const listed = parseCcList(edit.cc)
    if (!listed.ok) return BAD(listed.error)
  }
  if (edit.takeOutPicture !== undefined && edit.takeOutPicture !== true)
    return BAD('takeOutPicture is true, or left out.')
  if (
    edit.subject === undefined &&
    edit.text === undefined &&
    edit.copyEveryone === undefined &&
    edit.cc === undefined &&
    edit.takeOutPicture === undefined
  ) {
    return BAD('Change the subject, the words, who is copied or the picture.')
  }
  const patch: DraftPatch = { rev: edit.rev }
  if (edit.takeOutPicture === true) patch.takeOutPicture = true
  if (edit.copyEveryone !== undefined) patch.copyEveryone = edit.copyEveryone
  if (edit.cc !== undefined) patch.cc = edit.cc as string[]
  if (edit.subject !== undefined) patch.subject = edit.subject
  if (edit.text !== undefined) patch.body = edit.text
  return { id: edit.draftId, patch }
}

function readNewSend(key: string, raw: Record<string, unknown>, owner: InboxOwner): Compose | Refused {
  const address = normalizeAddress(raw.address)
  if (address === null) return BAD('That is not an email address.')
  if (typeof raw.subject !== 'string' || typeof raw.text !== 'string') {
    return BAD('A new email needs a subject and its words.')
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') return BAD('The name is text.')
  const chosen = readInboxFrom(raw.from)
  if (!chosen.ok) return BAD(chosen.message)
  const from = chosen.from
  const files = readFiles(raw.attachments)
  if ('ok' in files) return files
  // Refused before a draft is made, as a reply's are: files never go from the owner's Gmail, and are not dropped quietly from a send that goes without them.
  if (files.files.length > 0 && from?.kind === 'gmail')
    return BAD(filesFromBusinessMailboxOnly(owner.name, owner.mailboxNames))
  return {
    key,
    how: 'new',
    address,
    name: raw.name ?? '',
    subject: raw.subject,
    text: raw.text,
    from,
    files: files.files,
  }
}

/** The files a send carries: only a reply's or a new email's; a draft already made carries none. */
const filesOf = (compose: Compose): InboxFile[] => (compose.how === 'draft' ? [] : compose.files)

/**
 * How the draft of a press is made. A press with a file and no words is a picture that speaks for itself: the draft may then have no words (the send refuses it where a picture cannot go, and the draft is
 * discarded again), which only a press can do; the API's draft route never passes this.
 */
const composeDraftOptions = (compose: Compose): { empty?: boolean } =>
  compose.how !== 'draft' && compose.files.length > 0 && compose.text.trim() === '' ? { empty: true } : {}

/** Who a question is about: a contact the space holds the id of, or an email address (any of the contact's), in the one spelling. */
function readWho(raw: unknown): { ok: true; who: { contactId: string } | { address: string } } | Refused {
  if (!isRecord(raw)) return BAD('Say who: a contactId or an address.')
  if (typeof raw.contactId === 'string') {
    return ID.test(raw.contactId)
      ? { ok: true, who: { contactId: raw.contactId } }
      : refused('not-found', 'No such person.')
  }
  if (typeof raw.address !== 'string') return BAD('Say who: a contactId or an address.')
  const address = normalizeAddress(raw.address)
  return address === null ? BAD('That is not an email address.') : { ok: true, who: { address } }
}

/** At most MOST_ADDRESSES entries, each text: what `scope.addresses` must be. */
const isAddressList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MOST_ADDRESSES && v.every((a) => typeof a === 'string')

/** At most MOST_ADDRESSES entries, each text: what `scope.contactIds` must be. */
const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MOST_ADDRESSES && v.every((a) => typeof a === 'string')

/** Each contact on the conversations, with the conversations they are on (every one, or only the named contacts'). */
function groupByContact(
  conversations: readonly SpaceConversation[],
  only: readonly string[] | undefined,
): Map<string, { party: SpaceParty; conversations: SpaceConversation[] }> {
  const byContact = new Map<string, { party: SpaceParty; conversations: SpaceConversation[] }>()
  for (const conversation of conversations) {
    for (const party of conversation.parties) {
      if (only !== undefined && !only.includes(party.contactId)) continue
      const held = byContact.get(party.contactId) ?? { party, conversations: [] }
      held.conversations.push(conversation)
      byContact.set(party.contactId, held)
    }
  }
  return byContact
}

/** Whether the type a sender's app declared for a picture sent as a file is one a browser draws: png, jpeg or webp (not heic or heif, which are saved; not gif, which is never taken as an image). */
const isShownImageType = (declared: string | undefined): boolean =>
  ['image/png', 'image/jpeg', 'image/webp'].includes((declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '')

/**
 * A message's files as the space is told of them: names and sizes, whether each is worth asking for as a picture (image.ts, the same rule as the inbox's own
 * page) and whether any can be saved. A message the inbox holds neither a Gmail id nor a kept copy for has no bytes to give, so none is offered.
 */
export function attachmentsOf(m: MessageRow): InboxAttachment[] {
  const gmail = m.gmailId !== null
  // A photo or voice note from Telegram: shown when its bytes are kept, named with one plain line when they are not. Nothing is parsed; the file is the object.
  if (m.attachments.some((a) => a.tg !== undefined)) {
    return m.attachments.map((a: AttachmentInfo) => {
      const tg = a.tg
      const kept = tg?.copy === 'kept' && m.rawKey !== undefined
      const note = tg && !kept ? telegramFileNote(tg) : undefined
      return {
        name: a.name,
        size: a.size,
        type: a.mimeType ?? '',
        picture: kept && (tg?.kind === 'photo' || (tg?.kind === 'image' && isShownImageType(a.mimeType))),
        download: kept,
        ...(kept && tg?.kind === 'voice' && { play: true }),
        ...(kept && tg?.kind === 'video' && { video: true }),
        ...(tg?.seconds !== undefined && { seconds: tg.seconds }),
        ...(note !== undefined && { note }),
      }
    })
  }
  // Mail that arrived is opened by parsing the whole raw copy, which the inbox will not do past MAX_OPEN_MESSAGE_BYTES (image.ts); the files are then named only.
  const tooLarge = !gmail && m.rawKey !== undefined && m.direction === 'in' && tooLargeToOpen(m.attachments)
  const kept = !gmail && m.rawKey !== undefined && !tooLarge
  return m.attachments.map((a: AttachmentInfo) => ({
    name: a.name,
    size: a.size,
    type: a.mimeType ?? '',
    picture: (gmail || kept) && wantsPreview(a),
    download: kept,
    ...(tooLarge && { tooLarge: true }),
  }))
}

const deliveryNote = (n: DeliveryNote): InboxDeliveryNote => ({
  recipient: n.recipient,
  state: n.state,
  reason: n.reason,
  at: ms(n.at),
})

/** Every address of the team, lowercase: each teammate's company and sign-in address. With the owner's own they are INSIDE, and own no thread's row while an outsider is on it (src/store/placement.ts). */
const teamAddresses = (deps: SpaceDeps): string[] =>
  deps.install.people.flatMap((p) => [p.address, p.signIn].map((a) => a.trim().toLowerCase()))

/**
 * Every address that is "you" to the person asking, lower case: their work address and the one they sign in with, and, for the owner, every address of theirs (each Gmail account and mailbox, `own`). What an invitation's organizer is compared with
 * to say "From you".
 */
export function addressesOfYou(install: Install, actor: string, own: readonly string[]): Set<string> {
  const signIn = install.person(actor)?.signIn
  return new Set([actor, ...(signIn ? [signIn.toLowerCase()] : []), ...own])
}

export function createSpaceInbox(deps: SpaceDeps): InboxForSpace {
  const { store } = deps
  const owner = inboxOwnerOf(deps.install)

  const asOwner = ownerGate(deps)
  const asPerson = personGate(deps)

  /**
   * What the inbox only SUGGESTS for the contacts that have no Client (its own rule, `suggestClients`): shown as a dashed pill, counted for nothing until it is linked in the inbox.
   * Nothing at all while the Clients part does not answer, since nothing can vouch for a Client then.
   */
  async function suggestionsFor(
    unlinked: readonly string[],
    dir: ClientsRead | null,
    mail: MailScope,
  ): Promise<Map<string, ClientLabel>> {
    const out = new Map<string, ClientLabel>()
    if (!dir?.available || unlinked.length === 0) return out
    for (const s of suggestClients(await store.call('suggestionContacts', mail), dir.clients, owner.domain)) {
      if (!out.has(s.contactId)) out.set(s.contactId, { id: s.clientId, name: s.clientName, listed: true })
    }
    return out
  }

  // ── people ──────────────────────────────────────────────────────────────

  async function people(asker: SignedIn, scope?: InboxScope): Promise<SpaceReply<InboxPeople>> {
    return asPerson(asker, async ({ scope: mail }) => {
      if (scope !== undefined && !isRecord(scope)) return BAD('The scope is not an object.')
      const flags = readFlags(scope)
      if ('ok' in flags) return flags
      let contactIds: string[] | undefined
      if (scope?.addresses !== undefined) {
        if (!isAddressList(scope.addresses))
          return BAD(`addresses is a list of at most ${MOST_ADDRESSES} email addresses.`)
        contactIds = await store.call('spaceContactsWith', spelled(scope.addresses))
      }
      if (scope?.contactIds !== undefined) {
        if (!isIdList(scope.contactIds)) return BAD(`contactIds is a list of at most ${MOST_ADDRESSES} contact ids.`)
        contactIds = [...new Set([...(contactIds ?? []), ...scope.contactIds.filter((id) => ID.test(id))])]
      }
      const found = await store.call('spaceConversations', {
        ...flags,
        ...(contactIds !== undefined && { contactIds }),
        team: teamAddresses(deps),
        mail,
      })

      const byContact = groupByContact(found.conversations, contactIds)
      // The Clients part's list, asked once and only when there is someone to name a Client for, never cached.
      const parties = [...byContact.values()]
      const dir = parties.length > 0 ? await readClients(deps.clients, deps.install) : null
      const byId = clientsById(dir?.clients ?? [])
      const name = (id: number): ClientLabel => clientLabel(id, byId)
      const suggested = await suggestionsFor(
        parties.flatMap((p) => (p.party.clientId === null ? [p.party.contactId] : [])),
        dir,
        mail,
      )
      const list: InboxPerson[] = parties.map(({ party, conversations }) => {
        const lines = conversations.map((c) => threadLine(c, party.contactId))
        const first = lines[0] as InboxThreadLine
        return {
          contactId: party.contactId,
          name: party.name,
          addresses: spelled(party.emails),
          client: party.clientId === null ? null : name(party.clientId),
          suggestedClient: party.clientId === null ? (suggested.get(party.contactId) ?? null) : null,
          newest: {
            conversationId: first.conversationId,
            at: first.at,
            kind: first.kind,
            direction: first.direction,
            subject: first.subject,
            snippet: first.snippet,
          },
          unread: lines.filter((l) => l.unread).length,
          conversations: lines,
        }
      })
      list.sort(
        (a, b) => b.newest.at - a.newest.at || a.name.localeCompare(b.name) || a.contactId.localeCompare(b.contactId),
      )
      return answered({ people: list, more: found.more, ...(found.floor !== null && { floor: found.floor }) })
    })
  }

  const others = (c: SpaceConversation, contactId: string): InboxParty[] =>
    c.parties.filter((p) => p.contactId !== contactId).map(toParty)

  const clientOf = (c: SpaceConversation, contactId: string): number | null =>
    c.parties.find((p) => p.contactId === contactId)?.clientId ?? null

  function threadLine(c: SpaceConversation, contactId: string): InboxThreadLine {
    return {
      conversationId: c.id,
      subject: c.subject,
      kind: c.kind,
      at: ms(c.newestAt),
      snippet: c.snippet,
      direction: c.direction,
      unread: c.unread,
      open: c.open,
      bulk: c.bulk,
      drafts: c.drafts,
      mailbox: c.mailbox,
      alsoOn: others(c, contactId),
      listed: c.placed.everyone === contactId,
      // In a Client's list the thread is placed among that Client's people only. A contact with no Client is in no Client's list (the page keeps a Client's own people), so its line is left as it was.
      listedInClient:
        clientOf(c, contactId) === null || c.placed.byClient.get(clientOf(c, contactId) as number) === contactId,
      ...(c.telegramChat !== null && { telegramChat: c.telegramChat }),
      ...(c.needsReply !== null && { needsReply: c.needsReply }),
    }
  }

  // ── a person's messages ─────────────────────────────────────────────────

  async function messagesWith(
    asker: SignedIn,
    who: InboxWho,
    query?: InboxHistoryQuery,
  ): Promise<SpaceReply<InboxHistory>> {
    return asPerson(asker, async ({ scope: mail, actor, owner: isOwner }) => {
      const named = readWho(who)
      if (!named.ok) return named
      if (query !== undefined && !isRecord(query)) return BAD('The query is not an object.')
      const include = readInclude(query?.include)
      if ('ok' in include) return include
      const before = query?.before
      if (before !== undefined && (typeof before !== 'string' || !ID.test(before))) {
        return BAD('before is the id of the oldest message you hold.')
      }

      const contact = await store.call('spaceContact', named.who, mail)
      if (contact === null) return refused('not-found', 'No such person.')
      // Every conversation of the person, past the screen the lists stop at: their messages are paged, their conversations are not.
      const { conversations } = await store.call('spaceConversations', {
        ...include,
        contactIds: [contact.id],
        all: true,
        team: teamAddresses(deps),
        mail,
      })
      const page = await store.call(
        'spaceMessages',
        conversations.map((c) => c.id),
        before ?? null,
        INBOX_HISTORY_PAGE,
      )
      if (page === null) return BAD('That message is not on this person’s conversations.')
      // The addresses "you" means to the person asking, for an invitation's organizer: their own, and, for the owner, every address of theirs (each Gmail account and mailbox).
      const you = addressesOfYou(deps.install, actor, isOwner ? page.own : [])

      const byId = new Map(conversations.map((c) => [c.id, c]))
      const threads: InboxThread[] = conversations.map((c) => ({
        conversationId: c.id,
        subject: c.subject,
        kind: c.kind,
        through: c.through,
        unread: c.unread,
        open: c.open,
        bulk: c.bulk,
        mailbox: c.mailbox,
        alsoOn: others(c, contact.id),
        canReply: c.canReply,
        // Files go only from a Cloudflare mailbox, which sends through Cloudflare; the owner's Gmail accounts send none.
        canAttach: c.canReply && c.mailboxKind === 'cloudflare',
        // A Telegram chat with a person or a group that has a reply box takes ONE picture; a channel has no reply box. Additive: a thread of any other kind leaves it out.
        ...(c.canReply && c.mailboxKind === 'telegram' && { canPicture: true as const }),
        // The space draws the spam button (as the retired inbox page did) over a conversation in a mailbox that is in Bulk or has no contact linked to a Client; written once, here. Not over a Telegram chat: it is answered, and it is not mail.
        canMarkSpam:
          c.canReply && c.mailboxKind !== 'telegram' && (c.bulk || !c.parties.some((p) => p.clientId !== null)),
        ...(c.telegramChat !== null && { telegramChat: c.telegramChat }),
      }))
      // What a message quotes is proved against the messages before it in its conversation, those on earlier pages included.
      const inConversation: Map<string, string[]> = new Map()
      for (const o of page.older)
        inConversation.set(o.conversationId, [...(inConversation.get(o.conversationId) ?? []), repairMojibake(o.body)])
      const messages = page.messages.flatMap((m): InboxMessage[] => {
        const c = m.conversationId === null ? undefined : byId.get(m.conversationId)
        if (!c) return []
        const earlier = inConversation.get(c.id) ?? []
        // Mail stored before src/charset.ts was put right on arrival reads right here too, without the row being rewritten; once per message, for its own text and for the quotes after it.
        const body = repairMojibake(m.body)
        inConversation.set(c.id, [...earlier, body])
        return [messageOf(m, body, others(c, contact.id), earlier, you)]
      })
      return answered({ threads, messages, more: page.more })
    })
  }

  /** `you` is every address that is the person asking's own (lower case): an invitation whose organizer is one of them is "from you". */
  function messageOf(
    m: MessageRow,
    body: string,
    alsoOn: InboxParty[],
    earlier: readonly string[],
    you: ReadonlySet<string>,
  ): InboxMessage {
    const subject = repairMojibake(m.subject)
    return {
      id: m.id,
      conversationId: m.conversationId as string,
      subject,
      direction: m.direction,
      at: ms(m.sentAt ?? m.createdAt),
      // As the message wrote it; a note, or a message we sent that kept no header, has the name of who wrote it.
      from:
        m.from.trim() !== '' ? m.from : m.direction === 'out' && m.kind === 'email' ? owner.mailName : m.contactName,
      text: body,
      textCut: m.bodyTruncated,
      // The inbox's reading of it (src/read.ts), so the space folds a quote where the retired inbox page folded it. A Telegram message is not mail: it quotes nothing, so it is never folded.
      read:
        m.kind === 'telegram'
          ? { visible: body, quoted: '' }
          : readText(body, { earlier, subject, viaGmail: viaGmail(m) }),
      ...(m.direction === 'out' && m.kind === 'email' ? { to: m.to.trim() !== '' ? m.to : m.address } : {}),
      ...(m.attachments.length > 0 && { attachments: attachmentsOf(m) }),
      // What the email's calendar part says, kept when it arrived (src/calendar-summary.ts); the page draws a card from it. "From you" is the organizer being the person asking.
      ...(m.calendar !== undefined && {
        calendar: { ...m.calendar, fromYou: m.calendar.organizer !== null && you.has(m.calendar.organizer.address) },
      }),
      ...(m.delivery !== undefined && m.delivery.length > 0 && { delivery: m.delivery.map(deliveryNote) }),
      // Only a text or a direct message can be marked sent by hand: an email the Outbox carried in as sent has the same status, and must not be offered "Not sent after all" (it could then be sent again).
      ...(m.status === 'manual-sent' && m.kind !== 'email' && { sentByHand: true }),
      ...(m.deletedAt !== undefined ? { deleted: true } : m.editedAt !== undefined ? { edited: true } : {}),
      alsoOn,
    }
  }

  // ── drafts ──────────────────────────────────────────────────────────────

  /**
   * A draft as the space is told of it. The Cc a draft carries is who a send goes to besides `to`, so the space shows it before it sends the draft as it stands; `nameOf`
   * is a per-answer cache of the names the inbox knows the copied addresses by.
   */
  const draftOf = async (d: MessageRow, nameOf: (address: string) => Promise<string | null>): Promise<InboxDraft> => ({
    id: d.id,
    conversationId: d.conversationId,
    contactId: d.contactId,
    toName: d.contactName,
    to: d.kind === 'email' ? (normalizeAddress(d.address) ?? d.address) : d.address,
    cc: await copiedTo(d.cc, nameOf),
    subject: d.subject,
    text: d.body,
    rev: d.rev,
    author: draftAuthor(d.createdBy),
    // A Telegram send that is still going out is `sending`, not stuck: it may land, and it is not the owner's to answer for until it can no longer.
    stuck: d.status === 'sending' && d.sendingOnTelegram !== true,
    ...(d.sendingOnTelegram === true && { sending: true }),
    at: ms(d.createdAt),
    why: d.why,
    editedBy: draftEditedBy(d.createdBy, d.updatedBy, d.rev),
    canCopyEveryone: d.kind === 'email' && d.conversationId !== null,
    copiesEveryone: d.copiesEveryone === true,
    kind: d.kind,
    ...(d.sentFrom !== undefined && { sentFrom: d.sentFrom }),
    ...(d.sendsFrom !== undefined && { sendsFrom: d.sendsFrom }),
    ...(d.refusal !== undefined && { refusal: d.refusal }),
    // The picture a Telegram draft carries: its type and length. The bytes are the owner's through `attachment`; the fingerprint is Claude's, and the page has no use for it.
    ...(d.picture !== undefined && { picture: { type: d.picture.type, size: d.picture.size } }),
  })

  const namesFrom = (mail: MailScope) => {
    const named = new Map<string, string | null>()
    return async (address: string): Promise<string | null> => {
      if (!named.has(address)) named.set(address, (await store.call('spaceContact', { address }, mail))?.name ?? null)
      return named.get(address) ?? null
    }
  }

  async function drafts(asker: SignedIn): Promise<SpaceReply<InboxDraft[]>> {
    return asPerson(asker, async ({ scope: mail }) => {
      const rows = await store.call('listDrafts', mail)
      const nameOf = namesFrom(mail)
      return answered(await Promise.all(rows.map((d) => draftOf(d, nameOf))))
    })
  }

  /**
   * Where a draft's link opens: the draft as it stands (loose or on a conversation), or, once the message is no longer a draft, the conversation it sits on. A draft that was sent or marked sent
   * is the same message row, so the link a draft had keeps working. Deleted (no row), or a message with no conversation that is not waiting, is `not-found`.
   */
  async function draftAt(asker: SignedIn, draftId: string): Promise<SpaceReply<InboxDraftAt>> {
    return asPerson(asker, async ({ scope: mail }) => {
      if (typeof draftId !== 'string' || !ID.test(draftId)) return refused('not-found', 'No such message.')
      if (!(await seesMessage(deps, mail, draftId))) return refused('not-found', 'No such message.')
      const m = await store.call('messageById', draftId)
      if (m === null) return refused('not-found', 'No such message.')
      if (isPending(m.status)) return answered({ state: 'draft', draft: await draftOf(m, namesFrom(mail)) })
      if (m.conversationId === null) return refused('not-found', 'No such message.')
      return answered({ state: 'filed', contactId: m.contactId, conversationId: m.conversationId })
    })
  }

  // ── edit a draft ────────────────────────────────────────────────────────

  /**
   * The inbox's own draft edit (`PATCH /api/drafts/:id`, `updateDraft`), as the owner: the revision the person was shown is required, a draft changed since is
   * refused with nothing saved, a body cannot be blanked, and the store's audit says who. An em dash is saved as it is (as the retired inbox page did); the send refuses it.
   */
  async function editDraft(asker: SignedIn, edit: InboxDraftEdit): Promise<SpaceReply<InboxDraft>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      const patch = readEdit(edit)
      if ('ok' in patch) return patch
      if (!(await seesMessage(deps, mail, patch.id))) return refused('not-found', 'No such message.')
      const saved = await store.call('updateDraft', patch.id, patch.patch, actor)
      if (!saved.ok) return outcomeOf(saved)
      return answered(await draftOf(saved.value, namesFrom(mail)))
    })
  }

  /**
   * Put ONE picture on a Telegram draft, or replace the one it has, as the owner: the draft, the revision shown and the file. The Mailroom checks the bytes and the draft and names the picture on
   * it as an edit (the revision rises); `conflict` when the draft has moved on, `bad-request` for a file that is not a PNG or a JPEG, over 10 MB, or a draft that is not on a Telegram chat that takes one.
   */
  async function putDraftPicture(asker: SignedIn, put: InboxDraftPicture): Promise<SpaceReply<InboxDraft>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      if (!isRecord(put) || typeof put.draftId !== 'string' || !ID.test(put.draftId))
        return refused('not-found', 'No such message.')
      if (!isCount(put.rev)) return BAD('Say which version of the draft you were shown (rev).')
      const file = put.picture
      if (!isRecord(file) || !(file.bytes instanceof Uint8Array)) return BAD('A picture is a file with its bytes.')
      if (!(await seesMessage(deps, mail, put.draftId))) return refused('not-found', 'No such message.')
      const saved = await store.call('putDraftPicture', put.draftId, put.rev, file.bytes, actor)
      return saved.ok ? answered(await draftOf(saved.value, namesFrom(mail))) : outcomeOf(saved)
    })
  }

  // ── what only the retired inbox page still did ──────────────────────

  /**
   * The inbox's own `resolve-send` (`Mailroom.resolveSend`), as the owner: the person looked in Gmail Sent (or asked the recipient, for a business mailbox) and says whether a send Gmail never confirmed went
   * out. Out removes the stuck draft, not out makes it a draft again, and the store refuses a message that is not waiting on a send (409) and a "did not go out" when Gmail's copy is already held (409).
   * A boolean is required, so an empty request can never mean either. The Mailroom refuses an agent actor too; the owner's is never one.
   */
  async function resolveSend(asker: SignedIn, resolution: InboxSendResolution): Promise<SpaceReply<InboxSendResolved>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      if (!isRecord(resolution)) return BAD('Name the message and say whether it went out.')
      if (typeof resolution.draftId !== 'string' || !ID.test(resolution.draftId))
        return refused('not-found', 'No such message.')
      if (typeof resolution.sent !== 'boolean') return BAD('Say whether it went out: sent true or false.')
      if (!(await seesMessage(deps, mail, resolution.draftId))) return refused('not-found', 'No such message.')
      const done = await store.call('resolveSend', resolution.draftId, resolution.sent, actor)
      return done.ok ? answered({ id: done.value.id, status: done.value.status }) : outcomeOf(done)
    })
  }

  const handSentOf = (m: MessageRow): InboxHandSent => ({ messageId: m.id, conversationId: m.conversationId })

  /** The inbox's own `mark-sent` (`markSent`), as the owner: a text or a direct message draft, sent by hand, filed read and closed on the person's conversation for its channel. An email is refused (it is sent with Send). */
  async function markDraftSent(asker: SignedIn, draftId: string): Promise<SpaceReply<InboxHandSent>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      if (typeof draftId !== 'string' || !ID.test(draftId)) return refused('not-found', 'No such message.')
      if (!(await seesMessage(deps, mail, draftId))) return refused('not-found', 'No such message.')
      const done = await store.call('markSent', draftId, undefined, actor)
      return done.ok ? answered(handSentOf(done.value)) : outcomeOf(done)
    })
  }

  /** The inbox's own `unmark-sent` (`unmarkSent`), as the owner: "Not sent after all". Only a message marked sent by hand goes back to being a draft. */
  async function unmarkSent(asker: SignedIn, messageId: string): Promise<SpaceReply<InboxHandSent>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      if (typeof messageId !== 'string' || !ID.test(messageId)) return refused('not-found', 'No such message.')
      if (!(await seesMessage(deps, mail, messageId))) return refused('not-found', 'No such message.')
      const done = await store.call('unmarkSent', messageId, actor)
      return done.ok ? answered(handSentOf(done.value)) : outcomeOf(done)
    })
  }

  // ── spam ────────────────────────────────────────────────────────────────

  /**
   * The inbox's own "Mark as spam" and "Move to the Inbox" (`PUT /api/conversations/:id/spam`, `setSpam`), as the owner: the call is stored on the conversation and sticks,
   * decides over every rule but a Client's people, and changes nothing in Gmail. A boolean is required, so an empty request can never mean either. The answer says where the
   * conversation stands afterwards and why, read from the conversation as the store gives it (`getConversation`), so a call that moved nothing visible (a Client's person) says so.
   */
  async function setSpam(asker: SignedIn, mark: InboxSpamMark): Promise<SpaceReply<InboxSpamResult>> {
    return asPerson(asker, async ({ actor, scope: mail, owner: isOwner }) => {
      // Calling a conversation spam moves it for everyone on the mailbox: the owner's for now.
      if (!isOwner) return refused('not-admitted', NOT_ADMITTED)
      if (!isRecord(mark) || typeof mark.conversationId !== 'string' || !ID.test(mark.conversationId)) {
        return refused('not-found', 'No such conversation.')
      }
      if (typeof mark.spam !== 'boolean') return BAD('Say which: spam true or false.')
      if (!(await seesConversation(deps, mail, mark.conversationId)))
        return refused('not-found', 'No such conversation.')
      const called = await store.call('setSpam', mark.conversationId, mark.spam, actor)
      if (!called.ok) return outcomeOf(called)
      const page = await store.call('getConversation', mark.conversationId)
      return answered({
        conversationId: mark.conversationId,
        spam: mark.spam,
        // The call is stored whatever the read says; if the page cannot be read the call stands as the answer.
        bulk: page.ok ? page.value.bulk : mark.spam,
        reasons: page.ok ? (page.value.reasons ?? []) : [],
      })
    })
  }

  // ── send ────────────────────────────────────────────────────────────────

  async function send(asker: SignedIn, raw: InboxSend): Promise<WriteReply<InboxSent>> {
    return asPerson<WriteReply<InboxSent>>(asker, async ({ actor, scope: mail }) => {
      const read = readSend(raw, owner)
      if ('ok' in read) return read
      // A person sends only from the mailboxes they are on: a draft or a thread in another's is not theirs to answer, and nothing is claimed for it (the key stays free). A new email is checked where it is
      // made, which chooses its mailbox among theirs (`createDraft`), and the send is checked once more where it is planned (`planSend`).
      if (read.how === 'draft' && !(await seesMessage(deps, mail, read.draftId)))
        return refused('not-found', 'No such message.')
      if (read.how === 'reply' && !(await seesConversation(deps, mail, read.conversationId)))
        return refused('not-found', 'No such conversation.')
      return sendAs(actor, read)
    })
  }

  /** What a send that came back ok says: `sent`, or `sending` for a Telegram send (claimed and owed to the bridge). */
  const statusOfSend = (m: MessageRow): InboxSent['status'] => (m.status === 'sending' ? 'sending' : 'sent')

  /**
   * The send, with its key. The order is the point: CLAIM the key (one atomic step in the store, so two presses together cannot
   * both be first), make the draft where there is not one, send it through the Mailroom, and settle the key by what became of it.
   */
  async function sendAs(actor: string, compose: Compose): Promise<WriteReply<InboxSent>> {
    const claim = await store.call('claimCompose', compose.key)
    if (claim.kind === 'held') {
      return repeated<InboxSent>(
        claim.earlier.state === 'done'
          ? { state: 'done', reply: answered(claim.earlier.sent) }
          : { state: 'in-progress' },
      )
    }

    let draftId: string | null = null
    let conversationId: string | null = null
    let made = false
    try {
      let rev: number
      let through: number | null
      if (compose.how === 'draft') {
        const where = await store.call('composeOutcome', compose.draftId)
        if (where === null) {
          await store.call('releaseCompose', compose.key)
          return refused('not-found', 'No such message.')
        }
        draftId = compose.draftId
        conversationId = where.conversationId
        rev = compose.rev
        through = compose.through
      } else {
        const input =
          compose.how === 'reply'
            ? {
                conversationId: compose.conversationId,
                body: compose.text,
                subject: compose.subject,
                ...(compose.copyEveryone && { copyEveryone: true }),
              }
            : {
                address: compose.address,
                name: compose.name,
                subject: compose.subject,
                body: compose.text,
                ...(compose.from !== undefined && { sendFrom: compose.from }),
              }
        // The draft and its note on the key are one store call, so a Worker lost between them leaves no orphan draft.
        await store.call('prepareReply', input)
        // A press with a file and no words is a picture that speaks for itself: the draft may be empty, and the send refuses it where a picture cannot go.
        const drafted = await store.call('createComposeDraft', compose.key, input, actor, composeDraftOptions(compose))
        if (!drafted.ok) {
          await store.call('releaseCompose', compose.key)
          return outcomeOf(drafted)
        }
        made = true
        draftId = drafted.value.id
        conversationId = drafted.value.conversationId
        rev = drafted.value.rev
        through = compose.how === 'reply' ? compose.through : null
      }
      if (!made) await store.call('noteCompose', compose.key, draftId, conversationId)

      const sent = await store.call('sendDraft', draftId, { rev, through }, actor, filesOf(compose))
      if (sent.ok) {
        // A Telegram send comes back claimed and `sending` (the bridge sends it within seconds and the page changes by itself); every other send comes back sent.
        const done: InboxSent = {
          messageId: sent.value.id,
          conversationId: sent.value.conversationId ?? '',
          status: statusOfSend(sent.value),
        }
        await store.call('finishCompose', compose.key, done)
        return answered(done)
      }
      // It did not come back ok. What the draft is now says whether anything went out: a draft claimed for sending and not put
      // back is Gmail's "never said" (the 502 whose words are "check Gmail Sent"), and that is a success the person must check.
      const where = await store.call('composeOutcome', draftId)
      if (sent.status === 502 && where?.status === 'sending') {
        const unsure: InboxSent = { messageId: draftId, conversationId: where.conversationId ?? '', status: 'sending' }
        await store.call('finishCompose', compose.key, unsure)
        return answered(unsure)
      }
      if (made) await store.call('discardComposed', draftId, actor, compose.key)
      await store.call('releaseCompose', compose.key)
      return outcomeOf(sent)
    } catch (error) {
      console.error('space: a send was interrupted', error)
      return afterFault(compose.key, draftId, conversationId, made, actor)
    }
  }

  /**
   * Something threw after the key was taken. Nothing may be assumed: with no draft, nothing was sent, so the key is released and
   * the answer is `broken`; with one, the draft says what became of it, and when even that cannot be read the answer is `sending`
   * with the key left in progress, which the store ends as `sending` after WRITE_WITHIN_MS. Never `broken` for a send that may be out.
   */
  async function afterFault(
    key: string,
    draftId: string | null,
    conversationId: string | null,
    made: boolean,
    actor: string,
  ): Promise<WriteReply<InboxSent>> {
    try {
      if (draftId === null) {
        await store.call('releaseCompose', key)
        return failed(FAULT)
      }
      const where = await store.call('composeOutcome', draftId)
      if (where?.status === 'draft' || where === null) {
        if (made && where !== null) await store.call('discardComposed', draftId, actor, key)
        await store.call('releaseCompose', key)
        return failed(FAULT)
      }
      const known: InboxSent = {
        messageId: draftId,
        conversationId: where.conversationId ?? '',
        status: where.status === 'sent' ? 'sent' : 'sending',
      }
      await store.call('finishCompose', key, known)
      return answered(known)
    } catch (error) {
      console.error('space: could not settle an interrupted send', error)
      return answered({ messageId: draftId ?? '', conversationId: conversationId ?? '', status: 'sending' })
    }
  }

  // ── a file ──────────────────────────────────────────────────────────────

  /**
   * One file of one message, for the owner only: the same read the retired inbox page made (`readAttachment`), so what is checked is checked in one place. It
   * reads and nothing else, and marks nothing read. A file is named by its message and its place in the message's list, both checked as the shapes they are.
   */
  async function attachment(
    asker: SignedIn,
    messageId: string,
    index: number,
    how: 'view' | 'download',
    range?: FileRange,
  ): Promise<SpaceReply<InboxFileOut>> {
    return asPerson(asker, async ({ scope: mail }) => {
      if (typeof messageId !== 'string' || !ID.test(messageId)) return refused('not-found', 'No such attachment.')
      if (!isCount(index) || index > 999) return refused('not-found', 'No such attachment.')
      if (how !== 'view' && how !== 'download') return BAD('Say whether to view or download the file.')
      if (range !== undefined && !isFileRange(range))
        return BAD('A range is a first byte and a last, or the last bytes.')
      // A file of a message the person may not see is not told apart from a file that is not there.
      if (!(await seesMessage(deps, mail, messageId))) return refused('not-found', 'No such attachment.')
      const found = await store.call('readAttachment', messageId, index, how, { agent: false }, range)
      if (!found.ok) return outcomeOf(found)
      return answered({
        name: found.value.name,
        type: found.value.type,
        inline: found.value.inline,
        bytes: found.value.bytes,
        ...(found.value.total !== undefined && { total: found.value.total }),
        ...(found.value.part !== undefined && { part: found.value.part }),
        ...(found.value.unsatisfiable && { unsatisfiable: true as const }),
      })
    })
  }

  // ── mark read ───────────────────────────────────────────────────────────

  async function markRead(asker: SignedIn, marks: readonly InboxReadMark[]): Promise<SpaceReply<InboxReadResult>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      if (!Array.isArray(marks) || marks.length > INBOX_MOST_MARKS)
        return BAD(`Name at most ${INBOX_MOST_MARKS} conversations.`)
      for (const mark of marks) {
        if (!isRecord(mark) || typeof mark.conversationId !== 'string' || !ID.test(mark.conversationId)) {
          return BAD('Each mark names a conversation and how far into it you read.')
        }
        if (!isCount(mark.through)) return BAD('Each mark names how far into the conversation you read (through).')
      }
      const { done, not } = await changeEach('read', marks, actor, mail)
      return answered({ read: done, notRead: not })
    })
  }

  // ── close and reopen ────────────────────────────────────────────────────

  /**
   * The inbox's own Close or Reopen, once for each conversation named: `changeConversation`, the call the inbox's own route makes, so every rule of
   * it stays. A close names the position the caller read to (`through`), and a conversation with inbound mail beyond it (still in the Inbox, for
   * Gmail's) is refused with `conflict` and changed nowhere; a reopen needs none. Gmail is asked first, as it is for the page. One conversation's
   * trouble never fails the rest. A mark read is the same call (`'read'`, at the position the caller read to).
   */
  async function changeEach(
    change: 'read' | 'close' | 'reopen',
    items: readonly { conversationId: string; through: number | null }[],
    actor: string,
    mail: MailScope,
  ): Promise<{ done: string[]; not: { conversationId: string; outcome: Refused | Failed }[] }> {
    const out: { done: string[]; not: { conversationId: string; outcome: Refused | Failed }[] } = { done: [], not: [] }
    for (const { conversationId, through } of items) {
      try {
        if (!(await seesConversation(deps, mail, conversationId))) {
          out.not.push({ conversationId, outcome: refused('not-found', 'No such conversation.') })
          continue
        }
        const changed: Result<unknown> = await store.call('changeConversation', conversationId, change, actor, through)
        if (changed.ok) out.done.push(conversationId)
        else out.not.push({ conversationId, outcome: outcomeOf(changed) })
      } catch (error) {
        console.error(`space: ${change} failed`, error)
        out.not.push({ conversationId, outcome: failed(FAULT) })
      }
    }
    return out
  }

  /** At most the contract's `INBOX_MOST_MARKS` conversations: the question every one of these writes asks first. */
  const tooMany = (list: unknown): Refused | null =>
    !Array.isArray(list) || list.length > INBOX_MOST_MARKS
      ? BAD(`Name at most ${INBOX_MOST_MARKS} conversations.`)
      : null

  async function closeConversations(
    asker: SignedIn,
    marks: readonly InboxCloseMark[],
  ): Promise<SpaceReply<InboxCloseResult>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      const bad = tooMany(marks)
      if (bad) return bad
      for (const mark of marks) {
        if (!isRecord(mark) || typeof mark.conversationId !== 'string' || !ID.test(mark.conversationId)) {
          return BAD('Each close names a conversation and how far into it you read.')
        }
        if (!isCount(mark.through)) return BAD('Each close names how far into the conversation you read (through).')
      }
      const { done, not } = await changeEach('close', marks, actor, mail)
      return answered({ closed: done, notClosed: not })
    })
  }

  async function reopenConversations(
    asker: SignedIn,
    conversationIds: readonly string[],
  ): Promise<SpaceReply<InboxReopenResult>> {
    return asPerson(asker, async ({ actor, scope: mail }) => {
      const bad = tooMany(conversationIds)
      if (bad) return bad
      if (conversationIds.some((id) => typeof id !== 'string' || !ID.test(id))) {
        return BAD('Each reopen names a conversation.')
      }
      const { done, not } = await changeEach(
        'reopen',
        conversationIds.map((conversationId) => ({ conversationId, through: null })),
        actor,
        mail,
      )
      return answered({ reopened: done, notReopened: not })
    })
  }

  // ── search ──────────────────────────────────────────────────────────────

  async function search(asker: SignedIn, query: string): Promise<SpaceReply<InboxSearch>> {
    return asPerson(asker, async ({ scope: mail }) => {
      const terms = searchTerms(query)
      if (terms.length === 0) return answered({ terms, hits: [], more: false })
      const found = await store.call('spaceSearch', terms, teamAddresses(deps), mail)
      const hits = found.hits.map(
        ({ conversation: c, match }): InboxHit => ({
          conversationId: c.id,
          subject: c.subject,
          kind: c.kind,
          at: ms(c.newestAt),
          snippet: c.snippet,
          match,
          unread: c.unread,
          open: c.open,
          bulk: c.bulk,
          mailbox: c.mailbox,
          // The person the lists put it under leads, so a hit opens (and reads) as the list's row does.
          people: [...c.parties]
            .sort((a, b) => Number(b.contactId === c.placed.everyone) - Number(a.contactId === c.placed.everyone))
            .map(toParty),
        }),
      )
      return answered({ terms, hits, more: found.more })
    })
  }

  return {
    people,
    messagesWith,
    attachment,
    drafts,
    draftAt,
    send,
    editDraft,
    putDraftPicture,
    resolveSend,
    markDraftSent,
    unmarkSent,
    setSpam,
    markRead,
    search,
    closeConversations,
    reopenConversations,
    ...createSpaceViews(deps, asOwner, asPerson),
    ...createSpacePeople(deps, asOwner, asPerson),
    ...createSpaceOperator(deps, asOwner),
  }
}
