/**
 * The scenarios from the walgit design, as executable specs.
 *
 * They are numbered and worded to match the design so a reader can hold the
 * document and this file side by side. Each one returns the observations it
 * made, and the runner prints them — a scenario that passes silently is a
 * scenario nobody can tell was weakened, and several of these could be
 * weakened into tautologies without changing a single assertion.
 *
 * See docs/adr/0007-walgit-object-storage-holds-the-log.md in the zbc
 * repository for why the first seven are the ones that matter; scenario 8 is
 * the ref-event stream of docs/adr/0009.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { compact } from '../src/compact'
import { collectGarbage } from '../src/gc'
import { materialize } from '../src/materialize'
import { resolveRepo } from '../src/repo'
import { loadIndex, type WalIndex } from '../src/wal-index'
import { LATENCY_BASELINE, type LatencyCeiling } from './latency-baseline'
import { EventsEndpoint, clone, commit, git, gitOk, sleep, type Run } from './harness'

export interface Scenario {
  n: number
  name: string
  run(run: Run, opts: ScenarioOptions): Promise<string[]>
}

export interface ScenarioOptions {
  /** Halve the expensive scenarios. The runner discloses when this is on. */
  quick: boolean
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** `git log --all` plus every ref, the two halves of "the same history". */
async function history(gitDir: string): Promise<{ refs: string; log: string }> {
  const refs = await gitOk(gitDir, '--git-dir', gitDir, 'show-ref')
  const log = await gitOk(gitDir, '--git-dir', gitDir, 'log', '--all', '--format=%H')
  return {
    refs: refs.trim().split('\n').sort().join('\n'),
    log: log.trim().split('\n').sort().join('\n'),
  }
}

/** Rebuild `repoId` from `index` into a directory nothing has ever touched. */
async function coldRestore(run: Run, repoId: string, index: WalIndex, tag: string) {
  const reposDir = run.dir(`cold-${tag}`)
  const repo = resolveRepo(reposDir, repoId)
  const result = await materialize(run.store, repo, index)
  return { dir: repo.dir, stats: result.stats }
}

// ── 1. Durability ───────────────────────────────────────────────────────────

const durability: Scenario = {
  n: 1,
  name: 'Durability — push, kill -9 the node after ACK, materialize on a fresh node',
  async run(run) {
    const repoId = run.repoId('durability')
    const a = await run.node('a')
    const work = await clone(run, a, repoId, 'work')
    const oid = await commit(work, 'durable\n')

    const pushed = await git(work, 'push', 'origin', 'HEAD:refs/heads/main')
    assert(pushed.status === 0, `push was not acknowledged:\n${pushed.out}`)

    // No grace, no drain, no chance to flush anything: the acknowledgement had
    // to have been earned before it was given, or it was never true.
    a.kill()

    const b = await run.node('b')
    const restored = await clone(run, b, repoId, 'restored')
    const seen = (await gitOk(restored, 'rev-parse', 'HEAD')).trim()
    assert(seen === oid, `fresh node served ${seen}, expected ${oid}`)

    const { index } = await loadIndex(run.store, repoId)
    assert(index.refs['refs/heads/main'] === oid, 'the log does not name the pushed commit')

    const replayed = (await coldRestore(run, repoId, index, 'd')).stats.fetched
    return [
      `commit ${oid.slice(0, 8)} acknowledged, node SIGKILLed, served by a node with an empty disk`,
      `restore replayed ${replayed} WAL ${replayed === 1 ? 'entry' : 'entries'}`,
    ]
  },
}

// ── 2. No phantom ACKs ──────────────────────────────────────────────────────

/**
 * The kill points, enumerated rather than exhaustive — and enumerated HERE, in
 * one list, so that adding a step to the push path without adding it to this
 * list is a visible omission rather than a silent gap in coverage.
 *
 * `after-upload` / `before-cas` / `after-cas` are named points in
 * `src/hook-main.ts`; the process genuinely exits at them. `group-kill` is not
 * a named point at all — it is `SIGKILL` to the node's process group at an
 * arbitrary moment during a push, which lands wherever it lands. It is in the
 * list because an enumerated set can only ever prove the points someone
 * thought of, and this one is the check on that.
 */
const KILL_POINTS = ['after-upload', 'before-cas', 'after-cas', 'group-kill'] as const

const noPhantomAcks: Scenario = {
  n: 2,
  name: 'No phantom ACKs — at every kill point, a success means the commit is durable',
  async run(run) {
    const notes: string[] = []

    for (const point of KILL_POINTS) {
      const repoId = run.repoId(`phantom-${point}`)
      const node = await run.node(
        `phantom-${point}`,
        point === 'group-kill' ? {} : { WALGIT_FAULT: point },
      )
      const work = await clone(run, node, repoId, 'work')
      const oid = await commit(work, `${point}\n`)

      let pushed
      if (point === 'group-kill') {
        const pushing = git(work, 'push', 'origin', 'HEAD:refs/heads/main')
        // Long enough for the pack to be in flight and the hooks to be
        // running; short enough that the push is not already finished.
        await sleep(120)
        node.kill()
        pushed = await pushing
      } else {
        pushed = await git(work, 'push', 'origin', 'HEAD:refs/heads/main')
        node.kill()
      }

      const { index } = await loadIndex(run.store, repoId)
      const durable = index.refs['refs/heads/main'] === oid

      // The invariant, stated as the design states it: the forbidden outcome
      // is a client told "yes" over a log that does not have the commit.
      assert(
        !(pushed.status === 0 && !durable),
        `PHANTOM ACK at ${point}: git push exited 0 but the WAL does not name ${oid}`,
      )
      notes.push(
        `${point}: client ${pushed.status === 0 ? 'ACKed' : `rejected (${pushed.status})`}, ` +
          `WAL ${durable ? 'has' : 'does not have'} the commit — invariant holds`,
      )
    }

    notes.push(`kill points are an enumerated list of ${KILL_POINTS.length}, not exhaustive`)
    return notes
  },
}

// ── 3. Linearizability ──────────────────────────────────────────────────────

const linearizability: Scenario = {
  n: 3,
  name: 'Linearizability — two nodes push the same ref at once; exactly one wins',
  async run(run) {
    const repoId = run.repoId('linearizable')
    const a = await run.node('a')
    const b = await run.node('b')

    const seed = await clone(run, a, repoId, 'seed')
    await commit(seed, 'seed\n')
    assert(
      (await git(seed, 'push', 'origin', 'HEAD:refs/heads/main')).status === 0,
      'the seed push failed',
    )

    // Two clones from two DIFFERENT nodes: the race is then resolved by the
    // store's compare-and-swap, not by two hooks sharing one machine's lock.
    const left = await clone(run, a, repoId, 'left')
    const right = await clone(run, b, repoId, 'right')
    const leftOid = await commit(left, 'left\n')
    const rightOid = await commit(right, 'right\n')

    const [pushLeft, pushRight] = await Promise.all([
      git(left, 'push', 'origin', 'HEAD:refs/heads/main'),
      git(right, 'push', 'origin', 'HEAD:refs/heads/main'),
    ])

    const winners = [pushLeft, pushRight].filter((r) => r.status === 0)
    assert(
      winners.length === 1,
      `expected exactly one winner, got ${winners.length}\nleft:\n${pushLeft.out}\nright:\n${pushRight.out}`,
    )

    const loser = pushLeft.status === 0 ? pushRight : pushLeft
    const loserOid = pushLeft.status === 0 ? rightOid : leftOid

    // "Clean" is asserted as STATE, not as text. The rejection reaches the
    // client as a sideband disconnect rather than a per-ref message, because
    // the compare-and-swap is lost in `reference-transaction` and git does not
    // relay that hook's stderr to the pusher — so a text assertion here would
    // be asserting a limitation. What must be true is that the loser changed
    // nothing: it consumed no sequence number, its commit is not in the log,
    // and its own remote-tracking ref did not advance.
    assert(loser.status !== 0, 'the loser was not rejected')

    const { index } = await loadIndex(run.store, repoId)
    assert(
      index.refs['refs/heads/main'] !== loserOid,
      'the log named the loser — both pushes were published',
    )
    const seqs = index.entries.map((e) => e.seq)
    assert(
      seqs.every((s, i) => s === i + 1),
      `index seq is not contiguous: ${seqs.join(',')}`,
    )
    const head = index.refs['refs/heads/main']
    assert(
      head === (pushLeft.status === 0 ? leftOid : rightOid),
      'the log published a ref neither winner pushed',
    )

    const loserTracking = (
      await gitOk(loser === pushLeft ? left : right, 'rev-parse', 'refs/remotes/origin/main')
    ).trim()
    assert(loserTracking !== loserOid, "the loser's remote-tracking ref advanced anyway")

    return [
      `winner ${head!.slice(0, 8)}, loser ${loserOid.slice(0, 8)} rejected (exit ${loser.status}) ` +
        'and published nothing',
      `index seq contiguous: ${seqs.join(',')}`,
      'NOTE: the loser sees a sideband disconnect, not a per-ref rejection message — ' +
        'git does not relay reference-transaction stderr to the client',
    ]
  },
}

// ── 4. Cold restore fidelity ────────────────────────────────────────────────

const coldRestoreFidelity: Scenario = {
  n: 4,
  name: 'Cold restore fidelity — 100 pushes, 5 branches, 3 tags, matched against a reference clone',
  async run(run, opts) {
    const pushes = opts.quick ? 20 : 100
    const branches = ['main', 'feature-a', 'feature-b', 'release', 'wip']
    const repoId = run.repoId('fidelity')
    const a = await run.node('a')
    const work = await clone(run, a, repoId, 'work')

    // Establish main first — the other branches fork from it, which is what
    // makes the restored history a graph rather than five straight lines.
    await commit(work, 'base\n')
    await gitOk(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')

    // Each branch forks from main ONCE and then advances on its own. Re-forking
    // it every visit would rewind it, and the push would be refused as a
    // non-fast-forward — which would be the fixture failing, not walgit.
    const created = new Set(['main'])
    for (let i = 1; i < pushes; i += 1) {
      const branch = branches[i % branches.length]!
      if (created.has(branch)) await gitOk(work, 'checkout', '--quiet', branch)
      else {
        await gitOk(work, 'checkout', '--quiet', '-b', branch, 'main')
        created.add(branch)
      }
      await commit(work, `commit ${i} on ${branch}\n`)
      await gitOk(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)
    }

    for (const [i, name] of ['v1', 'v2', 'v3'].entries()) {
      await gitOk(work, 'tag', '-f', name, `refs/remotes/origin/${branches[i]!}`)
    }
    await gitOk(work, 'push', '--quiet', '--force', 'origin', '--tags')

    // The reference is a bare clone taken from the WARM node, i.e. from git's
    // own view of the repository, never from the WAL.
    const referenceParent = run.dir('reference')
    const reference = path.join(referenceParent, 'reference.git')
    await gitOk(referenceParent, 'clone', '--quiet', '--bare', a.origin(repoId), reference)

    a.kill()
    const { index } = await loadIndex(run.store, repoId)
    const { dir: restored } = await coldRestore(run, repoId, index, 'fidelity')

    const ref = await history(reference)
    const got = await history(restored)
    assert(
      ref.refs === got.refs,
      `refs differ:\n--- reference\n${ref.refs}\n--- restored\n${got.refs}`,
    )
    assert(ref.log === got.log, 'git log --all differs between the reference clone and the restore')

    const fsck = await git(restored, '--git-dir', restored, 'fsck', '--no-progress')
    assert(fsck.status === 0, `git fsck failed on the restored repo:\n${fsck.out}`)

    const refCount = ref.refs.split('\n').length
    const logCount = ref.log.split('\n').length
    return [
      `${pushes} pushes across ${branches.length} branches and 3 tags`,
      `${refCount} refs and ${logCount} commits identical to the reference clone; git fsck clean`,
      opts.quick ? `QUICK MODE: ${pushes} pushes instead of the design's 100` : '',
    ].filter(Boolean)
  },
}

// ── 5. Compaction safety ────────────────────────────────────────────────────

const compactionSafety: Scenario = {
  n: 5,
  name: 'Compaction safety — restores from before, during and after a compaction agree',
  async run(run, opts) {
    const pushes = opts.quick ? 6 : 15
    const repoId = run.repoId('compaction')
    const a = await run.node('a')
    const work = await clone(run, a, repoId, 'work')
    for (let i = 0; i < pushes; i += 1) {
      await commit(work, `commit ${i}\n`)
      await gitOk(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
    }

    const before = (await loadIndex(run.store, repoId)).index
    const beforeRestore = await coldRestore(run, repoId, before, 'before')

    // "During" is a restore that read `index.json` a moment before the
    // compaction's compare-and-swap and is still downloading afterwards. It is
    // reproduced by holding the pre-compaction index and replaying it while
    // the compaction runs — which is exactly the window that makes tombstones
    // rather than deletions the only safe way to supersede an entry.
    const compacting = compact(run.store, resolveRepo(run.dir('compactor'), repoId), {
      force: true,
      graceMs: 60 * 60 * 1000,
    })
    const duringRestore = await coldRestore(run, repoId, before, 'during')
    const result = await compacting
    assert(result.status === 'compacted', `compaction did not run: ${result.status}`)

    const after = (await loadIndex(run.store, repoId)).index
    assert(after.compaction_frontier > 0, 'compaction did not advance the frontier')
    const afterRestore = await coldRestore(run, repoId, after, 'after')

    const [h1, h2, h3] = await Promise.all([
      history(beforeRestore.dir),
      history(duringRestore.dir),
      history(afterRestore.dir),
    ])
    assert(h1.log === h2.log, 'a restore started before the compaction saw different history')
    assert(h1.log === h3.log, 'a restore after the compaction saw different history')
    assert(h1.refs === h3.refs, 'refs differ across the compaction')

    return [
      `${pushes} pushes compacted to frontier ${after.compaction_frontier}`,
      `restore replays ${beforeRestore.stats.fetched} entries before, ${afterRestore.stats.fetched} after`,
      'before / during / after produce identical history',
      opts.quick ? `QUICK MODE: ${pushes} pushes instead of 15` : '',
    ].filter(Boolean)
  },
}

// ── 6. Idle round-trip ──────────────────────────────────────────────────────

const idleRoundTrip: Scenario = {
  n: 6,
  name: 'Idle round-trip — push, GC, fetch, push again, with nothing lost',
  async run(run) {
    const repoId = run.repoId('idle')
    const a = await run.node('a')
    const work = await clone(run, a, repoId, 'work')
    const first = await commit(work, 'first\n')
    await gitOk(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')

    // The machine going away is the normal case for this app, not a fault:
    // `min_machines_running = 0` means every idle period ends in exactly this.
    a.kill()

    // GC with no grace at all — the harshest possible collection, deleting
    // everything it is ever entitled to delete. Anything it takes that a
    // restore still needs shows up as a failure two lines below.
    const gc = await collectGarbage(run.store, repoId, { graceMs: 0 })

    const b = await run.node('b')
    const fetched = await clone(run, b, repoId, 'fetched')
    assert(
      (await gitOk(fetched, 'rev-parse', 'HEAD')).trim() === first,
      'the fetch after GC did not return the pushed commit',
    )

    const second = await commit(fetched, 'second\n')
    assert(
      (await git(fetched, 'push', 'origin', 'HEAD:refs/heads/main')).status === 0,
      'the push after an idle round-trip was rejected',
    )
    b.kill()

    const c = await run.node('c')
    const final = await clone(run, c, repoId, 'final')
    assert((await gitOk(final, 'rev-parse', 'HEAD')).trim() === second, 'the second push was lost')
    const log = await gitOk(final, 'log', '--format=%H')
    assert(log.includes(first), 'the first commit did not survive the round-trip')

    return [
      `gc collected ${gc.collected.length} superseded and ${gc.orphansCollected.length} orphaned objects`,
      'both commits present after two machine deaths and a zero-grace collection',
    ]
  },
}

// ── 7. Restore latency ──────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1)]!
}

const restoreLatency: Scenario = {
  n: 7,
  name: 'Restore latency — p50/p99 cold materialize, gated against a committed baseline',
  async run(run, opts) {
    const ceilings = loadCeilings()
    const sizes = opts.quick ? [1, 10] : [1, 10, 50]
    const runs = opts.quick ? 5 : 11
    const notes: string[] = [
      'measures WAL replay ONLY — container cold start (median 1.77s, Containers spike) is excluded, ' +
        'because blending the two makes a regression unattributable',
    ]
    const breaches: string[] = []

    for (const size of sizes) {
      const repoId = run.repoId(`latency-${size}`)
      const node = await run.node(`lat-${size}`)
      const work = await clone(run, node, repoId, `w${size}`)
      for (let i = 0; i < size; i += 1) {
        await commit(work, `commit ${i}\n${'x'.repeat(512)}\n`)
        await gitOk(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
      }

      const raw = (await loadIndex(run.store, repoId)).index
      const rawSamples = await sample(run, repoId, raw, `raw${size}`, runs)

      const result = await compact(run.store, resolveRepo(run.dir(`c${size}`), repoId), {
        force: true,
        graceMs: 60 * 60 * 1000,
      })
      assert(result.status === 'compacted', `compaction for size ${size}: ${result.status}`)
      const compacted = (await loadIndex(run.store, repoId)).index
      const compactedSamples = await sample(run, repoId, compacted, `c${size}`, runs)
      node.kill()

      const ceiling = ceilings[String(size)]
      const report = (label: string, s: Awaited<ReturnType<typeof sample>>) =>
        `entries=${size} ${label}: total p50=${s.totalP50}ms p99=${s.totalP99}ms ` +
        `(fetch p50=${s.fetchP50}ms, init+refs p50=${s.overheadP50}ms)`
      notes.push(report('raw', rawSamples), report('compacted', compactedSamples))

      if (!ceiling) {
        // Never silently. An unbaselined size is coverage the suite does not
        // have, and saying so is the difference between a gap and a lie.
        notes.push(`entries=${size}: NO BASELINE — measured but not gated`)
        continue
      }
      // The compacted number is the one that must stay flat: a restore replays
      // one entry however many pushes the repository has taken, so growth here
      // is a real regression rather than a bigger repository.
      if (compactedSamples.totalP50 > ceiling.p50) {
        breaches.push(
          `entries=${size} compacted p50 ${compactedSamples.totalP50}ms > ${ceiling.p50}ms`,
        )
      }
      if (compactedSamples.totalP99 > ceiling.p99) {
        breaches.push(
          `entries=${size} compacted p99 ${compactedSamples.totalP99}ms > ${ceiling.p99}ms`,
        )
      }
    }

    if (opts.quick) notes.push(`QUICK MODE: sizes ${sizes.join(',')} × ${runs} runs`)

    assert(
      breaches.length === 0,
      `restore latency regressed against ${baselinePath() ?? 'the committed baseline'}:\n  ` +
        breaches.join('\n  ') +
        '\n\nThis is a control loop, not a broken build: the knob is ' +
        'WALGIT_COMPACTION_THRESHOLD, not this code. If the new numbers are ' +
        'legitimately the cost of a faster runner or a real bucket, re-baseline ' +
        'deliberately in e2e/latency-baseline.ts rather than raising them by reflex.',
    )
    return notes
  },
}

async function sample(run: Run, repoId: string, index: WalIndex, tag: string, runs: number) {
  const totals: number[] = []
  const fetches: number[] = []
  const overheads: number[] = []
  for (let i = 0; i < runs; i += 1) {
    // A fresh directory every run: a warm disk would measure a `readdir`,
    // which is not the operation anyone is waiting on.
    const { dir, stats } = await coldRestore(run, repoId, index, `${tag}-${i}`)
    totals.push(stats.totalMs)
    fetches.push(stats.fetchMs)
    overheads.push(stats.initMs + stats.refsMs)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const round = (n: number) => Math.round(n)
  return {
    totalP50: round(percentile(totals, 50)),
    totalP99: round(percentile(totals, 99)),
    fetchP50: round(percentile(fetches, 50)),
    overheadP50: round(percentile(overheads, 50)),
  }
}

function baselinePath(): string | null {
  return process.env.WALGIT_E2E_LATENCY_BASELINE ?? null
}

/** The committed ceilings, or an operator-supplied file for a different machine. */
function loadCeilings(): Record<string, LatencyCeiling> {
  const override = baselinePath()
  if (!override) return LATENCY_BASELINE
  return JSON.parse(fs.readFileSync(override, 'utf8')) as Record<string, LatencyCeiling>
}

// ── 8. Ref events ───────────────────────────────────────────────────────────

/**
 * How long a push that must announce NOTHING is given to prove it.
 *
 * A negative is only as strong as the wait behind it: assert immediately and
 * the scenario passes because the announcement had not arrived yet. This is an
 * announcement over loopback from a hook that has already exited, so a second
 * is orders of magnitude more than it needs.
 */
const SILENCE_WINDOW_MS = 1_000

const refEvents: Scenario = {
  n: 8,
  name: 'Ref events — a subscriber sees a real push, and never sees one that lost',
  async run(run) {
    const repoId = run.repoId('events')
    const endpoint = new EventsEndpoint()
    await endpoint.start()
    try {
      // Both nodes announce to the same endpoint, which is what makes the
      // third check possible: the loser of a compare-and-swap has somewhere to
      // announce to, and still announces nothing.
      const eventsEnv = {
        WALGIT_EVENTS_URL: endpoint.url,
        WALGIT_EVENTS_TOKEN: endpoint.token,
      }
      const a = await run.node('events-a', eventsEnv)
      const b = await run.node('events-b', eventsEnv)
      endpoint.refsFrom(a)

      const work = await clone(run, a, repoId, 'work')
      const seed = await commit(work, 'seed\n')
      assert(
        (await git(work, 'push', 'origin', 'HEAD:refs/heads/main')).status === 0,
        'the seed push failed',
      )

      // Subscribed AFTER the seed push, so the handshake has something to be
      // right about: a subscriber that connects to a repository already in
      // motion must be told where it stands before any event fires.
      const subscriber = await endpoint.subscribe([{ repo: repoId }])
      const handshakeMain = subscriber.handshake?.refs.find((r) => r.ref === 'refs/heads/main')
      assert(
        handshakeMain?.sha === seed,
        `handshake said ${handshakeMain?.sha ?? 'nothing'} for main, expected ${seed}`,
      )

      // 1. A real push, over a real socket.
      const pushed = await commit(work, 'pushed\n')
      assert(
        (await git(work, 'push', 'origin', 'HEAD:refs/heads/main')).status === 0,
        'the push under observation failed',
      )
      const advanced = await subscriber.next((e) => e.ref === 'refs/heads/main' && e.sha === pushed)

      // 2. A ref-only push. `git push` sends no pack at all here — the objects
      // are already on the server — so a hook path that only fires when
      // something was uploaded would pass every other check and fail this one.
      const beforeRelease = subscriber.events.length
      assert(
        (await git(work, 'push', 'origin', 'refs/heads/main:refs/heads/release')).status === 0,
        'the ref-only push failed',
      )
      const release = await subscriber.next(
        (e) => e.ref === 'refs/heads/release' && e.sha === pushed,
      )
      assert(
        subscriber.events.length > beforeRelease,
        'the ref-only push arrived as no new message',
      )

      // 3. The loser announces nothing. Two clones from two different nodes,
      // as in scenario 3, so the race is resolved by the store's
      // compare-and-swap rather than by one machine's lock — and the push that
      // loses it never reaches `post-receive`, which is the ordering the
      // announcement's correctness rests on (src/announce.ts).
      const left = await clone(run, a, repoId, 'left')
      const right = await clone(run, b, repoId, 'right')
      const leftOid = await commit(left, 'left\n')
      const rightOid = await commit(right, 'right\n')
      const [pushLeft, pushRight] = await Promise.all([
        git(left, 'push', 'origin', 'HEAD:refs/heads/main'),
        git(right, 'push', 'origin', 'HEAD:refs/heads/main'),
      ])
      const winners = [pushLeft, pushRight].filter((r) => r.status === 0)
      assert(
        winners.length === 1,
        `expected exactly one winner, got ${winners.length}\nleft:\n${pushLeft.out}\nright:\n${pushRight.out}`,
      )
      const winnerOid = pushLeft.status === 0 ? leftOid : rightOid
      const loserOid = pushLeft.status === 0 ? rightOid : leftOid

      await subscriber.next((e) => e.ref === 'refs/heads/main' && e.sha === winnerOid)
      await sleep(SILENCE_WINDOW_MS)
      // Asserted against what the endpoint was TOLD, not against what the
      // socket received: an announcement the fan-out happened to drop would
      // otherwise read as a push that never announced.
      assert(
        !endpoint.announced.some((e) => e.sha === loserOid),
        `the loser ${loserOid.slice(0, 8)} was announced`,
      )
      assert(
        !subscriber.events.some((e) => e.sha === loserOid),
        `the loser ${loserOid.slice(0, 8)} reached the subscriber`,
      )

      const { index } = await loadIndex(run.store, repoId)
      assert(
        index.refs['refs/heads/main'] === winnerOid,
        'the log does not name the push the subscriber was told about',
      )

      return [
        `handshake reported main at ${seed.slice(0, 8)} from the Index before any event`,
        `push ${pushed.slice(0, 8)} reached the subscriber as ${advanced.ref} over a real socket`,
        `ref-only push (no pack) reached it as ${release.ref} at ${release.sha?.slice(0, 8)}`,
        `the compare-and-swap loser ${loserOid.slice(0, 8)} announced nothing in ` +
          `${SILENCE_WINDOW_MS}ms; the winner ${winnerOid.slice(0, 8)} arrived`,
        'NOTE: the sockets are held by a Bun server, not a Durable Object — the ' +
          'decisions are worker/events.ts and worker/outbox.ts either way',
      ]
    } finally {
      endpoint.stop()
    }
  },
}

export const SCENARIOS: Scenario[] = [
  durability,
  noPhantomAcks,
  linearizability,
  coldRestoreFidelity,
  compactionSafety,
  idleRoundTrip,
  restoreLatency,
  refEvents,
]
