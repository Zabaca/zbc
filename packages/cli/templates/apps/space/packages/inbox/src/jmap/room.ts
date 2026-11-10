import type { ChosenFile } from '../cloudflare/send'
import { DAY_MS } from '../gmail/health'
import { backoffMs } from '../gmail/mailroom'
import { belongsInStore, inPlay, LABEL } from '../gmail/types'
import type { JmapJob, JmapPushState, JmapRow, JmapStore } from '../store/jmap'
import type { JmapSendPlan } from '../store/mail'
import { fail, ok, type Result } from '../store/store'
import {
  type ConversationChange,
  type ConversationState,
  FILL_DAYS,
  isAgent,
  type JmapMailboxStatus,
  type MessageRow,
  type SendRequest,
} from '../types'
import { createJmap, type JmapApi, JmapSubmitRefused } from './client'
import type { DeclaredJmap } from './declared'
import { type FolderIds, foldersByRole, labelsOf } from './mapping'
import { MAX_RAW_BYTES, parseJmapMessage } from './parse'
import {
  JmapAuthError,
  type JmapCursor,
  type JmapEmail,
  JmapError,
  JmapOutcomeUnknown,
  JmapStateGone,
  JmapUnreachable,
} from './types'

/**
 * The JMAP room: everything the inbox does with a mailbox on the company's own mail server that takes more than one breath, in the shape of the Gmail Mailroom (src/gmail/mailroom.ts, whose header explains each rule and
 * which this copies the ORDER OF OPERATIONS of: the one-at-a-time chain, a budget per run, a backoff per mailbox, the alarm doing the work and a push only asking for it). The Mailroom itself is not generalised: what
 * it holds is Gmail's (history, watch, grant, the calendar pass), and changing it would put the owner's live Gmail at risk for nothing. What is shared is the store's label-shaped path: at its edge this module turns
 * a message's server state into the label words the store derives read and closed from (src/jmap/mapping.ts) and hands the store the same parsed messages and label changes.
 *
 * ── A PUSH IS A HINT, THE CURSOR IS THE TRUTH ────────────────────────────
 * The server calls the inbox's public push hostname (src/push-door.ts) on a path that names the mailbox and carries a random token kept in the store. That door answers at once and does one thing: `receiveJmapPush`
 * records that changes are owed (or keeps the server's verification code) and asks for the alarm now. The alarm (`runAlarm`) does the work, and what it asks the server is "what changed since my cursor", never "what does this
 * push say". The cursor is the server's Email and Mailbox state strings, written in the same transaction as the page it follows. Pushes are a subscription the server forgets (it lapses in 7 days): the daily pass renews it, makes
 * it again if the server dropped it, and runs one sync from the cursor as the safety net, so a dropped push costs a day at worst. A stream held open from the Durable Object was turned down (it would keep the whole
 * inbox awake and must be opened again after every deploy).
 *
 * ── THE FILL, A SYNC, A RESYNC ───────────────────────────────────────────
 * The fill lists the last FILL_DAYS of Inbox and Sent mail, oldest first, a page at a time across alarm runs under a budget; the states read before it began become the cursor when it ends, and a sync is owed, so
 * nothing that changed meanwhile is missed. It notifies nobody. A sync asks for the changes since the cursor: a new message is read whole (its raw bytes through the door, parsed as a Cloudflare arrival is), a changed one has its
 * state rewritten, one the server destroyed is kept and counted as trashed. A cursor the server cannot answer from starts a resync: the window read again, and the open conversations' messages read again.
 *
 * ── READ AND CLOSE GO TO THE SERVER FIRST ────────────────────────────────
 * `changeConversation`: the thread is read on the server, anything not held is stored, the same refusal of what the page was not shown (`through`) applies, then the server is asked: Open sets the thread's `$seen`; Close
 * moves the thread's messages in play out of the Inbox into Archive, as a mail app's Archive does; Reopen moves them back. Only when the server accepts does the store make the same change; a refusal changes nothing and says
 * why, and a partial change says so. Bulk and the spam call stay the inbox's own, never written to the server.
 *
 * ── SENDING IS THE THIRD TRANSPORT ───────────────────────────────────────
 * `send` is the same path as the others (ADR 0001 decisions 13 and 18): the store plans (its checks, the switch and the owner's instruction for Claude), the draft is CLAIMED, the server is asked ONCE to make the message and submit it (filing it
 * in Sent), and the answer is filed. What a failure means is decided by what the server can be known to have done: refused (a 4xx, the key refused, no identity, a submission refused) puts the draft back and removes the unsent
 * copy; anything else (a connection dropped after the request left, a 5xx, an answer naming neither) keeps it `sending`, shown as "check the mailbox's Sent", for the owner to say. Nothing here ever retries a send, and nothing in this
 * file knows who is sending: the owner's instruction rule is the store's, before and at the claim.
 *
 * ── A REFUSED KEY IS A STATE ─────────────────────────────────────────────
 * The server refusing the space's key (or the door refusing its service token) marks the mailbox refused: nothing syncs or sends for it and NOTHING RETRIES, so the server is not hammered and no failed-sign-in ban is
 * invited. A deploy that changes the key (or the token) ends it.
 */

/** Messages downloaded (and so requests) per run before asking for another alarm. */
export const FETCH_BUDGET = 100
/** Messages named per page of a fill's list. */
export const LIST_PAGE = 50
/** Messages read again per run in a resync's last stage. */
export const REREAD_BUDGET = 150
/** Changes asked for at once in a sync. */
export const CHANGES_PAGE = 100
/** How long a push subscription is asked to last, and how soon before it lapses the daily pass renews it. */
export const PUSH_LIFETIME_MS = 7 * DAY_MS
export const PUSH_RENEW_WITHIN_MS = 2 * DAY_MS
/** How long a run that is not the daily pass waits before it asks again for a push subscription the server would not make. */
export const PUSH_RETRY_MS = 60 * 60 * 1000
/** How long a push subscription may wait for the server's verification before it is dropped and made again. */
export const PUSH_UNVERIFIED_MS = 10 * 60 * 1000

export const PUSH_PATH_PREFIX = '/api/jmap/push/'

/** The sentence for a mailbox whose key the server refused. One place, so the amber line, Settings and a refused send say the same thing. */
export const refusedReason = (address: string): string =>
  `The mail server refused the space’s key for ${address} (or Cloudflare Access refused the space’s token at its door), so nothing new arrives or goes out from it. A deploy with a working key ends this.`

const FILES_REFUSED = 'Files cannot be sent from a mailbox on the mail server yet. Nothing was sent.'
const NEVER_CROSSES = 'That draft is sent through the other mailbox, so nothing was sent. It is unchanged.'

export interface JmapRoomPorts {
  store: JmapStore
  /** The mailboxes the deploy declares (src/jmap/declared.ts). */
  declared: () => DeclaredJmap[]
  /** A Worker secret by name (the mailbox's key), or undefined when it is not set. */
  secret: (name: string) => string | undefined
  /** The service token the door's Access application admits: both halves, or null when the Worker has none. */
  access: () => { id: string; secret: string } | null
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  now: () => Date
  /** Ask for the alarm at `at`. */
  scheduleAlarm: (at: Date) => void | Promise<void>
  /** The origin of the inbox's public push hostname, e.g. https://inbox-push.northfield.example; null when it has none, and then no push subscription is made. */
  pushOrigin: string | null
  /** The name the server knows this install's space by for its push subscriptions: one per install, and never changed once a subscription is made (the server tells a client's subscriptions apart by it). */
  deviceClientId: string
  /** A fresh random token, 32 hex characters or more. */
  newToken: () => string
  /** Hands on the notifications the sync marked owed. Optional: a room without one notifies nobody. */
  notifications?: { deliverOwed(): Promise<void> } | null
  /** Replaces how the room reaches the server (tests, to read what was asked). */
  connect?: typeof createJmap
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Opened {
  api: JmapApi
  declared: DeclaredJmap
  fingerprint: string
}

export class JmapRoom {
  private chain: Promise<unknown> = Promise.resolve()
  /** What the last attempt to make a push subscription said, per mailbox, for Settings; in memory, so a restart tries once more. */
  private readonly pushErrors = new Map<string, string>()
  /** When a push subscription was last asked for, per mailbox, in memory: a server that refuses one is asked again on the daily pass, and not by every run. */
  private readonly pushAsked = new Map<string, number>()
  private readonly fingerprints = new Map<string, string>()

  constructor(private readonly ports: JmapRoomPorts) {}

  private get store(): JmapStore {
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

  // ─── opening a mailbox ───────────────────────────────────────────────

  /** The credential in use for a mailbox, as a fingerprint (a hash of the door, the key and the service token; never the credential), or why there is none. */
  private async credentialOf(
    row: JmapRow,
  ): Promise<
    | { declared: DeclaredJmap; key: string; access: { id: string; secret: string }; fingerprint: string }
    | { error: string }
  > {
    const declared = this.ports.declared().find((d) => d.address === row.address)
    if (!declared) return { error: `${row.address} is not declared any more, so it is not synced.` }
    const key = this.ports.secret(declared.secret)
    if (!key) return { error: `The Worker holds no key named ${declared.secret} for ${row.address}.` }
    const access = this.ports.access()
    if (!access)
      return {
        error:
          'The Worker holds no service token for the mail server’s door (JMAP_ACCESS_CLIENT_ID and JMAP_ACCESS_CLIENT_SECRET).',
      }
    return {
      declared,
      key,
      access,
      fingerprint: await sha256Hex(`${declared.door}\n${key}\n${access.id}\n${access.secret}`),
    }
  }

  /** The way into one mailbox, or why not. Also where a refusal ends: a key or token different from the one that was refused is tried. */
  private async open(row: JmapRow): Promise<Opened | { error: string }> {
    const credential = await this.credentialOf(row)
    if ('error' in credential) return credential
    const { declared, key, access, fingerprint } = credential
    this.fingerprints.set(row.id, fingerprint)
    this.store.clearJmapRefusalIfChanged(row.id, fingerprint)
    const connect = this.ports.connect ?? createJmap
    return {
      api: connect({
        door: declared.door,
        accessId: access.id,
        accessSecret: access.secret,
        key,
        fetch: this.ports.fetch,
      }),
      declared,
      fingerprint,
    }
  }

  /** Whether a mailbox the server refused has since been given a different credential (a deploy changed the key or the token): then the refusal is over, and the next run tries. Ends it, and answers whether it did. */
  private async refusalEnded(row: JmapRow): Promise<boolean> {
    if (row.refusedAt === null) return false
    const credential = await this.credentialOf(row)
    if ('error' in credential) return false
    return this.store.clearJmapRefusalIfChanged(row.id, credential.fingerprint)
  }

  // ─── what wakes it ───────────────────────────────────────────────────

  /**
   * The server called the push address with this token. Not a method the owner calls: the push door's, and only after it has found the mailbox. Answers whether the call is the server's for this mailbox (the token
   * matches), which the door turns into 204 or 404. One write and an alarm, and nothing else: no call to the server, nothing that can be slow. The body is a hint: a `PushVerification` names the subscription and carries the
   * server's code, which is kept for the alarm to complete the subscription with (only for the subscription the inbox made); anything else means changes are owed.
   */
  async receiveJmapPush(mailboxId: string, token: string, body: unknown): Promise<boolean> {
    const row = this.store.jmapRow(mailboxId)
    if (!row || !this.store.jmapPushTokenMatches(mailboxId, token)) return false
    const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    if (b['@type'] === 'PushVerification') {
      if (
        typeof b.pushSubscriptionId === 'string' &&
        typeof b.verificationCode === 'string' &&
        b.verificationCode.length <= 200
      ) {
        this.store.noteJmapVerification(mailboxId, b.pushSubscriptionId, b.verificationCode)
      }
    } else {
      this.store.recordJmapPush(mailboxId)
    }
    await this.alarmNow()
    return true
  }

  /** "Sync now": changes are owed, and a run is asked for. For one mailbox or, with none named, for every declared one. A refused or undeclared mailbox is said so in words. */
  async requestJmapSync(mailboxId?: string): Promise<Result<{ queued: true }>> {
    if (mailboxId !== undefined) {
      const row = this.store.jmapRow(mailboxId)
      if (!row) return fail(409, 'That mailbox is not on the mail server.')
      if (!this.ports.declared().some((d) => d.address === row.address))
        return fail(409, `${row.address} is not declared any more, so it is not synced.`)
      if (row.refusedAt !== null && !(await this.refusalEnded(row))) return fail(409, refusedReason(row.address))
    }
    this.store.markJmapSyncOwed(mailboxId)
    await this.alarmNow()
    return ok({ queued: true })
  }

  /** Whether the next alarm has anything to do for a JMAP mailbox: a declared one with no row yet, a fill or resync under way, a sync owed, or a push subscription the server has not verified yet (a code waiting, or the time to give it up not yet come: the object's alarm may have been replaced while it was away, and the run that follows sets the timer again). For the Durable Object's start. */
  async hasJmapWork(): Promise<boolean> {
    const rows = this.store.jmapRows()
    for (const d of this.ports.declared()) {
      const row = rows.find((r) => r.address === d.address)
      if (!row) return true
      if (row.refusedAt !== null) {
        // A refusal is over when the credential is not the one that was refused: that is a deploy, and the object starting is where it is noticed.
        if (await this.refusalEnded(row)) return true
        continue
      }
      const push = this.store.jmapPushState(row.id)
      if (row.job !== null || row.cursor === null || row.pushSeq > row.syncedSeq || (push !== null && !push.verified))
        return true
    }
    return false
  }

  // ─── the work ────────────────────────────────────────────────────────

  /** The Durable Object's alarm: do whatever is owed, for every declared mailbox. */
  runAlarm(): Promise<void> {
    return this.exclusive(() => this.workAll('push'))
  }

  /** The once-a-day pass: renew (or make again) each mailbox's push subscription, then one sync from the cursor as the safety net for a dropped push. */
  runJmapDaily(): Promise<void> {
    return this.exclusive(() => this.workAll('daily'))
  }

  private async workAll(source: 'push' | 'daily'): Promise<void> {
    const declared = this.ports.declared()
    if (declared.length === 0 && this.store.jmapRows().length === 0) return
    const made = this.store.declareJmap(declared.map((d) => ({ address: d.address, name: d.name })))
    for (const r of made)
      if (r.refusedAt !== null && declared.some((d) => d.address === r.address)) await this.refusalEnded(r)
    const rows = this.store.jmapRows()
    const working = rows.filter((r) => declared.some((d) => d.address === r.address) && r.refusedAt === null)
    let retryIn: number | null = null
    const failed = new Set<string>()
    for (const row of working) {
      const left = source === 'push' ? this.backoffLeftMs(row) : 0
      if (left > 0) {
        failed.add(row.id)
        retryIn = retryIn === null ? left : Math.min(retryIn, left)
        continue
      }
      const wait = await this.workOne(this.store.jmapRow(row.id) ?? row, source)
      if (wait !== undefined) {
        failed.add(row.id)
        if (wait !== null) retryIn = retryIn === null ? wait : Math.min(retryIn, wait)
      }
    }
    // The notifications the stored pages owe, failure or not: a sync that failed on its third page stored two.
    try {
      await this.ports.notifications?.deliverOwed()
    } catch (error) {
      console.error(`jmap: notifications failed: ${describe(error)}`)
    }
    const more = this.store
      .jmapRows()
      .some(
        (r) =>
          !failed.has(r.id) &&
          r.refusedAt === null &&
          declared.some((d) => d.address === r.address) &&
          (r.job !== null || r.pushSeq > r.syncedSeq),
      )
    if (more) await this.alarmNow()
    else await this.scheduleNext(working, failed, retryIn)
  }

  /**
   * The next thing that is due without anyone calling: a retry after a failure, or the moment a subscription the server has not verified is given up on and made again. Without the second, that check only ever
   * ran if some other alarm happened to fire, and a subscription whose verification was lost stayed silent until the daily pass (seen against a live server).
   */
  private async scheduleNext(working: readonly JmapRow[], failed: ReadonlySet<string>, retryIn: number | null) {
    const now = this.ports.now().getTime()
    const due = [retryIn === null ? null : now + retryIn, this.unverifiedDueAt(working, failed, now)].filter(
      (t): t is number => t !== null,
    )
    if (due.length > 0) await this.ports.scheduleAlarm(new Date(Math.min(...due)))
  }

  /** When the earliest push subscription still waiting for the server's verification passes PUSH_UNVERIFIED_MS (just after it, so the check finds it past); null when none is waiting or the moment has gone by. */
  private unverifiedDueAt(working: readonly JmapRow[], failed: ReadonlySet<string>, now: number): number | null {
    if (this.ports.pushOrigin === null) return null
    let earliest: number | null = null
    for (const row of working) {
      if (failed.has(row.id)) continue // its own backoff decides when it is next looked at
      const push = this.store.jmapPushState(row.id)
      if (!push || push.verified || push.code !== null) continue // a waiting code is the next run's, not a timer's
      const due = Date.parse(push.madeAt) + PUSH_UNVERIFIED_MS + 1000
      if (Number.isNaN(due) || due <= now) continue
      earliest = earliest === null ? due : Math.min(earliest, due)
    }
    return earliest
  }

  /** How long a mailbox that failed must still wait before its retry: its backoff so far, counted from the last failure; 0 when it has not failed, the time is up, or a push has come since. */
  private backoffLeftMs(row: JmapRow): number {
    if (row.retryCount === 0 || row.lastErrorAt === null) return 0
    if (row.lastPushAt !== null && row.lastPushAt > row.lastErrorAt) return 0
    const retryAt = Date.parse(row.lastErrorAt) + backoffMs(row.retryCount)
    return Number.isNaN(retryAt) ? 0 : Math.max(0, retryAt - this.ports.now().getTime())
  }

  /** One mailbox's turn. Answers undefined when it went well, and when it failed the delay before a retry (null when a retry would not help). */
  private async workOne(row: JmapRow, source: 'push' | 'daily'): Promise<number | null | undefined> {
    const opened = await this.open(row)
    if ('error' in opened) {
      this.store.recordJmapFailure(row.id, opened.error)
      console.warn(`jmap: ${row.address}: ${opened.error}`)
      return null
    }
    const { api } = opened
    try {
      const folders = foldersByRole((await api.folders()).list)
      if (folders.inbox === null) throw new JmapError(`${row.address} has no Inbox on the mail server.`, 200)
      await this.maintainPush(row, api, source)
      const now = this.store.jmapRow(row.id) ?? row
      if (now.job) await this.advanceJob(now, now.job, api, folders)
      else if (now.cursor === null) await this.beginFill(now, api)
      else if (now.pushSeq > now.syncedSeq || source === 'daily') await this.syncOnce(now, now.cursor, api, folders)
      return undefined
    } catch (error) {
      return this.failed(row, error)
    }
  }

  /** Record a failed step. A refused key is not helped by trying again (a deploy changing it is): the mailbox is marked refused and no retry is asked for (null). */
  private failed(row: JmapRow, error: unknown): number | null {
    const message = describe(error)
    console.warn(`jmap: ${row.address}: ${message}`)
    if (error instanceof JmapAuthError) {
      this.store.markJmapRefused(row.id, this.fingerprints.get(row.id) ?? 'unknown', refusedReason(row.address))
      return null
    }
    const failures = this.store.recordJmapFailure(row.id, message)
    return backoffMs(failures)
  }

  // ─── the push subscription ───────────────────────────────────────────

  /**
   * Keep the server calling the inbox: complete a subscription the server has sent its code for, make one when there is none, and on the daily pass check it is still there and extend it. A failure here is the push's alone
   * (Settings says mail arrives by the daily pass) and never fails the sync: the daily pass is the net.
   */
  private async maintainPush(row: JmapRow, api: JmapApi, source: 'push' | 'daily'): Promise<void> {
    const origin = this.ports.pushOrigin
    if (origin === null) return
    const before = this.store.jmapPushState(row.id)
    try {
      let state = before
      if (state && state.code !== null && !state.verified) state = await this.completeVerification(row, api, state)
      // A subscription whose verification never came (the server did not reach the push address, or its code was lost) would be renewed for ever and push nothing: after a while it is dropped and made again.
      // `workAll` asks for an alarm at that moment, so this does not wait for some other run. One whose id is still empty was never answered (the object stopped mid-call): there is nothing to remove by id.
      if (
        state &&
        !state.verified &&
        state.code === null &&
        !(this.ports.now().getTime() - Date.parse(state.madeAt) <= PUSH_UNVERIFIED_MS)
      ) {
        if (state.id !== '') await api.pushRemove(state.id).catch(() => undefined)
        this.store.setJmapPushState(row.id, null)
        this.pushAsked.delete(row.id)
        state = null
      }
      if (state && source === 'daily') {
        const there = (await api.pushGet()).find((s) => s.id === state?.id)
        if (!there) {
          this.store.setJmapPushState(row.id, null)
          state = null
        } else if (!state.expires || Date.parse(state.expires) - this.ports.now().getTime() < PUSH_RENEW_WITHIN_MS) {
          const expires = new Date(this.ports.now().getTime() + PUSH_LIFETIME_MS).toISOString()
          const renewed = await api.pushRenew(state.id, expires)
          state = { ...state, expires: renewed.expires ?? expires }
          this.store.setJmapPushState(row.id, state)
        }
      }
      const askedAt = this.pushAsked.get(row.id)
      if (!state && source === 'push' && askedAt !== undefined && this.ports.now().getTime() - askedAt < PUSH_RETRY_MS)
        return
      if (!state) await this.makePush(row, api, origin)
      this.pushErrors.delete(row.id)
    } catch (error) {
      // The credential refused is the whole mailbox's, and the sync below finds it too; anything else is the push's alone.
      if (error instanceof JmapAuthError) throw error
      // A subscription the server no longer knows (or would not accept a code for) is made again on the next pass; the one that failed is removed so the server is not left holding it.
      const held = this.store.jmapPushState(row.id)
      this.store.setJmapPushState(row.id, null)
      for (const id of new Set([before?.id, held?.id]))
        if (id !== undefined && id !== '') await api.pushRemove(id).catch(() => undefined)
      this.pushErrors.set(row.id, describe(error))
      console.warn(`jmap: ${row.address}: the push subscription could not be kept: ${describe(error)}`)
    }
  }

  /** Ask the server for a push subscription at this mailbox's address, and complete it at once if its verification came before the answer did. */
  private async makePush(row: JmapRow, api: JmapApi, origin: string): Promise<void> {
    this.pushAsked.set(row.id, this.ports.now().getTime())
    const token = this.ports.newToken()
    const madeAt = this.ports.now().toISOString()
    // The token is kept BEFORE the server is asked: Stalwart was measured POSTing its verification to the push address within a tenth of a second of making the subscription, before the answer to the
    // making call could be read and written down, and a call with a token the inbox does not know yet is a 404 the server does not repeat (seen against a live server: the first subscription stayed unverified).
    this.store.setJmapPushState(row.id, {
      id: '',
      token,
      code: null,
      verified: false,
      expires: null,
      madeAt,
      early: null,
    })
    const made = await api.pushMake({
      url: `${origin}${PUSH_PATH_PREFIX}${row.id}/${token}`,
      deviceClientId: this.ports.deviceClientId,
      types: ['Email', 'Mailbox'],
    })
    // A verification that came while the call was out names the subscription by the id the answer has now given.
    const early = this.store.jmapPushState(row.id)?.early ?? null
    const state: JmapPushState = {
      id: made.id,
      token,
      code: early !== null && early.id === made.id ? early.code : null,
      verified: false,
      expires: made.expires,
      madeAt,
      early: null,
    }
    this.store.setJmapPushState(row.id, state)
    if (state.code !== null) await this.completeVerification(row, api, state)
  }

  /**
   * Complete a subscription with the code the server sent. A push that was not there when the subscription was made is NOT in the cursor, and the cursor only moves when a sync runs, so a sync is owed from this moment:
   * mail that arrived before the subscription went live (seen against a live server: a message that came ten minutes before sat unseen until the next change) is read in by the sync that follows in the same run.
   */
  private async completeVerification(row: JmapRow, api: JmapApi, state: JmapPushState): Promise<JmapPushState> {
    if (state.code === null) return state
    await api.pushVerify(state.id, state.code)
    const done = { ...state, code: null, verified: true }
    this.store.setJmapPushState(row.id, done)
    this.store.markJmapSyncOwed(row.id)
    return done
  }

  // ─── the fill, a resync, a job ───────────────────────────────────────

  private fillSince(): Date {
    return new Date(this.ports.now().getTime() - FILL_DAYS * DAY_MS)
  }

  /** A mailbox with no cursor and no job: read the states first, then start the fill. */
  private async beginFill(row: JmapRow, api: JmapApi): Promise<void> {
    const states = await api.states()
    this.store.startJmapJob(row.id, {
      kind: 'fill',
      stage: 'list',
      after: this.fillSince().toISOString(),
      position: 0,
      cursorAfter: states,
      rereads: null,
    })
  }

  /**
   * Gap recovery. Read fresh states FIRST (so anything changing while this runs is caught by the sync that follows), then list Inbox and Sent mail from a day before the newest message held, and finally read the messages
   * of the open conversations again, so a move or a read made during the gap is caught too. All of it is idempotent, so the overlap does no harm.
   */
  private async startResync(row: JmapRow, api: JmapApi, reason: string): Promise<void> {
    const states = await api.states()
    const newest = this.store.newestJmapAt(row.id)
    const after = newest ? new Date(Date.parse(newest) - DAY_MS) : this.fillSince()
    this.store.startJmapJob(
      row.id,
      { kind: 'resync', stage: 'list', after: after.toISOString(), position: 0, cursorAfter: states, rereads: null },
      reason,
    )
  }

  private async advanceJob(row: JmapRow, job: JmapJob, api: JmapApi, folders: FolderIds): Promise<void> {
    if (job.stage === 'list') await this.listStep(row, job, api, folders)
    else await this.rereadStep(row, job, api, folders)
    this.store.recordJmapSuccess(row.id, null)
  }

  /**
   * Pages of the window, stored as they come, until a page would pass this run's budget. A message the list names that is already held is not downloaded again, but its state is read (a conversation closed here can have been
   * read or moved on the server, and nothing else would catch it after a gap).
   */
  private async listStep(row: JmapRow, start: JmapJob, api: JmapApi, folders: FolderIds): Promise<void> {
    let job = start
    let downloaded = 0
    const folderIds = [folders.inbox, folders.sent].filter((f): f is string => f !== null)
    for (;;) {
      const page = await api.list({ folderIds, after: job.after, position: job.position, limit: LIST_PAGE })
      const read = await this.read(row, api, page.ids, folders)
      downloaded += read.downloaded
      // The next page starts at the time of this one's last message, not at a position: a message that moves out of the folders while the fill runs would shift every position after it and one would be skipped for good.
      // The last message comes again (the time is inclusive), which costs a read of its state and nothing more. A page that makes no progress in time (a full page of messages received in the same second) falls back to the position.
      const advances = page.lastAt !== null && Date.parse(page.lastAt) > Date.parse(job.after)
      const position = advances ? 0 : job.position + page.ids.length
      const after = advances && page.lastAt !== null ? page.lastAt : job.after
      const more =
        page.ids.length > 0 &&
        (advances ? page.ids.length === LIST_PAGE || page.total > page.ids.length : position < page.total)
      const next: JmapJob | null = more
        ? { ...job, after, position }
        : job.kind === 'resync'
          ? { ...job, stage: 'labels', position: 0, rereads: null }
          : null
      this.store.applyJmapJobStep({
        mailboxId: row.id,
        kind: job.kind,
        cursorAfter: job.cursorAfter,
        messages: read.messages,
        labels: read.labels,
        destroyed: [],
        job: next,
      })
      if (next === null || next.stage === 'labels' || downloaded >= FETCH_BUDGET) return
      job = next
    }
  }

  /** A resync's last stage: the messages of the open conversations, as the server has them now. One it no longer has was destroyed. */
  private async rereadStep(row: JmapRow, job: JmapJob, api: JmapApi, folders: FolderIds): Promise<void> {
    const ids = job.rereads ?? this.store.openJmapMessageIds(row.id)
    const batch = ids.slice(0, REREAD_BUDGET)
    const rest = ids.slice(REREAD_BUDGET)
    const found = await api.emails(batch)
    const present = new Set(found.map((e) => e.id))
    this.store.applyJmapJobStep({
      mailboxId: row.id,
      kind: job.kind,
      cursorAfter: job.cursorAfter,
      messages: [],
      labels: found.map((e) => ({ id: e.id, labels: labelsOf(e, folders) })),
      destroyed: batch.filter((id) => !present.has(id)),
      job: rest.length > 0 ? { ...job, rereads: rest } : null,
    })
  }

  /**
   * Read these messages: the ones the store does not hold are downloaded and parsed (when they belong in the store at all), the ones it holds have their state read. A message too large to download is stored from what
   * the server says of it. Answers what to hand the store and how many downloads it cost (the budget).
   */
  private async read(
    row: JmapRow,
    api: JmapApi,
    ids: string[],
    folders: FolderIds,
  ): Promise<{
    messages: Awaited<ReturnType<typeof parseJmapMessage>>[]
    labels: { id: string; labels: string[] }[]
    downloaded: number
  }> {
    if (ids.length === 0) return { messages: [], labels: [], downloaded: 0 }
    const known = this.store.knownJmapIds(row.id, ids)
    const heldIds = ids.filter((id) => known.has(id))
    const newIds = ids.filter((id) => !known.has(id))
    const labels = (await api.emails(heldIds)).map((e) => ({ id: e.id, labels: labelsOf(e, folders) }))
    const fresh = await api.emails(newIds, { structure: true })
    return { ...(await this.parseNew(row, api, fresh, folders)), labels }
  }

  /** The messages new to the store, parsed: only those that belong (in play, and in the Inbox or Sent or a thread held), the Inbox's and Sent's first so their thread exists for the rest. */
  private async parseNew(
    row: JmapRow,
    api: JmapApi,
    fresh: JmapEmail[],
    folders: FolderIds,
  ): Promise<{ messages: Awaited<ReturnType<typeof parseJmapMessage>>[]; downloaded: number }> {
    const withLabels = fresh
      .map((email) => ({ email, labels: labelsOf(email, folders) }))
      .filter((m) => inPlay(m.labels))
    const opening = (labels: string[]) => labels.includes(LABEL.inbox) || labels.includes(LABEL.sent)
    const openThreads = new Set(withLabels.filter((m) => opening(m.labels)).map((m) => m.email.threadId))
    const wanted = withLabels
      .filter((m) =>
        belongsInStore(
          m.labels,
          this.store.jmapThreadHeld(row.id, m.email.threadId) || openThreads.has(m.email.threadId),
        ),
      )
      .sort((a, b) => Number(opening(b.labels)) - Number(opening(a.labels)))
    const messages = []
    let downloaded = 0
    for (const { email, labels } of wanted) {
      if (email.size > MAX_RAW_BYTES) {
        messages.push(await parseJmapMessage(email, null, labels))
        continue
      }
      const raw = await api.raw(email.blobId)
      downloaded += 1
      messages.push(await parseJmapMessage(email, raw, labels))
    }
    return { messages, downloaded }
  }

  /**
   * Ask the server what changed since the cursor and store it, a page at a time. The cursor moves to the states the server reports for each page, in the same transaction that stores it. A cursor the server cannot answer
   * from starts a resync instead.
   */
  private async syncOnce(row: JmapRow, start: JmapCursor, api: JmapApi, folders: FolderIds): Promise<void> {
    const seq = row.pushSeq
    let cursor = start
    let downloaded = 0
    for (;;) {
      let page: Awaited<ReturnType<JmapApi['changes']>>
      try {
        page = await api.changes(cursor, CHANGES_PAGE)
      } catch (error) {
        if (error instanceof JmapStateGone)
          return this.startResync(row, api, 'The mail server could no longer say what changed since the saved cursor.')
        throw error
      }
      const named = [...page.emails.created, ...page.emails.updated]
      const read = await this.read(row, api, named, folders)
      downloaded += read.downloaded
      const next: JmapCursor = { email: page.emails.newState, mailbox: page.mailboxState }
      this.store.applyJmapPage({
        mailboxId: row.id,
        messages: read.messages,
        labels: read.labels,
        destroyed: page.emails.destroyed,
        cursor: next,
        notify: true,
      })
      cursor = next
      if (!page.emails.hasMoreChanges) break
      if (downloaded >= FETCH_BUDGET) {
        // Cut short, not finished: the cursor is saved and the rest is OWED, so the next alarm carries on.
        this.store.markJmapSyncOwed(row.id)
        this.store.recordJmapSuccess(row.id, null)
        return
      }
    }
    this.store.recordJmapSuccess(row.id, seq)
  }

  // ─── read, close and reopen ──────────────────────────────────────────

  /**
   * Read, close or reopen a conversation in a JMAP mailbox. The server first: the thread is changed there, and only once the server accepts does the inbox change, so the two cannot disagree because of the inbox. A change that
   * is not needed (already read, already closed) asks the server for nothing. The same refusal of what the person was not shown applies as for Gmail: the store's plan (a message held beyond `through`) and the server's own thread, read just
   * before, for one the inbox does not hold yet; every message missing is stored on the spot. Runs in the chain with the sync, so a sync cannot be halfway through a page that predates the change while the change lands.
   */
  changeJmapConversation(
    conversationId: string,
    change: ConversationChange,
    actor: string,
    through: number | null,
  ): Promise<Result<ConversationState>> {
    const first = this.store.planConversationChange(conversationId, change, through)
    if (!first.ok) return Promise.resolve(first)
    return this.exclusive(async () => {
      const plan = this.store.planConversationChange(conversationId, change, through)
      if (!plan.ok) return plan
      if (plan.value.needed && plan.value.threadId !== null) {
        const refused = await this.askServer(conversationId, plan.value.threadId, change, through, actor)
        if (refused) return refused
      }
      return this.store.applyConversationChange(conversationId, change, actor)
    })
  }

  /** Have the server make the change, or say why not. Null when the inbox should now make it too (the server made it, or has no such thread), a refusal otherwise. */
  private async askServer(
    conversationId: string,
    threadId: string,
    change: ConversationChange,
    through: number | null,
    actor: string,
  ): Promise<Result<never> | null> {
    const row = this.store.jmapRowOfConversation(conversationId)
    if (!row) return fail(503, 'The mail server is not connected for this conversation, so nothing was changed.')
    if (row.refusedAt !== null) return fail(503, `${refusedReason(row.address)} Nothing was changed.`)
    const opened = await this.open(row)
    if ('error' in opened) return fail(503, `${opened.error} Nothing was changed.`)
    const { api } = opened
    try {
      const folders = foldersByRole((await api.folders()).list)
      if (folders.inbox === null)
        return fail(503, `${row.address} has no Inbox on the mail server. Nothing was changed.`)
      let metas = await api.emails(await api.thread(threadId), { structure: true })
      if (metas.length === 0)
        return change === 'reopen'
          ? fail(
              409,
              'The mail server no longer has this conversation, so there is nothing to put back in the Inbox. Nothing was changed.',
            )
          : null
      if (change !== 'reopen' && (await this.storeMissing(row, api, metas, folders, actor))) {
        const again = this.store.planConversationChange(conversationId, change, through)
        if (!again.ok) return again
      }
      metas = await api.emails(metas.map((m) => m.id))
      const inPlayNow = metas.filter((m) => inPlay(labelsOf(m, folders)))
      if (change === 'read') {
        await api.setSeen(
          inPlayNow
            .filter((m) => m.keywords.$seen !== true && labelsOf(m, folders).includes(LABEL.unread))
            .map((m) => m.id),
          true,
        )
        return null
      }
      if (folders.archive === null)
        return fail(
          503,
          `${row.address} has no Archive folder on the mail server (it is made when the mailbox's key is), so nothing was changed.`,
        )
      if (change === 'close') {
        const ids = inPlayNow.filter((m) => m.mailboxIds[folders.inbox as string] === true).map((m) => m.id)
        const result = await api.move(ids, folders.inbox, folders.archive)
        return this.moved(
          { moved: result.moved.length, failed: result.failed.length, reason: result.failed[0]?.reason ?? '' },
          'closed',
        )
      }
      // Reopen: what is in play and is not mail the mailbox sent or is already in the Inbox goes back, each from the folder it is in.
      const back = inPlayNow.filter(
        (m) => m.mailboxIds[folders.inbox as string] !== true && !labelsOf(m, folders).includes(LABEL.sent),
      )
      const byFolder = new Map<string, string[]>()
      for (const m of back) {
        const from = Object.keys(m.mailboxIds).find((id) => m.mailboxIds[id] === true)
        if (from) byFolder.set(from, [...(byFolder.get(from) ?? []), m.id])
      }
      let movedAll = 0
      let failedAll = 0
      let firstReason = ''
      for (const [from, ids] of byFolder) {
        const result = await api.move(ids, from, folders.inbox)
        movedAll += result.moved.length
        failedAll += result.failed.length
        firstReason ||= result.failed[0]?.reason ?? ''
      }
      return this.moved({ moved: movedAll, failed: failedAll, reason: firstReason }, 'reopened')
    } catch (error) {
      return this.refusal(row, error, 'Nothing was changed here.')
    }
  }

  /** What was moved becomes an answer: nothing wrong is null; some moved and some refused is a partial change, said so; none moved is a refusal. */
  private moved(counts: { moved: number; failed: number; reason: string }, word: string): Result<never> | null {
    if (counts.failed === 0) return null
    const total = counts.moved + counts.failed
    if (counts.moved === 0)
      return fail(
        502,
        `The mail server would not change this conversation (${counts.reason || 'refused'}). Nothing was changed here.`,
      )
    return fail(
      502,
      `The mail server moved ${counts.moved} of ${total} messages and then refused (${counts.reason || 'refused'}). The conversation is partly ${word} on the server. The inbox shows it as the server reports it once it has synced; doing it again moves the rest.`,
    )
  }

  /** What a person is told when the server would not do something: its words, and what it left undone. A refused key is also the state of the mailbox. */
  private refusal(row: JmapRow, error: unknown, tail: string): Result<never> {
    if (error instanceof JmapAuthError) {
      this.store.markJmapRefused(row.id, this.fingerprints.get(row.id) ?? 'unknown', refusedReason(row.address))
      return fail(503, `${refusedReason(row.address)} ${tail}`)
    }
    const said =
      error instanceof JmapUnreachable
        ? `${error.message}`
        : error instanceof JmapError
          ? error.message
          : `The mail server did not answer: ${describe(error)}`
    console.warn(`jmap: ${row.address}: refused: ${said}`)
    return fail(502, `${said} ${tail}`)
  }

  /**
   * Store the messages of a server thread that the inbox does not hold: ones whose push or sync is still on its way, and old ones from before the first fill. Answers whether it stored any. It stores them all and decides nothing:
   * whether one of them is a reason to refuse is the store's plan (`arrivedAfter`). Whether what it stores can notify depends on who is acting, as for Gmail: the owner's Read, Close or Send happens while they are looking, so it never
   * does; Claude's happens with nobody looking, and a reply it finds there is new mail like any other.
   */
  private async storeMissing(
    row: JmapRow,
    api: JmapApi,
    metas: JmapEmail[],
    folders: FolderIds,
    actor: string,
  ): Promise<boolean> {
    const known = this.store.knownJmapIds(
      row.id,
      metas.map((m) => m.id),
    )
    const fresh = metas.filter((m) => !known.has(m.id))
    if (fresh.length === 0) return false
    const read = await this.parseNew(row, api, fresh, folders)
    if (read.messages.length === 0) return false
    const { owed } = this.store.applyJmapPage({
      mailboxId: row.id,
      messages: read.messages,
      labels: [],
      destroyed: [],
      cursor: null,
      notify: isAgent(actor),
    })
    if (owed > 0) {
      try {
        await this.ports.notifications?.deliverOwed()
      } catch (error) {
        console.error(`jmap: notifications failed: ${describe(error)}`)
      }
    }
    return true
  }

  // ─── sending ─────────────────────────────────────────────────────────

  /**
   * A draft is sent through the mail server: by the owner pressing Send, or by Claude on their instruction (the store refuses the send without it, or with the switch off, before anything is read or claimed). See the header for what
   * each failure means.
   */
  sendJmap(
    id: string,
    input: SendRequest,
    actor: string,
    files: readonly ChosenFile[] = [],
  ): Promise<Result<MessageRow>> {
    return this.exclusive(async () => {
      if (files.length > 0) return fail(422, FILES_REFUSED)
      const planned = this.store.planSend(id, input, actor)
      if (!planned.ok) return planned
      if (planned.value.transport !== 'jmap') return fail(409, NEVER_CROSSES)
      const plan: JmapSendPlan = planned.value
      // A subject is one line (it is a header): refused before anything is claimed.
      if (/[\r\n]/.test(plan.subject)) return fail(422, 'The subject must be one line. Nothing was sent.')

      const row = this.store.jmapRow(plan.mailboxId)
      if (!row) return fail(503, 'That mailbox is not on the mail server, so nothing was sent.')
      if (row.refusedAt !== null) return fail(503, `${refusedReason(row.address)} Nothing was sent.`)
      const opened = await this.open(row)
      if ('error' in opened) return fail(503, `${opened.error} Nothing was sent.`)
      const { api } = opened

      const ready = await this.prepareSend(row, api, plan, { id, input, actor })
      if (!ready.ok) return ready
      const claimed = this.store.claimSend(ready.value.plan, actor)
      if (!claimed.ok) return claimed
      return this.deliver(api, row, ready.value.plan, ready.value.identityId, ready.value.folders, actor)
    })
  }

  /** What a send needs from the server before anything is claimed: its Drafts and Sent, the identity for the address, and, for a reply, that nothing arrived on the thread that the page has not shown. */
  private async prepareSend(
    row: JmapRow,
    api: JmapApi,
    first: JmapSendPlan,
    ask: { id: string; input: SendRequest; actor: string },
  ): Promise<Result<{ plan: JmapSendPlan; identityId: string; folders: { drafts: string; sent: string } }>> {
    let plan = first
    try {
      const folders = foldersByRole((await api.folders()).list)
      if (folders.drafts === null || folders.sent === null)
        return fail(503, `${row.address} has no Drafts or Sent folder on the mail server, so nothing was sent.`)
      const identity = (await api.identities()).find((i) => i.email === plan.from.toLowerCase())
      if (!identity) return fail(422, `The mail server has no sending identity for ${plan.from}, so nothing was sent.`)
      // A reply is also checked against the thread on the server just before it goes, so it cannot go out over a message that arrived and has not been shown yet.
      if (plan.threadId !== null) {
        const metas = await api.emails(await api.thread(plan.threadId), { structure: true })
        if (await this.storeMissing(row, api, metas, folders, ask.actor)) {
          const again = this.store.planSend(ask.id, ask.input, ask.actor)
          if (!again.ok) return again
          if (again.value.transport !== 'jmap') return fail(409, NEVER_CROSSES)
          plan = again.value
        }
      }
      return ok({ plan, identityId: identity.id, folders: { drafts: folders.drafts, sent: folders.sent } })
    } catch (error) {
      return this.refusal(row, error, 'Nothing was sent.')
    }
  }

  /** The one call to the server, and what each way it can end means (see the header). */
  private async deliver(
    api: JmapApi,
    row: JmapRow,
    plan: JmapSendPlan,
    identityId: string,
    folders: { drafts: string; sent: string },
    actor: string,
  ): Promise<Result<MessageRow>> {
    let sent: { emailId: string; threadId: string }
    try {
      sent = await api.submit(
        {
          from: { name: plan.fromName || plan.from, email: plan.from },
          to: [plan.to],
          cc: plan.cc,
          subject: plan.subject,
          body: plan.body,
          messageId: plan.messageId,
          inReplyTo: plan.inReplyTo,
          references: plan.references,
          identityId,
          at: plan.at,
        },
        folders,
      )
    } catch (error) {
      return this.submitFailed(api, row, plan, error, actor)
    }

    const notFiled = (why: string): Result<never> => {
      console.error(`jmap: ${plan.from} sent ${plan.id} but could not file it: ${why}`)
      return fail(
        502,
        `The mail server sent the message, but the inbox could not record it. It is held as "sending" and the server’s copy will arrive by itself: check ${plan.from}’s Sent before doing anything.`,
      )
    }
    try {
      const filed = this.store.fileJmapSent(plan, sent, actor)
      return filed.ok ? filed : notFiled(filed.error)
    } catch (error) {
      return notFiled(describe(error))
    }
  }

  /** What each way the one call can fail means: unknown (held as sending), refused or never reached (nothing went out; the draft goes back). */
  private async submitFailed(
    api: JmapApi,
    row: JmapRow,
    plan: JmapSendPlan,
    error: unknown,
    actor: string,
  ): Promise<Result<MessageRow>> {
    const unknown = (words: string) => {
      console.warn(`jmap: send as ${plan.from}, outcome unknown: ${words}`)
      return fail(
        502,
        `${words} It is not known whether the message went out, so it was NOT sent again. It is held as "sending": check ${plan.from}’s Sent in a mail app, then say whether it went out or not.`,
      )
    }
    if (error instanceof JmapOutcomeUnknown) return unknown(error.message)
    if (!(error instanceof JmapError || error instanceof JmapAuthError || error instanceof JmapUnreachable))
      return unknown(describe(error))
    // The server refused (or never got) it: nothing went out. A copy it made but would not submit is removed, the one removal there is.
    let leftBehind = ''
    if (error instanceof JmapSubmitRefused && error.emailId !== null) {
      try {
        await api.removeUnsent(error.emailId)
      } catch (removing) {
        leftBehind = ` (The unsent copy is still in Drafts: ${describe(removing)})`
      }
    }
    if (error instanceof JmapAuthError)
      this.store.markJmapRefused(row.id, this.fingerprints.get(row.id) ?? 'unknown', refusedReason(row.address))
    const said = `${error.message} Nothing was sent, and the draft is still a draft.${leftBehind}`
    console.warn(`jmap: send as ${plan.from} refused: ${said}`)
    this.store.releaseClaim(plan.id, said, actor)
    const theirs =
      error instanceof JmapError && error.status >= 400 && error.status < 500 && !(error instanceof JmapAuthError)
    return fail(theirs ? 422 : 502, said)
  }

  // ─── what Settings shows ─────────────────────────────────────────────

  /** Every JMAP mailbox the store holds as Settings shows it: live, filling, refused, unreachable, or no longer declared. Never a key. */
  jmapMailboxes(): JmapMailboxStatus[] {
    const declared = this.ports.declared()
    const now = this.ports.now().getTime()
    return this.store.jmapRows().map((row) => {
      const d = declared.find((x) => x.address === row.address)
      const state = this.stateOf(row, d)
      const push = this.pushOf(row.id, now)
      const reasons = this.reasonsOf(row, state, push)
      return {
        id: row.id,
        kind: 'jmap' as const,
        address: row.address,
        name: row.name,
        declared: d !== undefined,
        state,
        refusedAt: row.refusedAt,
        connectedAt: row.connectedAt,
        lastPushAt: row.lastPushAt,
        lastSyncAt: row.lastSyncAt,
        lastError: row.lastError,
        lastErrorAt: row.lastErrorAt,
        lastResyncAt: row.lastResyncAt,
        push,
        ...this.store.jmapCounts(row.id),
        health: { amber: reasons.length > 0, reasons },
      }
    })
  }

  private stateOf(row: JmapRow, declared: DeclaredJmap | undefined): JmapMailboxStatus['state'] {
    if (!declared) return 'undeclared'
    if (row.refusedAt !== null) return 'refused'
    if (!this.ports.secret(declared.secret) || this.ports.access() === null) return 'no-credential'
    if (row.job?.kind === 'resync') return 'resyncing'
    if (row.job?.kind === 'fill' || row.cursor === null) return 'filling'
    return row.lastError !== null ? 'unreachable' : 'live'
  }

  private pushOf(mailboxId: string, now: number): JmapMailboxStatus['push'] {
    const pushState = this.store.jmapPushState(mailboxId)
    if (pushState === null) return 'off'
    return pushState.verified && (!pushState.expires || Date.parse(pushState.expires) > now) ? 'live' : 'waiting'
  }

  /** The words that make a mailbox amber, none when it is well. */
  private reasonsOf(row: JmapRow, state: JmapMailboxStatus['state'], push: JmapMailboxStatus['push']): string[] {
    if (state === 'undeclared') return [`${row.address} is no longer declared, so it is kept and not synced.`]
    if (state === 'refused') return [refusedReason(row.address)]
    if (state === 'no-credential') {
      return [
        `The Worker holds no key (or no service token for the door) for ${row.address}, so nothing syncs or goes out.`,
      ]
    }
    const reasons: string[] = []
    if (row.lastError !== null) {
      const since = row.lastErrorAt ? ` since ${row.lastErrorAt}` : ''
      reasons.push(`The mail server did not answer well${since}: ${row.lastError}`)
    }
    if (push !== 'live' && this.ports.pushOrigin !== null) {
      reasons.push(
        this.pushErrors.has(row.id)
          ? `The mail server was not given the inbox’s push address (${this.pushErrors.get(row.id)}), so mail arrives only when the daily pass runs.`
          : 'The mail server has not yet confirmed the inbox’s push address, so mail arrives only when the daily pass runs.',
      )
    }
    return reasons
  }
}
