/**
 * The people of every mailbox, over the store's SQL port (migration 19's `mailbox_person`).
 *
 * A mailbox is one person's (a Gmail account they connected) or a list's (a shared mailbox), and what a person may see is the mailboxes they are on (`canSee`, src/queue.ts). THIS FILE KEEPS THE LISTS AND SAYS WHERE THEY COME
 * FROM; it makes no decision about what a list means for what is shown.
 *
 * ── WHERE THE PEOPLE COME FROM, AND HOW THAT CAN CHANGE ──────────────────
 * Every reader (the scope of a person, the check before a send) reads the table and only the table. What fills it is a `PeopleSource`, a port:
 *
 *   - a Gmail account is its connector's: the person who connected it is on it, written when it is connected (`seatMailbox`);
 *   - the install's declared business mailboxes (Cloudflare's and the mail server's) are the declaration's: `Install.mailboxPeople`, the `people` of each, else the install's owner alone; the Telegram mailbox is the owner's;
 *   - `settleMailboxPeople` makes the table agree with the source when the object starts, before it serves a request, so a change to a declaration is a deploy and nothing else;
 *   - a mailbox nobody is on (a row from before the table, a person taken off a mailbox's list) is the owner's alone, so no mail is ever left that nobody can see.
 *
 * When people are kept by the space itself, the source is the one that changes: the reads do not.
 */

import type { MailboxKind } from './kinds'
import type { InboxSql } from './schema'

/**
 * What fills the lists. `owner` is the install's owner (a mailbox nobody is on is theirs); `team` is every person of the install (an address that is none of them cannot see anything, so it is taken off a list, as the
 * address of an actor that was never a person, or of one who has left the install); `peopleOf` answers the people of a mailbox by kind and address, or null when the source does not say (a Gmail account, an undeclared mailbox).
 */
export interface PeopleSource {
  owner: string
  team: readonly string[]
  peopleOf: (kind: MailboxKind, address: string) => readonly string[] | null
}

/** The one spelling of a person's address on a list: lower case, trimmed. */
export const personKey = (address: string): string => address.trim().toLowerCase()

/** The people on a mailbox, in the order they were put there. */
export function peopleOnMailbox(sql: InboxSql, mailboxId: string): string[] {
  return sql
    .exec(`SELECT person FROM mailbox_person WHERE mailbox_id = ?1 ORDER BY added_at, rowid`, mailboxId)
    .toArray()
    .map((r) => String(r.person))
}

/** The ids of the mailboxes a person is on. A list naming a mailbox that has no row any more names nothing. */
export function mailboxesOfPerson(sql: InboxSql, person: string): string[] {
  return sql
    .exec(
      `SELECT mp.mailbox_id AS id FROM mailbox_person mp JOIN mailbox mb ON mb.id = mp.mailbox_id WHERE mp.person = ?1 ORDER BY mb.rowid`,
      personKey(person),
    )
    .toArray()
    .map((r) => String(r.id))
}

/** Put a person on a mailbox; on it already, nothing changes. Answers whether they were added. */
export function seatPerson(sql: InboxSql, mailboxId: string, person: string, by: string, at: string): boolean {
  return (
    sql.exec(
      `INSERT OR IGNORE INTO mailbox_person (mailbox_id, person, added_at, added_by) VALUES (?1, ?2, ?3, ?4)`,
      mailboxId,
      personKey(person),
      at,
      by,
    ).rowsWritten > 0
  )
}

/** Take a person off a mailbox. Answers whether they were on it. */
export function unseatPerson(sql: InboxSql, mailboxId: string, person: string): boolean {
  return (
    sql.exec(`DELETE FROM mailbox_person WHERE mailbox_id = ?1 AND person = ?2`, mailboxId, personKey(person))
      .rowsWritten > 0
  )
}

/**
 * Make one mailbox's list exactly `people`: the ones missing are added, the ones not named are taken off. Nothing is written for a list that is already right. Answers how many rows changed.
 */
export function putPeople(sql: InboxSql, mailboxId: string, people: readonly string[], by: string, at: string): number {
  const want = [...new Set(people.map(personKey))].filter((p) => p !== '')
  const have = peopleOnMailbox(sql, mailboxId)
  let changed = 0
  for (const person of have) if (!want.includes(person) && unseatPerson(sql, mailboxId, person)) changed += 1
  for (const person of want) if (!have.includes(person) && seatPerson(sql, mailboxId, person, by, at)) changed += 1
  return changed
}

/** The actor the lists are written under when the store does it on its own, at the start of the object. */
export const SETTLE_ACTOR = 'start'

/**
 * Make the table agree with the source, for every mailbox, and leave no mailbox with nobody on it. Run when the object starts, after the migrations and before anything is served. A mailbox the source names the
 * people of (a declared business mailbox, the Telegram mailbox) gets exactly them; a Gmail account keeps the people it has (its connector); anyone who is no person of the install is taken off; a mailbox with nobody on it is the owner's. Answers how many rows changed:
 * nothing, once it has settled.
 */
export function settleMailboxPeople(sql: InboxSql, source: PeopleSource, at: string): number {
  let changed = 0
  const rows = sql.exec(`SELECT id, kind, address FROM mailbox ORDER BY rowid`).toArray()
  for (const r of rows) {
    const id = String(r.id)
    const named = source.peopleOf(String(r.kind) as MailboxKind, String(r.address))
    if (named !== null && named.length > 0) changed += putPeople(sql, id, named, SETTLE_ACTOR, at)
    for (const person of peopleOnMailbox(sql, id)) {
      if (!source.team.includes(person) && unseatPerson(sql, id, person)) changed += 1
    }
    if (peopleOnMailbox(sql, id).length === 0 && seatPerson(sql, id, source.owner, SETTLE_ACTOR, at)) changed += 1
  }
  return changed
}
