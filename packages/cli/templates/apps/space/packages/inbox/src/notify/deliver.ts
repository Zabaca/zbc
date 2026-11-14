import { onlyOwnerNotifications } from '../owner-words'
import { canSee, type MailScope } from '../queue'
import type { DeviceWithKeys, MailStore, OwedNotification } from '../store/mail'
import { personKey } from '../store/people'
import { fail, ok, type Result } from '../store/store'
import {
  type DeliveryOutcome,
  type Device,
  isAgent,
  NOTIFICATIONS_NOT_SET_UP,
  type NotificationPayload,
  type NotificationSettings,
} from '../types'
import { bytesOf } from './base64url'
import { checkDevice, deviceLabel, isPushEndpoint } from './device'
import { COLLAPSE_AFTER, fresh, messagePayload, NOTIFY_WINDOW_S, summaryPayload, testPayload } from './rule'
import { encryptPayload, type VapidKey, type VapidTokens, vapidAuthorization } from './webpush'

/**
 * Notifications, from the Worker's side: turning devices on and off for Settings, the test notification, and handing
 * the notifications the sync marked owed to every device. Which mail is owed one is decided elsewhere (src/notify/rule.ts, asked by the store as mail is stored); this
 * only delivers. Why delivery is one attempt, why it fails closed with no key, and what replacing the key does are
 * in the inbox's ADR 0001.
 *
 * The push service is a port shaped like the Gmail module: `fetch` in production, with a timeout, because delivery
 * runs inside the Mailroom's one-at-a-time chain and a push service that never answers must not hold up the next sync;
 * a fake in tests; and in `vite dev` a stand-in that answers 201 and calls nothing (src/dev.ts). What an answer means
 * is decided in ONE place, `outcomeOf`. The log names the message's id, the device's id and the outcome, never the
 * sender or the subject.
 */

/** One request to a push service. Throws when there is no answer at all. */
export interface PushPort {
  send(endpoint: string, init: { headers: Record<string, string>; body: Uint8Array }): Promise<{ status: number }>
}

/** How long a request to a push service may take before it counts as no answer. */
export const PUSH_TIMEOUT_MS = 10_000

/** The push service over `fetch`: one POST, and its status; a request past `timeoutMs` is aborted (no answer). */
export function pushOverFetch(
  send: (url: string, init: RequestInit) => Promise<Response>,
  timeoutMs = PUSH_TIMEOUT_MS,
): PushPort {
  return {
    async send(endpoint, init) {
      const res = await send(endpoint, {
        method: 'POST',
        headers: init.headers,
        body: init.body as BodyInit,
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Read and discarded, so the connection is released; what the service says is in the status.
      await res.arrayBuffer().catch(() => undefined)
      return { status: res.status }
    },
  }
}

/** How long a push service keeps a notification for a device that is off: the freshness window, one constant. */
export const PUSH_TTL_S = NOTIFY_WINDOW_S

/** How far back Settings counts the notifications sent and dropped. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What a push service's answer means, in one place:
 *   201 or 202 (any 2xx): delivered;
 *   404 or 410: gone, the browser dropped this device (uninstalled, site data cleared, permission taken back);
 *   400, 401 or 403: refused, most often a key that is not the one the device turned on with;
 *   413: too large, which the length limits make impossible;
 *   429, a 5xx, anything else, or no answer: failed.
 */
export function outcomeOf(status: number | null): DeliveryOutcome {
  if (status === null) return 'failed'
  if (status >= 200 && status < 300) return 'delivered'
  if (status === 404 || status === 410) return 'gone'
  if (status === 400 || status === 401 || status === 403) return 'refused'
  if (status === 413) return 'too-large'
  return 'failed'
}

/** What a device's last failure says in Settings. */
function failureText(outcome: DeliveryOutcome, status: number | null): string {
  if (outcome === 'refused')
    return `The push service refused the notification (${status}). Turn notifications on again on this device.`
  if (outcome === 'too-large') return `The push service said the notification was too large (${status}).`
  if (status === null) return 'The push service did not answer.'
  return `The push service did not take the notification (${status}).`
}

export interface NotificationsPorts {
  store: MailStore
  push: PushPort
  /** Null when the Worker has no key: then every route is 503 and nothing is sent. */
  key: VapidKey | null
  now: () => Date
}

export class Notifications {
  constructor(private readonly ports: NotificationsPorts) {}

  /** Settings' Notifications section: the public key a browser turns notifications on with, and every device. */
  notificationSettings(actor: string): Result<NotificationSettings> {
    if (isAgent(actor)) return fail(403, onlyOwnerNotifications(this.ports.store.owner.name))
    if (!this.ports.key) return fail(503, NOTIFICATIONS_NOT_SET_UP)
    const since = new Date(this.ports.now().getTime() - WEEK_MS).toISOString()
    // A person's own devices, and the week's numbers over the mail they may see.
    return ok({
      publicKey: this.ports.key.publicKey,
      devices: this.ports.store.listDevices(actor),
      week: this.ports.store.notifiedSince(since, this.ports.store.mailScope(actor)),
    })
  }

  /** A browser turned notifications on: the device as it hands it over, checked, added or updated by its push address. */
  addDevice(body: Record<string, unknown>, userAgent: string | null, actor: string): Result<Device> {
    if (isAgent(actor)) return fail(403, onlyOwnerNotifications(this.ports.store.owner.name))
    if (!this.ports.key) return fail(503, NOTIFICATIONS_NOT_SET_UP)
    const checked = checkDevice(body)
    if (!checked.ok) return fail(422, checked.error)
    return this.ports.store.addDevice({ ...checked.value, label: deviceLabel(userAgent) }, actor)
  }

  removeDevice(id: string, actor: string): Result<{ id: string }> {
    if (isAgent(actor)) return fail(403, onlyOwnerNotifications(this.ports.store.owner.name))
    if (!this.ports.key) return fail(503, NOTIFICATIONS_NOT_SET_UP)
    return this.ports.store.removeDevice(id, actor)
  }

  /** The test notification, to one device, now: not through the owed marks. Answers what the push service said. */
  async sendTestNotification(
    id: string,
    actor: string,
  ): Promise<Result<{ outcome: DeliveryOutcome; status: number | null }>> {
    if (isAgent(actor)) return fail(403, onlyOwnerNotifications(this.ports.store.owner.name))
    const key = this.ports.key
    if (!key) return fail(503, NOTIFICATIONS_NOT_SET_UP)
    const device = this.ports.store.deviceWithKeys(id)
    // A device is its person's: someone else's is not told apart from one that is not there.
    if (!device || device.owner !== personKey(actor)) return fail(404, 'No such device.')
    return ok(await this.deliverTo(key, device, testPayload(this.ports.now(), this.ports.store.owner.company)))
  }

  /**
   * Hand every owed notification on. One past the hour, or with no key or no device to go to, is marked dropped. Of
   * the rest, up to COLLAPSE_AFTER go to every device one by one; more than that go as ONE summary to every device
   * (so a burst is one buzz, not a pile), and every one of them is marked sent, so none is sent on its own later.
   *
   * A notification goes only to the devices of people who may see its mail (the inbox's ADR 0004: `canSee`, src/queue.ts, over the mailbox of the message, for the
   * person each device is for), so a device is told of the mail of its person's mailboxes and no other. The devices owed the same notifications (all of them, where one person is on every mailbox, as the owner is
   * where the owner is on all of them) are handled together; a device with a different set is handed its own, and a notification is marked sent once every device that was owed it has been handed it.
   */
  async deliverOwed(): Promise<void> {
    // One delivery at a time. Two callers (the Gmail sync's, and a business mailbox's arrival) can reach this while the Durable Object is
    // waiting on a push service, and both would read the same owed list before either marked one sent: a double notification.
    const run = this.delivering.then(() => this.deliverOwedNow())
    this.delivering = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private delivering: Promise<void> = Promise.resolve()

  /** The tokens signed so far, so a push service is not sent a new one for every notification (webpush.ts `VAPID_REUSE_S`). */
  private readonly vapidTokens: VapidTokens = new Map()

  /** Whether a device's person may see a notification's mail (`canSee`, src/queue.ts, over the mailbox of its message): what each person may see is asked of the store once per person, and each message's mailbox once. */
  private audienceOf(owed: readonly OwedNotification[]): (device: DeviceWithKeys, n: OwedNotification) => boolean {
    const scopes = new Map<string, MailScope>()
    const scopeOf = (person: string): MailScope => {
      const held = scopes.get(person) ?? this.ports.store.mailScope(person)
      scopes.set(person, held)
      return held
    }
    const mailboxes = new Map(
      owed.map((n) => [n.messageId, this.ports.store.mailboxOfMessage(n.messageId)?.mailboxId ?? null] as const),
    )
    return (device, n) => canSee(scopeOf(device.owner), mailboxes.get(n.messageId) ?? null)
  }

  /** The devices owed the same notifications, together, each group with what it is owed: all the devices of one person, or of several who may see the same mail. */
  private groupByAudience(
    devices: readonly DeviceWithKeys[],
    due: readonly OwedNotification[],
    seenBy: (device: DeviceWithKeys, n: OwedNotification) => boolean,
  ): { devices: DeviceWithKeys[]; owed: OwedNotification[] }[] {
    const groups = new Map<string, { devices: DeviceWithKeys[]; owed: OwedNotification[] }>()
    for (const device of devices) {
      const mine = due.filter((n) => seenBy(device, n))
      if (mine.length === 0) continue
      const signature = mine.map((n) => n.messageId).join(',')
      const group = groups.get(signature) ?? { devices: [], owed: mine }
      group.devices.push(device)
      groups.set(signature, group)
    }
    return [...groups.values()]
  }

  private async deliverOwedNow(): Promise<void> {
    const owed = this.ports.store.owedNotifications()
    if (owed.length === 0) return
    const key = this.ports.key
    const now = this.ports.now()
    const devices = key ? this.ports.store.deviceKeys() : []
    const seenBy = this.audienceOf(owed)
    const due = owed.filter((n) => {
      const anyone = devices.some((d) => seenBy(d, n))
      if (key && anyone && fresh(n.receivedAt, now)) return true
      this.ports.store.markNotified(n.messageId, 'dropped')
      console.warn(
        `notify: message ${n.messageId} dropped (${!key ? 'no key' : !anyone ? 'no device' : 'past the hour'})`,
      )
      return false
    })
    if (!key || due.length === 0) return
    const groups = this.groupByAudience(devices, due, seenBy)
    // A notification is marked sent once the last group that was owed it has been handed it.
    const waiting = new Map<string, number>()
    for (const group of groups)
      for (const n of group.owed) waiting.set(n.messageId, (waiting.get(n.messageId) ?? 0) + 1)
    const handed = (n: OwedNotification): void => {
      const left = (waiting.get(n.messageId) ?? 1) - 1
      waiting.set(n.messageId, left)
      if (left === 0) this.ports.store.markNotified(n.messageId, 'sent')
    }
    for (const group of groups) await this.deliverGroup(key, group, now, handed)
  }

  /**
   * One group of devices is handed what it is owed. EVERY DEVICE IS THE SPACE'S (the inbox's own installed app is gone): one payload per notification, and a tap opens the
   * conversation in the space (rule.ts `messagePayload`); more than COLLAPSE_AFTER are one summary, which has no conversation. A device the push service says is gone is not sent the rest.
   */
  private async deliverGroup(
    key: VapidKey,
    group: { devices: DeviceWithKeys[]; owed: OwedNotification[] },
    now: Date,
    handed: (n: OwedNotification) => void,
  ): Promise<void> {
    let reach = group.devices
    const collapsed = group.owed.length > COLLAPSE_AFTER
    const payloads = collapsed ? [summaryPayload(group.owed, now)] : group.owed.map((n) => messagePayload(n))
    for (const payload of payloads) {
      const gone = new Set<string>()
      for (const device of reach) {
        if ((await this.deliverTo(key, device, payload)).outcome === 'gone') gone.add(device.id)
      }
      reach = reach.filter((d) => !gone.has(d.id))
      for (const n of group.owed) if (payload.kind === 'summary' || n.messageId === payload.messageId) handed(n)
    }
  }

  /** One request to one device, its answer recorded on the device. Never throws. */
  private async deliverTo(
    key: VapidKey,
    device: DeviceWithKeys,
    payload: NotificationPayload,
  ): Promise<{ outcome: DeliveryOutcome; status: number | null }> {
    let status: number | null = null
    let detail: string
    try {
      // Checked when the device was added; checked again here, so nothing can make the Worker call another address.
      if (!isPushEndpoint(device.endpoint)) throw new Error('not a push service')
      const uaPublic = bytesOf(device.p256dh)
      const authSecret = bytesOf(device.auth)
      if (!uaPublic || !authSecret) throw new Error('the device keys are unreadable')
      const body = await encryptPayload({
        plaintext: new TextEncoder().encode(JSON.stringify(payload)),
        uaPublic,
        authSecret,
      })
      const answer = await this.ports.push.send(device.endpoint, {
        headers: {
          Authorization: await vapidAuthorization(
            key,
            device.endpoint,
            this.ports.now().getTime(),
            this.ports.store.owner.spaceOrigin,
            this.vapidTokens,
          ),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(PUSH_TTL_S),
          // So a phone delivers it promptly when idle (Android's Doze, Apple's power-saving: both push services take this header). No Topic header: a Topic is readable by the push service.
          Urgency: 'high',
        },
        body,
      })
      status = answer.status
      detail = `status ${status}`
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    const outcome = outcomeOf(status)
    const log = `notify: message ${payload.messageId} to device ${device.id}: ${outcome} (${detail})`
    if (outcome === 'too-large') console.error(`${log}: a bug, the payload's limits should make this impossible`)
    else if (outcome !== 'delivered') console.warn(log)
    this.ports.store.recordDelivery(
      device.id,
      outcome,
      outcome === 'delivered' || outcome === 'gone' ? detail : failureText(outcome, status),
    )
    return { outcome, status }
  }
}
