// Close and Reopen without waiting for the inbox: the page shows the change at once and the call runs behind it.
//
// The inbox answers a Close only after Gmail has (it queues behind a sync, reads the thread, changes it), which is a second or more; the person is not made to
// watch that. A change is SUBMITTED here: its threads are shown as already changed (an overlay on whatever the conversation read says, `withPending` in
// close.ts), its row is dropped from the lists, and the call is made in its turn. One call at a time, in the order the person pressed, so a Reopen pressed
// while its Close is still out goes after it and never races it, and a second Close never finds the first still busy.
//
// When the inbox refuses or fails a thread the overlay for it goes at once (it is open again on screen) and the notice says why, as it always has. A failure
// is never replaced by a later success: failure notices stay (the last three) until they are dismissed, the conversation they are about is left after they were shown, or the same thread is changed again. A conversation shows only its own.
//
// The overlay of a change that WENT stays until a read that began after the call ended has landed (`release`), so a read that was started before cannot
// put the old state back for a moment, and the screen does not flicker between "closed" and what the page last read.
//
// This is module state, not the pane's: the person moves to the next conversation straight after Close, and a refusal that arrives then is still told.
import type { Changed } from './close'
import type { Notice } from './compose'

export type ChangeKind = 'close' | 'reopen'

export interface ChangeJob {
  kind: ChangeKind
  /** The email threads it acts on. */
  ids: readonly string[]
  /** The row they belong to and whether this close leaves it with nothing open, so the lists drop it at once. */
  row?: { key: string; leaves: boolean }
  /** What the person is told the moment they press, until the inbox answers ("Closed."). */
  hope: string
  /** Makes the call for the threads still asked for when its turn comes: a refusal of an earlier, opposite change takes some out. */
  run(ids: readonly string[]): Promise<Changed>
  /** After the call ended, with what was done (called for a job that was dropped too, with none). */
  settled?(done: readonly string[]): void
}

/** A notice and the threads it is about, in the order the changes were pressed. */
export interface Told {
  seq: number
  ids: readonly string[]
  notice: Notice
}

export interface Shown {
  /** Each thread with a change not yet read back, and whether it is to be open (a Reopen) or closed (a Close). */
  threads: ReadonlyMap<string, boolean>
  /** Rows to leave out of the lists that hold open conversations only. */
  rows: ReadonlySet<string>
  /** The notices to show: the newest "ok" one, and the failures. */
  told: readonly Told[]
  /** Counts up whenever a change ended, so an open conversation reads again. */
  ended: number
}

interface Queued {
  seq: number
  job: ChangeJob
  ids: string[]
  done: () => void
}
interface Mark {
  seq: number
  open: boolean
  endedAt: number | null
}

const KEEP_FAILURES = 3

export function createChanges() {
  let seq = 0
  let ended = 0
  const threads = new Map<string, Mark>()
  const rows = new Map<string, { seq: number; endedAt: number | null }>()
  let told: Told[] = []
  const waiting: Queued[] = []
  let tail: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  let shown: Shown = { threads: new Map(), rows: new Set(), told: [], ended: 0 }

  const publish = () => {
    shown = { threads: new Map([...threads].map(([id, m]) => [id, m.open])), rows: new Set(rows.keys()), told, ended }
    // A screen that throws while it redraws must not stop the others, nor the queue.
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        // its own error boundary tells it
      }
    }
  }

  // The newest "ok" notice and the last few failures: a success never hides a failure, and an old success is not left under a newer one.
  const prune = () => {
    const newestOk = told.filter((t) => t.notice.tone === 'ok').at(-1)
    const bad = told.filter((t) => t.notice.tone !== 'ok').slice(-KEEP_FAILURES)
    told = told.filter((t) => t === newestOk || bad.includes(t))
  }

  async function runOne(q: Queued): Promise<void> {
    const at = waiting.indexOf(q)
    if (at >= 0) waiting.splice(at, 1)
    // Every thread it was for was taken out by a refusal ahead of it: there is no call to make and nothing to tell.
    if (q.ids.length === 0) {
      ended++
      finish(q, [])
      return
    }
    let out: Changed
    try {
      out = await q.job.run(q.ids)
    } catch {
      out = { notice: { tone: 'error', text: `Whether it ${q.job.kind === 'close' ? 'closed' : 'reopened'} is not known: the conversation is shown as it stands.` }, done: [] }
    }
    const now = Date.now()
    const failed = q.ids.filter((id) => !out.done.includes(id))
    for (const id of q.ids) {
      const m = threads.get(id)
      if (m?.seq !== q.seq) continue
      if (out.done.includes(id)) m.endedAt = now
      else threads.delete(id)
    }
    const key = q.job.row?.key
    if (key !== undefined) {
      const r = rows.get(key)
      if (r?.seq === q.seq) {
        if (failed.length === 0) r.endedAt = now
        else rows.delete(key)
      }
    }
    // What the inbox REFUSED did not happen, so the change queued behind it (a Reopen of what a Close was to close) has nothing to act on. A change whose outcome is not known
    // (the connection dropped, no answer) may have gone through: what is queued behind it is still sent, and it is idempotent.
    const refused = out.refused ?? []
    if (refused.length > 0) {
      for (const other of [...waiting]) {
        if (other.job.kind === q.job.kind) continue
        const dropped = other.ids.filter((id) => refused.includes(id))
        if (dropped.length === 0) continue
        other.ids = other.ids.filter((id) => !dropped.includes(id))
        for (const id of dropped) if (threads.get(id)?.seq === other.seq) threads.delete(id)
        if (other.ids.length === 0) {
          told = told.filter((t) => t.seq !== other.seq)
          if (other.job.row && rows.get(other.job.row.key)?.seq === other.seq) rows.delete(other.job.row.key)
        }
      }
    }
    const had = told.some((t) => t.seq === q.seq)
    if (had) told = told.map((t) => (t.seq === q.seq ? { ...t, notice: out.notice } : t))
    else if (out.notice.tone !== 'ok') told = [...told, { seq: q.seq, ids: q.job.ids, notice: out.notice }].sort((a, b) => a.seq - b.seq)
    prune()
    ended++
    finish(q, out.done)
  }

  // The end of every job, whatever its callback does: the screens are told and whoever waits for it is let go.
  function finish(q: Queued, done: readonly string[]): void {
    try {
      q.job.settled?.(done)
    } catch {
      // a screen's own callback failed; the change itself ended
    } finally {
      publish()
      q.done()
    }
  }

  return {
    /** Show the change now and make the call in its turn. Resolves when the call has ended. */
    submit(job: ChangeJob): Promise<void> {
      const mine = ++seq
      const ids = [...job.ids]
      for (const id of ids) threads.set(id, { seq: mine, open: job.kind === 'reopen', endedAt: null })
      if (job.row) {
        if (job.kind === 'close' && job.row.leaves) rows.set(job.row.key, { seq: mine, endedAt: null })
        else if (job.kind === 'reopen') rows.delete(job.row.key)
      }
      // The person is doing something with these threads again: what was told of them before is done with.
      told = told.filter((t) => !(t.notice.tone !== 'ok' && t.ids.some((id) => ids.includes(id))))
      told = [...told, { seq: mine, ids, notice: { tone: 'ok', text: job.hope } }]
      prune()
      const finished = new Promise<void>((resolve) => {
        const q: Queued = { seq: mine, job, ids, done: resolve }
        waiting.push(q)
        // One that throws must not wedge the queue: every later change would be shown done and never sent.
        tail = tail.then(() => runOne(q)).catch(() => q.done())
      })
      publish()
      return finished
    },

    /** The person has dismissed a notice, or left the conversation it was shown in. */
    dismiss(seqs: readonly number[]): void {
      if (!told.some((t) => seqs.includes(t.seq))) return
      told = told.filter((t) => !seqs.includes(t.seq))
      publish()
    },

    /** A read of `scope` that began at `startedAt` has landed: changes that ended before it are in what it read, so their overlay is no longer needed. */
    release(scope: 'threads' | 'rows', startedAt: number): void {
      let any = false
      const map: Map<string, { endedAt: number | null }> = scope === 'threads' ? threads : rows
      for (const [id, m] of map) {
        if (m.endedAt !== null && m.endedAt <= startedAt) {
          map.delete(id)
          any = true
        }
      }
      if (any) publish()
    },

    /** Whether a change to any of these threads is queued or out (not yet answered). */
    busy(ids: readonly string[]): boolean {
      return ids.some((id) => threads.get(id)?.endedAt === null)
    },

    /** Resolves when everything submitted so far has ended. */
    idle: (): Promise<void> => tail,

    snapshot: (): Shown => shown,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    /** For tests: forget everything. */
    reset(): void {
      threads.clear()
      rows.clear()
      waiting.length = 0
      told = []
      tail = Promise.resolve()
      ended = 0
      publish()
    },
  }
}

/** The page's one set of changes. */
export const changes = createChanges()
