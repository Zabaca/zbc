/**
 * WHAT THE INBOX MAY ASK OF THE MAIL SERVER, in one place, checked on every request before it leaves (src/jmap/client.ts `call`) and pinned by test/jmap-allow-list.test.ts.
 *
 * The space holds a key on a mailbox that can do more than this (the server's permission for Email/set also covers deleting any message, and moving it anywhere), the way `gmail.modify` can do more than
 * the Gmail module asks for (src/gmail/google.ts). Where the Gmail module's three label changes are a table of fixed request bodies, a JMAP request is built from parts, so this names every shape the
 * module is allowed to send and classifies a request against them: a request that fits none is refused here, before it reaches the network, whatever the caller meant. The point is the same: a bug elsewhere in
 * the app cannot reach what is not offered here, and the space can never delete mail on the server (a destroy is the one removal below, of the single unsent copy of a message the server refused to submit).
 *
 * THE LIST (each is one `kind`):
 *   reads:  folders, folder-changes, identities, threads, message-list, messages, message-changes, push-get; and a download of one message's raw bytes (a GET, in client.ts)
 *   writes: set-seen    take or put the `$seen` keyword on messages (read and unread)
 *           move        move messages between two folders (the Inbox and the Archive): `mailboxIds/<id>` patches only
 *           make-outgoing   make ONE outgoing message in Drafts (From, To, Cc, Subject, one plain body, the Message-ID and the reply headers): no Bcc, no attachment, no other keyword than `$seen` and `$draft`
 *           submit      submit that one message, and have the server file it in Sent when the submission succeeds
 *           remove-unsent   remove that one message again when the server refused to submit it
 *           push-make, push-verify, push-renew, push-remove   the inbox's own push subscription: make, complete it with the server's code, extend it, drop it
 * Nothing else: no folder is made, renamed or removed (the Archive folder is made when the credential is), no identity changes, no message is copied or imported, nothing is sent
 * by a second route, and no Sieve script or vacation response is touched.
 */

export const ALLOWED_KINDS = [
  'folders',
  'folder-changes',
  'identities',
  'threads',
  'message-list',
  'messages',
  'message-changes',
  'push-get',
  'set-seen',
  'move',
  'make-outgoing',
  'submit',
  'remove-unsent',
  'push-make',
  'push-verify',
  'push-renew',
  'push-remove',
] as const
export type AllowedKind = (typeof ALLOWED_KINDS)[number]

/** The JMAP method names the list reaches, for the test that pins them (the kinds above are what the code decides by). */
export const ALLOWED_METHODS = [
  'Mailbox/get',
  'Mailbox/changes',
  'Identity/get',
  'Thread/get',
  'Email/query',
  'Email/get',
  'Email/changes',
  'Email/set',
  'EmailSubmission/set',
  'PushSubscription/get',
  'PushSubscription/set',
] as const

type Args = Record<string, unknown>
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const keysOf = (v: unknown): string[] => (isObject(v) ? Object.keys(v) : [])
const only = (v: unknown, allowed: readonly string[]): boolean => keysOf(v).every((k) => allowed.includes(k))

/** The properties an outgoing message is made with. No `bcc`, no `attachments`, no `bodyStructure`: the shape of what the inbox sends. */
export const OUTGOING_KEYS = [
  'mailboxIds',
  'keywords',
  'from',
  'to',
  'cc',
  'subject',
  'messageId',
  'inReplyTo',
  'references',
  'sentAt',
  'textBody',
  'bodyValues',
] as const

/** The keywords an outgoing message may carry: it is filed as read, and a draft until the server has submitted it. */
const OUTGOING_KEYWORDS = ['$seen', '$draft']

/**
 * The folders and the one message the module is allowed to name, as the client knows them (from the last `Mailbox/get`, and from the last submission the server refused). A write that names any other folder, or a
 * message other than the unsent copy, is refused here before it leaves, whatever the caller asked: moves are only between the Inbox and the Archive, a message is only ever made in Drafts, a submission only files it
 * in Sent, and the only message that may be destroyed is the one unsent copy of a submission the server refused. A folder the client has not seen (null) allows nothing that needs it.
 */
export interface AllowContext {
  inbox: string | null
  archive: string | null
  drafts: string | null
  sent: string | null
  /** The unsent copy of a submission the server just refused, which may be destroyed once. */
  unsent: string | null
}

/** What a patch of `Email/set` update may touch: the read mark, or a move between the Inbox and the Archive (one taken out and the other put in, nothing else). */
const isSeenPatch = (patch: unknown): boolean =>
  isObject(patch) && keysOf(patch).length === 1 && 'keywords/$seen' in patch
const isMovePatch = (patch: unknown, ctx: AllowContext): boolean => {
  if (!isObject(patch) || ctx.inbox === null || ctx.archive === null || ctx.inbox === ctx.archive) return false
  const inbox = `mailboxIds/${ctx.inbox}`
  const archive = `mailboxIds/${ctx.archive}`
  const keys = Object.keys(patch)
  if (keys.length !== 2 || !keys.includes(inbox) || !keys.includes(archive)) return false
  return (patch[inbox] === null && patch[archive] === true) || (patch[inbox] === true && patch[archive] === null)
}

/** The methods that only read: the kind each is, and the arguments it may carry (anything else, or any create/update/destroy, is refused). */
const READS: Record<string, { kind: AllowedKind; keys: readonly string[] }> = {
  'Mailbox/get': { kind: 'folders', keys: ['accountId', 'ids', 'properties'] },
  'Mailbox/changes': { kind: 'folder-changes', keys: ['accountId', 'sinceState', 'maxChanges'] },
  'Identity/get': { kind: 'identities', keys: ['accountId', 'ids', 'properties'] },
  'Thread/get': { kind: 'threads', keys: ['accountId', 'ids'] },
  'Email/query': {
    kind: 'message-list',
    keys: ['accountId', 'filter', 'sort', 'position', 'limit', 'calculateTotal'],
  },
  'Email/get': { kind: 'messages', keys: ['accountId', 'ids', 'properties'] },
  'Email/changes': { kind: 'message-changes', keys: ['accountId', 'sinceState', 'maxChanges'] },
  'PushSubscription/get': { kind: 'push-get', keys: ['ids', 'properties'] },
}

/** Which allowed kind a request is, or null when it is none of them (and so is never sent). `name` is the JMAP method, `args` its arguments. */
export function classify(name: string, args: Args, ctx: AllowContext): AllowedKind | null {
  const read = READS[name]
  if (read) return ['create', 'update', 'destroy'].some((k) => k in args) || !only(args, read.keys) ? null : read.kind
  if (name === 'Email/set') return classifyEmailSet(args, ctx)
  if (name === 'EmailSubmission/set') return classifySubmission(args, ctx)
  if (name === 'PushSubscription/set') return classifyPushSet(args)
  return null
}

const onlyOneWrite = (args: Args): boolean => ['create', 'update', 'destroy'].filter((k) => k in args).length === 1

function classifyEmailUpdate(update: Record<string, unknown>, ctx: AllowContext): AllowedKind | null {
  const patches = Object.values(update)
  if (patches.length === 0) return null
  const seen = (p: unknown) =>
    isSeenPatch(p) && isObject(p) && (p['keywords/$seen'] === true || p['keywords/$seen'] === null)
  if (patches.every(seen)) return 'set-seen'
  return patches.every((p) => isMovePatch(p, ctx)) ? 'move' : null
}

function classifyEmailCreate(create: Record<string, unknown>, ctx: AllowContext): AllowedKind | null {
  const made = Object.values(create)
  const message = made[0]
  if (made.length !== 1 || !isObject(message)) return null
  if (!only(message, OUTGOING_KEYS) || !only(message.keywords, OUTGOING_KEYWORDS)) return null
  // made in Drafts and nowhere else
  const into = keysOf(message.mailboxIds)
  const inDrafts =
    ctx.drafts !== null &&
    into.length === 1 &&
    into[0] === ctx.drafts &&
    isObject(message.mailboxIds) &&
    message.mailboxIds[ctx.drafts] === true
  return inDrafts ? 'make-outgoing' : null
}

function classifyEmailSet(args: Args, ctx: AllowContext): AllowedKind | null {
  if (!only(args, ['accountId', 'create', 'update', 'destroy']) || !onlyOneWrite(args)) return null
  if (isObject(args.update)) return classifyEmailUpdate(args.update, ctx)
  if (isObject(args.create)) return classifyEmailCreate(args.create, ctx)
  // the one unsent copy of a submission the server refused, by its id, and nothing else
  if (Array.isArray(args.destroy))
    return ctx.unsent !== null && args.destroy.length === 1 && args.destroy[0] === ctx.unsent ? 'remove-unsent' : null
  return null
}

function classifySubmission(args: Args, ctx: AllowContext): AllowedKind | null {
  if (!only(args, ['accountId', 'create', 'onSuccessUpdateEmail']) || !isObject(args.create)) return null
  const made = Object.values(args.create)
  if (made.length !== 1 || !isObject(made[0]) || !only(made[0], ['identityId', 'emailId'])) return null
  // what the server does to the message once it has submitted it: file it in Sent and take the draft mark off
  const after = args.onSuccessUpdateEmail
  if (after === undefined) return 'submit'
  if (!isObject(after)) return null
  // out of Drafts, into Sent, and the draft mark off, for the one message just made
  const allowed: Record<string, unknown> = {
    'keywords/$draft': null,
    ...(ctx.drafts !== null && { [`mailboxIds/${ctx.drafts}`]: null }),
    ...(ctx.sent !== null && { [`mailboxIds/${ctx.sent}`]: true }),
  }
  const fine = Object.values(after).every(
    (patch) => isObject(patch) && Object.entries(patch).every(([k, v]) => k in allowed && allowed[k] === v),
  )
  return fine ? 'submit' : null
}

function classifyPushSet(args: Args): AllowedKind | null {
  if (!only(args, ['create', 'update', 'destroy']) || !onlyOneWrite(args)) return null
  if (isObject(args.create)) {
    const made = Object.values(args.create)
    const one = made[0]
    if (made.length !== 1 || !isObject(one) || !only(one, ['deviceClientId', 'url', 'types'])) return null
    return typeof one.url === 'string' && one.url.startsWith('https://') ? 'push-make' : null
  }
  if (isObject(args.update)) {
    const patches = Object.values(args.update)
    const one = patches[0]
    if (patches.length !== 1 || !isObject(one)) return null
    const keys = Object.keys(one)
    if (keys.length === 1 && keys[0] === 'verificationCode') return 'push-verify'
    return keys.length === 1 && keys[0] === 'expires' ? 'push-renew' : null
  }
  return Array.isArray(args.destroy) && args.destroy.length === 1 ? 'push-remove' : null
}

/** The path a raw message is downloaded from (the one GET the module makes beside the API and the session). `name` is only what the download is called. */
export const downloadPath = (accountId: string, blobId: string): string =>
  `/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/message.eml`
