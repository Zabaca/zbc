/**
 * The shapes of the company's own mail server (Stalwart) over JMAP (RFC 8620 and 8621) that the inbox reads, and the errors the JMAP module tells its callers apart by. Only the fields something
 * here uses are declared (the same rule as src/gmail/types.ts): a type that lists everything the RFC documents would make a fixture that includes it all look like a faithful one.
 *
 * Plain data only, so these cross the Durable Object boundary and the tests unchanged.
 */

/** A folder, as `Mailbox/get` returns it. `role` is the RFC 8621 role word (inbox, sent, drafts, trash, junk, archive) or null for a folder with none. */
export interface JmapFolder {
  id: string
  name: string
  role: string | null
}

/** An address the account may send from, as `Identity/get` returns it. */
export interface JmapIdentity {
  id: string
  email: string
  name: string
}

/** A message's server-side state, as `Email/get` returns it (metadata only: the text is read from the raw copy). */
export interface JmapEmail {
  id: string
  threadId: string
  /** The folders it is in, by id. A mail app's Archive and Move change this. */
  mailboxIds: Record<string, boolean>
  /** `$seen`, `$flagged`, `$draft`, `$junk`, `$answered`. A mail app's read mark and star change this. */
  keywords: Record<string, boolean>
  /** When the server received it, ISO. */
  receivedAt: string
  blobId: string
  size: number
  /**
   * What the server itself says of the people and the subject, for a message too large to open here (the inbox reads the raw copy of everything else). Present only when asked for
   * (`JmapApi.emails(ids, { structure: true })`).
   */
  structure?: {
    from: { name: string | null; email: string }[] | null
    to: { name: string | null; email: string }[] | null
    cc: { name: string | null; email: string }[] | null
    replyTo: { name: string | null; email: string }[] | null
    subject: string | null
    sentAt: string | null
    preview: string
    messageId: string[] | null
    inReplyTo: string[] | null
  }
}

/** What changed since a state (`Email/changes`). */
export interface JmapChanges {
  oldState: string
  newState: string
  hasMoreChanges: boolean
  created: string[]
  updated: string[]
  destroyed: string[]
}

/** The two states a cursor holds: the Email state and the Mailbox (folder) state, as the server spells them. */
export interface JmapCursor {
  email: string
  mailbox: string
}

/** An outgoing message, as the inbox hands it over to be made and submitted. Always from the mailbox's own address; the server is asked for nothing else (no Bcc, no attachments). */
export interface JmapOutgoing {
  from: { name: string; email: string }
  to: string[]
  cc: string[]
  subject: string
  body: string
  /** The Message-ID the inbox chose and recorded when it claimed the draft, with its angle brackets. */
  messageId: string
  inReplyTo: string | null
  references: string[]
  /** The identity to submit under: the one whose address is `from`. */
  identityId: string
  /** The moment of sending, ISO: the Date header. */
  at: string
}

/** What the server answered to a submission. */
export interface JmapSubmitted {
  /** The id of the message the server made, in its Sent folder. */
  emailId: string
  threadId: string
}

/** The push subscription the inbox holds on the server for one mailbox. */
export interface JmapPushSubscription {
  id: string
  /** Null once it is verified. */
  verificationCode: string | null
  /** ISO. */
  expires: string | null
}

// ── Errors, classified here once: what the caller needs is what to DO, not the status ─────────────────────────────────

/** The server answered, and refused or failed. `type` is the RFC 8620 error type when it gave one. */
export class JmapError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | null = null,
  ) {
    super(message)
  }
}

/** The server refused the space's credential (a 401, or the Access gate's 403): retrying is pointless until a deploy changes it. */
export class JmapAuthError extends JmapError {
  constructor(message: string, status: number) {
    super(message, status)
  }
}

/** The state the cursor holds cannot be answered from any more: start a resync. */
export class JmapStateGone extends JmapError {
  constructor() {
    super('The mail server can no longer say what changed since the saved cursor.', 200, 'cannotCalculateChanges')
  }
}

/** The mail server could not be reached at all (a connection that failed, a timeout): said with the time since, and retried with a backoff. */
export class JmapUnreachable extends Error {}

/**
 * A call whose outcome is not known: the request left and the answer never came (a connection that dropped, a timeout), or the answer named neither success nor failure. NOT a JmapError on purpose,
 * so a caller that handles "the server refused" cannot catch it by accident and treat the message as unsent.
 */
export class JmapOutcomeUnknown extends Error {}
