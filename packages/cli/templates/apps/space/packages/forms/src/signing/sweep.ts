/**
 * The hourly sweep (wrangler.jsonc `triggers.crons`): what time does to envelopes. Expires the ones past their date,
 * sends the reminders that are due (to whoever's turn it is, on the schedule, in the client's hours), seals again
 * any envelope stuck sealing, sends mail a request left pending, and purges what retention says is due. Each step is
 * independent: one failing is logged and the rest run.
 */
import { isoAt, type CoreDeps, type EnvelopeRow, type RecipientRow, loadRecipients } from './support'
import { retryStuck } from './completion'
import { expire, remind } from './lifecycle'
import { flushMail } from './mail'
import { purgeDue } from './purge'
import { dueReminders } from './rules'

export interface SweepResult {
  expired: number
  reminded: number
  resealed: number
  mailSent: number
  purged: number
}

async function step<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    console.error(`[sweep] ${name} failed`, err)
    return fallback
  }
}

async function expireDue(d: CoreDeps): Promise<number> {
  const rows = (await d.db.prepare("SELECT id FROM envelopes WHERE status IN ('sent', 'prepared') AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50").bind(isoAt(d.now())).all<{ id: string }>()).results
  let n = 0
  for (const { id } of rows) if (await step(`expire ${id}`, false, () => expire(d, id))) n++
  return n
}

async function sendReminders(d: CoreDeps): Promise<number> {
  const rows = (
    await d.db
      .prepare("SELECT e.*, c.time_zone AS zone FROM envelopes e JOIN clients c ON c.id = e.client_id WHERE e.status IN ('sent', 'prepared') AND (e.expires_at IS NULL OR e.expires_at > ?) LIMIT 200")
      .bind(isoAt(d.now()))
      .all<EnvelopeRow & { zone: string }>()
  ).results
  let n = 0
  for (const e of rows) {
    const recipients: RecipientRow[] = await loadRecipients(d.db, e.id)
    // A form whose document was withdrawn (its filler is changing an answer) has nothing for the others to sign: only the filler is reminded.
    const withdrawn = e.kind === 'form' && e.status === 'prepared' && !e.prepared_key
    for (const r of dueReminders(e, recipients, d.now(), e.zone).filter((x) => !withdrawn || x.position === 1)) {
      n += await step(`remind ${e.id}`, 0, async () => {
        await remind(d, { kind: 'system' }, {}, e.id, { recipientId: r.id, scheduled: true })
        return 1
      })
    }
  }
  return n
}

async function sendPendingMail(d: CoreDeps): Promise<number> {
  // A message a request recorded and did not get to send. Five minutes leaves a live request its turn.
  const rows = (await d.db.prepare("SELECT id FROM mail WHERE status = 'pending' AND created_at <= ? AND attempts < 3 ORDER BY created_at LIMIT 50").bind(isoAt(d.now() - 5 * 60_000)).all<{ id: string }>()).results
  let n = 0
  for (const { id } of rows) if ((await step(`mail ${id}`, 'pending', () => flushMail(d, id))) === 'sent') n++
  return n
}

export async function sweep(d: CoreDeps): Promise<SweepResult> {
  return {
    expired: await step('expiry', 0, () => expireDue(d)),
    reminded: await step('reminders', 0, () => sendReminders(d)),
    resealed: await step('sealing', 0, () => retryStuck(d)),
    mailSent: await step('pending mail', 0, () => sendPendingMail(d)),
    purged: await step('retention', 0, () => purgeDue(d)),
  }
}

