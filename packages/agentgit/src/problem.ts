/**
 * Saying, once, why this machine has no credential.
 *
 * `authorize` (`src/credential.ts`) composes the sentence; until now nobody
 * printed it. A watcher reconnects with a backoff, so the same misconfiguration
 * is decided again every few seconds — which is why this is a latch and not a
 * log line: the first occurrence is the diagnosis, the next two hundred are a
 * channel that stops being read. It is the discipline the collision report
 * already uses, and for the same reason.
 *
 * It clears on a header rather than on a timer, because "fixed" is a thing the
 * next authorization knows for certain: a key put back, or a challenge endpoint
 * that started answering again. A problem that comes back after that is news a
 * second time.
 *
 * The report goes through the watcher's `Emit`, never to stderr, so a `--json`
 * consumer sees it. A consumer that cannot see the diagnosis is a consumer that
 * does not get it at all.
 */

import type { Authorization } from './credential'
import type { Emit } from './watch'

/** The event name, which is documented output (packages/agentgit/README.md). */
export const CREDENTIAL_PROBLEM = 'credential-problem'

/**
 * The problems one process has already said out loud, per origin.
 *
 * Shared by the watcher's socket and the Proposals read, so whichever of them
 * notices first is the one that explains it and the other stays quiet — a 401
 * on the Proposals read of a machine with no signing key has one cause and
 * deserves one sentence.
 */
export interface CredentialProblems {
  /**
   * What one authorization decided, for one origin.
   *
   * A `problem` is emitted the first time and latched; a `header` clears the
   * latch; `none` — the ordinary public case — is neither, because a host that
   * publishes no challenge has told us nothing about this machine's keys.
   */
  report(origin: string, answer: Authorization): void
  /**
   * Where the reports go.
   *
   * The watcher owns the emitter and is constructed after this object is —
   * `src/resolve.ts` builds the latch so the Proposals lookup can hold it — so
   * the sink is attached rather than passed in. Before it is attached nothing
   * is emitted AND nothing is latched, so the first real report is never the
   * one that was swallowed.
   */
  through(emit: Emit): void
}

export function credentialProblems(emit: Emit | null = null): CredentialProblems {
  /** `origin` → the problem codes already reported for it. */
  const said = new Map<string, Set<string>>()
  let sink = emit

  return {
    through(next) {
      sink = next
    },
    report(origin, answer) {
      if (sink === null) return
      if (answer.kind === 'none') return
      if (answer.kind === 'header') {
        said.delete(origin)
        return
      }
      const seen = said.get(origin) ?? new Set<string>()
      if (seen.has(answer.code)) return
      seen.add(answer.code)
      said.set(origin, seen)
      sink(
        CREDENTIAL_PROBLEM,
        { origin, code: answer.code, problem: answer.message },
        `${origin}: ${answer.message}`,
      )
    },
  }
}
