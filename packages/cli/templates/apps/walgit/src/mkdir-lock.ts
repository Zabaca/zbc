/**
 * A mutual exclusion between processes on one machine, built out of `mkdir`.
 *
 * `mkdir` is the primitive because it is atomic on POSIX and needs no daemon:
 * exactly one of N concurrent callers creates the directory and the rest get
 * `EEXIST`. That is the whole mechanism. walgit needs it in two places — a
 * `FileStore` conditional write, and a materialize that must not run twice into
 * the same directory — and until this module they were two hand-rolled copies
 * whose comments each pointed at the other.
 *
 * **Breaking the lock is the subtle part, and it is why one copy is not
 * enough.** A holder that is killed mid-write releases nothing, and on Fly a
 * machine is stopped whenever it is idle, so a lock that only a graceful
 * release could clear would wedge a repository permanently — a failure that
 * presents as everything quietly hanging. So the wait is bounded and then the
 * lock is taken by force. That is safe only because both callers are
 * idempotent: the loser re-reads what is on disk and redoes only what is
 * genuinely absent.
 *
 * `breakAfter` is an argument rather than a constant because the two callers
 * legitimately differ — a conditional write is over in milliseconds, a cold
 * restore downloads packfiles — and passing it makes that difference a decision
 * the call site states rather than a number that drifted.
 */

import * as fs from 'node:fs'

/** How long between attempts. Short: contention here is measured in ms. */
const POLL_MS = 5

export interface LockOptions {
  /**
   * How many failed attempts to tolerate before breaking the lock. Attempts are
   * `POLL_MS` apart, so this is a duration in disguise: 200 ≈ 1 s, 1200 ≈ 6 s.
   */
  breakAfter: number
}

/**
 * Releases the lock. `waited` says whether anyone was holding it on arrival —
 * which is the difference between "this restore was the only one" and "this
 * restore queued behind another", and materialize reports it.
 */
export type LockRelease = (() => void) & { waited: boolean }

/** Take `lockPath`, waiting for it if held. The parent directory must exist. */
export async function acquireLock(lockPath: string, opts: LockOptions): Promise<LockRelease> {
  let waited = false
  for (let i = 0; ; i += 1) {
    try {
      fs.mkdirSync(lockPath)
      const release = () => {
        try {
          fs.rmdirSync(lockPath)
        } catch {
          /* already released, or broken by a waiter */
        }
      }
      return Object.assign(release, { waited })
    } catch {
      waited = true
      if (i > opts.breakAfter) fs.rmSync(lockPath, { recursive: true, force: true })
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }
}
