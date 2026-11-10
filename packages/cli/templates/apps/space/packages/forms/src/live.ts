// Telling the space's live object that documents moved (the space's ADR 0019).
//
// EVERY WRITE IN FORMS IS ONE BATCH (src/records.ts: "every write is sent as ONE batch ... so a state change and the event or audit row that records it land together or not at all"), and every envelope event is
// written with the change it records in such a batch (src/events.ts `appendEvents`). So the one place that knows "an envelope event has been stored" is the database seam, and that is where it is told: a `Db` that,
// after a batch has been committed, tells the live object that documents moved. It is what the signer's pages, the operator's API and the hourly sweep (expiry, reminders, sealing again, the purge) all write through,
// because each makes its core with `coreFor`. A batch that fails tells nothing (the change was not stored), and a message that cannot be delivered neither fails nor slows the batch (packages/workspace/src/live.ts).
//
// The message names the documents part and the install's people (forms' operators are all of them) and no envelope: what changed is read again by the screens on view.

import { type Install, type LiveBinding, type WaitUntil, teamOf, tellLive } from '@space/workspace'
import type { Db } from './records'

/** `db`, telling the live object after each committed batch. With no live object bound (a test, a local run) it is `db` itself. */
export function watched(db: Db, live: LiveBinding, install: Install, wait?: WaitUntil): Db {
  if (live === undefined || live === null) return db
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      const done = await db.batch(statements)
      tellLive(live, { part: 'documents', people: teamOf(install) }, wait)
      return done
    },
  }
}
