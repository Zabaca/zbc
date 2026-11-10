import type { MailboxStatus } from '../types'

/**
 * When the header turns amber, and what it says. Pure: the store hands over the
 * mailbox's stamps and the time, so each rule is a table test.
 *
 * Amber means "do not trust a quiet queue", which is the point of showing it at
 * all (story 7). It has exactly the three causes the option names, plus one the
 * option leaves implicit:
 *
 *   - THE WATCH LAPSES. Gmail's watch lasts a week and the daily pass renews it;
 *     if it runs out within a day, the renewal is not working. A mailbox with no
 *     watch at all (the call failed at connect) counts as lapsed.
 *   - THE LAST SYNC FAILED. The error is shown with its time.
 *   - PUSHES ARE BROKEN. The daily pass found new mail while no push had arrived
 *     for 24 hours, so mail is arriving by the safety net alone. A later push
 *     clears it.
 *
 * And the one it does not name: a mailbox that is disconnected is not amber (it
 * says so), but one that is connected and has never finished its first fill is
 * shown as `filling`, never as live, so a queue that is still being read in
 * cannot be mistaken for the whole mailbox.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The sentence for an account whose grant Google no longer accepts. One place, so the amber line, Settings and a refused send say the same thing. The reason is named
 * because it is the usual one for an owner's outside accounts: Google's app is in testing, and a testing app's grants end after 7 days.
 */
export const lapsedReason = (address: string): string =>
  `Google no longer accepts the saved sign-in for ${address} (a Google app in testing mode loses its grants after 7 days), so nothing new arrives or goes out from it. Connect it again.`

/**
 * A working grant: the account holds a token and Google has not ended it. The one rule, in two spellings that must agree: a function for a row already read, and the SQL for a
 * query that picks or updates rows, so nothing syncs, renews, sends or is chosen to send for an account that is disconnected or lapsed by a check that forgot one half.
 */
export const grantWorks = <T extends { refreshToken: string | null; lapsedAt: string | null }>(
  m: T,
): m is T & { refreshToken: string } => m.refreshToken !== null && m.lapsedAt === null
export const workingGrantSql = (alias = 'mailbox'): string =>
  `${alias}.refresh_token IS NOT NULL AND ${alias}.grant_lapsed_at IS NULL`

/**
 * What `healthOf` and `stateOf` read of a mailbox: the fields of the status that
 * they judge (declared once, in MailboxStatus, so a renamed field cannot be missed
 * here) plus the three the status does not show.
 */
export type MailboxStamps = Pick<
  MailboxStatus,
  'address' | 'connected' | 'watchExpiry' | 'lastPushAt' | 'lastSyncAt' | 'lastError' | 'lapsedAt'
> & {
  historyId: string | null
  jobKind: 'fill' | 'resync' | null
  pushSuspectAt: string | null
}

export function stateOf(
  m: Pick<MailboxStamps, 'connected' | 'historyId' | 'jobKind' | 'lapsedAt'>,
): MailboxStatus['state'] {
  if (!m.connected) return 'disconnected'
  if (m.lapsedAt !== null) return 'lapsed'
  if (m.jobKind === 'resync') return 'resyncing'
  if (m.jobKind === 'fill' || m.historyId === null) return 'filling'
  return 'live'
}

export function healthOf(m: MailboxStamps, now: Date): MailboxStatus['health'] {
  if (!m.connected) return { amber: false, reasons: [] }
  // A lapsed grant is the whole story: the watch, the sync and the pushes all fail because of it, so saying them too would bury the one thing to do.
  if (m.lapsedAt !== null) return { amber: true, reasons: [lapsedReason(m.address)] }
  const reasons: string[] = []

  const expiry = m.watchExpiry === null ? Number.NaN : Date.parse(m.watchExpiry)
  if (Number.isNaN(expiry)) {
    reasons.push('Gmail is not set up to tell the inbox about new mail, so mail arrives only when the daily pass runs.')
  } else if (expiry - now.getTime() < DAY_MS) {
    reasons.push(
      expiry <= now.getTime()
        ? 'The live connection to Gmail has lapsed.'
        : 'The live connection to Gmail runs out within a day.',
    )
  }

  if (m.lastError !== null) reasons.push(`The last sync failed: ${m.lastError}`)

  if (m.pushSuspectAt !== null) {
    const suspectedAt = Date.parse(m.pushSuspectAt)
    const lastPush = m.lastPushAt === null ? Number.NEGATIVE_INFINITY : Date.parse(m.lastPushAt)
    if (!(lastPush > suspectedAt)) {
      reasons.push('Mail arrived but Gmail has not pushed for over a day, so pushes may be broken.')
    }
  }

  return { amber: reasons.length > 0, reasons }
}
