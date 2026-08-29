/**
 * What the fan-out remembers about refs.
 *
 * A handshake needs the current sha of everything a subscriber watches, and in
 * the first cut that always asked the container — so a connect could wake a
 * sleeping container to be told what the fan-out had just finished announcing.
 * This is the copy that removes that: ask once per repository, then answer from
 * memory and keep it current from the announcements already flowing through.
 *
 * The copy is DERIVED and never authoritative. `index.json` remains the source
 * of truth for refs (docs/adr/0007) and gains no field; on a miss the answer
 * still comes from it, through the container. Nothing here is written to
 * Durable Object storage, deliberately: state that survives in the object would
 * be a database beside the log, and would cost the two properties the log buys
 * — a repository restorable from the bucket alone, and an operator CLI that
 * reads the bucket from outside Cloudflare entirely. Losing this cache costs a
 * container round-trip, which is the correct price for a cache.
 *
 * Pure: a Map, no I/O, no runtime. That is why it lives in `shared/` and is a
 * module of its own rather than fields on the Durable Object, and why its
 * behaviour is tested from `src/` with the rest of the suite.
 */

import type { RefEvent } from './events'

/** A repository's full ref state, exactly as the Index reports it. */
export type Refs = Record<string, string>

/**
 * How many repositories one fan-out remembers.
 *
 * A bound rather than a growing map, because the object is long-lived and the
 * set of repositories it is asked about is not bounded by anything else. The
 * oldest-filled entry goes first; evicting one costs a container round-trip on
 * the next connect for it, and nothing more.
 */
export const MAX_CACHED_REPOS = 512

export class RefCache {
  /** Insertion-ordered, so the oldest fill is the first eviction candidate. */
  private readonly refsByRepo = new Map<string, Refs>()

  constructor(private readonly maxRepos: number = MAX_CACHED_REPOS) {}

  /** Is this repository's ref state known here? */
  has(repo: string): boolean {
    return this.refsByRepo.has(repo)
  }

  /** The repositories out of these that still have to be read from the Index. */
  missing(repos: readonly string[]): string[] {
    return repos.filter((repo) => !this.refsByRepo.has(repo))
  }

  /**
   * Record a repository's full ref state, as read from the Index.
   *
   * Whole-repository only: a partial fill would be indistinguishable from a
   * complete one at read time, and a whole-repository handshake would then
   * answer with a subset and look authoritative doing it.
   */
  fill(repo: string, refs: Refs): void {
    this.refsByRepo.delete(repo)
    this.refsByRepo.set(repo, { ...refs })
    while (this.refsByRepo.size > this.maxRepos) {
      const oldest = this.refsByRepo.keys().next()
      if (oldest.done) break
      this.refsByRepo.delete(oldest.value)
    }
  }

  /** Everything known for these repositories, in the shape `handshake` takes. */
  read(repos: readonly string[]): Record<string, Refs> {
    const byRepo: Record<string, Refs> = {}
    for (const repo of repos) {
      const refs = this.refsByRepo.get(repo)
      if (refs) byRepo[repo] = refs
    }
    return byRepo
  }

  /**
   * Fold announced events into what is known.
   *
   * An event for a repository this cache has never filled is DROPPED rather
   * than used to start an entry: one ref is not a repository's ref state, and
   * an entry built from events alone would answer a later whole-repository
   * watch with whatever happened to have moved since. A miss is cheap; a
   * confidently wrong hit is not.
   *
   * A deletion (`sha: null`) removes the ref, so the cache says what the Index
   * says rather than remembering a ref that is gone.
   */
  apply(events: readonly RefEvent[]): void {
    for (const event of events) {
      const refs = this.refsByRepo.get(event.repo)
      if (!refs) continue
      if (event.sha === null) delete refs[event.ref]
      else refs[event.ref] = event.sha
    }
  }

  /** How many repositories are remembered. For tests and for the bound. */
  get size(): number {
    return this.refsByRepo.size
  }
}
