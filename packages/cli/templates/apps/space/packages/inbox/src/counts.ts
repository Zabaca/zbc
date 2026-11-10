import type { InboxSql } from './store/schema'

/**
 * What the operator's counts read of the inbox's store (InboxDO.counts, src/durable.ts), for the sitting that moves the store between Workers
 * (the space's runbook for that move). Constants, never a caller's: the answer is numbers under names and
 * nothing of a message, a draft or a person.
 *
 * THE INBOX IS NEVER QUIET. Mail arrives through Gmail's push and Cloudflare's routing during every step, so unlike the chat's store some counts legitimately rise while a sitting runs.
 * The runbook compares them in three groups, and the groups are written here, once, so the runbook and the test say the same thing:
 *   - EQUAL: nothing an arrival, the daily pass or the queue's consumer writes. Only the owner's own acts change them, and a sitting makes none. A difference is a finding. Drafts (`message:status:draft`) are in it.
 *   - ONLY UP: an arrival, a send, a delivery report or a sync writes these and nothing in a sitting deletes them. Equal or higher; every rise is mail the tails saw arrive. `mailbox` is here: a Cloudflare
 *     mailbox's row is made on its FIRST arrival (src/store/arrival.ts), so it can rise by one per declared mailbox that has had no mail yet.
 *   - MOVES BOTH WAYS: owed work, which an arrival adds and the alarm clears (at rest each is 0), and devices, which the owner adds and the push service deletes when it says one is gone (`gone`, src/store/mail.ts). Reported and not compared.
 */
export const INBOX_COUNTED = {
  equal: ['draft_chat', 'assistant_usage', 'knowledge_entry', 'knowledge_version', 'outbox_tombstone', 'setting'],
  onlyUp: ['mailbox', 'contact', 'identity', 'conversation', 'participant', 'message', 'audit', 'delivery_event'],
  movesBothWays: ['device', 'arrival_owed', 'assist_owed'],
  /** Counted values (see INBOX_GROUPED) that are EQUAL: drafts are made only by the owner and Claude, and the sitting makes none. */
  equalValues: ['message:status:draft'],
} as const

/**
 * Rows counted by a value of one of their columns (messages by direction and by status), under `table:column:value`. `message:direction:in` and `message:direction:out` are in the ONLY UP group with
 * `message` (a sync stores what the owner sent from Gmail's own screens too, so `out` can rise); `message:status:*` moves both ways (a send goes from `sending` to `sent`, a draft is sent), so it is
 * reported and not compared, but its values always add up to `message`.
 */
export const INBOX_GROUPED = [
  { table: 'message', by: 'direction' },
  { table: 'message', by: 'status' },
] as const satisfies readonly { table: string; by: string }[]

/** How many rows each of the counted tables holds. A table that is not there (an older store) counts 0. */
export function countInbox(sql: InboxSql): Record<string, number> {
  const out: Record<string, number> = {}
  const tables = [...INBOX_COUNTED.equal, ...INBOX_COUNTED.onlyUp, ...INBOX_COUNTED.movesBothWays]
  for (const table of tables) out[table] = scalar(sql, `SELECT COUNT(*) AS n FROM "${table}"`)
  for (const { table, by } of INBOX_GROUPED) {
    try {
      for (const row of sql.exec(`SELECT "${by}" AS v, COUNT(*) AS n FROM "${table}" GROUP BY "${by}"`).toArray())
        out[`${table}:${by}:${String(row.v ?? 'none')}`] = Number(row.n)
    } catch {
      // The table is not there: nothing to count.
    }
  }
  return out
}

function scalar(sql: InboxSql, query: string): number {
  try {
    return Number(sql.exec(query).toArray()[0]?.n ?? 0)
  } catch {
    return 0
  }
}
