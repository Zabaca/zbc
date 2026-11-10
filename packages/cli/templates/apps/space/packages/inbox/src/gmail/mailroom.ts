import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  CALENDAR_SUMMARY_PART_MAX,
  type CalendarAccess,
  type CalendarAccessLevel,
  type CalendarGrant,
  type CalendarSummary,
  type FileRange,
  INBOX_FILE_PART_BYTES,
  INBOX_FILE_WHOLE_BYTES,
  INBOX_MOST_FILE_BYTES,
  resolveByteRange,
} from '@space/workspace'
import type { RawBucket } from '../cloudflare/arrivals'
import { keptAttachment } from '../cloudflare/parse'
import {
  buildOutgoing,
  type ChosenFile,
  EmailRefused,
  type EmailSender,
  infoOf,
  sentCopy,
  sentCopyKey,
  sentFileKey,
} from '../cloudflare/send'
import { MAX_OPEN_MESSAGE_BYTES, MAX_PREVIEW_BYTES, sniffImage, wantsPreview } from '../image'
import { filesFromBusinessMailboxOnly, onlyOwnerConnects, onlyOwnerResolves } from '../owner-words'
import type { AttachmentRef, GmailSendPlan, MailboxRow, MailStore, SyncJob } from '../store/mail'
import { fail, ok, type Result } from '../store/store'
import type { PictureFacts } from '../store/telegram'
import { dropPicture, putPicture, readPictureObject, sha256Hex, sniffVideo, sniffVoice } from '../telegram/media'
import {
  isCopiedKind,
  sniffPicture,
  TELEGRAM_PICTURE_MAX_BYTES,
  type TelegramCopiedKind,
  telegramFileMax,
} from '../telegram/wire'
import {
  CALENDAR_ACTOR,
  type ConversationChange,
  type ConversationState,
  type DraftInput,
  FILL_DAYS,
  isAgent,
  type MailboxStatus,
  type MessageRow,
  type SendRequest,
} from '../types'
import {
  GMAIL_SCOPE,
  type GmailApi,
  GmailAuthError,
  GmailError,
  GmailHistoryGone,
  GmailPartialChange,
  type GoogleAuth,
  type SentMessage,
} from './google'
import { DAY_MS, grantWorks, lapsedReason } from './health'
import { planHistory } from './history'
import { buildMime, MimeError, toRaw } from './mime'
import { attachmentParts, base64Bytes, calendarOfMessage, calendarPartOf, parseMessage, summaryOfBytes } from './parse'
import { type GmailMessage, inPlay, type ParsedMessage } from './types'

/**
 * The Mailroom: everything the inbox does with Gmail that takes more than one
 * breath. It connects the account, reads in the first thirty days, takes a push as
 * a hint and asks Gmail what changed, recovers when the cursor goes stale, and
 * renews the watch once a day. The store (store/mail.ts) holds every rule about
 * what a message becomes; this is the order of operations around the awaits.
 *
 * ── A PUSH IS A HINT, THE CURSOR IS THE TRUTH ────────────────────────────
 * `receivePush` does one thing: it records that changes are owed and asks for an
 * alarm NOW, then returns, so Pub/Sub's ack deadline can never trigger a retry.
 * The alarm (`runAlarm`) does the work. What it asks Gmail is "what changed since
 * my cursor", never "what does this push say", and the cursor moves only in the
 * same transaction that stores a page.
 *
 * ── WHY THE WORK IS CHUNKED ──────────────────────────────────────────────
 * A Worker invocation has a hard subrequest limit, and a fetch per message is a
 * subrequest. A thirty-day fill is hundreds of messages and a gap after an outage
 * can be more, so each run stops after a budget of fetches and asks for another
 * alarm. Progress is in the database (the cursor, or the job's page token), so a
 * run that dies loses nothing but its own page.
 *
 * ── READ AND CLOSE GO TO GMAIL FIRST ──────────────────────────────────────
 * `changeConversation` is how a person (or Claude, for close and reopen) changes
 * an email conversation's state. It asks Gmail to change the thread, and ONLY
 * when Gmail accepts does the store apply the same change. A refusal changes
 * nothing here and comes back as a 502 saying why, so the inbox never claims a
 * state Gmail does not have because of the inbox. The history event Gmail then
 * publishes for the change finds the store already there and does nothing.
 *
 * ── SENDING GOES TO GMAIL BETWEEN A CLAIM AND A FILING ───────────────────
 * `sendDraft` is how the owner's Send, or Claude's on their instruction, becomes an email, and
 * it is built so that a message cannot go out twice and cannot go out changed. It plans (the store's checks),
 * builds the message, CLAIMS the draft (one conditional write, draft to sending), calls
 * Gmail once, and files the answer. All of it runs in `exclusive`, so a second press
 * waits and then finds the draft sent, and no sync stores the message Gmail has just
 * made between Gmail accepting it and the filing. What a failure means is decided by
 * what Gmail can be known to have done:
 *   - Gmail REFUSED (a 4xx, a sign-in that no longer works, a token that could not be
 *     minted): nothing went out, so the draft goes back to being a draft and the answer
 *     says whether to fix what was typed (422) or to try later (502).
 *   - The outcome is NOT KNOWN (a connection that dropped after the request left, a 5xx,
 *     an answer that names no message): the message may have gone out, so the draft is
 *     NOT put back. It stays `sending`, shown as "check Gmail Sent", and only the owner can
 *     say which way it went (`resolveSend`). Nothing here ever retries a send.
 *   - Gmail ACCEPTED but the inbox could not file it (the store failed): the same, since
 *     the message is out. The next sync stores Gmail's copy.
 * A reply is also checked against the thread in Gmail just before it goes (as Close is),
 * so it cannot go out over a message that arrived and has not been shown yet.
 * CLAUDE'S SEND IS THIS SAME PATH, not a second one: the same plan, claim, call and
 * filing, the same exclusive and the same meaning for each failure, and nothing in this
 * file knows who is sending. What differs is decided in the store before and at the
 * claim (the switch, the owner's instruction, and recording that instruction), so the two
 * cannot drift apart.
 *
 * ── A BUSINESS MAILBOX'S REPLY TAKES THE SAME STEPS THROUGH CLOUDFLARE ───
 * `sendDraft` asks the store first which transport the draft goes through (its conversation's mailbox, or for a new email the
 * mailbox the contact last wrote to), and a Cloudflare one runs `sendViaCloudflare`: the same plan (the store's checks, the
 * switch and the instruction for Claude), the same claim, ONE call to the Worker's `send_email` binding, and a filing only
 * when it ACCEPTS. A refusal that says nothing went out puts the draft back; anything else leaves it `sending` for the owner to
 * say, since there is no Sent folder to look in and no copy that will arrive by itself. The exact request is kept in the
 * raw-mail bucket after Cloudflare accepts and before the message is filed. The two transports never cross: Gmail is not
 * asked about a business mailbox's draft, and the binding is not asked about the owner's Gmail. ADR 0001, decision 18.
 *
 * ── SEVERAL ACCOUNTS ─────────────────────────────────────────────────────
 * The owner can have more than one Gmail account (the mailbox table always could hold them; the code now names a row). Each account has its own grant, cursor, watch,
 * job, push counters and error, and everything here that used to mean "the mailbox" takes the row of the account it is about: a push by the address it carries,
 * a conversation's changes by the account the conversation came through, a reply from that same account, a new email from the one chosen (or the default). One
 * alarm serves them all: a run works every account that is owed something, an account's failure never stops another's, and the retry waits only as long as
 * the failed accounts' backoff when nothing else is owed. A grant Google no longer accepts (a testing app's lasts 7 days) is NOT retried: the account is marked
 * LAPSED where the status and Settings say so by name, nothing syncs, renews or sends for it, and connecting it again (one click) ends the lapse.
 * Only the owner connects, and any address may be connected: the one check that mattered (which account) is now the owner's choice at Google.
 *
 * ── ONE AT A TIME ────────────────────────────────────────────────────────
 * A Durable Object serializes storage, but an `await` on the network lets another
 * request in. Connecting, disconnecting, the alarm and the daily pass therefore
 * run one after another through `exclusive`, so two of them can never be halfway
 * through the same page. A push is not among them: it is one write.
 *
 * ── FAILURE ──────────────────────────────────────────────────────────────
 * Anything that throws leaves the cursor where it was, records the error where
 * the header shows it, and (except when Google says the grant is gone, where
 * retrying only hammers Google) schedules the alarm again with a growing delay.
 * Idempotent upserts mean the retry costs nothing.
 *
 * ── WHAT IT CANNOT KNOW IN A WORKTREE ────────────────────────────────────
 * Every method here is driven in tests by a Google that can fail
 * (test-support/fake-google.ts). Whether the real one behaves the same (the label
 * events a watch delivers, `after:` taking epoch seconds, how fast pushes arrive)
 * is the hand test, and the runbook lists what to check.
 */

/** Where the first fill (or a resync with nothing held) starts: FILL_DAYS back. */
const fillSince = (now: Date): Date => new Date(now.getTime() - FILL_DAYS * DAY_MS)

/** Messages fetched per run before asking for another alarm. */
export const FETCH_BUDGET = 150
/** Threads re-read per run in a resync's label stage. */
export const LABEL_BUDGET = 150
/** Replaced calendar conversations closed per run (each is a Gmail call or two). */
export const SUPERSEDE_PER_RUN = 20
/** Stored messages the one-time calendar pass reads again from Gmail per run. */
export const CALENDAR_PASS_PER_RUN = 100
/** How many stored messages the calendar summary pass reads in one run: the pass holds the Mailroom's turn while it reads, so a push, a Close or a Sync now waits behind at most this many Gmail reads, and the alarm is asked for again while more are left. */
export const CALENDAR_SUMMARY_PASS_PER_RUN = 25
/** Failures in a row (not one message, so Gmail) after which the calendar pass ends its run. */
export const CALENDAR_PASS_FAILURES = 3
/** How long a conversation Gmail refused to close is left alone before it is tried again. */
export const SUPERSEDE_RETRY_MS = 60 * 60 * 1000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 60 * 60 * 1000

/** Retry delay after the Nth failure in a row: 30s, 1m, 2m ... capped at an hour. */
export const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))

/** The Gmail search for a window of Inbox and Sent mail since `since`. */
export const windowQuery = (since: Date): string => `(in:inbox OR in:sent) after:${Math.floor(since.getTime() / 1000)}`

/**
 * An attachment handed back to be shown or saved. A PICTURE (`inline`) carries the type its own first bytes say (never the sender's word); anything
 * else is a download, always `application/octet-stream`, so nothing a stranger attached is ever served as something a browser would run.
 */
export interface AttachmentImage {
  bytes: Uint8Array
  type: string
  name: string
  inline: boolean
  /** Set with `part` and `unsatisfiable`: the length of the whole file (`InboxFileOut` says the rest). */
  total?: number
  part?: { first: number; last: number }
  unsatisfiable?: true
}

const TOO_LARGE_TO_OPEN = `This message is larger than ${MAX_OPEN_MESSAGE_BYTES / (1024 * 1024)} MB, which is too large for the inbox to open a file from. The whole message is kept in the raw-mail bucket.`
/** The kinds of a Telegram file the inbox hands back for showing (`view`); every kind that is kept can be saved. */
const SHOWN_TELEGRAM_KINDS: readonly string[] = ['photo', 'image', 'voice', 'video']
/** How much of a kept file's start is read to say what it is: the longest signature (an MP4's box, a WebP's header) is under this. */
const HEAD_BYTES = 32
const NOT_KEPT = 'The inbox no longer has this message’s kept copy.'
const KEPT_COPY_CHANGED = 'The kept copy no longer matches this file.'
const NOT_A_TELEGRAM_FILE =
  'This is not a photo, voice note or video the inbox can show. Save it, or open it in Telegram.'

const TOO_LARGE = 'This picture is too large for the inbox to show. Open it in Gmail.'
const NOT_A_PICTURE =
  'This attachment is not a PNG, JPEG, GIF or WebP picture, so the inbox does not show it. Open it in Gmail.'

/** What a kept Telegram file is, by its own first bytes and its kind: the type to serve it as, or a refusal in words. */
function sniffTelegram(kind: TelegramCopiedKind, head: Uint8Array): Result<string> {
  const type = kind === 'voice' ? sniffVoice(head) : kind === 'video' ? sniffVideo(head) : sniffImage(head)
  if (type !== null) return ok(type)
  return fail(415, kind === 'photo' || kind === 'image' ? NOT_A_PICTURE : NOT_A_TELEGRAM_FILE)
}

export interface MailroomPorts {
  store: MailStore
  /** Null when the OAuth client's id or secret is not set on this Worker. */
  google: GoogleAuth | null
  now: () => Date
  /** Ask for the alarm at `at`. Replaces any alarm already set. */
  scheduleAlarm: (at: Date) => void | Promise<void>
  /** `projects/<id>/topics/<name>`, from the Google module. Empty when unset. */
  topicName: string
  /**
   * Hands on the notifications the sync marked owed (src/notify/deliver.ts), after each run's pages are stored.
   * Optional: a Mailroom without one notifies nobody.
   */
  notifications?: { deliverOwed(): Promise<void> } | null
  /**
   * Sending as a Cloudflare mailbox: the Worker's `send_email` binding (null where the Worker has none, so a business mailbox's send is
   * refused 503 before anything is claimed) and the raw-mail bucket the copy of what was sent is kept in.
   */
  cloudflare?: { sender: EmailSender | null; bucket: RawBucket } | null
  /**
   * The room that serves the mailboxes on the company's own mail server (src/jmap/room.ts). Gmail's Mailroom is not generalised for them: a conversation or a draft that is one of theirs is handed to this room before anything
   * of Gmail's runs, so the owner's Gmail never waits on the mail server (its own chain) and nothing here knows how a JMAP mailbox is read or written.
   */
  jmap?: {
    changeJmapConversation(
      conversationId: string,
      change: ConversationChange,
      actor: string,
      through: number | null,
    ): Promise<Result<ConversationState>>
    sendJmap(id: string, input: SendRequest, actor: string, files: readonly ChosenFile[]): Promise<Result<MessageRow>>
  } | null
}

export class Mailroom {
  private chain: Promise<unknown> = Promise.resolve()
  /** The turns kept-file reads take (`readKept`): their own chain, never `exclusive`'s. */
  private keptReads: Promise<unknown> = Promise.resolve()
  /** When each replaced calendar conversation was last refused a close (`closeReplaced`); in memory, so a restart tries them all once more. */
  private readonly refusedAt = new Map<string, number>()

  constructor(private readonly ports: MailroomPorts) {}

  private get store(): MailStore {
    return this.ports.store
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private alarmNow(): void | Promise<void> {
    return this.ports.scheduleAlarm(this.ports.now())
  }

  // ─── connecting ──────────────────────────────────────────────────────

  /**
   * Finish the sign-in: exchange the code, check what was granted and WHO
   * granted it, and only then keep anything. A grant that is not gmail.modify is
   * revoked at Google on the spot so it does not linger, and nothing is stored. ANY
   * address may be connected (the owner's accounts: the one they signed in to at Google
   * is the one connected, and a second sign-in to an account already held replaces
   * its grant). A code is exchanged with the return address the sign-in was started with, because Google refuses any other:
   * the space's (`gmailConnect` in src/space-views.ts); there is no default, since the inbox has no return address of its own.
   */
  connectMailbox(
    code: string,
    actor: string,
    redirectUri: string,
    purpose: 'mail' | 'calendar' = 'mail',
  ): Promise<Result<MailboxStatus>> {
    // Before the code is spent: only the owner connects an account, and the space's gate has said so already (this is the store's own lock, as every owner-only act has).
    if (actor !== this.store.owner.email) return Promise.resolve(fail(403, onlyOwnerConnects(this.store.owner.name)))
    return this.exclusive(async () => {
      const google = this.ports.google
      if (!google) {
        return fail(503, 'Gmail sign-in is not set up on this Worker: the Google client id and secret are missing.')
      }

      let refreshToken: string | null
      let scopes: string[]
      try {
        const granted = await google.exchangeCode(code, redirectUri)
        refreshToken = granted.refreshToken
        scopes = granted.scopes
      } catch (error) {
        return fail(502, `Google would not complete the sign-in: ${describe(error)} Try connecting again.`)
      }
      if (refreshToken === null) {
        return fail(422, 'Google did not grant lasting access. Connect again, and accept every permission it asks for.')
      }
      // The calendar's own Connect (Settings, Calendars) adds the calendar permission to an account that is already connected for mail: Google adds what the account already granted to the new grant, so it must come back with BOTH mail's and the calendar's reading permission. The permission to change events (`calendar.events`, asked beside it) is NOT required: a grant that reads without it is kept and shown as connected for reading, and `calendarGrants` says it lacks `events`.
      // When it does not, nothing is kept and NOTHING IS REVOKED: revoking the new token ends the account's whole grant at Google, mail's included, and the grant held here is still good.
      const forCalendar = purpose === 'calendar'
      const dropNew = async (): Promise<void> => {
        if (!forCalendar) await google.revoke(refreshToken)
      }
      if (forCalendar && !scopes.includes(GMAIL_SCOPE)) {
        return fail(
          409,
          "Google did not keep this account's mail permission with the calendar's, so nothing was changed. Connect the account in Mailboxes first, then add the calendar here.",
        )
      }
      if (forCalendar && !scopes.includes(CALENDAR_READONLY_SCOPE)) {
        return fail(
          422,
          'The sign-in did not grant the calendar permission, so nothing was changed. Press Connect calendar again and accept it.',
        )
      }
      if (!scopes.includes(GMAIL_SCOPE)) {
        await dropNew()
        return fail(403, 'The sign-in did not grant permission to read and organize Gmail, so nothing was connected.')
      }

      const gmail = google.gmail(refreshToken)
      let profile: { emailAddress: string; historyId: string }
      try {
        profile = await gmail.getProfile()
      } catch (error) {
        await dropNew()
        return fail(502, `Gmail would not answer after sign-in: ${describe(error)} Try connecting again.`)
      }
      const address = profile.emailAddress.trim().toLowerCase()
      if (address === '') {
        await dropNew()
        return fail(502, 'Gmail did not say which account that was, so nothing was connected. Try connecting again.')
      }

      const row = this.store.connectMailbox(
        {
          address,
          refreshToken,
          scopes,
          historyId: profile.historyId,
          query: windowQuery(fillSince(this.ports.now())),
        },
        actor,
      )
      try {
        await this.renewWatch(row, gmail)
      } catch (error) {
        // Connected is connected: the fill and the daily pass do not need the
        // watch. It shows amber until a renewal works.
        this.store.recordFailure(row.id, `Could not start the live connection: ${describe(error)}`)
      }
      await this.alarmNow()
      return ok(this.store.mailboxStatus(row.id) as MailboxStatus)
    })
  }

  // ─── the calendar's door ─────────────────────────────────────────────────────

  /**
   * The Google accounts as the calendar is told of them: who is connected, whether the grant is lapsed, whether it includes the calendar permission, and the label mail
   * calls the account. NO TOKEN is in it. Asked by the calendar's store (a Durable Object of the same Worker) and by nothing a request reaches. Not under `exclusive`: it reads.
   */
  calendarGrants(): Promise<CalendarGrant[]> {
    return Promise.resolve(
      this.store.gmailMailboxes().map(
        (row): CalendarGrant => ({
          address: row.address,
          label: row.name,
          connected: row.refreshToken !== null,
          lapsed: row.lapsedAt !== null,
          calendar: row.scopes.includes(CALENDAR_READONLY_SCOPE),
          events: row.scopes.includes(CALENDAR_EVENTS_SCOPE),
        }),
      ),
    )
  }

  /**
   * A short-lived access token for the calendar, LIMITED TO THE CALENDAR PERMISSION: Google is asked for that scope alone when the refresh token is used, so the calendar
   * (which keeps its tokens in memory and its events in a store of its own) holds nothing that can read or change mail. The refresh token stays in this store and is in no answer
   * and no error. One grant per account serves mail and calendar, so when Google ends it the account is lapsed here, for mail and calendar together, and says so
   * in the one sentence both use. `fresh` skips the in-memory token (the calendar saw a 401 with the last one).
   *
   * `level` is the seam for booking: `read` (the default, and all the sync ever asks for) is a token for `calendar.readonly` alone; `events` is a token for `calendar.events` alone, refused (`no-events`) for a grant that
   * lacks it. Nothing asks for `events` yet. Anything but the word `events` is `read`, so a reading token can never be turned into a writing one by a mistaken argument.
   */
  async calendarAccess(address: string, fresh = false, level: CalendarAccessLevel = 'read'): Promise<CalendarAccess> {
    const scope = level === 'events' ? CALENDAR_EVENTS_SCOPE : CALENDAR_READONLY_SCOPE
    const row = typeof address === 'string' ? this.store.mailboxRowAt(address) : null
    if (!row || row.refreshToken === null)
      return {
        ok: false,
        why: 'disconnected',
        message: `${typeof address === 'string' ? address : 'That account'} is not connected.`,
      }
    if (row.lapsedAt !== null) return { ok: false, why: 'lapsed', message: lapsedReason(row.address) }
    if (!row.scopes.includes(scope)) {
      return scope === CALENDAR_EVENTS_SCOPE
        ? {
            ok: false,
            why: 'no-events',
            message: `${row.address} is connected without the permission to change events. Press Connect calendar in Settings, Calendars and accept it.`,
          }
        : {
            ok: false,
            why: 'no-calendar',
            message: `${row.address} is connected for mail without the calendar permission. Press Connect calendar in Settings, Calendars and accept it.`,
          }
    }
    const google = this.ports.google
    if (!google) return { ok: false, why: 'failed', message: 'Google sign-in is not set up on this Worker.' }
    try {
      const grant = await google.accessToken(row.refreshToken, scope, fresh === true)
      return { ok: true, accessToken: grant.accessToken, expiresAt: grant.expiresAt }
    } catch (error) {
      this.noteAuth(row.id, error)
      if (error instanceof GmailAuthError) return { ok: false, why: 'lapsed', message: lapsedReason(row.address) }
      return {
        ok: false,
        why: 'failed',
        message: `Google would not give the calendar access just now: ${describe(error)}`,
      }
    }
  }

  /** Forget one account's token: stop its watch, revoke its grant, and keep nothing that can reach that Gmail. The other accounts are untouched. */
  disconnectMailbox(mailboxId: string, actor: string): Promise<Result<{ revoked: boolean }>> {
    if (actor !== this.store.owner.email) return Promise.resolve(fail(403, onlyOwnerConnects(this.store.owner.name)))
    return this.exclusive(async () => {
      const row = this.store.mailboxRow(mailboxId)
      if (!row || row.refreshToken === null) return fail(409, 'That Gmail account is not connected.')
      let revoked = false
      if (this.ports.google) {
        try {
          await this.ports.google.gmail(row.refreshToken).stop()
        } catch {
          // Best effort: revoking the grant ends the watch's access anyway.
        }
        revoked = await this.ports.google.revoke(row.refreshToken)
      }
      this.store.disconnectMailbox(row.id, actor, revoked)
      return ok({ revoked })
    })
  }

  // ─── what wakes it ───────────────────────────────────────────────────

  /**
   * A verified push arrived. One write and an alarm, and nothing else: no Gmail
   * call, nothing that can be slow. The push names the account it is about
   * (`emailAddress`) and only that account is owed a sync; a push that names none
   * we can read is a hint for every account. A push for an account we do not hold
   * (or hold without a working grant) is acknowledged and dropped, because a refusal
   * would only make Pub/Sub send it again.
   */
  async receivePush(address: string | null): Promise<void> {
    const rows =
      address === null
        ? this.store.gmailMailboxes()
        : [this.store.mailboxRowAt(address)].filter((r): r is MailboxRow => r !== null)
    const live = rows.filter(grantWorks)
    if (live.length === 0) return
    for (const row of live) this.store.recordPush(row.id)
    await this.alarmNow()
  }

  /**
   * "Sync now": changes are owed, and a run is asked for. Not a push, so it is not counted as one. For one account (`mailboxId`) or, with none named,
   * for every account with a working grant; an account named that is not connected, or whose grant has lapsed, is said so in words.
   */
  async requestSync(mailboxId?: string): Promise<Result<{ queued: true }>> {
    if (mailboxId !== undefined) {
      const row = this.store.mailboxRow(mailboxId)
      if (!row || row.refreshToken === null) return fail(409, 'That Gmail account is not connected.')
      if (row.lapsedAt !== null) return fail(409, lapsedReason(row.address))
    } else if (!this.store.gmailMailboxes().some((r) => grantWorks(r))) {
      return fail(409, 'Gmail is not connected.')
    }
    this.store.markSyncOwed(mailboxId)
    await this.alarmNow()
    return ok({ queued: true })
  }

  /**
   * Read, close or reopen a conversation. Gmail first: the thread is changed there,
   * and only once Gmail accepts does the inbox change, so the two cannot disagree
   * because of the inbox. A change that is not needed (already read, already
   * closed) asks Gmail for nothing. A manual conversation has no Gmail side and is
   * changed here alone.
   *
   * ── NOTHING UNSEEN IS READ OR ARCHIVED ───────────────────────────────────
   * Read and close act on the whole thread in Gmail, so a reply that arrived after
   * the person's page was loaded would be marked read, or filed under Closed, without
   * anybody having looked at it. `through` says how far the page reached. Two checks
   * refuse (409, nothing changed) when an inbound message the change would affect
   * (unread, for a read; in the Inbox, for a close) is beyond it: the store's (a
   * message already held), and Gmail's own thread, read just before the change, for
   * one the inbox does not hold yet. Every message missing is stored on the spot, so
   * the reload that follows shows it; one the change would leave as it is (an old
   * archived message from before the first fill) refuses nothing. Only the milliseconds between that
   * read and the change are left, and Gmail's own app has the same window.
   *
   * A thread Gmail no longer has (deleted there) is closed or marked read here
   * anyway: there is nothing in Gmail to be out of step with, and refusing would make
   * the conversation impossible to close. Reopening one is refused, since there is
   * nothing to put back.
   *
   * It runs in `exclusive` with the sync, so a sync cannot be halfway through a page
   * of history that predates the change while the change lands. The first check is
   * outside it only to find out whether there is a Gmail side at all: a manual
   * conversation never waits behind a sync, and the check is repeated inside, where
   * the answer is the one acted on.
   *
   * Never reached by a read. The Worker's GET routes call no Mailroom method, and
   * "read" is refused to the agent in app.ts: Claude's reading marks nothing.
   */
  changeConversation(
    conversationId: string,
    change: ConversationChange,
    actor: string,
    through: number | null,
  ): Promise<Result<ConversationState>> {
    // A conversation on the mail server is the JMAP room's, whole: its server is asked first, in its own chain.
    if (this.store.conversationMailboxKind(conversationId) === 'jmap') {
      return this.ports.jmap
        ? this.ports.jmap.changeJmapConversation(conversationId, change, actor, through)
        : Promise.resolve(fail(503, 'The mail server is not set up on this Worker, so nothing was changed.'))
    }
    const first = this.store.planConversationChange(conversationId, change, through)
    if (!first.ok) return Promise.resolve(first)
    if (first.value.threadId === null) {
      return Promise.resolve(this.store.applyConversationChange(conversationId, change, actor))
    }

    return this.exclusive(() => this.changeHeld(conversationId, change, actor, through))
  }

  /** `changeConversation`'s second half, for a caller that already holds `exclusive` (the sweep of replaced calendar mail, which runs inside the alarm's turn). */
  private async changeHeld(
    conversationId: string,
    change: ConversationChange,
    actor: string,
    through: number | null,
  ): Promise<Result<ConversationState>> {
    const plan = this.store.planConversationChange(conversationId, change, through)
    if (!plan.ok) return plan
    if (plan.value.needed && plan.value.threadId !== null) {
      const refused = await this.askGmail(conversationId, plan.value.threadId, change, through, actor)
      if (refused) return refused
    }
    return this.store.applyConversationChange(conversationId, change, actor)
  }

  /**
   * The ONE-TIME pass over Gmail mail stored before the store knew which event a message is about. Whether a message is Google's own
   * calendar mail turns on its `Sender` and `List-Id` headers, which the store never kept, so each candidate (`MailStore.calendarCandidates`: the stored
   * text has one of Google Calendar's event links, or the message has a calendar attachment) is read again from Gmail and parsed as new mail is; what that
   * says is recorded, `none` included, so nothing is read twice. At most `CALENDAR_PASS_PER_RUN` a run, with the alarm asked for again while more are
   * left; it is done (a setting row) once every account with a working grant has none left. An account that failed this run, or whose grant does not
   * work, is left alone; a lapsed account's stored mail stays unkeyed. Runs before `closeReplaced`, which closes the duplicates it makes visible.
   * NEVER THROWS.
   */
  private async keyStoredCalendarMail(failedIds: ReadonlySet<string>): Promise<void> {
    try {
      if (this.store.calendarPassDone() || !this.ports.google) return
      let looked = 0
      let blocked = false
      for (const row of this.store.gmailMailboxes()) {
        if (!grantWorks(row)) continue
        if (failedIds.has(row.id)) {
          blocked = true
          continue
        }
        const gmail = this.ports.google.gmail(row.refreshToken as string)
        let failures = 0
        for (const c of this.store.calendarCandidates(row.id, CALENDAR_PASS_PER_RUN - looked)) {
          let raw: GmailMessage | null
          try {
            raw = await gmail.getMessage(c.gmailId)
          } catch (error) {
            // A grant Google ended is the whole account's, and the sync handles it; and a run of failures is Gmail being down, not one message:
            // both end the run and leave every message for the next. One message Gmail will not give is marked looked at and logged, so it can
            // never stall the pass by being first in line on every run.
            failures += 1
            if (error instanceof GmailAuthError || failures >= CALENDAR_PASS_FAILURES) throw error
            console.warn(
              `mailroom: could not read ${c.gmailId} for the calendar pass, left as not calendar mail: ${describe(error)}`,
            )
            this.store.recordEventKey(c.id, null)
            looked += 1
            continue
          }
          failures = 0
          this.store.recordEventKey(c.id, raw ? (parseMessage(raw).event ?? null) : null)
          looked += 1
        }
      }
      const left = this.store
        .gmailMailboxes()
        .some((r) => grantWorks(r) && this.store.calendarCandidates(r.id, 1).length > 0)
      if (!left && !blocked) this.store.markCalendarPassDone(looked)
      else if (left && looked > 0) await this.alarmNow()
    } catch (error) {
      console.warn(`mailroom: reading stored calendar mail failed: ${describe(error)}`)
    }
  }

  /**
   * A Gmail message as Gmail returned it, becoming the row the store keeps (`parseMessage`), with the one thing a parse of the message alone cannot do: when the calendar part's bytes are kept apart by Gmail (an attachment id, as for a part with a file
   * name and sometimes without one), ask Gmail for that one file (a second call, for a calendar email only) and read the summary from it. That call failing leaves the email with no summary (`calendar` undefined, stored NULL, so the one-time
   * pass may try again) and NEVER fails the sync or the page it is part of. NEVER THROWS for the second call. `calls` is how many Gmail calls it made (0 or 1), so a run counts them against `FETCH_BUDGET`.
   */
  private async parse(gmail: GmailApi, raw: GmailMessage): Promise<{ message: ParsedMessage; calls: number }> {
    const parsed = parseMessage(raw)
    if (parsed.calendar !== undefined) return { message: parsed, calls: 0 }
    try {
      return { message: { ...parsed, calendar: await this.readApartCalendar(gmail, raw) }, calls: 1 }
    } catch (error) {
      console.warn(
        `mailroom: could not read the calendar file of ${raw.id}, stored with no summary: ${describe(error)}`,
      )
      return { message: parsed, calls: 1 }
    }
  }

  /** The summary of a calendar part whose bytes Gmail keeps apart: the file is asked of Gmail (one call), and read. `null` when Gmail has no such file or it holds no event. THROWS what Gmail's call throws. */
  private async readApartCalendar(gmail: GmailApi, raw: GmailMessage): Promise<CalendarSummary | null> {
    const part = calendarPartOf(raw)
    const attachmentId = part?.body?.attachmentId
    if (!part || !attachmentId) return null
    const bytes = await gmail.getAttachment(raw.id, attachmentId)
    return bytes === null || bytes.length > CALENDAR_SUMMARY_PART_MAX ? null : summaryOfBytes(part, bytes)
  }

  /** One stored message read again from Gmail, and what its calendar part says: `null` when Gmail no longer has it or it holds no event. THROWS what Gmail's calls throw (the pass counts those). */
  private async summaryOfStored(gmail: GmailApi, gmailId: string): Promise<CalendarSummary | null> {
    const raw = await gmail.getMessage(gmailId)
    if (raw === null) return null
    const inMessage = calendarOfMessage(raw)
    return inMessage !== undefined ? inMessage : this.readApartCalendar(gmail, raw)
  }

  /**
   * The ONE-TIME pass over Gmail mail stored before the store kept what a calendar part says (migration 20), the sibling of `keyStoredCalendarMail` and shaped the same: each candidate (`MailStore.calendarSummaryCandidates`: stored inbound Gmail mail with
   * no summary and not looked at, that lists a calendar file, carries an event key, or has no words) is read again from Gmail and summarised as new mail is (the calendar file asked of Gmail when its bytes are kept apart); what that says is recorded,
   * `none` included, so nothing is read twice. At most `CALENDAR_SUMMARY_PASS_PER_RUN` a run, with the alarm asked for again while more are left; it is done (a setting row) once every account with a working grant has none left. An account that failed this
   * run (in its backoff), or whose grant has lapsed, is left alone for later, and the pass is not done while it has mail left. A run of failures (`CALENDAR_PASS_FAILURES`) is Gmail down, not bad messages: it ends the run and leaves the rest; one message Gmail will not give is logged and recorded `none`, so it cannot
   * stall the pass by being first in line on every run. Runs AFTER the run's notifications (`workAll`), never before them: the earlier pass delayed a new mail's bell. NEVER THROWS.
   */
  private async summariseStoredCalendarMail(failedIds: ReadonlySet<string>): Promise<void> {
    try {
      if (this.store.calendarSummariesDone() || !this.ports.google) return
      let looked = 0
      let blocked = false
      for (const row of this.store.gmailMailboxes()) {
        if (!grantWorks(row)) {
          // A lapsed account (connected, its grant ended) is left for LATER: the pass is not done while it has mail left to read, and connecting it again lets the pass go on. A disconnected one has no grant to read with and is left.
          if (row.refreshToken !== null && this.store.calendarSummaryCandidates(row.id, 1).length > 0) blocked = true
          continue
        }
        if (failedIds.has(row.id)) {
          blocked = true
          continue
        }
        const gmail = this.ports.google.gmail(row.refreshToken as string)
        let failures = 0
        for (const c of this.store.calendarSummaryCandidates(row.id, CALENDAR_SUMMARY_PASS_PER_RUN - looked)) {
          let found: CalendarSummary | null
          try {
            found = await this.summaryOfStored(gmail, c.gmailId)
          } catch (error) {
            failures += 1
            if (error instanceof GmailAuthError || failures >= CALENDAR_PASS_FAILURES) throw error
            console.warn(
              `mailroom: could not read ${c.gmailId} for the calendar summary pass, left without one: ${describe(error)}`,
            )
            this.store.recordCalendarSummary(c.id, null)
            looked += 1
            continue
          }
          failures = 0
          this.store.recordCalendarSummary(c.id, found)
          looked += 1
        }
      }
      const left = this.store
        .gmailMailboxes()
        .some((r) => grantWorks(r) && this.store.calendarSummaryCandidates(r.id, 1).length > 0)
      if (!left && !blocked) this.store.markCalendarSummariesDone(looked)
      else if (left && looked > 0) await this.alarmNow()
    } catch (error) {
      console.warn(`mailroom: reading stored calendar summaries failed: ${describe(error)}`)
    }
  }

  /**
   * Close the Gmail conversations that a newer update of the same calendar event has replaced (`MailStore.supersededEvents` says which
   * and why). Gmail first, as a person's Close is: the thread is archived there, so the two cannot disagree. Runs inside the alarm's turn, after the
   * sync, so the update that just arrived is stored.
   *
   * - An account that failed this run (`failedIds`: in its backoff, or its sync threw) or whose grant does not work is left alone.
   * - At most `SUPERSEDE_PER_RUN` a run. A conversation Gmail refuses (a message arrived meanwhile, Gmail is down for it) is not tried again for
   *   `SUPERSEDE_RETRY_MS`, so it neither starves the ones behind it nor makes every run call Gmail for it.
   * - The alarm is asked for again only when something WAS closed and more are waiting; a run that closed nothing leaves the next push or the daily pass to try.
   *
   * NEVER THROWS: a meeting shown twice must not hold up mail.
   */
  private async closeReplaced(failedIds: ReadonlySet<string>): Promise<void> {
    try {
      const now = this.ports.now().getTime()
      const owed = this.store.supersededEvents().filter((s) => {
        if (s.kind !== 'gmail' || failedIds.has(s.mailboxId)) return false
        const refused = this.refusedAt.get(s.conversationId)
        if (refused !== undefined && now - refused < SUPERSEDE_RETRY_MS) return false
        const row = this.store.mailboxRow(s.mailboxId)
        return row !== null && grantWorks(row)
      })
      let closedNow = 0
      for (const s of owed.slice(0, SUPERSEDE_PER_RUN)) {
        const closed = await this.changeHeld(s.conversationId, 'close', CALENDAR_ACTOR, s.through)
        if (closed.ok) {
          this.store.noteSuperseded(s)
          this.refusedAt.delete(s.conversationId)
          closedNow += 1
        } else {
          this.refusedAt.set(s.conversationId, now)
          console.warn(`mailroom: could not close a replaced calendar mail: ${closed.error}`)
        }
      }
      if (closedNow > 0 && owed.length > SUPERSEDE_PER_RUN) await this.alarmNow()
    } catch (error) {
      console.warn(`mailroom: closing replaced calendar mail failed: ${describe(error)}`)
    }
  }

  /**
   * One image attachment's bytes, fetched from Gmail NOW and handed back to be shown, or why not. This is what lets the
   * conversation show a thumbnail without the inbox keeping a single byte of an attachment: nothing is stored, and
   * Gmail stays the only copy (ADR 0001).
   *
   * ── WHAT MAKES IT SAFE TO HAND OUT ───────────────────────────────────────
   * The attachment is named by its message and its place in the message's list, never by an id the caller supplies,
   * so a caller can only ask for what the store lists. Gmail's ids for an attachment are not promised to last, so the
   * message is read again and the part at that place is checked against the name and size the store kept before its
   * bytes are fetched. The size is checked twice (the part's, then the bytes') against MAX_PREVIEW_BYTES. And the
   * bytes are handed back only if their first bytes say PNG, JPEG, GIF or WebP, with the type THEY name: what the
   * sender declared is a hint and never trusted (image.ts). SVG and everything else is refused (415), so the Worker serves
   * no other kind of file.
   *
   * ── IT READS AND NOTHING ELSE ────────────────────────────────────────────
   * Two Gmail GETs (the message, the attachment) and no change: it marks nothing read, closes nothing and stores
   * nothing, so looking at a picture cannot change what the owner has or has not seen. It does not wait in `exclusive`
   * behind a sync or a send, because it writes nothing a sync could be halfway through. The Worker reaches it only
   * from a GET behind Access, for the owner and for Claude's token alike; the public push hostname answers 404 to it.
   */
  async readAttachment(
    messageId: string,
    index: number,
    how: 'view' | 'download' = 'view',
    as: { agent: boolean } = { agent: false },
    range?: FileRange,
  ): Promise<Result<AttachmentImage>> {
    const ref = this.store.attachmentRef(messageId, index)
    // Without a Gmail sign-in on this Worker nothing about a message can be vouched for, so that is what is said, as it always was.
    if (!ref.ok) return this.ports.google ? ref : fail(503, 'Gmail sign-in is not set up on this Worker.')
    // A message that came through Cloudflare has no Gmail to ask: its kept copy is the whole record (see `readKept`).
    if (ref.value.gmailId === null) return this.readKept(ref.value, index, how, as, range)
    const google = this.ports.google
    if (!google) return fail(503, 'Gmail sign-in is not set up on this Worker.')
    const { gmailId, attachment } = ref.value
    if (attachment.size > MAX_PREVIEW_BYTES) return fail(413, TOO_LARGE)
    if (!wantsPreview(attachment)) return fail(415, NOT_A_PICTURE)
    const row = ref.value.mailboxId === null ? null : this.store.mailboxRow(ref.value.mailboxId)
    if (!row || row.refreshToken === null) return fail(503, 'Gmail is not connected.')

    try {
      const gmail = google.gmail(row.refreshToken)
      const message = await gmail.getMessage(gmailId)
      const part = message?.payload ? attachmentParts(message.payload)[index] : undefined
      // The part at that place must still be the file the store listed there: the same name and the same size.
      const partSize = part?.body?.size ?? 0
      if (!part || part.filename !== attachment.name || partSize !== attachment.size) {
        return fail(404, 'Gmail no longer has this attachment.')
      }
      if (partSize > MAX_PREVIEW_BYTES) return fail(413, TOO_LARGE)
      const attachmentId = part.body?.attachmentId
      const bytes = attachmentId
        ? await gmail.getAttachment(gmailId, attachmentId)
        : part.body?.data !== undefined
          ? base64Bytes(part.body.data)
          : null
      if (bytes === null) return fail(404, 'Gmail no longer has this attachment.')
      if (bytes.length > MAX_PREVIEW_BYTES) return fail(413, TOO_LARGE)
      const type = sniffImage(bytes)
      if (type === null) return fail(415, NOT_A_PICTURE)
      return ok({ bytes, type, name: attachment.name, inline: true })
    } catch (error) {
      this.noteAuth(row.id, error)
      return fail(
        502,
        error instanceof GmailAuthError
          ? 'Gmail no longer accepts the saved sign-in. Connect Gmail again.'
          : `Gmail would not give this attachment: ${describe(error)}`,
      )
    }
  }

  /**
   * An attachment of a message that went through Cloudflare, from the message's kept copy in the raw-mail bucket. Nothing is asked of Gmail and
   * nothing changes: it reads, so looking at a file cannot mark anything read.
   *
   * ── WHO ──────────────────────────────────────────────────────────────────
   * The owner only. Claude's token reads a Gmail picture today; a file a stranger sent to a Cloudflare mailbox is not something the agent is handed
   * (`as.agent` is refused 403), and the space's entrypoint admits the owner alone before it gets here.
   *
   * ── ONE AT A TIME, AND THE SIZE FIRST ────────────────────────────────────
   * Opening a file of a message that arrived parses the whole message in this Durable Object, which is the whole inbox in a 128 MB heap, and a parse costs
   * several times the message (image.ts, MAX_OPEN_MESSAGE_BYTES says what was measured). A conversation with several pictures asks for each at once, so
   * these reads take turns on a chain of their own: not `exclusive`, because they write nothing a sync could be halfway through and must not queue behind
   * one, but never two at a time, and the object's own `size` is checked before a byte of it is read: a message over the limit is refused in words. A reset of
   * the object would leave a send in flight stuck at "sending", which is why this is not left to the runtime's luck.
   *
   * ── WHAT IS CHECKED, AND WHAT IS HANDED OUT ──────────────────────────────
   * The file is named by its message and its place in the message's list, never by anything the caller supplies. For mail that ARRIVED (`in/<hash>`)
   * the copy is parsed again and the part at that place must be the file the store listed there (same name, same size) before its bytes are
   * used; for mail the inbox SENT (`out/<id>`) the file is the object beside the copy, `out/<id>/<n>`, and its size must match too. Then:
   * `view` hands back a picture only, by its first bytes and as the type THEY name (PNG, JPEG, GIF, WebP; image.ts), and refuses everything
   * else (415); `download` hands back any file as `application/octet-stream` to be saved, never shown.
   */
  private readKept(
    ref: AttachmentRef,
    index: number,
    how: 'view' | 'download',
    as: { agent: boolean },
    range?: FileRange,
  ): Promise<Result<AttachmentImage>> {
    if (as.agent) return Promise.resolve(fail(403, 'Only a person opens a file that arrived in a Cloudflare mailbox.'))
    const bucket = this.ports.cloudflare?.bucket
    const { attachment, rawKey } = ref
    if (rawKey === null || !bucket) return Promise.resolve(fail(404, NOT_KEPT))
    // A photo, voice note, image or video copied from Telegram is the object itself, not a mail to parse; the bytes decide what it is. It takes its own turns (see `openTelegramFile`).
    if (attachment.tg !== undefined) return this.openTelegramFile(bucket, ref, how, range)
    if (how === 'view' && !wantsPreview(attachment)) return Promise.resolve(fail(415, NOT_A_PICTURE))
    return this.inTurn(() => this.openKept(bucket, ref, index, how))
  }

  /** One read at a time on the chain of kept-file reads (`keptReads`): the read waits for those before it, and the next waits for this one, whatever becomes of it. */
  private inTurn<T>(open: () => Promise<T>): Promise<T> {
    const run = this.keptReads.then(open, open)
    this.keptReads = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * A photo, voice note, image or video copied from Telegram (src/telegram/media.ts): `tg/<message id>` is the file itself. Read only when the store says it is kept, never past `telegramFileMax(kind)` (10 MB, and 50 MB for
   * a video) and only when the bucket's object is the length the keeper recorded. `view` hands back a picture (the four kinds, by its first bytes), a voice note (Ogg) or a video (MP4, QuickTime or WebM), each as the type
   * THEIR OWN first bytes name, and refuses everything else; `download` hands back any file as `application/octet-stream` to be saved, never shown. A picture is shown up to the copy limit, not the 5 MB of mail's previews:
   * this is one object read alone from the bucket, not a message parsed out of Gmail's text.
   *
   * ── WHOLE, OR A PART ─────────────────────────────────────────────────────
   * A file of at most `INBOX_FILE_WHOLE_BYTES` is read whole, as it always was. A video can be five times that, and a Durable Object's RPC carries 32 MiB at most (and the Worker is 128 MB), so a video is never read whole:
   * `range` (a request's `Range`, resolved here against the length the store holds) names the part, which is read by a ranged `get` of just those bytes and is cut to `INBOX_FILE_PART_BYTES` (`bytes=0-` over a 50 MB video
   * answers its first part, as a server may); with no range, a file over the whole-file size answers its first part and the caller reads on. A range is honoured for a voice note or a video only (a picture is never in
   * parts). The first bytes of a file that is shown are read by a ranged `get` of their own, because the type is what THEY say, whichever part is asked for. Both reads check the object is still the length the store holds.
   *
   * ── TURNS ────────────────────────────────────────────────────────────────
   * A whole read holds up to 10 MiB in the heap (and the same again in the copy that crosses to the Worker), and a conversation of pictures asks for a dozen at once, which the 128 MB heap does not take: whole reads
   * take their turns on the chain the mail reads use (`inTurn`). A part is at most 8 MiB and a playing video asks for one at a time, so parts do not wait: a video that is playing does not hold up the thumbnails.
   */
  private async openTelegramFile(
    bucket: RawBucket,
    ref: AttachmentRef,
    how: 'view' | 'download',
    range?: FileRange,
  ): Promise<Result<AttachmentImage>> {
    const { attachment, rawKey } = ref
    const tg = attachment.tg
    if (tg?.copy !== 'kept' || rawKey === null || !rawKey.startsWith('tg/')) return fail(404, NOT_KEPT)
    const kind = tg.kind
    if (!isCopiedKind(kind)) return fail(404, NOT_KEPT)
    if (how === 'view' && !SHOWN_TELEGRAM_KINDS.includes(kind)) return fail(415, NOT_A_TELEGRAM_FILE)
    const total = attachment.size
    if (total > telegramFileMax(kind)) return fail(413, TOO_LARGE_TO_OPEN)
    const playable = kind === 'voice' || kind === 'video'
    const wanted =
      playable && range !== undefined
        ? resolveByteRange(range, total)
        : total > INBOX_FILE_WHOLE_BYTES
          ? { first: 0, last: total - 1 }
          : null
    if (wanted === 'unsatisfiable') {
      return ok({
        bytes: new Uint8Array(0),
        type: 'application/octet-stream',
        name: attachment.name,
        inline: false,
        total,
        unsatisfiable: true,
      })
    }
    try {
      return wanted === null
        ? await this.inTurn(() => this.readTelegramWhole(bucket, rawKey, attachment.name, kind, total, how))
        : await this.readTelegramPart(bucket, rawKey, attachment.name, kind, total, how, wanted)
    } catch (error) {
      return fail(502, `The inbox could not read the kept file: ${describe(error)}`)
    }
  }

  /** A kept Telegram file of at most `INBOX_FILE_WHOLE_BYTES`, read whole: sniffed by its own first bytes when it is being viewed, a plain download otherwise. */
  private async readTelegramWhole(
    bucket: RawBucket,
    key: string,
    name: string,
    kind: TelegramCopiedKind,
    total: number,
    how: 'view' | 'download',
  ): Promise<Result<AttachmentImage>> {
    const object = await bucket.get(key)
    if (!object) return fail(404, NOT_KEPT)
    if (object.size !== undefined && object.size !== total) return fail(404, KEPT_COPY_CHANGED)
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.length !== total) return fail(404, KEPT_COPY_CHANGED)
    if (how === 'download') return ok({ bytes, type: 'application/octet-stream', name, inline: false })
    const type = sniffTelegram(kind, bytes)
    return type.ok ? ok({ bytes, type: type.value, name, inline: true }) : type
  }

  /** One part of a kept Telegram file, cut to `INBOX_FILE_PART_BYTES`, by ranged reads: the first bytes for the type (viewing only), then the part. */
  private async readTelegramPart(
    bucket: RawBucket,
    key: string,
    name: string,
    kind: TelegramCopiedKind,
    total: number,
    how: 'view' | 'download',
    wanted: { first: number; last: number },
  ): Promise<Result<AttachmentImage>> {
    const last = Math.min(wanted.last, wanted.first + INBOX_FILE_PART_BYTES - 1)
    let type: string | null = null
    if (how === 'view') {
      const head = await this.readRange(bucket, key, 0, Math.min(HEAD_BYTES, total), total)
      if (!head.ok) return head
      const sniffed = sniffTelegram(kind, head.value)
      if (!sniffed.ok) return sniffed
      type = sniffed.value
    }
    const piece = await this.readRange(bucket, key, wanted.first, last - wanted.first + 1, total)
    if (!piece.ok) return piece
    const part = { first: wanted.first, last }
    return ok(
      type === null
        ? { bytes: piece.value, type: 'application/octet-stream', name, inline: false, total, part }
        : { bytes: piece.value, type, name, inline: true, total, part },
    )
  }

  /** `length` bytes of an object from `offset`, by a ranged get that reads nothing else; refused when the object is not the length the store holds or does not give what was asked. */
  private async readRange(
    bucket: RawBucket,
    key: string,
    offset: number,
    length: number,
    total: number,
  ): Promise<Result<Uint8Array>> {
    const object = await bucket.get(key, { range: { offset, length } })
    if (!object) return fail(404, NOT_KEPT)
    if (object.size !== undefined && object.size !== total) return fail(404, KEPT_COPY_CHANGED)
    const bytes = new Uint8Array(await object.arrayBuffer())
    return bytes.length === length ? ok(bytes) : fail(404, KEPT_COPY_CHANGED)
  }

  private async openKept(
    bucket: RawBucket,
    ref: AttachmentRef,
    index: number,
    how: 'view' | 'download',
  ): Promise<Result<AttachmentImage>> {
    const { attachment, rawKey } = ref
    let bytes: Uint8Array
    try {
      // A file the inbox SENT is its own object, at most the send's limit; mail that ARRIVED is one object with everything in it.
      const out = ref.direction === 'out'
      const object = await bucket.get(out ? `${rawKey}/${index}` : (rawKey as string))
      if (!object) return fail(404, NOT_KEPT)
      // The size is the bucket's, read before the body: an object over the limit is never read into memory.
      if (object.size !== undefined && object.size > (out ? INBOX_MOST_FILE_BYTES : MAX_OPEN_MESSAGE_BYTES)) {
        return fail(413, TOO_LARGE_TO_OPEN)
      }
      if (out) {
        bytes = new Uint8Array(await object.arrayBuffer())
      } else {
        const part = await keptAttachment(await object.arrayBuffer(), index)
        if (!part || part.name !== attachment.name) return fail(404, 'The kept copy no longer has this attachment.')
        bytes = part.bytes
      }
    } catch (error) {
      return fail(502, `The inbox could not read the kept copy: ${describe(error)}`)
    }
    if (bytes.length !== attachment.size) return fail(404, 'The kept copy no longer has this attachment.')
    if (how === 'download') return ok({ bytes, type: 'application/octet-stream', name: attachment.name, inline: false })
    if (bytes.length > MAX_PREVIEW_BYTES) return fail(413, TOO_LARGE)
    const type = sniffImage(bytes)
    if (type === null) return fail(415, NOT_A_PICTURE)
    return ok({ bytes, type, name: attachment.name, inline: true })
  }

  /**
   * Have Gmail make the change, or say why not. Answers null when the inbox should now
   * make the change too (Gmail made it, or Gmail has no such thread), and a refusal
   * to hand back when it should not.
   */
  private async askGmail(
    conversationId: string,
    threadId: string,
    change: ConversationChange,
    through: number | null,
    actor: string,
  ): Promise<Result<never> | null> {
    const row = this.store.mailboxRowOfConversation(conversationId)
    if (!row || row.refreshToken === null) {
      return fail(
        503,
        'Gmail is not connected, so the inbox cannot change this conversation there. Nothing was changed.',
      )
    }
    if (row.lapsedAt !== null) return fail(503, `${lapsedReason(row.address)} Nothing was changed.`)
    if (!this.ports.google) return fail(503, 'Gmail sign-in is not set up on this Worker, so nothing was changed.')
    const gmail = this.ports.google.gmail(row.refreshToken)
    try {
      if (change !== 'reopen') {
        const thread = await gmail.getThreadLabels(threadId)
        if (thread === null) return null
        if (await this.storeMissing(row.id, gmail, thread, actor)) {
          const again = this.store.planConversationChange(conversationId, change, through)
          if (!again.ok) return again
        }
      }
      await gmail.changeThread(threadId, change)
      return null
    } catch (error) {
      if (error instanceof GmailError && error.status === 404 && change !== 'reopen') return null
      this.noteAuth(row.id, error)
      const message = refusal(error)
      console.warn(`mailroom: ${change} refused: ${message}`)
      return fail(502, message)
    }
  }

  /**
   * Store the messages of a thread that the inbox does not hold: ones whose push or
   * sync is still on its way, and old ones from before the first fill. Answers whether
   * it stored any. It stores them all and decides nothing: whether one of them is a
   * reason to refuse is the store's plan (`arrivedAfter`), which looks at what the
   * change would affect, so an old archived message is stored without stopping anything.
   * Messages in the trash, spam or drafts are not stored, as everywhere.
   *
   * Whether what it stores can notify depends on who is acting. The owner's Read, Close or
   * Send happens while they are looking at the conversation, so it never does. Claude's
   * Close or Send happens with nobody looking, and a reply it finds there is new mail
   * like any other: it is put to the notification rule and delivered at once, or it would
   * never notify, since the sync that follows finds it already held.
   */
  private async storeMissing(
    mailboxId: string,
    gmail: GmailApi,
    thread: { id: string; labels: string[] }[],
    actor: string,
  ): Promise<boolean> {
    const known = this.store.knownGmailIds(
      mailboxId,
      thread.map((m) => m.id),
    )
    const messages: ParsedMessage[] = []
    for (const m of thread) {
      if (known.has(m.id) || !inPlay(m.labels)) continue
      const raw = await gmail.getMessage(m.id)
      if (raw) messages.push((await this.parse(gmail, raw)).message)
    }
    if (messages.length === 0) return false
    // Nobody is looking when Claude or the calendar's sweep closes: a reply found there is new mail like any other.
    const notify = isAgent(actor) || actor === CALENDAR_ACTOR
    const { owed } = this.store.applyHistoryPage({ mailboxId, messages, deltas: [], cursor: null, notify })
    if (owed > 0) await this.notify()
    return true
  }

  // ─── sending ─────────────────────────────────────────────────────────

  /**
   * Create a draft. The store does all of it; this exists for one thing. A reply
   * on an email conversation goes to its newest inbound message's Reply-To, and
   * messages stored before the Reply-To was recorded have none, so the first reply drafted on
   * such a conversation reads that one message back from Gmail (a single read, which
   * marks nothing) and records it. Best effort: if Gmail will not answer, the draft is
   * addressed from the From, and it names its recipient on its face before anything is
   * sent. Not needed, and not done, when the caller names the address.
   */
  async createDraft(input: DraftInput, actor: string): Promise<Result<MessageRow>> {
    await this.prepareReply(input)
    return this.store.createDraft(input, actor)
  }

  /**
   * The read of Gmail a reply's draft needs before the store makes it (see `createDraft`), on its own so the space can make its
   * draft in one store call and still have it (src/space.ts). Writes nothing but the Reply-To it learns.
   */
  async prepareReply(input: DraftInput): Promise<void> {
    if (input.conversationId && !input.address) await this.learnReplyTo(input.conversationId)
  }

  private async learnReplyTo(conversationId: string): Promise<void> {
    const gmailId = this.store.replyToToLearn(conversationId)
    const row = this.store.mailboxRowOfConversation(conversationId)
    if (gmailId === null || !row || !grantWorks(row) || !this.ports.google) return
    try {
      const raw = await this.ports.google.gmail(row.refreshToken).getMessage(gmailId)
      if (raw) this.store.recordReplyTo(row.id, gmailId, parseMessage(raw).replyToHeader)
    } catch (error) {
      this.noteAuth(row.id, error)
      console.warn(`mailroom: could not read back the Reply-To of ${gmailId}: ${describe(error)}`)
    }
  }

  /**
   * A draft is sent: by the owner pressing Send, or by Claude on their instruction. `input.rev` is the revision of the draft they were
   * shown and `input.through` how far into its conversation (for a reply) the page
   * reached. Answers the message as filed, or a refusal that says whether anything went
   * out; see the header for what each failure means. `actor` is the owner or the agent, and
   * for the agent `input.instruction` is the owner's instruction: the store refuses the send
   * without it, or with the switch off, before anything is read or claimed.
   */
  sendDraft(
    id: string,
    input: SendRequest,
    actor: string,
    files: readonly ChosenFile[] = [],
  ): Promise<Result<MessageRow>> {
    // A draft that goes out through the mail server is the JMAP room's: decided before Gmail's chain is entered, so a send there never holds up Gmail.
    if (this.store.sendTransportOf(id) === 'jmap') {
      return this.ports.jmap
        ? this.ports.jmap.sendJmap(id, input, actor, files)
        : Promise.resolve(fail(503, 'The mail server is not set up on this Worker, so nothing was sent.'))
    }
    return this.exclusive(async () => {
      const transport = this.store.sendTransportOf(id)
      if (transport === 'telegram') return this.sendViaTelegram(id, input, actor, files)
      if (transport === 'cloudflare') return this.sendViaCloudflare(id, input, actor, files)
      // Files go from a Cloudflare mailbox only (sending files from the Gmail mailbox is not built). Refused before anything is read,
      // claimed or sent, and never dropped quietly from a send that would go out without them.
      if (files.length > 0)
        return fail(422, filesFromBusinessMailboxOnly(this.store.owner.name, this.store.owner.mailboxNames))
      const ready = await this.readyToSend(id, input, actor)
      if (!ready.ok) return ready
      const { plan, gmail } = ready.value

      let raw: string
      try {
        raw = rawFor(plan, this.store.owner.mailName)
      } catch (error) {
        if (error instanceof MimeError) return fail(422, `${error.message} Nothing was sent.`)
        throw error
      }

      const claimed = this.store.claimSend(plan, actor)
      if (!claimed.ok) return claimed
      return this.deliver(gmail, plan, raw, actor)
    })
  }

  /**
   * The send of a draft that goes out on Telegram, as the owner. It is the same path as the others up to the call: the store plans (the same checks, the switch and the owner's instruction for Claude), the
   * draft is CLAIMED (one conditional write; the claim also owes the bridge the message under a random id of Telegram's own repeat key, kept with it), and then there is no call to make: the Telegram bridge
   * takes the send with its next work request, sends it once (a repeat inside five minutes carries the same key and is stored once by Telegram) and reports Telegram's message id or its refusal, which files the
   * message as sent or puts the draft back with the reason. What comes back here is the draft as claimed, `sending`; the space shows that as "sending on Telegram" and the page changes by itself when the
   * outcome arrives. Nothing here ever sends twice, and a send the bridge never reported stays `sending`, shown as "check Telegram", for the owner to settle (`resolveSend`).
   */
  private async sendViaTelegram(
    id: string,
    input: SendRequest,
    actor: string,
    files: readonly ChosenFile[],
  ): Promise<Result<MessageRow>> {
    // At most ONE picture, a PNG or a JPEG by its own first bytes and within the send limit, from the owner's press (Claude's door carries no bytes: a picture on a draft of Claude's is put there by its own route).
    const attached = await this.pictureToAttach(files, actor)
    if (!attached.ok) return attached
    const attaching = attached.value
    const planned = this.store.planSend(id, input, actor, attaching?.facts ?? null)
    if (!planned.ok) return planned
    if (planned.value.transport !== 'telegram') return fail(409, NEVER_CROSSES)
    // The object is written first and the claim names it on the draft after, in its own transaction; a claim that fails leaves an object nobody names, which is deleted again.
    const bucket = this.ports.cloudflare?.bucket
    if (attaching !== null) {
      if (!bucket) return fail(503, 'The inbox has no bucket to keep the picture in, so nothing was sent.')
      try {
        await putPicture(bucket, id, attaching.bytes)
      } catch (error) {
        console.error('telegram: the bucket would not take a picture', describe(error))
        return fail(503, 'The inbox could not keep the picture, so nothing was sent.')
      }
    }
    const claimed = this.store.claimSend(planned.value, actor)
    if (!claimed.ok) {
      if (attaching !== null && bucket) await dropPicture(bucket, id)
      return claimed
    }
    const waiting = this.store.messageById(id)
    return waiting
      ? ok(waiting)
      : fail(502, 'The draft was claimed but could not be read back. It is held as "sending": check Telegram.')
  }

  /**
   * The picture a press carries, checked by its own bytes: one at most, within `TELEGRAM_PICTURE_MAX_BYTES`, a PNG or a JPEG by its first bytes (never by the name or the type the browser gave). Null for a
   * send of words. Only the owner's press carries bytes; the same limits are checked again by the space's page before the press and by the bridge before the upload, each by the bytes where it holds them.
   */
  private async pictureToAttach(
    files: readonly ChosenFile[],
    actor: string,
  ): Promise<Result<{ facts: PictureFacts; bytes: Uint8Array } | null>> {
    if (files.length === 0) return ok(null)
    if (isAgent(actor))
      return fail(422, 'A picture on a Telegram draft is put there by its own route. Nothing was sent.')
    if (files.length > 1) return fail(422, 'A Telegram message carries one picture. Nothing was sent.')
    return this.pictureFromBytes((files[0] as ChosenFile).bytes, 'Nothing was sent.')
  }

  /** One picture's bytes, checked: not empty, within the send limit, a PNG or a JPEG by its first bytes. `ending` is what the refusal says happened (or did not). */
  private async pictureFromBytes(
    bytes: Uint8Array,
    ending: string,
  ): Promise<Result<{ facts: PictureFacts; bytes: Uint8Array }>> {
    if (bytes.length === 0) return fail(422, `That picture is empty. ${ending}`)
    if (bytes.length > TELEGRAM_PICTURE_MAX_BYTES) {
      return fail(422, `A picture goes on Telegram up to ${TELEGRAM_PICTURE_MAX_BYTES / (1024 * 1024)} MB. ${ending}`)
    }
    const type = sniffPicture(bytes)
    if (type === null) return fail(422, `A picture goes on Telegram as a PNG or a JPEG. This is neither. ${ending}`)
    return ok({ facts: { type, size: bytes.length, sha256: await sha256Hex(bytes) }, bytes })
  }

  /**
   * Put a picture on a Telegram draft, or replace the one it has: the owner's (the draft card's Edit) or Claude's (its script), at the revision they were shown, as an edit of the draft. The
   * store says whether the draft may carry one (`planDraftPicture`), the bytes are checked by their own first bytes, the object is written to the draft's own key first, and the store names it on the draft in
   * one transaction after (`commitDraftPicture`: the revision rises, the audit says who). A commit that fails after the object was written deletes it again for a draft that had none, and puts the old bytes back for one that had a picture. Takes its turn
   * on the Mailroom's chain, so a put never interleaves with a send of the same draft.
   */
  putDraftPicture(id: string, rev: number | null, bytes: Uint8Array, actor: string): Promise<Result<MessageRow>> {
    return this.exclusive(async () => {
      const planned = this.store.planDraftPicture(id, rev, actor)
      if (!planned.ok) return planned
      const checked = await this.pictureFromBytes(bytes, 'Nothing was changed.')
      if (!checked.ok) return checked
      const bucket = this.ports.cloudflare?.bucket
      if (!bucket) return fail(503, 'The inbox has no bucket to keep the picture in, so nothing was changed.')
      // A replacement writes over the one key the draft's picture lives at, so the old bytes are held first: a commit that then fails must leave the object the row still names, not the new one under the old fingerprint.
      const before = planned.value.picture === undefined ? null : await readPictureObject(bucket, id)
      try {
        await putPicture(bucket, id, bytes)
      } catch (error) {
        console.error('telegram: the bucket would not take a picture', describe(error))
        return fail(503, 'The inbox could not keep the picture, so nothing was changed.')
      }
      const done = this.store.commitDraftPicture(id, rev, checked.value.facts, actor)
      if (done.ok) return done
      try {
        if (planned.value.picture === undefined) await dropPicture(bucket, id)
        else if (before !== null) await putPicture(bucket, id, before)
        else console.error('telegram: a picture replacement failed and the old picture could not be put back', id)
      } catch (error) {
        console.error(
          'telegram: a picture replacement failed and the old picture could not be put back',
          id,
          describe(error),
        )
      }
      return done
    })
  }

  /**
   * Everything that can still stop a send, checked before the draft is claimed: that
   * Gmail is there and may send, that the store's checks pass (planSend), and, for a
   * reply, that nothing is waiting in the thread in Gmail that the inbox has not stored
   * yet (it is stored, and the plan is made again over it, which refuses if it matters).
   */
  private async readyToSend(
    id: string,
    input: SendRequest,
    actor: string,
  ): Promise<Result<{ plan: GmailSendPlan; gmail: GmailApi }>> {
    const google = this.ports.google
    if (!google) return fail(503, 'Gmail sign-in is not set up on this Worker, so nothing was sent.')
    let plan = this.store.planSend(id, input, actor)
    if (!plan.ok) return plan
    // The transport was decided before this; a plan that came back for the other one is a bug, and nothing crosses.
    if (plan.value.transport !== 'gmail') return fail(409, NEVER_CROSSES)
    const row = this.store.mailboxRow(plan.value.mailboxId)
    if (!row || row.refreshToken === null) return fail(503, 'Gmail is not connected, so nothing was sent.')
    if (row.lapsedAt !== null) return fail(503, `${lapsedReason(row.address)} Nothing was sent.`)
    if (!row.scopes.includes(GMAIL_SCOPE)) {
      return fail(
        403,
        'The Gmail connection does not include permission to send. Connect Gmail again. Nothing was sent.',
      )
    }
    const gmail = google.gmail(row.refreshToken)
    if (plan.value.threadId !== null) {
      try {
        const thread = await gmail.getThreadLabels(plan.value.threadId)
        if (thread !== null && (await this.storeMissing(plan.value.mailboxId, gmail, thread, actor))) {
          plan = this.store.planSend(id, input, actor)
          if (!plan.ok) return plan
          if (plan.value.transport !== 'gmail') return fail(409, NEVER_CROSSES)
        }
      } catch (error) {
        this.noteAuth(row.id, error)
        return fail(
          502,
          `Gmail would not say whether anything new has arrived on this conversation (${describe(error)}), so nothing was sent. Try again.`,
        )
      }
    }
    return ok({ plan: plan.value, gmail })
  }

  /** Google said this account's grant is gone: mark it lapsed, where Settings and the header say so by name. Anything else is not a lapse. */
  private noteAuth(mailboxId: string, error: unknown): void {
    if (error instanceof GmailAuthError) this.store.markGrantLapsed(mailboxId)
  }

  /**
   * The one call to Gmail, and what each way it can end means (see the header). Only an
   * error that says Gmail did NOT act puts the draft back; anything else, including a thing
   * this file did not expect, is treated as "may have gone out" and is never retried.
   */
  private async deliver(gmail: GmailApi, plan: GmailSendPlan, raw: string, actor: string): Promise<Result<MessageRow>> {
    let sent: SentMessage
    try {
      sent = await gmail.sendMessage(raw, plan.threadId)
    } catch (error) {
      if (error instanceof GmailError || error instanceof GmailAuthError) {
        this.noteAuth(plan.mailboxId, error)
        const message = sendRefusal(error)
        console.warn(`mailroom: send refused: ${message}`)
        this.store.releaseClaim(plan.id, message, actor)
        return fail(error instanceof GmailError && error.status === 400 ? 422 : 502, message)
      }
      console.warn(`mailroom: send outcome unknown: ${describe(error)}`)
      return fail(
        502,
        `${describe(error)} It is not known whether the message went out, so it was NOT sent again. It is held as "sending": check Gmail Sent, then say whether it went out or not.`,
      )
    }

    const sentButNotFiled = (why: string): Result<never> => {
      console.error(`mailroom: sent ${sent.id} but could not file it: ${why}`)
      return fail(
        502,
        'Gmail sent the message, but the inbox could not record it. It is held as "sending" and Gmail\'s copy will arrive by itself: check Gmail Sent before doing anything.',
      )
    }
    try {
      const filed = this.store.fileSentMessage(plan, sent, actor)
      return filed.ok ? filed : sentButNotFiled(filed.error)
    } catch (error) {
      return sentButNotFiled(describe(error))
    }
  }

  /**
   * The send of a draft that goes out through Cloudflare, as the mailbox's own address. Plans (the store's checks, which also
   * decide the sender: it is the conversation's mailbox, never anything typed), builds the structured message, CLAIMS the draft,
   * calls the binding once, and only when Cloudflare ACCEPTS keeps the copy and files the message as sent. Runs in `exclusive`
   * with every other send, so a second press waits and finds the draft taken. Nothing here retries.
   */
  private async sendViaCloudflare(
    id: string,
    input: SendRequest,
    actor: string,
    files: readonly ChosenFile[],
  ): Promise<Result<MessageRow>> {
    const planned = this.store.planSend(id, input, actor)
    if (!planned.ok) return planned
    const plan = planned.value
    if (plan.transport !== 'cloudflare') return fail(409, NEVER_CROSSES)
    const sender = this.ports.cloudflare?.sender ?? null
    if (!sender) {
      return fail(503, `This Worker cannot send as ${plan.from} (no sending binding is set up), so nothing was sent.`)
    }

    let message: ReturnType<typeof buildOutgoing>
    try {
      message = buildOutgoing(plan, files)
    } catch (error) {
      if (error instanceof MimeError) return fail(422, `${error.message} Nothing was sent.`)
      throw error
    }

    const claimed = this.store.claimSend(plan, actor)
    if (!claimed.ok) return claimed

    let reportedId: string | null
    try {
      reportedId = (await sender.send(message)).messageId
    } catch (error) {
      if (error instanceof EmailRefused) {
        const said = `${error.message} Nothing was sent, and the draft is still a draft.`
        console.warn(`mailroom: send as ${plan.from} refused: ${said}`)
        this.store.releaseClaim(plan.id, said, actor)
        return fail(error.status, said)
      }
      console.warn(`mailroom: send as ${plan.from}, outcome unknown: ${describe(error)}`)
      return fail(
        502,
        `${describe(error)} It is not known whether the message went out, so it was NOT sent again. It is held as "sending". There is no Sent folder for ${plan.from}: ask ${plan.to}, then say whether it went out or not.`,
      )
    }

    // Accepted. Keep what was handed over (best effort: the message is out whatever the bucket says), then file it.
    let rawKey: string | null = null
    let copyError: string | null = null
    try {
      const bucket = this.ports.cloudflare?.bucket
      if (!bucket) throw new Error('The Worker has no raw-mail bucket bound.')
      const key = sentCopyKey(plan.id)
      const bytes = new TextEncoder().encode(
        sentCopy({ id: plan.id, request: message, reportedId, sentAt: plan.at, sentBy: actor }),
      )
      await bucket.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        customMetadata: { from: plan.from, to: plan.to, sentAt: plan.at },
      })
      rawKey = key
      // The files' bytes, one object each beside the copy (`out/<id>/<n>`), so the sent message can show and give them back. A file that
      // cannot be kept does not undo the send: the message lists it, and opening it says the inbox no longer has it.
      for (const [n, file] of message.attachments.entries()) {
        const copy = file.content.slice().buffer as ArrayBuffer
        await bucket.put(sentFileKey(plan.id, n), copy, { customMetadata: { name: file.filename, type: file.type } })
      }
    } catch (error) {
      copyError = describe(error)
      console.error(`mailroom: sent ${plan.id} as ${plan.from} but could not keep its copy: ${copyError}`)
    }

    const sentButNotFiled = (why: string): Result<never> => {
      console.error(`mailroom: ${plan.from} sent ${plan.id} but could not file it: ${why}`)
      return fail(
        502,
        `Cloudflare accepted the message, but the inbox could not record it. It is held as "sending": say that it went out, and it is kept as sent.`,
      )
    }
    try {
      const filed = this.store.fileCloudflareSent(
        plan,
        { reportedId, rawKey, copyError, attachments: infoOf(message.attachments) },
        actor,
      )
      return filed.ok ? filed : sentButNotFiled(filed.error)
    } catch (error) {
      return sentButNotFiled(describe(error))
    }
  }

  /**
   * The owner says how a send whose outcome was never known went (they have looked in Gmail
   * Sent): out, so the stuck draft is removed and Gmail's own copy is the record; or
   * not, so it is a draft again. Runs in `exclusive`, so it cannot land in the middle of a
   * send that is still waiting on Gmail.
   */
  resolveSend(
    id: string,
    wentOut: boolean,
    actor: string,
  ): Promise<Result<{ id: string; status: 'removed' | 'draft' | 'sent' }>> {
    // The owner's alone, in the route, here and in the store: Claude can send now, but whether
    // a send it made went out is something only the person who looked in Gmail Sent can say.
    if (isAgent(actor)) return Promise.resolve(fail(403, onlyOwnerResolves(this.store.owner.name)))
    return this.exclusive(async () => {
      // A Cloudflare send the owner says went out is filed from what the kept copy says (the id Cloudflare reported, and the copy's
      // key), when Cloudflare accepted it and only the filing failed; a send whose outcome was never known has no copy.
      const kept = wentOut && this.store.sendTransportOf(id) === 'cloudflare' ? await this.keptCopy(id) : undefined
      return this.store.resolveSending(id, wentOut, actor, kept)
    })
  }

  /** What `out/<id>` holds, if it is there: its key and the id Cloudflare reported. Never throws: no copy is the common case. */
  private async keptCopy(id: string): Promise<{ reportedId: string | null; rawKey: string | null }> {
    const none = { reportedId: null, rawKey: null }
    try {
      const bucket = this.ports.cloudflare?.bucket
      const key = sentCopyKey(id)
      const object = await bucket?.get(key)
      if (!object) return none
      const kept = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as { reportedMessageId?: unknown }
      return {
        reportedId: typeof kept.reportedMessageId === 'string' ? kept.reportedMessageId : null,
        rawKey: key,
      }
    } catch (error) {
      console.warn(`mailroom: could not read the kept copy of ${id}: ${describe(error)}`)
      return none
    }
  }

  /** The Durable Object's alarm: do whatever is owed, for every account. */
  runAlarm(): Promise<void> {
    return this.exclusive(() => this.workAll('push', new Set()))
  }

  /**
   * The once-a-day pass, the only scheduled work there is: for each account with a working grant, renew the watch, then
   * run one sync from the cursor as a safety net for a dropped push. On a healthy
   * day the cursor makes that sync find nothing. If it finds NEW MAIL while no push
   * has come for a day, pushes are broken and the header says so. One account's renewal
   * failing (or its grant lapsing) leaves the others' untouched.
   */
  runDaily(): Promise<void> {
    return this.exclusive(async () => {
      const google = this.ports.google
      if (!google) return
      const renewalFailed = new Set<string>()
      for (const row of this.store.gmailMailboxes()) {
        if (!grantWorks(row)) continue
        try {
          await this.renewWatch(row, google.gmail(row.refreshToken))
        } catch (error) {
          renewalFailed.add(row.id)
          this.noteAuth(row.id, error)
          this.store.recordFailure(row.id, `Could not renew the live connection: ${describe(error)}`)
        }
      }
      await this.workAll('daily', renewalFailed)
    })
  }

  // ─── the work ────────────────────────────────────────────────────────

  private async renewWatch(row: MailboxRow, gmail: GmailApi): Promise<void> {
    if (this.ports.topicName === '')
      throw new GmailError('GMAIL_TOPIC_NAME is not set, so there is no topic to watch.', 503)
    const watch = await gmail.watch(this.ports.topicName)
    this.store.setWatch(row.id, watch.expiration)
  }

  /**
   * Work every account that has a working grant, one after another, each isolated from the others' failures; then deliver the notifications the
   * stored pages owe, and ask for the next run: straight away when an account that did not fail still has more to do (a job with more pages,
   * a sync cut short by its budget, a push that arrived while this ran), else after the shortest backoff of the accounts that failed. An alarm
   * replaces any alarm already set, so the two cases are decided once, here, and not by each account on its own.
   */
  private async workAll(source: 'push' | 'daily', keepError: ReadonlySet<string>): Promise<void> {
    if (!this.ports.google) return
    const failedIds = new Set<string>()
    let retryIn: number | null = null
    const working = this.store.gmailMailboxes().filter(grantWorks)
    // An alarm kept for one account's work must not hammer another that is failing. The alarm is the push source's (the daily pass works every account, being the safety net for
    // a dropped push). An account still inside its backoff, with nothing newer than its failure (no push since, no "sync now": that clears the count), waits it out and asks
    // for its own retry, but only while another account has work to do now: alone, it is tried as it always was, since this run may be a step that was not a sync's failure
    // (a watch that could not be set at connect) or the push that is the very news it was waiting for.
    const waits = new Map<string, number>()
    if (source === 'push') {
      const inBackoff = working.filter((r) => this.backoffLeftMs(r) > 0)
      const ready = working.filter((r) => (r.job !== null || r.pushSeq > r.syncedSeq) && !inBackoff.includes(r))
      if (ready.length > 0) for (const r of inBackoff) waits.set(r.id, this.backoffLeftMs(r))
    }
    for (const row of working) {
      const waiting = waits.get(row.id)
      if (waiting !== undefined) {
        failedIds.add(row.id)
        retryIn = retryIn === null ? waiting : Math.min(retryIn, waiting)
        continue
      }
      const wait = await this.workOne(row, source, keepError.has(row.id))
      if (wait !== undefined) {
        failedIds.add(row.id)
        if (wait !== null) retryIn = retryIn === null ? wait : Math.min(retryIn, wait)
      }
    }

    // A newer update of a calendar event replaces the older ones (after the sync, so the update that just arrived is stored).
    await this.keyStoredCalendarMail(failedIds)
    await this.closeReplaced(failedIds)

    // The notifications the stored pages owe, failure or not: a sync that failed on its third page stored two.
    await this.notify()

    // The one-time pass for what the stored mail's calendar parts say reads Gmail again for each candidate, so it runs AFTER the bell: new mail rings at once and never waits behind it.
    await this.summariseStoredCalendarMail(failedIds)

    const moreToDo = this.store
      .gmailMailboxes()
      .some((r) => grantWorks(r) && !failedIds.has(r.id) && (r.job !== null || r.pushSeq > r.syncedSeq))
    if (moreToDo) await this.alarmNow()
    else if (retryIn !== null) await this.ports.scheduleAlarm(new Date(this.ports.now().getTime() + retryIn))
  }

  /**
   * How long an account that failed must still wait before its retry: the backoff of its failures so far, counted from the last one; 0 when it has not failed, the time is up, or a push
   * has come since (that is news the failure could not have seen, and a push during a backoff retries at once).
   */
  private backoffLeftMs(row: MailboxRow): number {
    if (row.retryCount === 0 || row.lastErrorAt === null) return 0
    if (row.lastPushAt !== null && row.lastPushAt > row.lastErrorAt) return 0
    const retryAt = Date.parse(row.lastErrorAt) + backoffMs(row.retryCount)
    return Number.isNaN(retryAt) ? 0 : Math.max(0, retryAt - this.ports.now().getTime())
  }

  /**
   * One account's turn. Answers undefined when it went well, and when it failed the delay before a retry (null when a retry would not help: the
   * grant is gone, and the account is now lapsed).
   */
  private async workOne(
    row: MailboxRow,
    source: 'push' | 'daily',
    keepError: boolean,
  ): Promise<number | null | undefined> {
    const google = this.ports.google as GoogleAuth
    const gmail = google.gmail(row.refreshToken as string)
    try {
      if (row.job) await this.advanceJob(row, row.job, gmail, keepError)
      else if (row.historyId === null) await this.beginFill(row, gmail)
      else if (row.pushSeq > row.syncedSeq || source === 'daily') await this.syncOnce(row, gmail, source, keepError)
      return undefined
    } catch (error) {
      return this.failed(row, error)
    }
  }

  /**
   * Deliver what the sync marked owed. A notification is a bell and never holds up mail: whatever goes wrong is
   * logged, and the sync, its cursor and the next run are untouched.
   */
  private async notify(): Promise<void> {
    try {
      await this.ports.notifications?.deliverOwed()
    } catch (error) {
      console.error(`mailroom: notifications failed: ${describe(error)}`)
    }
  }

  /** Record a failed step. A revoked grant is not helped by trying again (the owner reconnecting is): the account is marked lapsed and no retry is asked for (null). */
  private failed(row: MailboxRow, error: unknown): number | null {
    const revoked = error instanceof GmailAuthError
    const message = revoked ? 'Gmail no longer accepts the saved sign-in. Connect Gmail again.' : describe(error)
    console.warn(`mailroom: ${row.address}: ${message}`)
    const failures = this.store.recordFailure(row.id, message)
    if (revoked) {
      this.store.markGrantLapsed(row.id)
      return null
    }
    return backoffMs(failures)
  }

  /** A connected mailbox with no cursor and no job: read the cursor first, then start the fill. */
  private async beginFill(row: MailboxRow, gmail: GmailApi): Promise<void> {
    const profile = await gmail.getProfile()
    const since = fillSince(this.ports.now())
    this.store.startFill(row.id, listJob('fill', windowQuery(since), profile.historyId))
  }

  /**
   * Ask Gmail what changed since the cursor and store it, a page at a time. The
   * cursor moves to the last record of a page that has more after it, and to the
   * history id Gmail reports on the last page, in the same transaction that stores
   * the page. A cursor Gmail no longer has starts a resync instead.
   *
   * ⚠️ EVERY PAGE OF ONE RUN ASKS FROM THE SAME `start`. A page token continues a
   * query, and the query is "since this history id": passing a token with a
   * different start id (the cursor, which moves as pages are stored) asks for a
   * page of a different list. The stored cursor advances; the question does not.
   * The test with a failure on the third page is what found this.
   */
  private async syncOnce(
    row: MailboxRow,
    gmail: GmailApi,
    source: 'push' | 'daily',
    keepError: boolean,
  ): Promise<void> {
    const seq = row.pushSeq
    const start = row.historyId as string
    let cursor = start
    let pageToken: string | null = null
    let fetched = 0
    let stored = 0

    for (;;) {
      let page: Awaited<ReturnType<GmailApi['listHistory']>>
      try {
        page = await gmail.listHistory(start, pageToken)
      } catch (error) {
        if (error instanceof GmailHistoryGone)
          return this.startResync(row, gmail, 'Gmail no longer had the saved cursor.')
        throw error
      }

      const plan = planHistory(page.history, (id) => this.store.knownGmailIds(row.id, [id]).has(id))
      const messages: ParsedMessage[] = []
      for (const candidate of plan.candidates) {
        const raw = await gmail.getMessage(candidate.id)
        fetched += 1
        if (raw) {
          const read = await this.parse(gmail, raw)
          fetched += read.calls
          messages.push(read.message)
        }
      }

      const last = page.nextPageToken === null
      const next = last ? page.historyId : (plan.lastRecordId ?? cursor)
      const applied = this.store.applyHistoryPage({
        mailboxId: row.id,
        messages,
        deltas: plan.deltas,
        cursor: next === '' ? null : next,
        notify: true,
      })
      stored += applied.counts.stored
      cursor = next || cursor

      if (last) break
      pageToken = page.nextPageToken
      if (fetched >= FETCH_BUDGET) {
        // Cut short, not finished: the cursor is saved and the rest is OWED. On a
        // push-driven run it already is (the sequence is ahead of `synced_seq`),
        // but the daily pass runs with nothing owed, so this says so explicitly,
        // and `work` then asks for the next alarm. Without it a gap of a few
        // hundred messages found by the daily pass would be stored 200 at a time
        // by nobody.
        this.store.markSyncOwed()
        this.store.recordSyncSuccess(row.id, null, keepError)
        this.noteBrokenPushes(row, source, stored)
        return
      }
    }

    this.store.recordSyncSuccess(row.id, seq, keepError)
    this.noteBrokenPushes(row, source, stored)
  }

  /**
   * The daily pass found new mail while no push had arrived for a day: pushes are
   * broken. Said as soon as the pass has stored any, including when it was cut
   * short by its budget, so the header does not depend on the pass finishing.
   */
  private noteBrokenPushes(row: MailboxRow, source: 'push' | 'daily', stored: number): void {
    if (source === 'daily' && stored > 0 && quiet(row.lastPushAt, this.ports.now())) {
      this.store.markPushSuspect(row.id)
    }
  }

  /**
   * Gap recovery. Read a fresh history id FIRST (so anything arriving while this
   * runs is caught by the sync that follows), then list Inbox and Sent mail from a
   * day before the newest message held, and finally re-read the labels of every
   * open conversation, so an archive or a read made during the gap is caught too.
   * All of it is idempotent, so the overlap does no harm.
   */
  private async startResync(row: MailboxRow, gmail: GmailApi, reason: string): Promise<void> {
    const profile = await gmail.getProfile()
    const newest = this.store.newestMessageAt(row.id)
    const since = newest ? new Date(Date.parse(newest) - DAY_MS) : fillSince(this.ports.now())
    this.store.startResync(row.id, listJob('resync', windowQuery(since), profile.historyId), reason)
  }

  private async advanceJob(row: MailboxRow, job: SyncJob, gmail: GmailApi, keepError: boolean): Promise<void> {
    if (job.stage === 'list') await this.listStep(row, job, gmail)
    else await this.labelStep(row, job, gmail)
    this.store.recordSyncSuccess(row.id, null, keepError)
  }

  /**
   * Pages of the window, stored as they come, until a page would pass this run's
   * budget. A message the listing returns that is already held is not fetched
   * again, but its LABELS are re-read (by thread, one call for all of a thread's
   * messages that the page named): after a gap, a conversation that is closed here
   * can have been read, starred or moved in Gmail, and nothing else would catch it,
   * because the label stage re-reads only the open ones. Each thread read counts
   * against the budget like a fetch.
   */
  private async listStep(row: MailboxRow, start: SyncJob, gmail: GmailApi): Promise<void> {
    let job = start
    let fetched = 0
    for (;;) {
      const page = await gmail.listMessageIds(job.query, job.pageToken)
      const known = this.store.knownGmailIds(
        row.id,
        page.ids.map((m) => m.id),
      )
      const messages: ParsedMessage[] = []
      const heldThreads = new Set<string>()
      for (const { id, threadId } of page.ids) {
        if (known.has(id)) {
          heldThreads.add(threadId)
          continue
        }
        const raw = await gmail.getMessage(id)
        fetched += 1
        if (raw) {
          const read = await this.parse(gmail, raw)
          fetched += read.calls
          messages.push(read.message)
        }
      }
      const labels: { gmailId: string; labels: string[] }[] = []
      for (const threadId of heldThreads) {
        for (const m of (await gmail.getThreadLabels(threadId)) ?? []) labels.push({ gmailId: m.id, labels: m.labels })
        fetched += 1
      }

      // The window is listed. A fill is then done; a resync goes on to re-read
      // labels. Otherwise the job remembers where to continue.
      const next: SyncJob | null = page.next
        ? { ...job, pageToken: page.next }
        : job.kind === 'resync'
          ? { ...job, stage: 'labels', pageToken: null, threads: null }
          : null
      this.store.applyJobStep({
        mailboxId: row.id,
        kind: job.kind,
        cursorAfter: job.cursorAfter,
        messages,
        labels,
        job: next,
      })
      if (next === null || next.stage === 'labels' || fetched >= FETCH_BUDGET) return
      job = next
    }
  }

  /** A resync's last stage: the labels of the open conversations, as Gmail has them now. */
  private async labelStep(row: MailboxRow, job: SyncJob, gmail: GmailApi): Promise<void> {
    const threads = job.threads ?? this.store.openThreadIds(row.id)
    const batch = threads.slice(0, LABEL_BUDGET)
    const rest = threads.slice(LABEL_BUDGET)
    const labels: { gmailId: string; labels: string[] }[] = []
    for (const thread of batch) {
      for (const m of (await gmail.getThreadLabels(thread)) ?? []) labels.push({ gmailId: m.id, labels: m.labels })
    }
    this.store.applyJobStep({
      mailboxId: row.id,
      kind: job.kind,
      cursorAfter: job.cursorAfter,
      messages: [],
      labels,
      job: rest.length > 0 ? { ...job, threads: rest } : null,
    })
  }
}

/**
 * What a person is told when Gmail would not make a change, in the words of the Gmail
 * module (which names the change from CHANGE_VERBS). Every one says nothing changed
 * here, except a reopen Gmail did part of, which says so.
 */
function refusal(error: unknown): string {
  if (error instanceof GmailPartialChange) {
    return (
      `Gmail moved ${error.moved} of ${error.total} messages back to the Inbox and then refused: ${error.message} ` +
      'The conversation is partly reopened in Gmail. The inbox shows it open once Gmail reports that; if it still shows closed, Reopen again moves the rest.'
    )
  }
  const said =
    error instanceof GmailAuthError
      ? 'Gmail no longer accepts the saved sign-in. Connect Gmail again.'
      : error instanceof GmailError
        ? error.message
        : `Gmail did not answer: ${describe(error)}`
  return `${said} Nothing was changed here.`
}

/** The message as Gmail takes it. Throws MimeError for anything unsafe to send. */
const rawFor = (plan: GmailSendPlan, fromName: string): string =>
  toRaw(
    buildMime({
      from: { name: fromName, address: plan.from },
      to: plan.to,
      cc: plan.cc,
      subject: plan.subject,
      body: plan.body,
      messageId: plan.messageId,
      inReplyTo: plan.inReplyTo,
      date: new Date(plan.at),
    }),
  )

/** What the owner is told when Gmail would not send: its words, and that nothing went out. */
function sendRefusal(error: GmailError | GmailAuthError): string {
  const said =
    error instanceof GmailAuthError ? 'Gmail no longer accepts the saved sign-in. Connect Gmail again.' : error.message
  return `${said} Nothing was sent, and the draft is still a draft.`
}

/** What a plan for the wrong transport is answered with: the two never cross, and the store decided before this. */
const NEVER_CROSSES = 'That draft is sent through the other mailbox, so nothing was sent. It is unchanged.'

const listJob = (kind: SyncJob['kind'], query: string, cursorAfter: string): SyncJob => ({
  kind,
  query,
  cursorAfter,
  stage: 'list',
  pageToken: null,
  threads: null,
})

/** No push for over a day (or none ever). */
const quiet = (lastPushAt: string | null, now: Date): boolean =>
  lastPushAt === null || now.getTime() - Date.parse(lastPushAt) > DAY_MS

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
