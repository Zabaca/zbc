/**
 * The visibility rule (`canSee`, src/queue.ts) as SQL, for the reads that cut in the database and not over facts already read. It is a TRANSLATION and holds no rule of its own: test/mail-scope.test.ts
 * runs it over a real SQLite beside `canSee` for every kind of mailbox column value, so the two cannot drift.
 *
 * The ids of a person's mailboxes go in as ONE bound JSON list read by `json_each` (a Durable Object's SQLite takes only 100 bound values), and the owner's flag as a bound number, so nothing of a scope is ever
 * put into the SQL text.
 */

import type { MailScope } from '../queue'

/** A piece of SQL with its bound values: the placeholders it uses start at `?${from}`. */
export interface Where {
  sql: string
  bindings: unknown[]
}

/**
 * `column` (a mailbox id column, or an expression that is one, NULL where there is no mailbox) is one the scope may see. `from` is the number of the first free placeholder of the statement it joins. The binding
 * order is the order of the placeholders: the list, then the flag.
 */
export function scopeWhere(scope: MailScope, column: string, from: number): Where {
  if (scope.mailboxIds === null) {
    return { sql: `(${column} IS NOT NULL OR ?${from} = 1)`, bindings: [scope.unfiled ? 1 : 0] }
  }
  return {
    sql: `(CASE WHEN ${column} IS NULL THEN ?${from + 1} = 1 ELSE ${column} IN (SELECT value FROM json_each(?${from})) END)`,
    bindings: [JSON.stringify(scope.mailboxIds), scope.unfiled ? 1 : 0],
  }
}

/** The mailbox a message belongs to: its conversation's, and for one on no conversation (a draft of a new email) the one it records. `m` is the message's alias, `cv` its conversation's, joined LEFT. */
export const MESSAGE_MAILBOX = (m = 'm', cv = 'cv'): string =>
  `(CASE WHEN ${m}.conversation_id IS NULL THEN ${m}.mailbox_id ELSE ${cv}.mailbox_id END)`
