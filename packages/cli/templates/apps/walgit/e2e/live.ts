#!/usr/bin/env bun
/**
 * Signer Lists, against a walgit that is actually running.
 *
 *     bun run e2e/live.ts --origin https://walgit.example.com  # a deployment
 *     bun run e2e/live.ts --origin https://…  --expect-unclaimed
 *     bun run e2e/live.ts --local                              # boot src/server.ts here
 *
 * The MECHANISM is proven in `src/push.e2e.test.ts` — claim, grant, revoke, the
 * atomic list-and-branch steal, and the orphan assertions, all over real HTTP
 * with real keys. Nothing here duplicates that, and this file must not grow
 * into a second copy of it.
 *
 * What it proves instead is the one thing no test in the package can:
 * **`--origin` says a DEPLOYMENT has ownership turned on.**
 * `WALGIT_SIGNER_LISTS` is instance configuration (docs/adr/0012), so only a
 * request to the running service can tell you the flag reached the container,
 * that the nonce seed is there to sign against, and that a stranger is refused
 * over the public network rather than in a test's imagination.
 *
 * `--local` is the same run against a node this file boots. It is a smoke test
 * for this file — pointing it at a deployment and discovering it was broken is
 * an expensive way to find that out — and asserts nothing about any instance.
 *
 * ## The two assertions
 *
 * They are assertions about an origin, not verbosity levels, and exactly one of
 * them is true of any deployment that advertises signed pushes at all:
 *
 *   - default — **this origin enforces Signer Lists.** Claims a free name,
 *     reads the list back, is refused from an unlisted key and from an unsigned
 *     push, and clones the claimed repository with no credential.
 *   - `--expect-unclaimed` — **this origin does not.** Pins the untouched path:
 *     an unsigned push to a free name lands and clones back byte-identical, a
 *     signed push from a key nothing knows lands too, and `/llms.txt` says in
 *     its own words that this host keeps no list of allowed signers.
 *
 * Each exits 0 only when its assertion holds, so neither can be mistaken for
 * the other by a script. There is no mode that merely reports what it found:
 * "whatever this deployment does is fine" is not a check.
 *
 * ## Exit codes
 *
 * | 0 | the assertion holds |
 * | 1 | it does not, or the run could not reach the origin |
 * | 64 | the arguments were wrong |
 *
 * ## What it leaves behind
 *
 * Repositories named `walgit-live-<random>`, on `--origin` only — under
 * `--local` the whole node is thrown away. They are collected by the
 * deployment's retention window if it has one; on a deployment without one they
 * are permanent, and the claimed one is claimed forever, which is ADR-0012's
 * own consequence rather than a defect here. The names are printed on the way
 * out.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PROVENANCE_PATH, SIGNERS_REF } from '../shared/protocol'
import { APP_ROOT, git, gitOk, sleep } from './harness'

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

function usage(problem: string): never {
  console.error(problem)
  console.error('')
  console.error('usage: bun run e2e/live.ts (--origin <url> | --local) [--expect-unclaimed]')
  console.error('')
  console.error('  --origin <url>      a running walgit; also read from WALGIT_LIVE_ORIGIN')
  console.error('  --local             boot src/server.ts with ownership on and run against it')
  console.error('  --expect-unclaimed  assert the origin does NOT enforce Signer Lists')
  process.exit(64)
}

const flag = (name: string) => argv.includes(`--${name}`)

/**
 * The value after `--name`, and never the next FLAG.
 *
 * `--origin --expect-unclaimed` would otherwise read as an origin literally
 * spelled `--expect-unclaimed`, and the run would die reporting a URL it could
 * not parse rather than the argument mistake the caller actually made.
 */
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return null
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) usage(`--${name} needs a value.`)
  return next
}

if (flag('help')) usage('walgit live check')

const local = flag('local')
const expectUnclaimed = flag('expect-unclaimed')
// The environment fallback is consulted only where an origin is wanted: a shell
// that exports `WALGIT_LIVE_ORIGIN` must not make `--local` fail as though the
// caller had passed a flag they did not.
const originArg = local ? value('origin') : (value('origin') ?? process.env.WALGIT_LIVE_ORIGIN)

if (local && originArg) usage('--local and --origin are mutually exclusive: --local IS the origin.')
if (!local && !originArg) usage('nothing to check: pass --origin <url> or --local.')
if (local && expectUnclaimed) {
  // The local node is booted by this file with the flag on, so the assertion
  // would be about this file's own argv rather than about a deployment.
  usage('--expect-unclaimed is about a deployment; --local boots one with the flag ON.')
}

function normalizeOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    usage(`--origin ${JSON.stringify(raw)} is not a URL.`)
  }
  // Scheme-checked rather than assumed: git reads an origin with no scheme as a
  // path on this disk, and would report a missing local repository.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    usage(`--origin ${JSON.stringify(raw)} must be http or https.`)
  }
  return raw.replace(/\/+$/, '')
}

// ── Repositories, keys, and working copies ──────────────────────────────────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-live-'))
/** Names that a push actually created, so the report names nothing imaginary. */
const created: string[] = []
let node: { stop: () => void } | null = null

/** `ssh-keygen -lf` prints `<bits> SHA256:… <comment> (ED25519)`. */
function fingerprintOf(pub: string): string {
  const printed = Bun.spawnSync(['ssh-keygen', '-lf', pub]).stdout.toString()
  const found = printed.split(/\s+/).find((word) => word.startsWith('SHA256:'))
  if (!found) throw new Error(`no fingerprint in ${JSON.stringify(printed)}`)
  return found
}

function keypair(name: string): { pub: string; fingerprint: string } {
  const file = path.join(scratch, `key-${name}`)
  const keygen = Bun.spawnSync(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', name, '-f', file])
  if (keygen.exitCode !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr.toString()}`)
  return { pub: `${file}.pub`, fingerprint: fingerprintOf(`${file}.pub`) }
}

const remote = (origin: string, repoId: string) => `${origin}/${repoId}.git`

/** A name no concurrent run can collide with, in the grammar `REPO_ID` allows. */
const freshName = () => `walgit-live-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

let workdirs = 0

/** An empty repository on `branch`. A failed setup step throws here, not later. */
async function emptyWorkdir(kind: string, branch: string): Promise<string> {
  workdirs += 1
  const dir = path.join(scratch, `work-${workdirs}-${kind}`)
  fs.mkdirSync(dir, { recursive: true })
  await gitOk(dir, 'init', '--quiet', `--initial-branch=${branch}`)
  return dir
}

/** A repository with one commit, ready to push. Never cloned — the name is new. */
async function workdir(kind: string, body: string): Promise<string> {
  const dir = await emptyWorkdir(kind, 'main')
  fs.writeFileSync(path.join(dir, 'README'), body)
  await gitOk(dir, 'add', 'README')
  await gitOk(dir, 'commit', '--quiet', '-m', 'live check')
  return dir
}

/**
 * A working copy of the list itself, with no history in common with anything
 * else — because the list is its own ref, and an agent claiming a free name has
 * nothing to clone.
 */
const listWorkdir = () => emptyWorkdir('list', 'signers')

/** Commit a `signers` file naming exactly `keys`. */
async function writeList(dir: string, keys: string[], message: string): Promise<void> {
  fs.writeFileSync(path.join(dir, 'signers'), keys.map((k) => `${k}\n`).join(''))
  await gitOk(dir, 'add', 'signers')
  await gitOk(dir, 'commit', '--quiet', '-m', message)
}

const pushSigned = (dir: string, pub: string, url: string, ...refspecs: string[]) =>
  git(
    dir,
    '-c',
    'gpg.format=ssh',
    '-c',
    `user.signingkey=${pub}`,
    'push',
    '--signed=yes',
    url,
    ...refspecs,
  )

// ── The local node, when there is no deployment to point at ─────────────────

/**
 * `src/server.ts` in a child process, configured the way a deployment that has
 * turned ownership on is configured.
 *
 * The seed is generated per run and the store is a directory: neither is a
 * credential, and needing one would put this behind the thing it is meant to be
 * runnable without. It is the same process the container runs — spawned rather
 * than imported, so what answers is a server that read its environment once at
 * start, exactly as the container does.
 */
async function startLocalNode(): Promise<string> {
  // Ask the kernel for a free port and hand it straight to the child. There is
  // a window between releasing it and the child binding it, which is why the
  // readiness failure below names a collision as one of its two causes: a child
  // that exits immediately did not fail to serve, it failed to listen.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)

  const reposDir = path.join(scratch, 'repos')
  const storeDir = path.join(scratch, 'store')
  fs.mkdirSync(reposDir, { recursive: true })
  fs.mkdirSync(storeDir, { recursive: true })

  // Ambient `WALGIT_*` stripped for the reason `git` is run with no global
  // config: a shell that already exports a bucket or a retention window would
  // make this run prove something about the machine rather than the mechanism.
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('WALGIT_')),
  )

  const child = spawn('bun', [path.join(APP_ROOT, 'src', 'server.ts')], {
    cwd: APP_ROOT,
    // Its own process group, exactly as `WalgitNode` does it in harness.ts: the
    // node forks `git-http-backend` and the hooks, and a kill that reaches only
    // the bun process leaves them holding the port and the repos directory.
    detached: true,
    env: {
      ...ambient,
      PORT: String(port),
      WALGIT_REPOS_DIR: reposDir,
      WALGIT_STORE_DIR: storeDir,
      WALGIT_PUBLIC: '1',
      WALGIT_APPEND_ONLY: '1',
      WALGIT_SIGNER_LISTS: '1',
      WALGIT_PUSH_CERT_SEED: crypto.randomUUID(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Registered BEFORE the wait, not after it: a node that never becomes healthy
  // still has to be killed, and killing it has to happen before `cleanup()`
  // deletes the repos and store directories from under a process still running.
  node = {
    stop: () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    },
  }
  // The node's own log, behind the same switch the suite gates its nodes on, so
  // a passing run is the checks and nothing else.
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.WALGIT_E2E_VERBOSE) process.stderr.write(chunk)
  })

  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `local node exited with ${child.exitCode} — it refused to boot, or something ` +
          `else took port ${port} between this process releasing it and the child binding it ` +
          '(WALGIT_E2E_VERBOSE=1 to see its log)',
      )
    }
    try {
      const res = await fetch(`${origin}/_walgit/health`)
      if (res.ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`local node never became healthy on ${origin}`)
    await sleep(100)
  }
  return origin
}

// ── Checks ──────────────────────────────────────────────────────────────────

let ran = 0
let failures = 0

/**
 * One check, and what it OBSERVED rather than merely that it passed — the rule
 * `e2e/suite.ts` states and this file keeps: a green tick over a weakened
 * assertion is indistinguishable from a green tick over a real one.
 */
async function check(name: string, body: (note: (line: string) => void) => Promise<void>) {
  const notes: string[] = []
  ran += 1
  try {
    await body((line) => notes.push(line))
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures += 1
    notes.push(`FAILED: ${(err as Error).message}`)
    console.log(`  FAIL ${name}`)
  }
  for (const line of notes) console.log(`         ${line}`)
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * The origin's own account of itself, which is rendered from the flags.
 *
 * `/llms.txt` is the WORKER's document and `GET /` is the container's, so a
 * container-only origin (`--local`) has the second and not the first. That is
 * reported as an absence rather than assumed away: `llms` is null only where
 * this file knows there is no Worker in front, and a real deployment answering
 * 404 there is a failure like any other.
 */
async function frontDoors(
  origin: string,
  hasWorker: boolean,
): Promise<{ llms: string | null; terse: string }> {
  const terseRes = await fetch(`${origin}/`, { headers: { accept: 'text/plain' } })
  must(terseRes.ok, `GET ${origin}/ answered ${terseRes.status}`)
  const terse = await terseRes.text()
  if (!hasWorker) return { llms: null, terse }
  const llmsRes = await fetch(`${origin}/llms.txt`)
  must(llmsRes.ok, `GET ${origin}/llms.txt answered ${llmsRes.status}`)
  return { llms: await llmsRes.text(), terse }
}

/**
 * An unsigned push to a name nobody has claimed, and a clone of it back.
 *
 * Run under BOTH assertions, because it is the promise ownership must not have
 * broken: turning the flag on changes nothing for a name with no list, which is
 * every name until someone writes one.
 */
async function anonymousPushLands(origin: string): Promise<void> {
  await check('an unclaimed name takes an unsigned push, and clones back', async (note) => {
    const repoId = freshName()
    const body = `anonymous ${repoId}\n`
    const dir = await workdir('anon', body)
    const pushed = await git(dir, 'push', remote(origin, repoId), 'HEAD:refs/heads/main')
    must(pushed.status === 0, `push refused (${pushed.status}):\n${pushed.out}`)
    created.push(repoId)
    note(`pushed to ${repoId} with no key and no credential`)

    const clone = path.join(scratch, `clone-${repoId}`)
    const cloned = await git(scratch, 'clone', '--quiet', remote(origin, repoId), clone)
    must(cloned.status === 0, `clone failed (${cloned.status}):\n${cloned.out}`)
    const read = fs.readFileSync(path.join(clone, 'README'), 'utf8')
    must(read === body, `clone read back ${JSON.stringify(read)}, not ${JSON.stringify(body)}`)
    note('cloned back byte-identical, with no credential')
  })
}

/** The whole of the flag-on assertion, on one repository, in the order an agent meets it. */
async function ownershipEnforced(origin: string, hasWorker: boolean): Promise<void> {
  const alice = keypair('alice')
  const bob = keypair('bob')
  const repoId = freshName()
  const url = remote(origin, repoId)

  await check('a real signed push claims a free name', async (note) => {
    const list = await listWorkdir()
    await writeList(list, [alice.fingerprint], 'claim')
    const claimed = await pushSigned(list, alice.pub, url, `HEAD:${SIGNERS_REF}`)
    must(claimed.status === 0, `claim refused (${claimed.status}):\n${claimed.out}`)
    created.push(repoId)
    note(`${repoId} claimed by ${alice.fingerprint} on ${SIGNERS_REF}`)

    const ls = await git(list, 'ls-remote', url, SIGNERS_REF)
    must(
      ls.status === 0 && ls.out.includes(SIGNERS_REF),
      `ls-remote did not show the list:\n${ls.out}`,
    )
    note('the ref reads back with `git ls-remote`, uncredentialed')
  })

  await check('the list reads back from the Provenance endpoint', async (note) => {
    const res = await fetch(`${origin}${PROVENANCE_PATH}?repo=${repoId}`)
    must(res.ok, `GET ${PROVENANCE_PATH} answered ${res.status}`)
    const body = (await res.json()) as { claim?: { signers?: string[]; ts?: string } }
    must(body.claim !== undefined, `no claim in ${JSON.stringify(body)}`)
    must(
      JSON.stringify(body.claim?.signers) === JSON.stringify([alice.fingerprint]),
      `claim names ${JSON.stringify(body.claim?.signers)}, not [${alice.fingerprint}]`,
    )
    note(`claim.signers = [${alice.fingerprint}], claimed at ${body.claim?.ts}`)
  })

  await check("a listed key's push lands", async (note) => {
    const dir = await workdir('alice', `alice ${repoId}\n`)
    const pushed = await pushSigned(dir, alice.pub, url, 'HEAD:refs/heads/main')
    must(pushed.status === 0, `refused (${pushed.status}):\n${pushed.out}`)
    note('refs/heads/main written by the key the list names')
  })

  await check('an unlisted key is refused, in words an agent can act on', async (note) => {
    const dir = await workdir('bob', `bob ${repoId}\n`)
    const refused = await pushSigned(dir, bob.pub, url, 'HEAD:refs/heads/bob')
    must(refused.status !== 0, `a stranger's push LANDED:\n${refused.out}`)
    must(
      refused.out.includes(`${repoId} is held by a Signer List`),
      `refusal did not say the name is held:\n${refused.out}`,
    )
    must(
      refused.out.includes(bob.fingerprint),
      `refusal did not name the key that pushed:\n${refused.out}`,
    )
    must(
      new RegExp(`${repoId}-[0-9a-f]{8}\\.git`).test(refused.out),
      `refusal did not suggest a free name:\n${refused.out}`,
    )
    must(
      refused.out.includes(SIGNERS_REF),
      `refusal did not say where the list lives:\n${refused.out}`,
    )
    note(`refused ${bob.fingerprint}: named the key, a free name to use, and ${SIGNERS_REF}`)
  })

  await check('an unsigned push to a claimed name is refused too', async (note) => {
    // Fail-open's one exception, and the reason it has to exist: if breaking
    // verification landed the push, breaking it would BE the way past the gate.
    const dir = await workdir('unsigned', `unsigned ${repoId}\n`)
    const refused = await git(dir, 'push', url, 'HEAD:refs/heads/unsigned')
    must(refused.status !== 0, `an unsigned push to a claimed name LANDED:\n${refused.out}`)
    must(
      refused.out.includes('carries no signature'),
      `refusal did not name the missing signature:\n${refused.out}`,
    )
    note('refused, and told to push --signed=yes')
  })

  await check('the claimed repository is still world-readable', async (note) => {
    const clone = path.join(scratch, `clone-claimed-${repoId}`)
    const cloned = await git(scratch, 'clone', '--quiet', url, clone)
    must(
      cloned.status === 0,
      `clone of a claimed repository failed (${cloned.status}):\n${cloned.out}`,
    )
    const read = fs.readFileSync(path.join(clone, 'README'), 'utf8')
    must(read === `alice ${repoId}\n`, `clone read back ${JSON.stringify(read)}`)
    note('cloned with no credential — reads are not gated by a claim')
  })

  await check(
    '/llms.txt describes Signer Lists; the terse front door gains no section',
    async (note) => {
      const { llms, terse } = await frontDoors(origin, hasWorker)
      if (llms === null) {
        note("NOT CHECKED: /llms.txt is the Worker's document, and this origin is the container")
      } else {
        must(llms.includes('Signer List'), '/llms.txt does not mention a Signer List')
        must(llms.includes(SIGNERS_REF), `/llms.txt does not name ${SIGNERS_REF}`)
        must(
          !llms.includes('keeps no list of allowed signers'),
          '/llms.txt still says this host keeps no list of allowed signers',
        )
        note(`/llms.txt names ${SIGNERS_REF} and what a name that holds one refuses`)
      }

      // ADR-0012 put discovery in `/llms.txt` and in the refusal, not here: the
      // terse page has a byte budget, and the clause is all ownership buys on
      // it. Pinned by the REF rather than by a heading, because any section
      // teaching an agent to claim a name would have to name the ref to be of
      // any use, whatever it called itself.
      must(!terse.includes(SIGNERS_REF), `GET / grew a section: it names ${SIGNERS_REF}`)
      must(
        terse.includes('Unsigned is fine unless a name holds a Signer List'),
        'GET / still promises that nothing is refused for being unsigned',
      )
      // The byte budget is REPORTED here and asserted in `src/llms.test.ts`,
      // which renders this deployment's maximal policy. Asserting it here too
      // would make an unrelated copy edit report itself as ownership being off.
      note(`GET / is ${terse.length} bytes, carries the clause and names no ref`)
    },
  )
}

/** The flag-off assertion: the untouched path, pinned. */
async function ownershipAbsent(origin: string): Promise<void> {
  await check('this host says in its own words that it keeps no list of signers', async (note) => {
    // Always with the Worker: `--expect-unclaimed` is only ever pointed at a
    // deployment, and `--local` boots one with the flag on.
    const { llms, terse } = await frontDoors(origin, true)
    // The POSITIVE sentence, not the absence of the other one. `/llms.txt` drops
    // the whole signing section on a host with no nonce seed, so "it does not
    // say Signer List" is also true of a deployment that has ownership ON and no
    // seed — the misconfiguration in which every claimed name is unpushable.
    // Requiring the sentence makes that case fail here instead of passing as
    // "ownership is off".
    must(llms !== null, '/llms.txt was not served')
    must(
      llms!.includes('keeps no list of allowed signers'),
      '/llms.txt does not say this host keeps no list of allowed signers — either ' +
        'ownership is ON here, or this host advertises no signed pushes at all and ' +
        'nothing can be concluded from its front door',
    )
    must(!terse.includes(SIGNERS_REF), `GET / names ${SIGNERS_REF}`)
    must(!terse.includes('Signer List'), 'GET / mentions a Signer List')
    note(`GET / is ${terse.length} bytes and silent on ownership; /llms.txt says so outright`)
  })

  await check('a signed push from a key nothing knows lands on a free name', async (note) => {
    const stranger = keypair('stranger')
    const repoId = freshName()
    const dir = await workdir('stranger', `stranger ${repoId}\n`)
    const url = remote(origin, repoId)
    const pushed = await pushSigned(dir, stranger.pub, url, 'HEAD:refs/heads/main')
    must(pushed.status === 0, `refused (${pushed.status}):\n${pushed.out}`)
    created.push(repoId)
    note(`${stranger.fingerprint} pushed to ${repoId} with nothing registered anywhere`)
  })
}

// ── Run ─────────────────────────────────────────────────────────────────────

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  node?.stop()
  fs.rmSync(scratch, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
}

try {
  const origin = local ? await startLocalNode() : normalizeOrigin(originArg!)

  const assertion = expectUnclaimed
    ? 'this origin does NOT enforce Signer Lists'
    : 'this origin ENFORCES Signer Lists'
  console.log(`walgit live check — ${origin}`)
  console.log(`asserting: ${assertion}`)
  if (local) {
    console.log(
      'NOTE: --local. A node this file booted, not a deployment. It exercises this ' +
        'file against a real server and asserts nothing about any instance; the ' +
        'mechanism itself is proven in src/push.e2e.test.ts.',
    )
  }
  console.log('')

  await anonymousPushLands(origin)
  if (expectUnclaimed) await ownershipAbsent(origin)
  else await ownershipEnforced(origin, !local)

  console.log('')
  if (!local && created.length > 0) {
    console.log(
      `left behind on ${origin}: ${created.join(', ')} — collected by this deployment's ` +
        'retention window, if it has one.',
    )
  }
  console.log(
    failures > 0
      ? `FAILED — ${failures} of ${ran} checks say ${assertion} is not true of ${origin}`
      : `PASSED — ${ran} checks, and ${assertion}`,
  )
  cleanup()
  process.exit(failures > 0 ? 1 : 0)
} catch (err) {
  console.error(`\nlive check could not run: ${(err as Error).message}`)
  cleanup()
  process.exit(1)
}
