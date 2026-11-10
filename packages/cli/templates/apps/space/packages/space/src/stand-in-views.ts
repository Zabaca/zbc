// Stand-ins for the inbox's other views: what `bun test` asks instead of the real inbox, and what a local page shows with fixture data
// (`SPACE_FIXTURES`, src/app.ts) so Settings can be seen and photographed without it.
//
// They keep the shape of the real answers (packages/workspace/src/inbox-views.ts) and the rules the page leans on: a restore is two steps with a token that must come back with
// the bookmark, a device is added as the space's. They check nothing about who is asking: the real inbox does, and the space's own tests prove
// the asker is passed along (`asked.askers`). Every call is recorded, so a test can see what was and was not sent.

import {
  type Client,
  type SignedIn,
  GMAIL_STATE,
  INBOX_CAPABILITIES,
  NOT_ADMITTED,
  type InboxBusinessMailbox,
  type InboxClaudeSending,
  type InboxClientContact,
  type InboxClientPage,
  type InboxClients,
  type InboxClientSummary,
  type InboxDevice,
  type InboxForSpace,
  type InboxGmail,
  type InboxGmailChanged,
  type InboxGmailSignIn,
  type InboxJmap,
  type InboxMailbox,
  type InboxRestoreDone,
  type InboxRestorePlan,
  type InboxRestoreRecord,
  type InboxTelegram,
  type InboxTestSent,
  type SpaceReply,
  answered,
  failed,
  refused,
} from '@space/workspace'

export type StandInViewMethods = Pick<
  InboxForSpace,
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
>

export interface StandInClient {
  summary: InboxClientSummary
  contacts: InboxClientContact[]
  suggestions: (InboxClientContact & { reason: 'address' | 'domain'; via: string })[]
}

/** What the stand-in holds; a test or the fixtures set it, and the methods change it as the real inbox would. */
export interface StandInViewState {
  claudeSending: InboxClaudeSending
  gmailAccounts: InboxGmail[]
  mailboxes: InboxBusinessMailbox[]
  /** The Telegram bridge's mailbox: absent is an inbox that predates it, null is one the bridge has not spoken to. */
  telegram?: InboxTelegram | null
  /** The mailboxes on the mail server: absent is an inbox that predates them. */
  jmap?: InboxJmap[]
  assistantKey: boolean
  /** Null: the inbox has no key, so nothing can be turned on. */
  publicKey: string | null
  devices: InboxDevice[]
  current: string
  restores: InboxRestoreRecord[]
  clients: StandInClient[]
  directoryAvailable: boolean
  /** What this inbox says it can do (`INBOX_CAPABILITIES`); left out of the answer when undefined, as an inbox that predates capabilities leaves it out. */
  capabilities?: string[]
}

export interface StandInViews {
  /** Every call, by method and its arguments after the asker. */
  calls: { method: string; args: unknown[]; asker?: SignedIn }[]
  state: StandInViewState
  /** What the next view call does instead of the normal thing: `throw` (the binding fails), `hang` (never answers), `broken` (a fault). */
  script: ('throw' | 'hang' | 'broken')[]
  methods: StandInViewMethods
  /** The Clients as the stand-in inbox shows them (the Clients part's, when it was given one), for the stand-in inbox's menu. */
  clientList(): StandInClient[]
}

export const mailboxMark = (m: InboxMailbox): InboxMailbox => ({ id: m.id, name: m.name, address: m.address })

export function emptyViewState(): StandInViewState {
  return {
    claudeSending: { enabled: false, changedAt: null },
    gmailAccounts: [],
    mailboxes: [],
    assistantKey: true,
    publicKey: null,
    devices: [],
    current: 'bookmark-0001-now',
    restores: [],
    clients: [],
    directoryAvailable: true,
    capabilities: [...INBOX_CAPABILITIES],
  }
}

/** Where the stand-in says Google returns to: the space's, as the real inbox derives it from the declaration (`gmailReturnUrl`; pinned in packages/workspace/test/space-contract.test.ts). */
export const STAND_IN_GMAIL_RETURN = 'https://space.northfield.example/api/inbox/gmail/callback'

/** The address the person signs in with, as the stand-in tells Tessa from someone else. The real inbox applies its owner rule to the person the space's check named; this only mirrors it. */
function emailOf(a: SignedIn): string | null {
  return a.person.signIn
}

/**
 * Where the stand-in inbox looks for the Clients when it is given the Clients part (stand-in-clients.ts): the list the part holds, and who a person is (their name and addresses, for a Client's page). Left out, the Clients are only `state.clients`, as a test that draws no Clients part has them.
 */
export interface StandInClientsLink {
  list(): Client[]
  person(contactId: string): { name: string; addresses: string[] } | undefined
}

export function standInViews(initial: Partial<StandInViewState> = {}, options: { now?: () => number; clients?: StandInClientsLink } = {}): StandInViews {
  const state: StandInViewState = { ...emptyViewState(), ...initial }
  const calls: StandInViews['calls'] = []
  const script: StandInViews['script'] = []
  const now = options.now ?? Date.now
  let ids = 0
  const nextId = (prefix: string) => `${prefix}-${++ids}`
  /** The codes Google has accepted once: it accepts each once, so a second use is `invalid_grant`. */
  const spentCodes = new Set<string>()
  let pending: { token: string; target: string; expiresAt: string } | null = null

  /** Record the call, and do what the script says the next one does. Returns a reply to give instead, or null to carry on. */
  async function enter<T>(asker: SignedIn, method: string, args: unknown[]): Promise<SpaceReply<T> | null> {
    calls.push({ method, args, asker })
    const step = script.shift()
    if (step === 'throw') throw new Error('stand-in inbox lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    if (step === 'broken') return failed('The inbox could not answer that. Nothing was changed.')
    return null
  }

  const part = options.clients

  /** A Client of the part as the inbox's views summarise it, with the counts of the entry the stand-in holds for it, if any. */
  function summaryOf(c: Client, entry: StandInClient | undefined): InboxClientSummary {
    return {
      id: c.number,
      name: c.name,
      listed: true,
      legalEntity: c.legalName,
      contacts: entry?.summary.contacts ?? 0,
      conversations: entry?.summary.conversations ?? 0,
      open: entry?.summary.open ?? 0,
      adminUrl: c.source?.url ?? null,
      archived: c.archivedAt !== null,
    }
  }

  /** The Clients the stand-in inbox shows: the part's own (name, legal name, archived and address from the part, people from the entry) plus any number only its people hold. Without a part, `state.clients`. */
  function withPart(): StandInClient[] {
    if (!part) return state.clients
    const held = part.list().map((c): StandInClient => {
      const entry = state.clients.find((e) => e.summary.id === c.number)
      return { summary: summaryOf(c, entry), contacts: entry?.contacts ?? [], suggestions: entry?.suggestions ?? [] }
    })
    const numbers = new Set(held.map((c) => c.summary.id))
    return [...held, ...state.clients.filter((e) => !numbers.has(e.summary.id))]
  }

  const methods: StandInViewMethods = {
    async claudeSending(a: SignedIn) {
      return (await enter(a, 'claudeSending', [])) ?? answered(state.claudeSending)
    },
    async setClaudeSending(a, enabled) {
      const early = await enter<InboxClaudeSending>(a, 'setClaudeSending', [enabled])
      if (early) return early
      state.claudeSending = { enabled, changedAt: now() }
      return answered(state.claudeSending)
    },
    async mailboxes(a) {
      return (await enter(a, 'mailboxes', [])) ?? answered({ gmailAccounts: state.gmailAccounts, mailboxes: state.mailboxes, ...(state.telegram !== undefined && { telegram: state.telegram }), ...(state.jmap !== undefined && { jmap: state.jmap }), assistantKey: state.assistantKey, ...(state.capabilities !== undefined && { capabilities: state.capabilities }) })
    },
    async setSpamCheck(a, mailboxId, enabled) {
      const early = await enter<InboxBusinessMailbox['spamCheck']>(a, 'setSpamCheck', [mailboxId, enabled])
      if (early) return early
      const box = state.mailboxes.find((m) => m.id === mailboxId)
      if (!box) return refused('not-found', 'No such mailbox.')
      box.spamCheck = { ...box.spamCheck, enabled, changedAt: now(), changedBy: 'tessa@northfield.example' }
      return answered(box.spamCheck)
    },
    async changeGmail(a, change, mailboxId) {
      const early = await enter<InboxGmailChanged>(a, 'changeGmail', [change, mailboxId])
      if (early) return early
      // A mailbox on the mail server is synced from here too; it is declared in the deploy, so it is not disconnected.
      const onServer = mailboxId === undefined ? undefined : state.jmap?.find((m) => m.id === mailboxId)
      if (onServer) {
        if (change === 'disconnect') return refused('bad-request', 'A mailbox on the mail server is declared in the deploy: it can be synced, not disconnected.')
        if (onServer.state === 'refused' || !onServer.declared) return refused('conflict', onServer.reasons[0] ?? 'That mailbox is not synced.')
        return answered({ change, revoked: null })
      }
      const account = mailboxId === undefined ? undefined : state.gmailAccounts.find((g) => g.id === mailboxId)
      if (mailboxId !== undefined && !account) return refused('not-found', 'No such Gmail account.')
      if (change === 'disconnect') {
        if (!account) return refused('bad-request', 'Say which Gmail account to disconnect.')
        if (!account.connected) return refused('conflict', 'That Gmail account is not connected.')
        state.gmailAccounts = state.gmailAccounts.map((g) => (g === account ? { ...g, connected: false, state: 'disconnected', lapsedAt: null, reasons: [] } : g))
        return answered({ change, revoked: true })
      }
      if (account ? !account.connected || account.state === 'lapsed' : !state.gmailAccounts.some((g) => g.connected && g.state !== 'lapsed')) return refused('conflict', 'Gmail is not connected.')
      return answered({ change, revoked: null })
    },
    async gmailSignIn(a, check, mailboxId, purpose) {
      const early = await enter<InboxGmailSignIn>(a, 'gmailSignIn', [check, mailboxId, purpose])
      if (early) return early
      const who = emailOf(a)
      if (who !== null && who !== 'tessa@northfield.example') return refused('not-admitted', NOT_ADMITTED)
      if (!GMAIL_STATE.test(check)) return refused('bad-request', 'The sign-in check is a hexadecimal string of 32 to 128 characters.')
      const hint = mailboxId === undefined ? undefined : state.gmailAccounts.find((g) => g.id === mailboxId)
      if (mailboxId !== undefined && !hint) return refused('not-found', 'No such Gmail account.')
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.searchParams.set('client_id', 'client-id.apps.googleusercontent.com')
      url.searchParams.set('redirect_uri', STAND_IN_GMAIL_RETURN)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', purpose === 'calendar' ? 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events' : 'https://www.googleapis.com/auth/gmail.modify openid email')
      url.searchParams.set('state', check)
      if (hint) url.searchParams.set('login_hint', hint.address)
      return answered({ url: url.toString() })
    },
    async gmailConnect(a, code, purpose) {
      const early = await enter<InboxGmail>(a, 'gmailConnect', [code, purpose])
      if (early) return early
      const who = emailOf(a)
      if (who !== null && who !== 'tessa@northfield.example') return refused('not-admitted', NOT_ADMITTED)
      if (!code.startsWith('good-code') || spentCodes.has(code)) return failed('Google would not complete the sign-in: invalid_grant: Bad Request Try connecting again.')
      spentCodes.add(code)
      // `good-code` is Tessa's own account; `good-code-<n>:<address>` is the account that signed in (a code is good once, hence the number). Any address is connected, and one already held has its lapse ended.
      const address = /^good-code[\w-]*:(.+)$/.exec(code)?.[1] ?? 'tessa@northfield.example'
      const held = state.gmailAccounts.find((g) => g.address === address)
      const made: InboxGmail = {
        id: held?.id ?? `gmail-${address.split('@')[1]?.split('.')[0] ?? 'account'}-${state.gmailAccounts.length + 1}`,
        address,
        name: held?.name ?? (address.endsWith('@gmail.com') ? address.split('@')[0] : address.split('@')[1]?.split('.')[0]) ?? address,
        connected: true,
        state: 'filling',
        lapsedAt: null,
        lastPushAt: null,
        lastSyncAt: null,
        watchExpiry: now() + 7 * 24 * 60 * 60 * 1000,
        messages: held?.messages ?? 0,
        conversations: held?.conversations ?? 0,
        open: held?.open ?? 0,
        unreadOpen: held?.unreadOpen ?? 0,
        reasons: [],
      }
      state.gmailAccounts = held ? state.gmailAccounts.map((g) => (g === held ? made : g)) : [...state.gmailAccounts, made]
      return answered(made)
    },
    async notifications(a) {
      return (await enter(a, 'notifications', [])) ?? answered({ publicKey: state.publicKey, devices: state.devices, week: { sent: 12, dropped: 1 } })
    },
    async addDevice(a, device, userAgent) {
      const early = await enter<InboxDevice>(a, 'addDevice', [device, userAgent])
      if (early) return early
      if (!state.publicKey) return failed('Notifications are not set up on the inbox: the Worker has no key to send with.')
      const held = state.devices.find((d) => d.endpoint === device.endpoint)
      const made: InboxDevice = {
        id: held?.id ?? nextId('device'),
        label: /Android/.test(userAgent ?? '') ? 'Chrome on Android' : 'Chrome on macOS',
        origin: 'space',
        endpoint: device.endpoint,
        addedAt: now(),
        lastDeliveredAt: null,
        lastFailedAt: null,
        lastFailure: null,
        refused: false,
        delivered: 0,
        failed: 0,
      }
      state.devices = [...state.devices.filter((d) => d.endpoint !== device.endpoint), made]
      return answered(made)
    },
    async removeDevice(a, id) {
      const early = await enter<{ id: string }>(a, 'removeDevice', [id])
      if (early) return early
      if (!state.devices.some((d) => d.id === id)) return refused('not-found', 'No such device.')
      state.devices = state.devices.filter((d) => d.id !== id)
      return answered({ id })
    },
    async testDevice(a, id) {
      const early = await enter<InboxTestSent>(a, 'testDevice', [id])
      if (early) return early
      return state.devices.some((d) => d.id === id) ? answered({ outcome: 'delivered' as const, status: 201 }) : refused('not-found', 'No such device.')
    },
    async restoreReport(a) {
      return (await enter(a, 'restoreReport', [])) ?? answered({ current: state.current, restores: state.restores, restoresError: null })
    },
    async prepareRestore(a, choice) {
      const early = await enter<InboxRestorePlan>(a, 'prepareRestore', [choice])
      if (early) return early
      const target = 'bookmark' in choice ? choice.bookmark : 'bookmark-0000-for-that-time'
      pending = { token: `token-${++ids}`, target, expiresAt: new Date(now() + 5 * 60_000).toISOString() }
      return answered({ target, targetTime: 'time' in choice ? choice.time : null, token: pending.token, expiresAt: pending.expiresAt })
    },
    async confirmRestore(a, confirm) {
      const early = await enter<InboxRestoreDone>(a, 'confirmRestore', [confirm])
      if (early) return early
      if (!pending || pending.token !== confirm.token) return refused('conflict', 'There is no restore waiting for that confirmation.')
      if (pending.target !== confirm.bookmark) return refused('bad-request', 'That is not the bookmark the preparation named.')
      const done = { restoredTo: pending.target, targetTime: null, undoBookmark: 'bookmark-0002-undo' }
      state.restores = [{ kind: 'restored', id: nextId('restore'), at: new Date(now()).toISOString(), actor: 'tessa@northfield.example', target: pending.target, targetTime: null, undoBookmark: done.undoBookmark }, ...state.restores]
      pending = null
      return answered(done)
    },
    async clients(a) {
      return (await enter(a, 'clients', [])) ?? answered<InboxClients>({ directory: { available: state.directoryAvailable, error: state.directoryAvailable ? null : 'The Client list did not answer, so Clients show by number.' }, clients: withPart().map((c) => c.summary) })
    },
    async client(a, id) {
      const early = await enter<InboxClientPage>(a, 'client', [id])
      if (early) return early
      const found = withPart().find((c) => c.summary.id === id)
      if (!found) return refused('not-found', 'No such Client.')
      return answered({ directory: { available: state.directoryAvailable, error: null }, client: found.summary, contacts: found.contacts, suggestions: found.suggestions })
    },
    async linkClient(a, contactId, clientId) {
      const early = await enter<{ contactId: string; clientId: number | null }>(a, 'linkClient', [contactId, clientId])
      if (early) return early
      // With the Clients part given, the link is checked against it as the real inbox checks it: a Client it does not hold, or holds archived, is refused with a sentence.
      if (clientId !== null && part) {
        const held = part.list().find((c) => c.number === clientId)
        if (!held) return refused('bad-request', `There is no Client ${clientId}, so nothing was assigned.`)
        if (held.archivedAt !== null) return refused('bad-request', `${held.name} is archived, so nothing was assigned. Put it back in Settings first.`)
      }
      if (part) {
        // The person moves from the Client they were under to the new one, in the Clients' own pages.
        for (const c of state.clients) c.contacts = c.contacts.filter((x) => x.contactId !== contactId)
        if (clientId !== null) {
          const who = part.person(contactId)
          let entry = state.clients.find((c) => c.summary.id === clientId)
          if (!entry) {
            const held = part.list().find((c) => c.number === clientId) as Client
            entry = { summary: summaryOf(held, undefined), contacts: [], suggestions: [] }
            state.clients.push(entry)
          }
          if (who) entry.contacts.push({ contactId, name: who.name, addresses: who.addresses })
        }
        for (const c of state.clients) {
          c.suggestions = c.suggestions.filter((x) => x.contactId !== contactId)
          c.summary = { ...c.summary, contacts: c.contacts.length }
        }
        return answered({ contactId, clientId })
      }
      for (const c of state.clients) {
        const s = c.suggestions.find((x) => x.contactId === contactId)
        if (s && c.summary.id === clientId) {
          c.suggestions = c.suggestions.filter((x) => x !== s)
          c.contacts.push({ contactId: s.contactId, name: s.name, addresses: s.addresses })
          c.summary = { ...c.summary, contacts: c.summary.contacts + 1 }
        }
      }
      return answered({ contactId, clientId })
    },
  }

  return { calls, state, script, methods, clientList: withPart }
}
