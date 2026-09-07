// The engine's half of the readiness contract.
//
// A module says what proves its resource usable (`ReadinessDeclaration`); this
// says WHEN that proof is demanded and what happens while it is refused. The
// rule is one sentence: **an instance's outputs do not cross an `imports` edge
// until its probe has succeeded.**
//
// At the edge, and not at the end of `apply`, for two reasons. The cheap one is
// that an instance nothing imports pays nothing — a probe is provider traffic,
// and charging every apply for a wait nobody is waiting on is how a contract
// gets worked around. The load-bearing one is that the edge is the only place
// the engine knows a reader exists at all: readiness is a claim about a
// capability someone is about to use, which is exactly what leeandco measured —
// `/tokens/verify` answering 200 at ~112ms while the scope-gated call was still
// refusing at ~1621ms. A probe with no reader proves nothing about a reader.
//
// Retry policy is deliberately dumb: throw or `false` means "not ready", wait,
// try again, give up when the budget is spent. All four hand-rolled loops this
// replaces behaved that way, and nothing here can tell a transient refusal from
// a permanent one — the budget expiring is what turns one into the other.

import type { ApplyContext, ModuleInstance } from '../../templates/infra/src/types'

/** Engine defaults, for a module that declares `ready` without knobs. */
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_INTERVAL_MS = 1_000

/** How long a probe may go on refusing before the wait is reported as progress. */
const PROGRESS_EVERY_MS = 10_000

/** What was applied, kept so the probe can be run later — at the edge. */
interface Recorded {
  instance: ModuleInstance
  config: unknown
  outputs: unknown
  ctx: ApplyContext
}

export interface ReadinessGate {
  /**
   * Remember an applied instance so its probe can run when something imports
   * it. Called for every instance, whether or not its module declares `ready` —
   * the gate, not the caller, decides there is nothing to prove.
   */
  record(instance: ModuleInstance, config: unknown, outputs: unknown, ctx: ApplyContext): void
  /**
   * Block until `name`'s resource is usable. A no-op for an instance whose
   * module declares no `ready`, or that this run did not apply. Probes at most
   * once per run however many importers ask.
   */
  ensureReady(name: string): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `work`, or a rejection once `ms` has passed — whichever settles first.
 *
 * The budget has to bound the ATTEMPT, not just the gap between attempts. A
 * probe reaches a provider over `fetch`, which carries no timeout of its own: a
 * connection that is accepted and then never answered leaves the probe pending
 * forever, and a deadline checked only after `await` is never reached. What the
 * operator sees then is `zbc apply` hanging with no output until CI's own
 * wall-clock kills the job — the exact failure a 30s budget was written to
 * prevent.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  // The loser of the race still settles. Without a handler of its own, a probe
  // that rejects after the deadline is an unhandled rejection — which in Bun and
  // in Node kills the process rather than the apply.
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the probe did not answer within ${(ms / 1000).toFixed(1)}s`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createReadinessGate(): ReadinessGate {
  const applied = new Map<string, Recorded>()
  // The PROMISE is memoised, not the boolean: two importers of the same
  // instance in the same run must wait on one probe, not race two.
  const proven = new Map<string, Promise<void>>()

  return {
    record(instance, config, outputs, ctx) {
      applied.set(instance.name, { instance, config, outputs, ctx })
    },
    ensureReady(name) {
      const existing = proven.get(name)
      if (existing) return existing
      const recorded = applied.get(name)
      const ready = recorded?.instance._definition.ready
      if (!recorded || !ready) return Promise.resolve()
      const pending = probeUntilReady(recorded, ready).catch((err: unknown) => {
        // A FAILURE is not memoised, only a proof. `gate` is a public field on
        // both engine paths' options, so one gate can outlive a single apply —
        // and a cached rejection would answer "not usable yet", with a stale
        // last failure, for a resource that became usable a second after the
        // budget expired.
        proven.delete(name)
        throw err
      })
      proven.set(name, pending)
      return pending
    },
  }

  async function probeUntilReady(
    recorded: Recorded,
    ready: NonNullable<ModuleInstance['_definition']['ready']>,
  ): Promise<void> {
    const { instance } = recorded
    const where = `Instance "${instance.name}" (module "${instance.moduleName}")`
    const timeoutMs = ready.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const intervalMs = ready.intervalMs ?? DEFAULT_INTERVAL_MS
    // A zero or negative budget is a declaration bug, and both spellings of it
    // fail silently otherwise: a zero timeout aborts every probe, and a zero
    // interval turns the loop into an unthrottled hammer on the provider.
    if (!(timeoutMs > 0) || !(intervalMs > 0)) {
      throw new Error(
        `${where} declares ready.timeoutMs=${timeoutMs} and ready.intervalMs=${intervalMs}; both must be greater than 0`,
      )
    }
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1)
    let attempts = 0
    let lastFailure = 'the probe returned false'
    let reportedAt = startedAt

    for (;;) {
      attempts += 1
      let passed = false
      try {
        // Only an explicit `false` is a refusal. A probe whose whole body is a
        // provider call returns that call's result, and demanding `true` back
        // would make every such probe a silent forever-loop.
        const verdict = await withDeadline(
          Promise.resolve(ready.probe(recorded.outputs, recorded.config, recorded.ctx)),
          Math.max(deadline - Date.now(), 1),
        )
        passed = verdict !== false
        if (!passed) lastFailure = 'the probe returned false'
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err)
      }
      if (passed) {
        if (attempts > 1) {
          console.log(
            `  ready: ${instance.name} — ${ready.proves} (after ${elapsed()}s, ${attempts} attempts)`,
          )
        }
        return
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${where} was applied, but is not usable yet: ${ready.proves}. ` +
            `Gave up after ${elapsed()}s and ${attempts} attempts. Last failure: ${lastFailure}`,
        )
      }
      // Silence for a whole minute is indistinguishable from a wedged apply, so
      // say something on the first refusal and then keep saying it — but only
      // when there is news: a new failure, or ten more seconds of the same one.
      if (attempts === 1 || Date.now() - reportedAt >= PROGRESS_EVERY_MS) {
        reportedAt = Date.now()
        console.log(
          `  ${instance.name} not ready yet (${elapsed()}s, ${attempts} attempts): ` +
            `${ready.proves} — retrying. Last failure: ${lastFailure}`,
        )
      }
      await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)))
    }
  }
}
