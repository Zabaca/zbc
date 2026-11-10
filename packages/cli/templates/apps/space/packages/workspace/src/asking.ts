// Who is asking, and what an answer looks like, for everything the space asks of the inbox, meet, forms and the knowledge app.
//
// The rule (docs/adr/0003): the space's Worker checks the Access assertion ONCE per request, and every part that runs in it is handed the person that check named (`SignedIn`), then applies its own
// visibility rules (today the inbox admits only its owner). Before the parts moved into the space's Worker each app was a Worker of its own and
// verified the assertion the space forwarded (docs/adr/0001, superseded). This file is the one place a refusal and a failure get their shape, so the space can show one part as "could not be reached"
// while the rest works (one part down, the rest shows).
//
// Pure types and small functions: nothing here does I/O.

import type { Person } from './declaration'

/**
 * How long the space waits for a READ before it shows the other parts and says this one could not be reached (a few
 * seconds). READS ONLY. A write (send, post, mark read) is awaited up to the app's own limit (`WRITE_WITHIN_MS`), because a
 * space that gives up on a slow send has lost track of an email that may still go out.
 */
export const ANSWER_WITHIN_MS = 4000

/**
 * How long the space waits for a WRITE: longer than the slowest thing an app waits on, so the app's answer arrives before the
 * space stops listening. The inbox waits up to 25 seconds for Gmail (`SEND_TIMEOUT_MS`, packages/inbox/src/gmail/google.ts), so
 * this is a little past that. A write the space stops waiting for, or loses (the binding throws), is `outcome-unknown`.
 */
export const WRITE_WITHIN_MS = 30_000

/** The three parts the space draws from, named for what the person sees: mail, chat and documents. */
export const SPACE_PARTS = { mail: 'inbox', chat: 'meet', documents: 'forms' } as const
export type SpacePart = keyof typeof SPACE_PARTS

// ── The compose key: a send, or a post, goes out at most once ─────────────────────────────────────────────────────────────

/**
 * A key the SPACE chooses once per compose (one message being written, from the first keystroke to Send) and sends with every
 * write that makes something go out: each variant of the inbox's `send`, and meet's `post`. The apps remember it and refuse a
 * repeat, so pressing Send twice, or the space retrying after it lost track, can never send twice. Opaque to the apps: 16 to
 * 128 characters of letters, digits, `_` and `-` (a UUID without its braces fits); anything else is `bad-request`.
 *
 * WHY THE APPS MUST DO THIS, not the space: the inbox waits up to 25 seconds for Gmail, and its safety checks look only at
 * inbound mail after `through` (packages/inbox/src/store/mail.ts), so a second press with the same `through` makes a second
 * draft and sends a second email. Nothing but a remembered key stops that.
 */
export type ComposeKey = string

export const COMPOSE_KEY = /^[A-Za-z0-9_-]{16,128}$/

/** How long an app remembers a key it HOLDS (below): at least a day, well past any retry the space would make. */
export const COMPOSE_KEY_KEPT_MS = 24 * 60 * 60 * 1000

/**
 * WHEN A KEY IS USED UP. One rule, for the inbox's `send` and meet's `post`:
 *
 * - **Held**: a key is held only while its first use MAY have sent something: it is in progress, it sent, or it ended in the
 *   inbox's own `sending` (Gmail never said). A held key answers `Repeated` and nothing new is done.
 * - **Released**: a `Refused` releases it, because the app records nothing for a refusal and nothing went out (the inbox's
 *   `conflict` "a new message arrived, read it and press Send again"; meet's `limit`). So does a `Failed`: an app returns `broken`
 *   for a write only when it knows nothing went out. The same key then sends. Without this a refused first press would use up the
 *   key, and nothing could ever be sent from that compose.
 * - **Uncertain**: when the app cannot tell (Gmail timed out mid-send), it answers success with status `sending` and HOLDS the key.
 *   It never answers `broken` for that, and never releases.
 *
 * **Each part that sends proves BOTH halves with a test**: a refused (or `broken`) first use followed by the same key sends; a sent,
 * in-progress or `sending` first use followed by the same key answers `Repeated` and sends nothing new.
 */

// ── Refusals and failures ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why an app said no. The app knew who was asking, or could tell what was asked was wrong, and the answer is a decision, not a
 * fault; the space shows the rest and does not call it "could not be reached".
 *
 * - `not-signed-in`: no assertion, or one that did not verify (forged, expired, for another application, another team, a
 *   service token, naming both a person and a token). Nothing is learned from which.
 * - `not-admitted`: a verified person of this install whom this app's own rules do not admit (the inbox admits its owner only),
 *   or an act the app's rules forbid them.
 * - `not-found`: what was named does not exist, or exists but is not theirs to see (another mailbox's mail, a channel they are
 *   not in). The two are never told apart.
 * - `bad-request`: the arguments are not the shape the method takes, or name a position that does not exist (the inbox's 422 for
 *   a `through` past the end of a conversation).
 * - `conflict`: the thing changed since the caller saw it (a draft edited since its revision, mail that arrived after the
 *   position the caller read to). Showing it again and letting the person decide is the fix.
 * - `limit`: a rate or size limit of the app's own (meet's six messages in ten seconds).
 */
export const REFUSAL_REASONS = ['not-signed-in', 'not-admitted', 'not-found', 'bad-request', 'conflict', 'limit'] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export interface Refused {
  ok: false
  kind: 'refused'
  reason: RefusalReason
  /** A sentence the signed-in person may be shown, the app's own words where it has them. For `not-signed-in` always the same one. */
  message: string
}

/**
 * The app could not do what was asked. THE ONLY REASON AN APP MAY RETURN IS `broken`: the app was reached and something it
 * depends on failed (Gmail would not send, a store threw); an app catches its own faults and returns this rather than throwing.
 * On a WRITE it means the app knows nothing went out. When an app does not know (Gmail never said), it answers success with the
 * unconfirmed status its result type has (`InboxSent.status: 'sending'`), never `broken`.
 */
export interface Failed {
  ok: false
  kind: 'failed'
  reason: 'broken'
  message: string
}

/**
 * What every method of every entrypoint answers: the value, a refusal, or a failure. Data and not an exception, because an
 * error thrown across a service binding arrives as a message with its type and fields gone, and the space must tell a
 * decision from a fault. An entrypoint throws for nothing it can foresee.
 */
export type SpaceReply<T> = { ok: true; value: T } | Refused | Failed

/**
 * A write's answer to a key it HOLDS (see COMPOSE_KEY_KEPT_MS above): nothing new was done, and `earlier` says how the first went. `in-progress`
 * when the first use is still being worked (the inbox is waiting on Gmail): the space shows "sending", not a second attempt.
 * This is a refusal, so `kind` is `refused`; its reason is not one of `RefusalReason` because it carries a value.
 */
export interface Repeated<T> {
  ok: false
  kind: 'refused'
  reason: 'repeated'
  message: string
  /**
   * `done` carries the first use's successful reply (a refusal would have released the key, so `reply` is a success). An
   * `in-progress` record ENDS: one older than `WRITE_WITHIN_MS` is answered as `done` with the app's own unconfirmed status
   * (the inbox's `sending`, "check Gmail Sent"), matching its stuck state, so the space never shows "sending" for good.
   */
  earlier: { state: 'done'; reply: SpaceReply<T> } | { state: 'in-progress' }
}

/** What a write (the inbox's `send` and `markRead`, meet's `post` and `markRead`) answers. */
export type WriteReply<T> = SpaceReply<T> | Repeated<T>

/**
 * Why the SPACE has no answer from an app. ONLY THE SPACE MAKES THESE: an app that is not there, or too slow, cannot say so, and
 * an app never returns one.
 *
 * - `unreachable`: the binding threw, or the app is not deployed.
 * - `timed-out`: no answer within `ANSWER_WITHIN_MS`. READS ONLY.
 * - `not-understood`: an answer that is not the shape this contract says; never half read, as the inbox treats the Client list.
 * - `outcome-unknown`: a WRITE the space lost track of (the binding threw, or it stopped waiting). The thing may have been done.
 *   The space says "outcome unknown", points at the app's own view (Gmail's Sent, the channel), and NEVER offers a retry.
 */
export type SpaceFailureReason = 'unreachable' | 'timed-out' | 'not-understood' | 'outcome-unknown'

export interface Unanswered {
  ok: false
  kind: 'failed'
  reason: SpaceFailureReason
  message: string
}

/** What the space has after a call: an app's reply, or none. */
export type Reached<T> = SpaceReply<T> | Unanswered
/** The same for a write, which may also answer that its key was already used. */
export type ReachedWrite<T> = WriteReply<T> | Unanswered

/** Every reason a part can be down for, as the Conversations list reports it. */
export type FailureReason = Failed['reason'] | SpaceFailureReason

export const answered = <T>(value: T): SpaceReply<T> => ({ ok: true, value })
export const refused = (reason: RefusalReason, message: string): Refused => ({ ok: false, kind: 'refused', reason, message })
export const failed = (message: string): Failed => ({ ok: false, kind: 'failed', reason: 'broken', message })
export const repeated = <T>(earlier: Repeated<T>['earlier']): Repeated<T> => ({
  ok: false,
  kind: 'refused',
  reason: 'repeated',
  message: 'That was already sent.',
  earlier,
})
/** For the space only. */
export const unanswered = (reason: SpaceFailureReason, message: string): Unanswered => ({ ok: false, kind: 'failed', reason, message })

export const NOT_SIGNED_IN = 'You are not signed in.'
export const NOT_ADMITTED = 'This is not open to you.'

/** Who a verified assertion names, and when it stops being good (seconds since the epoch, as the assertion carries it). */
export interface Asker {
  person: Person
  exp: number
}

/**
 * A person the space's ONE sign-in check has named (ADR 0003), handed to a part that runs inside the space's Worker. The first argument of every
 * method of a part that is called in-process (forms' reads, the knowledge app): it replaces the `Assertion` those methods took while they were
 * apps of their own, so a part no longer verifies anything and cannot be asked on a person's behalf without the check having happened.
 *
 * Branded, so that only `signedIn` makes one: a person's address, a `Person` read from the declaration or an `Asker`
 * will not typecheck where one is asked for. The brand is the compiler's and nothing more. What keeps a stranger from holding one is that the
 * parts are functions of the space's own bundle: there is no binding, no route and no argument a request can put one in.
 *
 * `exp` is when the assertion that made it stops being good (seconds since the epoch), for the part that wants a shorter window.
 */
declare const signedInBrand: unique symbol
export type SignedIn = Asker & { readonly [signedInBrand]: true }

/** Mint a `SignedIn` from the person the one check verified. Called by the space's check and by nothing a request can reach. */
export const signedIn = (person: Person, exp: number): SignedIn => ({ person, exp }) as SignedIn
