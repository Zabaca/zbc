#!/usr/bin/env bun
/**
 * One bounded load run against a walgit DEPLOYMENT.
 *
 *     bun run e2e/load.ts --origin https://agentgit.zabaca.com
 *     bun run e2e/load.ts --origin https://… --clones 8 --pushes 8 --watchers 8 --json run.json
 *
 * `suite.ts` measures one stream against a node it starts itself, which is the
 * right shape for a regression gate and answers nothing about capacity: it has
 * no edge, no Durable Object, no R2 and no contention. `live.ts` asks a
 * deployment a yes/no question about its configuration. Neither produces a
 * NUMBER for the question an operator actually has before handing the URL to a
 * crowd — how many at once, and what gives way first.
 *
 * This does, for the three things a visitor does: clone, push, and subscribe to
 * the ref-event stream. Every workload is real (`git` over HTTP, a real
 * WebSocket); nothing here is stood in for, because a deployment is the thing
 * being measured.
 *
 * ## What it spends, and why it refuses to spend more
 *
 * Every seeded repository is a NEW NAME and every push is a push, against a
 * deployment that may rate-limit both per source (docs: the `WALGIT_MAX_*_PER_SOURCE`
 * block in the instance). `parseLoadArgs` refuses a plan that would take more
 * than half of agentgit production's hourly per-source budget: a run that spends
 * it measures `src/rate-limit.ts` rather than the service, and leaves the rest
 * of the hour unmeasurable for whoever runs next from the same address — which
 * behind a NAT is more people than the operator.
 *
 * The run is also ordered so that the cheap questions are answered first:
 * seeding is sequential (it is the reference number, uncontended), then the
 * clone burst, then the push burst, then the fan-out. A saturated container
 * shows up in the later phases, and stopping early still leaves a usable
 * report rather than nothing.
 *
 * ## What it leaves behind
 *
 * `load-<run id>-*` repositories on the origin, world-readable, named on the
 * way out. On a deployment with a retention window they are collected by it;
 * on one without, they are permanent — which is stated rather than assumed,
 * because this file must not be the reason a private host fills up.
 *
 * ## Exit codes
 *
 * | 0  | the run completed — read the report for the verdict |
 * | 1  | the origin could not be measured at all |
 * | 64 | the arguments were wrong |
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type OpSummary,
  type Sample,
  nameBottleneck,
  parseLoadArgs,
  summarize,
} from './load-report'

const parsed = parseLoadArgs(Bun.argv.slice(2))
if (!parsed.ok) {
  console.error(`walgit load: ${parsed.error}`)
  process.exit(64)
}
const options = parsed.value

const runId = Math.random().toString(36).slice(2, 8)
const scratch = mkdtempSync(join(tmpdir(), 'walgit-load-'))

/**
 * The repositories this run actually created, each with the working copy it
 * was pushed from.
 *
 * The pair travels together rather than as two lists indexed in parallel: a
 * seed that FAILS leaves a gap, and a later phase indexing names by the
 * position it seeded from would push one repository's working copy at another
 * repository's name — arriving as a non-fast-forward and being recorded as the
 * host giving way under load, which is the one mistake this tool exists to
 * avoid making.
 */
const seeded: { name: string; dir: string }[] = []

process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

/** `git`, with the ambient config out of the way, as the suite runs it. */
async function git(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
    },
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, stderr }
}

/**
 * One timed attempt.
 *
 * A rate-limit refusal is its own outcome rather than an error: the two mean
 * opposite things about a deployment — one is the host working exactly as
 * configured, the other is it failing — and a report that blends them says
 * neither. `pre-receive` speaks the refusal, so it arrives as a `remote:`
 * line on stderr with walgit's own words in it.
 */
async function timed(run: () => Promise<{ code: number; stderr: string }>): Promise<Sample> {
  const started = Bun.nanoseconds()
  const { code, stderr } = await run()
  const ms = (Bun.nanoseconds() - started) / 1e6
  if (code === 0) return { ms, outcome: 'ok' }
  const limited = stderr.includes('This is a walgit limit')
  return {
    ms,
    outcome: limited ? 'limited' : 'error',
    detail: firstMeaningfulLine(stderr),
  }
}

function firstMeaningfulLine(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((each) => each.replace(/^remote:\s*/, '').trim())
    .find((each) => each.length > 0 && !each.startsWith('Cloning into'))
  return (line ?? 'no output').slice(0, 200)
}

/** Run `count` tasks with no more than `count` in flight — the burst IS the point. */
async function burst<T>(count: number, task: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => task(index)))
}

async function seedRepo(index: number): Promise<Sample> {
  const name = `load-${runId}-${index}`
  const dir = join(scratch, `seed-${index}`)
  await Bun.write(join(dir, 'README.md'), `walgit load run ${runId}, repository ${index}\n`)
  await git(['init', '-q', '-b', 'main'], dir)
  await git(['add', '-A'], dir)
  await git(
    ['-c', 'user.email=load@localhost', '-c', 'user.name=load', 'commit', '-q', '-m', 'seed'],
    dir,
  )
  const sample = await timed(() =>
    git(['push', '-q', `${options.origin}/${name}.git`, 'HEAD:refs/heads/main'], dir),
  )
  if (sample.outcome === 'ok') seeded.push({ name, dir })
  return sample
}

async function cloneOnce(index: number): Promise<Sample> {
  const { name } = seeded[index % seeded.length] as { name: string; dir: string }
  return timed(() =>
    git(['clone', '-q', `${options.origin}/${name}.git`, join(scratch, `clone-${index}`)], scratch),
  )
}

/**
 * One more commit onto a repository this run already owns.
 *
 * Distinct repositories per worker, deliberately: concurrent pushes to the SAME
 * ref lose the compare-and-swap and would be measuring git's non-fast-forward
 * refusal rather than the host's throughput.
 */
async function pushOnce(index: number): Promise<Sample> {
  const { name, dir } = seeded[index % seeded.length] as { name: string; dir: string }
  await Bun.write(join(dir, `change-${index}.txt`), `${index} ${Date.now()}\n`)
  await git(['add', '-A'], dir)
  await git(
    [
      '-c',
      'user.email=load@localhost',
      '-c',
      'user.name=load',
      'commit',
      '-q',
      '-m',
      `change ${index}`,
    ],
    dir,
  )
  return timed(() =>
    git(['push', '-q', `${options.origin}/${name}.git`, 'HEAD:refs/heads/main'], dir),
  )
}

interface Watcher {
  handshake: Sample
  /**
   * `Bun.nanoseconds()` at the moment the event for the target repository
   * arrived, or null if none did.
   *
   * An absolute instant rather than a duration, because the interval that means
   * anything — fan-out — starts at the wake-up push, which has not happened
   * when the socket opens. The caller subtracts.
   */
  arrivedAt: Promise<number | null>
  close: () => void
}

/**
 * One subscriber on the ref-event stream: connect, `watch`, wait for the
 * handshake, then wait for the event the wake-up push produces.
 *
 * The handshake is timed separately from delivery because they fail
 * differently — the first is the Durable Object reading the Index once per
 * repository named, the second is fan-out — and a report that adds them
 * together cannot tell a slow subscribe from a slow push.
 */
function openWatcher(repos: readonly string[], target: string): Promise<Watcher> {
  const url = `${options.origin.replace(/^http/, 'ws')}/_walgit/events`
  const started = Bun.nanoseconds()
  return new Promise<Watcher>((resolve) => {
    const socket = new WebSocket(url)
    let handshaken = false
    let resolveDelivered: (value: number | null) => void = () => {}
    const arrivedAt = new Promise<number | null>((done) => {
      resolveDelivered = done
    })

    const settle = (handshake: Sample) =>
      resolve({
        handshake,
        arrivedAt,
        close: () => {
          resolveDelivered(null)
          try {
            socket.close()
          } catch {
            // Already gone; a closed socket is the state we wanted.
          }
        },
      })

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ watch: repos.map((repo) => ({ repo })) }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        ok?: true
        error?: string
        repo?: string
        ref?: string
      }
      if (!handshaken) {
        handshaken = true
        if (message.error !== undefined) {
          settle({
            ms: (Bun.nanoseconds() - started) / 1e6,
            outcome: 'error',
            detail: message.error,
          })
          return
        }
        settle({ ms: (Bun.nanoseconds() - started) / 1e6, outcome: 'ok' })
        return
      }
      if (message.repo === target) resolveDelivered(Bun.nanoseconds())
    })
    socket.addEventListener('error', () => {
      if (handshaken) {
        resolveDelivered(null)
        return
      }
      handshaken = true
      settle({
        ms: (Bun.nanoseconds() - started) / 1e6,
        outcome: 'error',
        detail: 'websocket error',
      })
    })
    socket.addEventListener('close', () => resolveDelivered(null))
  })
}

const ms = (value: number | null) => (value === null ? '   —' : `${Math.round(value)}`.padStart(5))

function row(label: string, summary: OpSummary): string {
  return [
    label.padEnd(12),
    `n=${String(summary.n).padStart(3)}`,
    `ok=${String(summary.ok).padStart(3)}`,
    `err=${String(summary.errors).padStart(2)}`,
    `limited=${String(summary.limited).padStart(2)}`,
    `p50=${ms(summary.p50)}ms`,
    `p95=${ms(summary.p95)}ms`,
    `p99=${ms(summary.p99)}ms`,
    `max=${ms(summary.max)}ms`,
  ].join('  ')
}

async function main(): Promise<number> {
  // Preflight: measure nothing against an origin that is not there, and record
  // WHAT was measured — there is no version endpoint, so the deployment is
  // identified by a fingerprint of the document it serves.
  const started = Date.now()
  let landing: Response
  try {
    landing = await fetch(`${options.origin}/llms.txt`)
  } catch (error) {
    console.error(`walgit load: could not reach ${options.origin}: ${(error as Error).message}`)
    return 1
  }
  if (!landing.ok) {
    console.error(`walgit load: ${options.origin}/llms.txt answered ${landing.status}`)
    return 1
  }
  const document = await landing.text()
  const fingerprint = Bun.hash(document).toString(16)

  console.log(`walgit load run ${runId} against ${options.origin}`)
  console.log(`  /llms.txt fingerprint ${fingerprint} (${document.length} bytes)`)
  console.log(
    `  plan: ${options.repos} new names, ${options.clones} concurrent clones, ${options.pushes} concurrent pushes, ${options.watchers} subscribers`,
  )

  // Sequential on purpose: this is the uncontended reference the later phases
  // are read against.
  const seed: Sample[] = []
  for (let index = 0; index < options.repos; index += 1) seed.push(await seedRepo(index))
  if (seeded.length === 0) {
    console.error('walgit load: no repository could be seeded; nothing to measure')
    console.error(`  ${seed[0]?.detail ?? 'no detail'}`)
    return 1
  }

  const clone = options.clones > 0 ? await burst(options.clones, cloneOnce) : []

  // One repository per concurrent push, held here as well as in the plan: a
  // seed that failed means there are fewer repositories than the plan assumed,
  // and pushing the difference anyway would put two workers on one ref and
  // record git's non-fast-forward refusal as a load failure.
  const pushers = Math.min(options.pushes, seeded.length)
  if (pushers < options.pushes) {
    console.log(
      `  note: ${options.pushes - pushers} push worker(s) dropped — only ${seeded.length} of ${options.repos} repositories were seeded`,
    )
  }
  const push = pushers > 0 ? await burst(pushers, pushOnce) : []

  const handshakes: Sample[] = []
  const deliveries: Sample[] = []
  if (options.watchers > 0) {
    const target = (seeded[0] as { name: string }).name
    const names = seeded.map((repo) => repo.name)
    const watchers = await Promise.all(
      Array.from({ length: options.watchers }, () => openWatcher(names, target)),
    )
    handshakes.push(...watchers.map((watcher) => watcher.handshake))

    // One push wakes every subscriber at once, which is the fan-out question.
    //
    // Measured from when that push STARTED, not from when it returned: the
    // container announces in `post-receive`, so an event can and does arrive
    // before the client's `git push` finishes, and measuring from the end
    // would produce a negative number for the healthy case. The interval
    // therefore contains the push itself — `push` in the table is what to
    // subtract, and the spread across subscribers is the fan-out cost.
    const wokeAt = Bun.nanoseconds()
    const wake = await pushOnce(0)
    const results = await Promise.all(
      watchers.map((watcher) =>
        Promise.race([
          watcher.arrivedAt,
          new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]),
      ),
    )
    for (const watcher of watchers) watcher.close()
    for (const arrival of results) {
      deliveries.push(
        arrival === null
          ? { ms: 20_000, outcome: 'error', detail: 'no event within 20s' }
          : { ms: (arrival - wokeAt) / 1e6, outcome: 'ok' },
      )
    }
    push.push(wake)
  }

  const byOp: Record<string, Sample[]> = {
    'seed-push': seed,
    clone,
    push,
    subscribe: handshakes,
    'event-fanout': deliveries,
  }
  const summaries: Record<string, OpSummary> = Object.fromEntries(
    Object.entries(byOp).map(([label, samples]) => [label, summarize(samples)]),
  )
  const verdict = nameBottleneck(summaries)

  console.log('')
  for (const [label, summary] of Object.entries(summaries)) {
    if (summary.n > 0) console.log(`  ${row(label, summary)}`)
  }
  console.log('')
  console.log(`  first to degrade: ${verdict.op ?? 'nothing'} — ${verdict.reason}`)
  // The remote's own words, once per distinct refusal. A bottleneck named with
  // no evidence is an opinion, and the difference between a saturated queue, a
  // lost compare-and-swap and a rate limit is entirely in this line.
  for (const [label, samples] of Object.entries(byOp)) {
    const reasons = new Map<string, number>()
    for (const sample of samples) {
      if (sample.outcome === 'ok') continue
      const detail = sample.detail ?? 'no detail'
      reasons.set(detail, (reasons.get(detail) ?? 0) + 1)
    }
    for (const [detail, count] of reasons) console.log(`    ${label} ×${count}: ${detail}`)
  }
  console.log(`  left behind on ${options.origin}: ${seeded.map((repo) => repo.name).join(', ')}`)
  console.log("  (collected by the deployment's retention window, if it has one)")

  if (options.json !== null) {
    writeFileSync(
      options.json,
      `${JSON.stringify(
        {
          runId,
          origin: options.origin,
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date().toISOString(),
          documentFingerprint: fingerprint,
          plan: options,
          summaries,
          // Every attempt, so a reader can recompute the table and read the
          // refusals in the remote's own words rather than take this file's.
          samples: byOp,
          verdict,
          repositories: seeded.map((repo) => repo.name),
        },
        null,
        2,
      )}\n`,
    )
    console.log(`  wrote ${options.json}`)
  }

  return 0
}

process.exit(await main())
