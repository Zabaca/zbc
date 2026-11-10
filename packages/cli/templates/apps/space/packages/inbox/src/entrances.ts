import type { StoreApi } from './app'
import type { RawBucket } from './cloudflare/arrivals'
import { type DeclaredMailbox, parseDeclared } from './cloudflare/declared'
import { type Entered, type InboundEmail, receiveEmail } from './cloudflare/entrance'
import { inboxOwnerOf } from './owner'
import { bundledInstall } from './workspace'

/**
 * The inbox's machine entrances, as functions over a store: what Cloudflare Email Routing, Cloudflare Queues and Cloudflare's cron call, and nothing of Gmail's push (src/push-door.ts).
 *
 * They run in the space's Worker (packages/space/src/worker.ts hands them its store), not in a Worker of the inbox's own. They are a file of their own, with no import of the Workers runtime, so `bun test` drives them.
 *
 * ── THE ALARM AND THE CRON ───────────────────────────────────────────────
 * Nothing polls Gmail. A push sets the Durable Object's alarm to now, and the alarm (`alarm()` in src/durable.ts) does the work, so a push is answered before any of it
 * starts. Mail Cloudflare delivers is filed in the request, and so is its spam check; only a filing that failed is owed work, which the same alarm retries. The daily cron is
 * only the safety net: it renews Gmail's watch (it lapses after seven days) and runs one sync from the cursor. Mail does not arrive through it.
 */

/** The cron expression of the daily pass (`triggers.crons` in the Worker's settings (kit/worker-settings.ts), beside meet's five-minute sweep). 09:47 UTC is a quiet hour in Pacific time and an off-the-hour minute. */
export const DAILY_CRON = '47 9 * * *'

/**
 * The Cloudflare mailboxes this deployment declares. A declaration that is not valid declares none, and says why: every
 * arrival is then refused, which is loud (the sender is told, and the log says why) and never mail filed in the wrong place.
 */
export function declaredMailboxes(env: { INBOX_MAILBOXES?: unknown }): DeclaredMailbox[] {
  const declared = parseDeclared(env.INBOX_MAILBOXES, inboxOwnerOf(bundledInstall).email)
  if (declared.ok) return declared.mailboxes
  console.error(`the declared mailboxes are not valid, so none is served: ${declared.error}`)
  return []
}

/** What stands in for the bucket in a Worker deployed without one: every use fails, so mail is refused or owed and never lost quietly. */
export const NO_BUCKET: RawBucket = {
  head: () => Promise.reject(new Error('The Worker has no raw-mail bucket bound.')),
  get: () => Promise.reject(new Error('The Worker has no raw-mail bucket bound.')),
  put: () => Promise.reject(new Error('The Worker has no raw-mail bucket bound.')),
  delete: () => Promise.reject(new Error('The Worker has no raw-mail bucket bound.')),
}

export interface WaitsUntil {
  waitUntil(promise: Promise<unknown>): void
}

/**
 * Cloudflare Email Routing hands a message here (the routing rules name the space's Worker): the raw copy is kept in the bucket first and the Durable Object files it from
 * there. Everything decided is in src/cloudflare/entrance.ts. A throw is how Cloudflare is told the delivery failed, so a failure of ours is never a bounce.
 */
export async function takeEmail(
  message: InboundEmail,
  env: { RAW?: RawBucket; INBOX_MAILBOXES?: unknown },
  store: StoreApi,
  ctx: WaitsUntil,
  now: () => Date = () => new Date(),
): Promise<Entered> {
  const entered = await receiveEmail(message, {
    mailboxes: declaredMailboxes(env),
    // No bucket and no mailbox declared both end the same way: nothing is accepted that could not be kept.
    bucket: env.RAW ?? NO_BUCKET,
    file: (input) => store.call('fileArrival', input),
    now,
  })
  // The notification goes after the handler has answered Cloudflare: filing the message is what the handler is for, and waiting
  // on a push service inside it would spend its time limit on the owner's phone.
  if (entered === 'filed') {
    ctx.waitUntil(
      store
        .call('deliverNotifications')
        .catch((error: unknown) => console.error('notifying about an arrival failed', error)),
    )
  }
  return entered
}

/** What a queue hands a consumer: the messages' bodies, and the two answers (the whole batch is kept, or asked for again). */
export interface ReportBatch {
  messages: readonly { body: unknown }[]
  ackAll(): void
  retryAll(): void
}

/**
 * Cloudflare's delivery reports for the mail the inbox sent as a Cloudflare mailbox: the queue named in the space's Worker settings (`queues.consumers`) receives Email Sending's
 * events (the event subscriptions the install's deploy makes), and the Durable Object keeps the ones that are ours (src/delivery.ts). A store that fails
 * asks the queue for the batch again (`retryAll`); keeping a report twice is keeping it once.
 */
export async function keepReports(batch: ReportBatch, store: StoreApi): Promise<void> {
  try {
    const result = await store.call(
      'keepDeliveryEvents',
      batch.messages.map((m) => m.body),
    )
    // Counts only, never a report's words: what the live check reads in `wrangler tail`. `unmatched` is the reports no sent message is filed under (yet).
    console.log(
      `delivery reports: ${batch.messages.length} handed over, ${result.kept} kept, ${result.repeated} repeated, ${result.dropped} not ours, ${result.unmatched} matching no sent message`,
    )
    batch.ackAll()
  } catch (error) {
    console.error('keeping delivery reports failed', error)
    batch.retryAll()
  }
}

/** The once-a-day pass (`DAILY_CRON`). The only scheduled work for Gmail and for the mail server's mailboxes. */
export function runDaily(store: StoreApi, ctx: WaitsUntil): void {
  ctx.waitUntil(store.call('runDaily').catch((error: unknown) => console.error('the daily pass failed', error)))
  // The mailboxes on the mail server have a pass of their own (renew the push subscription, one sync from the cursor), asked after Gmail's has been handed over and failing alone.
  ctx.waitUntil(
    store
      .call('runJmapDaily')
      .catch((error: unknown) => console.error('the daily pass for the mail server mailboxes failed', error)),
  )
}
