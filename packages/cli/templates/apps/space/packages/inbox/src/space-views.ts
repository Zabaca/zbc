/**
 * The inbox's other views, as it answers the space:
 * Claude's sending switch, the mailboxes and the spam check, notifications, restore, Clients, and the draft chat.
 * The contract is packages/workspace/src/inbox-for-space.ts (the methods) and inbox-views.ts (the shapes). Like src/space.ts, this is a
 * function over the inbox's own store, so every rule here runs under plain `bun` against the real store (test/space-views.test.ts), and
 * the space's Worker calls it in-process (src/space-part.ts).
 *
 * ── THE SAME GATES, AND THE SAME ROUTES' RULES ───────────────────────────
 * Every method goes through a gate (src/space-gate.ts). What the inbox's own page did for anyone it admitted, and what only reads or works the mail (the menu, the mailboxes' list, notifications, Clients' counts, the draft chat)
 * is a person's: `personGate`, handed what they may see, so every number and row is cut to the mailboxes they are on (the inbox's ADR 0004). What changes the install's setup (Claude's
 * switch, the spam check's switch, Gmail's connection, restore, linking a Client) is the owner's alone: `ownerGate`. Then each calls the very store or module method the inbox's own route calls, with the actor, so every
 * rule that route has stays: a switch is the owner's alone in the store as well, a device
 * is checked again as a push service the inbox sends to, a Client the Clients part does not hold is not assigned, and so on. Nothing here is a
 * second implementation of any of them. The two things the routes do that a method cannot are done here as they are there: a restore
 * confirmation is followed by the restart (in a call of its own, expected to fail), and a Client is checked against the Clients part.
 *
 * ── CLAUDE NEVER FLIPS A SWITCH HERE ──────────────────────────────────────
 * Claude's sending switch, the spam check and restore are the owner's. This entrypoint is reachable only with a verified
 * assertion of the owner's, a service token is never admitted (the layer's check is not told to allow one), and the stores refuse anyone but the
 * owner's address as well. Claude's script reaches the inbox on its own address with its own token.
 */

import {
  answered,
  failed,
  GMAIL_CODE_MAX,
  GMAIL_PURPOSES,
  GMAIL_STATE,
  type GmailPurpose,
  gmailReturnUrl,
  INBOX_CAPABILITIES,
  type InboxBusinessMailbox,
  type InboxChat,
  type InboxChatAnswer,
  type InboxChatTurn,
  type InboxClaudeSending,
  type InboxClientContact,
  type InboxClientPage,
  type InboxClientSummary,
  type InboxClients,
  type InboxDevice,
  type InboxDeviceInput,
  type InboxForSpace,
  type InboxGmail,
  type InboxGmailChange,
  type InboxGmailChanged,
  type InboxGmailSignIn,
  type InboxJmap,
  type InboxMailboxes,
  type InboxNav,
  type InboxNotifications,
  type InboxRestoreChoice,
  type InboxRestoreDone,
  type InboxRestorePlan,
  type InboxRestoreReport,
  type InboxSpamCheck,
  type InboxTelegram,
  type InboxTestSent,
  MAILBOX_ID,
  NOT_ADMITTED,
  type Refused,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'
import { checkLink, clientLabel, clientsById, clientView, readClients, suggestClients } from './clients'
import { buildAuthUrl } from './gmail/google'
import { inboxOwnerOf } from './owner'
import { canSee, type MailScope } from './queue'
import {
  type AsOwner,
  type AsPerson,
  BAD,
  ID,
  isCount,
  isRecord,
  ms,
  outcomeOf,
  type SpaceDeps,
  seesConversation,
  spelled,
} from './space-gate'
import type { Result } from './store/store'
import {
  type AssistantSwitch,
  type ChatTurn,
  type ClaudeSending,
  type ClientView,
  type CloudflareMailboxStatus,
  type ContactListItem,
  type Device,
  type DirectoryStatus,
  isClientId,
  type JmapMailboxStatus,
  type MailboxStatus,
  NOTIFICATIONS_NOT_SET_UP,
  type TelegramMailboxStatus,
} from './types'

/** What connecting Gmail says where the install's `gmail` switch is off. */
export const GMAIL_OFF = 'Gmail is not turned on in this space.'

/** The most a chat instruction or a restore bookmark is read as before the store's own limits speak: a screen, not a file. */
const MOST_TEXT = 20_000

const text = (v: unknown): v is string => typeof v === 'string'

/** A store result as the contract's reply, its value mapped. */
function reply<T, U>(r: Result<T>, map: (value: T) => U): SpaceReply<U> {
  return r.ok ? answered(map(r.value)) : outcomeOf(r)
}

const orNull = (iso: string | null): number | null => (iso === null ? null : ms(iso))

// ── The shapes ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const claudeSendingOf = (s: ClaudeSending): InboxClaudeSending => ({
  enabled: s.enabled,
  changedAt: orNull(s.changedAt),
})

const spamCheckOf = (a: AssistantSwitch): InboxSpamCheck => ({
  enabled: a.enabled,
  changedAt: orNull(a.changedAt),
  changedBy: a.changedBy,
  judged: a.judged,
})

const gmailOf = (g: MailboxStatus): InboxGmail => ({
  id: g.id,
  address: g.address,
  name: g.name,
  connected: g.connected,
  state: g.state,
  lapsedAt: orNull(g.lapsedAt),
  sendsByDefault: g.sendsByDefault,
  lastPushAt: orNull(g.lastPushAt),
  lastSyncAt: orNull(g.lastSyncAt),
  watchExpiry: orNull(g.watchExpiry),
  messages: g.messages,
  conversations: g.conversations,
  open: g.open,
  unreadOpen: g.unreadOpen,
  reasons: g.health.reasons,
})

const businessOf = (m: CloudflareMailboxStatus): InboxBusinessMailbox => ({
  id: m.id,
  name: m.name,
  address: m.address,
  lastArrivalAt: orNull(m.lastArrivalAt),
  lastFilingError: m.lastFilingError,
  messages: m.messages,
  conversations: m.conversations,
  open: m.open,
  unreadOpen: m.unreadOpen,
  spamCheck: spamCheckOf(m.assistant),
  reasons: m.health.reasons,
})

const telegramOf = (t: TelegramMailboxStatus): InboxTelegram => ({
  id: t.id,
  name: t.name,
  address: t.address,
  state: t.state,
  reportedAt: t.reported === null ? null : ms(t.reported.at),
  checkedInAt: orNull(t.checkedInAt),
  lastPushAt: orNull(t.lastPushAt),
  filled: t.hasPosition,
  messages: t.messages,
  conversations: t.conversations,
  open: t.open,
  unreadOpen: t.unreadOpen,
})

const jmapOf = (m: JmapMailboxStatus): InboxJmap => ({
  id: m.id,
  name: m.name,
  address: m.address,
  declared: m.declared,
  state: m.state,
  refusedAt: m.refusedAt === null ? null : ms(m.refusedAt),
  push: m.push,
  lastPushAt: orNull(m.lastPushAt),
  lastSyncAt: orNull(m.lastSyncAt),
  lastError: m.lastError,
  lastErrorAt: orNull(m.lastErrorAt),
  messages: m.messages,
  conversations: m.conversations,
  open: m.open,
  unreadOpen: m.unreadOpen,
  reasons: m.health.reasons,
})

const deviceOf = (d: Device): InboxDevice => ({
  id: d.id,
  label: d.label,
  // Every device is the space's (the inbox's own installed app is gone). The contract still names the kind.
  origin: 'space',
  endpoint: d.endpoint,
  addedAt: ms(d.addedAt),
  lastDeliveredAt: orNull(d.lastDeliveredAt),
  lastFailedAt: orNull(d.lastFailedAt),
  lastFailure: d.lastFailure,
  refused: d.lastOutcome === 'refused',
  delivered: d.delivered,
  failed: d.failed,
})

const turnOf = (t: ChatTurn): InboxChatTurn => ({
  seq: t.seq,
  at: ms(t.at),
  instruction: t.instruction,
  note: t.note,
  revised: t.revised,
})

const directoryOf = (d: DirectoryStatus): { available: boolean; error: string | null } => ({
  available: d.available,
  error: d.error,
})

const addressesOf = (c: ContactListItem): string[] =>
  spelled(c.identities.filter((i) => i.kind === 'email').map((i) => i.address))

const summaryOf = (
  view: ClientView,
  usage: { contacts: number; conversations: number; open: number },
): InboxClientSummary => ({
  id: view.id,
  name: view.name,
  listed: view.listed,
  legalEntity: view.legalEntity,
  contacts: usage.contacts,
  conversations: usage.conversations,
  open: usage.open,
  adminUrl: view.adminUrl,
  archived: view.archived,
})

// ── Reading what a change asks ────────────────────────────────────────────────────────────────────────────────────────────

function readRestoreChoice(raw: unknown): { ok: true; choice: InboxRestoreChoice } | Refused {
  if (!isRecord(raw)) return BAD('Say a time or a bookmark.')
  const time = raw.time
  const bookmark = raw.bookmark
  if (text(time) && bookmark === undefined && time.length <= 100) return { ok: true, choice: { time } }
  if (text(bookmark) && time === undefined && bookmark.length <= 300) return { ok: true, choice: { bookmark } }
  return BAD('Say a time with its zone, or a bookmark, and not both.')
}

// ── The views ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Views = Pick<
  InboxForSpace,
  | 'navigation'
  | 'claudeSending'
  | 'setClaudeSending'
  | 'mailboxes'
  | 'setSpamCheck'
  | 'changeGmail'
  | 'gmailSignIn'
  | 'gmailConnect'
  | 'notifications'
  | 'addDevice'
  | 'removeDevice'
  | 'testDevice'
  | 'restoreReport'
  | 'prepareRestore'
  | 'confirmRestore'
  | 'clients'
  | 'client'
  | 'linkClient'
  | 'draftChat'
  | 'chat'
>

export function createSpaceViews(deps: SpaceDeps, asOwner: AsOwner, asPerson: AsPerson): Views {
  const { store } = deps
  const ownDomain = inboxOwnerOf(deps.install).domain

  // ── The menu ────────────────────────────────────────────────────────────

  /**
   * The inbox's own left menu in one read. The counts are ROWS, the unit the space's lists are drawn in (a person each), counted over every conversation by one store call
   * (`spaceRowCounts`, src/store/row-counts.ts): not the queue's conversation counts, which read as a fault beside a list of fewer rows, and not cut to a screen the way the lists are.
   * The Drafts count adds the drafts that sit on no conversation, which the Drafts list shows above its rows.
   */
  const navigation = (asker: SignedIn) =>
    asPerson(asker, async ({ scope }): Promise<SpaceReply<InboxNav>> => {
      // Each teammate's two addresses: the space puts a teammate known by both in one row, so a count must.
      const team = deps.install.people.map((p) => [p.address, p.signIn].map((a) => a.trim().toLowerCase()))
      const [rows, drafts, dir, usage, contacts, gmail, boxes, telegram, jmap] = await Promise.all([
        store.call('spaceRowCounts', team, scope),
        store.call('listDrafts', scope),
        readClients(deps.clients, deps.install),
        store.call('clientUsage', scope),
        store.call('listContacts', scope),
        store.call('mailboxStatuses'),
        store.call('cloudflareMailboxes'),
        store.call('telegramMailboxes'),
        store.call('jmapMailboxes'),
      ])
      const byId = clientsById(dir.clients)
      const none = { count: 0, unread: 0 }
      // The menu leaves out archived Clients, even one with people linked (its people stay linked and its page still opens; it is just not offered).
      const archived = new Set(dir.clients.filter((k) => k.archived).map((k) => k.id))
      const ids = new Set(
        [...dir.clients.map((k) => k.id), ...usage.map((u) => u.clientId)].filter((id) => !archived.has(id)),
      )
      const clients = [...ids].map((id) => {
        const label = clientLabel(id, byId)
        return { id, name: label.name, listed: label.listed, ...(rows.clients[id] ?? none) }
      })
      clients.sort((a, b) => Number(b.listed) - Number(a.listed) || a.name.localeCompare(b.name) || a.id - b.id)
      const loose = drafts.filter((d) => d.conversationId === null).length
      // Only the mailboxes the person is on are listed at all, with their own counts.
      const mine = <T extends { id: string }>(list: readonly T[]): T[] => list.filter((m) => canSee(scope, m.id))
      const myTelegram = mine(telegram)[0]
      return answered({
        views: { ...rows.views, drafts: { ...rows.views.drafts, count: rows.views.drafts.count + loose } },
        mailboxes: mine(boxes).map((m) => ({
          id: m.id,
          name: m.name,
          address: m.address,
          ...(rows.mailboxes[m.id] ?? none),
          lastArrivalAt: orNull(m.lastArrivalAt),
          reason: m.health.reasons[0] ?? null,
        })),
        clients,
        contacts: contacts.length,
        gmailAccounts: mine(gmail).map((g) => ({
          id: g.id,
          name: g.name,
          address: g.address,
          connected: g.connected,
          state: g.state,
          lastPushAt: orNull(g.lastPushAt),
          reason: g.health.reasons[0] ?? null,
        })),
        telegram: myTelegram
          ? {
              id: myTelegram.id,
              name: myTelegram.name,
              address: myTelegram.address,
              ...(rows.mailboxes[myTelegram.id] ?? none),
              state: myTelegram.state,
              checkedInAt: orNull(myTelegram.checkedInAt),
              lastPushAt: orNull(myTelegram.lastPushAt),
            }
          : null,
        jmap: mine(jmap).map((m) => ({
          id: m.id,
          name: m.name,
          address: m.address,
          ...(rows.mailboxes[m.id] ?? none),
          state: m.state,
          lastSyncAt: orNull(m.lastSyncAt),
          reason: m.health.reasons[0] ?? null,
        })),
      })
    })

  // ── Claude's sending ────────────────────────────────────────────────────

  const claudeSending = (asker: SignedIn) =>
    asOwner(asker, async () => answered(claudeSendingOf(await store.call('claudeSending'))))

  const setClaudeSending = (asker: SignedIn, enabled: boolean) =>
    asOwner(asker, async (actor) => {
      if (typeof enabled !== 'boolean') return BAD('Say which: on or off.')
      return reply(await store.call('setClaudeSending', enabled, actor), claudeSendingOf)
    })

  // ── Mailboxes, the spam check, Gmail ────────────────────────────────────

  async function readMailboxes(scope: MailScope): Promise<InboxMailboxes> {
    const [gmail, business, telegram, jmap, usage] = await Promise.all([
      store.call('mailboxStatuses'),
      store.call('cloudflareMailboxes'),
      store.call('telegramMailboxes'),
      store.call('jmapMailboxes'),
      store.call('assistantUsage', null, null),
    ])
    const mine = <T extends { id: string }>(list: readonly T[]): T[] => list.filter((m) => canSee(scope, m.id))
    const myTelegram = mine(telegram)[0]
    return {
      gmailAccounts: mine(gmail).map(gmailOf),
      mailboxes: mine(business).map(businessOf),
      telegram: myTelegram ? telegramOf(myTelegram) : null,
      jmap: mine(jmap).map(jmapOf),
      assistantKey: usage.ok && usage.value.keyConfigured,
      capabilities: [...INBOX_CAPABILITIES],
    }
  }

  const mailboxes = (asker: SignedIn) => asPerson(asker, async ({ scope }) => answered(await readMailboxes(scope)))

  const setSpamCheck = (asker: SignedIn, mailboxId: string, enabled: boolean) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxSpamCheck>> => {
      if (!text(mailboxId) || !MAILBOX_ID.test(mailboxId)) return refused('not-found', 'No such mailbox.')
      if (typeof enabled !== 'boolean') return BAD('Say which: on or off.')
      const set = await store.call('setAssistant', mailboxId, enabled, actor)
      if (!set.ok) return outcomeOf(set)
      // The switch's answer has no count of what was judged; the mailbox's card has, and is what the page draws.
      const now = (await store.call('cloudflareMailboxes')).find((m) => m.id === mailboxId)
      return now
        ? answered(spamCheckOf(now.assistant))
        : answered({
            enabled: set.value.enabled,
            changedAt: ms(set.value.changedAt),
            changedBy: set.value.changedBy,
            judged: 0,
          })
    })

  const changeGmail = (asker: SignedIn, change: InboxGmailChange, mailboxId?: string) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxGmailChanged>> => {
      if (mailboxId !== undefined && (!text(mailboxId) || !MAILBOX_ID.test(mailboxId))) {
        return refused('not-found', 'No such Gmail account.')
      }
      // A mailbox on the mail server is synced from here too (its Sync now): it is declared in the deploy, so there is nothing to connect or disconnect.
      const onMailServer =
        mailboxId !== undefined && (await store.call('jmapMailboxes')).some((m) => m.id === mailboxId)
      if (onMailServer && change === 'sync') {
        return reply(
          await store.call('requestJmapSync', mailboxId),
          (): InboxGmailChanged => ({ change: 'sync', revoked: null }),
        )
      }
      if (onMailServer)
        return BAD('A mailbox on the mail server is declared in the deploy: it can be synced, not disconnected.')
      if (mailboxId !== undefined && (await store.call('mailboxStatus', mailboxId)) === null) {
        return refused('not-found', 'No such Gmail account.')
      }
      if (change === 'sync') {
        return reply(
          await store.call('requestSync', mailboxId),
          (): InboxGmailChanged => ({ change: 'sync', revoked: null }),
        )
      }
      if (change === 'disconnect') {
        if (mailboxId === undefined) return BAD('Say which Gmail account to disconnect.')
        return reply(
          await store.call('disconnectMailbox', mailboxId, actor),
          (done): InboxGmailChanged => ({ change: 'disconnect', revoked: done.revoked }),
        )
      }
      return BAD('Gmail can be synced or disconnected.')
    })

  // ── Connecting Gmail, in the space ────

  /**
   * Step one. The return address is the space's, derived here from the declaration this Worker was built with and never taken from the caller, so a request cannot ask Google
   * to send a code anywhere else (Google would refuse an address the client does not list anyway). The check (`state`) is the space's, kept in its cookie; it is only given its
   * shape here. Nothing is stored: the attempt is the browser's, and a code is good for one exchange.
   */
  const gmailSignIn = (asker: SignedIn, state: string, mailboxId?: string, purpose?: GmailPurpose) =>
    asOwner(asker, async (): Promise<SpaceReply<InboxGmailSignIn>> => {
      if (!deps.install.has('gmail')) return refused('not-found', GMAIL_OFF)
      if (!text(state) || !GMAIL_STATE.test(state))
        return BAD('The sign-in check is a hexadecimal string of 32 to 128 characters.')
      if (purpose !== undefined && !(GMAIL_PURPOSES as readonly unknown[]).includes(purpose))
        return BAD('A sign-in is for mail or for the calendar.')
      // Connecting an account again hints it to Google, so the right one is offered first; a new account hints nothing and Google asks which.
      let loginHint: string | undefined
      if (mailboxId !== undefined) {
        const account =
          text(mailboxId) && MAILBOX_ID.test(mailboxId) ? await store.call('mailboxStatus', mailboxId) : null
        if (account === null) return refused('not-found', 'No such Gmail account.')
        loginHint = account.address
      }
      const clientId = (deps.googleClientId ?? '').trim()
      if (clientId === '') return failed('Gmail sign-in is not set up on this Worker.')
      return answered({
        url: buildAuthUrl({
          clientId,
          redirectUri: gmailReturnUrl(deps.install),
          state,
          loginHint,
          purpose: purpose === 'calendar' ? 'calendar' : 'mail',
        }),
      })
    })

  /** Step two: the inbox's own connection (the same Mailroom method its page's callback calls, so every refusal it has stays), exchanging the code with the space's return address. */
  const gmailConnect = (asker: SignedIn, code: string, purpose?: GmailPurpose) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxGmail>> => {
      if (!deps.install.has('gmail')) return refused('not-found', GMAIL_OFF)
      if (!text(code) || code === '' || code.length > GMAIL_CODE_MAX)
        return BAD('Google sent no usable code, so nothing was connected.')
      if (purpose !== undefined && !(GMAIL_PURPOSES as readonly unknown[]).includes(purpose))
        return BAD('A sign-in is for mail or for the calendar.')
      return reply(
        await store.call(
          'connectMailbox',
          code,
          actor,
          gmailReturnUrl(deps.install),
          purpose === 'calendar' ? 'calendar' : 'mail',
        ),
        gmailOf,
      )
    })

  // ── Notifications ───────────────────────────────────────────────────────

  const notifications = (asker: SignedIn) =>
    asPerson(asker, async ({ actor }): Promise<SpaceReply<InboxNotifications>> => {
      const got = await store.call('notificationSettings', actor)
      if (!got.ok) {
        // The routes answer 503 only when the Worker has no key: that is a state the page names, not a fault.
        if (got.status === 503 && got.error === NOTIFICATIONS_NOT_SET_UP) {
          return answered({ publicKey: null, devices: [], week: { sent: 0, dropped: 0 } })
        }
        return outcomeOf(got)
      }
      return answered({
        publicKey: got.value.publicKey,
        devices: got.value.devices.map(deviceOf),
        week: got.value.week,
      })
    })

  const addDevice = (asker: SignedIn, device: InboxDeviceInput, userAgent: string | null) =>
    asPerson(asker, async ({ actor }): Promise<SpaceReply<InboxDevice>> => {
      if (!isRecord(device)) return BAD('Send the device as the browser gives it.')
      if (userAgent !== null && (!text(userAgent) || userAgent.length > 1000)) return BAD('The user agent is text.')
      const added = await store.call('addDevice', { endpoint: device.endpoint, keys: device.keys }, userAgent, actor)
      return reply(added, deviceOf)
    })

  const removeDevice = (asker: SignedIn, id: string) =>
    asPerson(asker, async ({ actor }): Promise<SpaceReply<{ id: string }>> => {
      if (!text(id) || !ID.test(id)) return refused('not-found', 'No such device.')
      return reply(await store.call('removeDevice', id, actor), (r) => r)
    })

  const testDevice = (asker: SignedIn, id: string) =>
    asPerson(asker, async ({ actor }): Promise<SpaceReply<InboxTestSent>> => {
      if (!text(id) || !ID.test(id)) return refused('not-found', 'No such device.')
      return reply(
        await store.call('sendTestNotification', id, actor),
        (r): InboxTestSent => ({ outcome: r.outcome, status: r.status }),
      )
    })

  // ── Restore: two steps, as the retired inbox page had them ────────────────

  const restoreReport = (asker: SignedIn) =>
    asOwner(
      asker,
      async (): Promise<SpaceReply<InboxRestoreReport>> =>
        reply(
          await store.call('restoreBookmarks', null),
          (r): InboxRestoreReport => ({
            current: r.current,
            restores: r.restores.map((x) => ({
              kind: x.kind,
              id: x.id,
              at: x.at,
              actor: x.actor,
              target: x.target,
              targetTime: x.targetTime,
              undoBookmark: x.undoBookmark,
            })),
            restoresError: r.restoresError,
          }),
        ),
    )

  /** Step one. Changes nothing: it resolves a time or a bookmark and answers the token that step two must send back. */
  const prepareRestore = (asker: SignedIn, choice: InboxRestoreChoice) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxRestorePlan>> => {
      const read = readRestoreChoice(choice)
      if (!read.ok) return read
      const prepared = await store.call('prepareRestore', read.choice, actor)
      return reply(
        prepared,
        (p): InboxRestorePlan => ({
          target: p.target,
          targetTime: p.targetTime,
          token: p.token,
          expiresAt: p.expiresAt,
        }),
      )
    })

  /**
   * Step two: the token and the bookmark sent back, so a restore cannot be made blind or from a stale screen. As the route does, the
   * restart is asked for in a call of its own after the confirmation's answer is in hand, whatever that answer was: the abort it makes
   * rejects the call that asks, and that is the restart happening. Nothing but this method ever asks for it.
   */
  const confirmRestore = (asker: SignedIn, confirm: { token: string; bookmark: string }) =>
    asOwner(asker, async (actor): Promise<SpaceReply<InboxRestoreDone>> => {
      if (
        !isRecord(confirm) ||
        !text(confirm.token) ||
        !text(confirm.bookmark) ||
        confirm.token.length > 200 ||
        confirm.bookmark.length > 300
      ) {
        return BAD('Send back the token and the bookmark the preparation named.')
      }
      const done = await store.call('confirmRestore', { token: confirm.token, bookmark: confirm.bookmark }, actor)
      try {
        await store.call('restartForRestore', actor)
      } catch {
        // The restart is an abort, which rejects the call that asked for it. That is the restart happening.
      }
      return reply(
        done,
        (d): InboxRestoreDone => ({ restoredTo: d.restoredTo, targetTime: d.targetTime, undoBookmark: d.undoBookmark }),
      )
    })

  // ── Clients ─────────────────────────────────────────────────────────────

  const clients = (asker: SignedIn) =>
    asPerson(asker, async ({ scope }): Promise<SpaceReply<InboxClients>> => {
      const [usage, dir] = await Promise.all([
        store.call('clientUsage', scope),
        readClients(deps.clients, deps.install),
      ])
      const byId = clientsById(dir.clients)
      const used = new Map(usage.map((u) => [u.clientId, u]))
      const ids = new Set([...dir.clients.map((k) => k.id), ...usage.map((u) => u.clientId)])
      const list = [...ids].map((id) =>
        summaryOf(clientView(id, byId), used.get(id) ?? { contacts: 0, conversations: 0, open: 0 }),
      )
      list.sort((a, b) => Number(b.listed) - Number(a.listed) || a.name.localeCompare(b.name) || a.id - b.id)
      return answered({ directory: directoryOf(dir), clients: list })
    })

  const client = (asker: SignedIn, id: number) =>
    asPerson(asker, async ({ scope }): Promise<SpaceReply<InboxClientPage>> => {
      if (!isClientId(id)) return refused('not-found', 'No such Client.')
      const [card, dir, usage, candidates] = await Promise.all([
        store.call('clientCard', id, scope),
        readClients(deps.clients, deps.install),
        store.call('clientUsage', scope),
        store.call('suggestionContacts', scope),
      ])
      const byId = clientsById(dir.clients)
      // A Client the part holds, or one the inbox holds people under (whatever the part says now).
      if (dir.available && !byId.has(id) && card.contacts.length === 0) return refused('not-found', 'No such Client.')
      const view = clientView(id, byId)
      const contact = (c: ContactListItem): InboxClientContact => ({
        contactId: c.id,
        name: c.name,
        addresses: addressesOf(c),
      })
      const emails = new Map(candidates.map((c) => [c.id, spelled(c.emails)]))
      return answered({
        directory: directoryOf(dir),
        client: summaryOf(view, usage.find((u) => u.clientId === id) ?? { contacts: 0, conversations: 0, open: 0 }),
        contacts: card.contacts.map(contact),
        suggestions: suggestClients(candidates, dir.clients, ownDomain)
          .filter((s) => s.clientId === id)
          .map((s) => ({
            contactId: s.contactId,
            name: s.contactName,
            addresses: emails.get(s.contactId) ?? [],
            reason: s.reason,
            via: s.via,
          })),
      })
    })

  const linkClient = (asker: SignedIn, contactId: string, clientId: number | null) =>
    asOwner(asker, async (actor): Promise<SpaceReply<{ contactId: string; clientId: number | null }>> => {
      if (!text(contactId) || !ID.test(contactId)) return refused('not-found', 'No such contact.')
      if (clientId !== null && !isClientId(clientId)) return BAD('Say which Client, or null to take the contact out.')
      if (clientId !== null) {
        // A contact must never point at a Client the part has not confirmed (as the route checks it). Nothing here waits on a Client's source.
        const checked = checkLink(await readClients(deps.clients, deps.install), clientId)
        if (!checked.ok) return checked.why === 'down' ? refused('conflict', checked.error) : BAD(checked.error)
      }
      const done = await store.call('assignClient', contactId, clientId, actor)
      return reply(done, (c) => ({ contactId, clientId: c.clientId }))
    })

  // ── The draft chat ──────────────────────────────────────────────────────

  const draftChat = (asker: SignedIn, conversationId: string, draftId: string) =>
    asPerson(asker, async ({ scope, owner: isOwner }): Promise<SpaceReply<InboxChatTurn[]>> => {
      // The draft chat spends the install's model money and is the owner's for now, as the rest of what changes the setup is; the conversation is still checked against what the owner may see.
      if (!isOwner) return refused('not-admitted', NOT_ADMITTED)
      if (!text(conversationId) || !ID.test(conversationId)) return refused('not-found', 'No such conversation.')
      if (!text(draftId) || !ID.test(draftId)) return refused('not-found', 'No such draft.')
      if (!(await seesConversation(deps, scope, conversationId))) return refused('not-found', 'No such conversation.')
      const found = await store.call('getConversation', conversationId)
      if (!found.ok) return outcomeOf(found)
      const draft = found.value.drafts.find((d) => d.id === draftId)
      return draft ? answered((draft.chat ?? []).map(turnOf)) : refused('not-found', 'No such draft.')
    })

  const chat = (asker: SignedIn, asked: InboxChat) =>
    asPerson(asker, async ({ actor, scope, owner: isOwner }): Promise<SpaceReply<InboxChatAnswer>> => {
      if (!isOwner) return refused('not-admitted', NOT_ADMITTED)
      if (!isRecord(asked)) return BAD('A chat turn names a draft, the revision you were shown, and your words.')
      const { conversationId, draftId, rev, instruction } = asked
      if (!text(conversationId) || !ID.test(conversationId)) return refused('not-found', 'No such conversation.')
      if (!text(draftId) || !ID.test(draftId)) return refused('not-found', 'No such draft.')
      if (!(await seesConversation(deps, scope, conversationId))) return refused('not-found', 'No such conversation.')
      if (!isCount(rev)) return BAD('Say which revision of the draft you were shown (rev).')
      if (!text(instruction) || instruction.length > MOST_TEXT) return BAD('Say what you want the assistant to do.')
      // No `body` or `subject`: the space chats about the draft as the inbox holds it, and never saves words on its behalf.
      const answer = await store.call('chat', conversationId, { instruction, draftId, rev }, actor)
      return reply(
        answer,
        (a): InboxChatAnswer => ({
          draftId: a.draft.id,
          rev: a.draft.rev,
          text: a.draft.body,
          subject: a.draft.subject,
          turn: turnOf(a.turn),
        }),
      )
    })

  return {
    navigation,
    claudeSending,
    setClaudeSending,
    mailboxes,
    setSpamCheck,
    changeGmail,
    gmailSignIn,
    gmailConnect,
    notifications,
    addDevice,
    removeDevice,
    testDevice,
    restoreReport,
    prepareRestore,
    confirmRestore,
    clients,
    client,
    linkClient,
    draftChat,
    chat,
  }
}
