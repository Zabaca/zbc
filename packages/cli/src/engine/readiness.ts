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

export interface ReadinessGateOptions {
  /** Swapped by tests that must not sleep in real time. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createReadinessGate(opts: ReadinessGateOptions = {}): ReadinessGate {
  const sleep = opts.sleep ?? realSleep
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
      const pending = probeUntilReady(recorded, ready)
      proven.set(name, pending)
      return pending
    },
  }

  async function probeUntilReady(
    recorded: Recorded,
    ready: NonNullable<ModuleInstance['_definition']['ready']>,
  ): Promise<void> {
    const { instance } = recorded
    const timeoutMs = ready.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const intervalMs = ready.intervalMs ?? DEFAULT_INTERVAL_MS
    const startedAt = Date.now()
    let attempts = 0
    let lastFailure = 'the probe returned false'

    for (;;) {
      attempts += 1
      let passed = false
      try {
        // Only an explicit `false` is a refusal. A probe whose whole body is a
        // provider call returns that call's result, and demanding `true` back
        // would make every such probe a silent forever-loop.
        passed = (await ready.probe(recorded.outputs, recorded.config, recorded.ctx)) !== false
        if (!passed) lastFailure = 'the probe returned false'
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err)
      }
      if (passed) {
        if (attempts > 1) {
          const waited = ((Date.now() - startedAt) / 1000).toFixed(1)
          console.log(
            `  ready: ${instance.name} — ${ready.proves} (after ${waited}s, ${attempts} attempts)`,
          )
        }
        return
      }
      // Checked AFTER an attempt, so a zero budget still probes once and a
      // module that is ready immediately never sleeps.
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Instance "${instance.name}" (module "${instance.moduleName}") was applied, but is not ` +
            `usable yet: ${ready.proves}. Gave up after ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
            `and ${attempts} attempts. Last failure: ${lastFailure}`,
        )
      }
      if (attempts === 1) {
        console.log(`  not ready yet: ${ready.proves} — retrying. Last failure: ${lastFailure}`)
      }
      await sleep(intervalMs)
    }
  }
}
