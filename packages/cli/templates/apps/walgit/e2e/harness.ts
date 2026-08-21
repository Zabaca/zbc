/**
 * The machinery the seven scenarios share: a real walgit node they can kill, a
 * real git client, and a real object store with a prefix nobody else is using.
 *
 * The one design rule here is that nothing in this file is a double. The
 * scenarios exist to check claims about what happens when a process dies
 * mid-push, and a double is precisely the thing that cannot die mid-push — it
 * would answer every question with the answer it was written to give. So the
 * node is a child process, the kill is `SIGKILL` to its process group, the
 * client is `git`, and the store comes from the environment: `FileStore` on a
 * developer's laptop, `S3Store` against a real bucket when `WALGIT_S3_*` is
 * set. The scenarios do not know or care which.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ObjectStore } from '../src/store'
import { storeFromEnv } from '../src/store-env'
import { ulid } from '../src/ulid'

export const APP_ROOT = path.resolve(import.meta.dir, '..')

/** Bearer token the suite's nodes accept. Local-only; the node is on loopback. */
export const TOKEN = 'walgit-e2e-token'

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * One suite invocation's world: an object-store namespace, a scratch directory,
 * and a list of things to undo.
 *
 * Isolation is by REPO ID, not by bucket. Every key walgit writes lives under
 * `repos/<repoId>/`, so a run-unique repo-id prefix is a run-unique key prefix —
 * which means a real shared bucket can host concurrent runs without a
 * per-run bucket to provision and, more to the point, without a failed run
 * being able to corrupt the next one.
 */
export class Run {
  readonly id = ulid()
  readonly store: ObjectStore
  readonly storeKind: 'file' | 's3'
  readonly scratch: string
  private readonly repoIds: string[] = []
  private readonly nodes: WalgitNode[] = []
  private readonly dirs: string[] = []
  private dirCounter = 0
  private readonly localStoreDir: string | null

  constructor() {
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-e2e-'))
    this.dirs.push(this.scratch)

    if (process.env.WALGIT_S3_ENDPOINT) {
      this.localStoreDir = null
      this.storeKind = 's3'
    } else {
      // Not a fake store — a real one, on a real filesystem, with a real
      // compare-and-swap. It is the same `ObjectStore` the node uses in
      // production; only the backend differs.
      this.localStoreDir = path.join(this.scratch, 'store')
      fs.mkdirSync(this.localStoreDir, { recursive: true })
      process.env.WALGIT_STORE_DIR = this.localStoreDir
      this.storeKind = 'file'
    }

    // The scenarios drive materialize directly and read its numbers; its
    // per-restore log line on stdout would bury the suite's own output.
    process.env.WALGIT_QUIET ??= '1'

    const store = storeFromEnv()
    if (!store) throw new Error('e2e: no object store could be built from the environment')
    this.store = store
  }

  /** A repo id nothing else in this or any concurrent run will use. */
  repoId(name: string): string {
    const id = `e2e-${this.id.toLowerCase()}-${name}`
    this.repoIds.push(id)
    return id
  }

  /** A scratch directory, removed when the run cleans up. */
  dir(name: string): string {
    this.dirCounter += 1
    const d = path.join(this.scratch, `${name}-${this.dirCounter}`)
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  /** Environment every node and every hook subprocess in this run inherits. */
  env(): Record<string, string> {
    const passthrough = [
      'WALGIT_S3_ENDPOINT',
      'WALGIT_S3_BUCKET',
      'WALGIT_S3_REGION',
      'WALGIT_S3_ACCESS_KEY_ID',
      'WALGIT_S3_SECRET_ACCESS_KEY',
    ]
    const env: Record<string, string> = { WALGIT_HTTP_TOKENS: TOKEN }
    if (this.localStoreDir) env.WALGIT_STORE_DIR = this.localStoreDir
    for (const key of passthrough) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    return env
  }

  /** Start a node. Its repos directory is fresh, which is what "a new node" means. */
  async node(label: string, extraEnv: Record<string, string> = {}): Promise<WalgitNode> {
    const node = new WalgitNode(this, label, extraEnv)
    this.nodes.push(node)
    await node.start()
    return node
  }

  /**
   * Undo everything. Runs on the happy path AND on a throw AND on a signal,
   * because the alternative is a shared bucket that accumulates the debris of
   * every run that ever failed.
   */
  async cleanup(): Promise<void> {
    for (const node of this.nodes) node.kill()
    for (const repoId of this.repoIds) {
      try {
        for (const key of await this.store.list(`repos/${repoId}/`)) await this.store.delete(key)
      } catch (err) {
        console.error(`e2e: could not clean store prefix repos/${repoId}/: ${String(err)}`)
      }
    }
    for (const dir of this.dirs) fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── The node ────────────────────────────────────────────────────────────────

/**
 * A walgit smart-HTTP server in its own process.
 *
 * Out-of-process is the point. An in-process handler cannot be `kill -9`ed, and
 * the hooks git spawns during a push are grandchildren of this process — so
 * killing the group is the only way to reproduce "the machine went away
 * mid-push" rather than "a promise was never awaited".
 */
export class WalgitNode {
  private child: ChildProcess | null = null
  port = 0
  readonly reposDir: string

  constructor(
    private readonly run: Run,
    readonly label: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    this.reposDir = run.dir(`repos-${label}`)
  }

  async start(): Promise<void> {
    this.port = await freePort()
    this.child = spawn('bun', [path.join(APP_ROOT, 'src/server.ts')], {
      cwd: APP_ROOT,
      // Its own process group: `kill(-pid)` then reaches git-http-backend and
      // the hook processes too, which is where the interesting deaths are.
      detached: true,
      env: {
        ...process.env,
        ...this.run.env(),
        ...this.extraEnv,
        WALGIT_REPOS_DIR: this.reposDir,
        PORT: String(this.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout?.on('data', () => {})
    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (process.env.WALGIT_E2E_VERBOSE) process.stderr.write(`[${this.label}] ${chunk}`)
    })
    await this.waitUntilListening()
  }

  /** `SIGKILL` to the whole process group. No handlers run — that is the point. */
  kill(): void {
    const child = this.child
    if (!child?.pid) return
    this.child = null
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }

  /** The push/fetch URL for a repo on this node. */
  origin(repoId: string): string {
    return `http://walgit:${TOKEN}@127.0.0.1:${this.port}/${repoId}.git`
  }

  private async waitUntilListening(): Promise<void> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(`node ${this.label} exited before it listened`)
      try {
        // 401 is a perfectly good "it is up": the port is answering HTTP, and
        // an unauthenticated probe is the cheapest request that proves it.
        await fetch(`http://127.0.0.1:${this.port}/`)
        return
      } catch {
        await sleep(50)
      }
    }
    throw new Error(`node ${this.label} did not listen on :${this.port} within 20s`)
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── git ─────────────────────────────────────────────────────────────────────

export interface GitResult {
  status: number
  out: string
}

/**
 * Run git with the ambient configuration stripped.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` is not tidiness: a developer with
 * `push.default`, a credential helper, or `init.defaultBranch=master` in their
 * `~/.gitconfig` would otherwise get a different suite than CI does, and the
 * difference would surface as a scenario that fails only on one machine.
 */
export async function git(cwd: string, ...args: string[]): Promise<GitResult> {
  const child = Bun.spawn(['git', '-c', 'credential.helper=', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ASKPASS: '/usr/bin/false',
      GIT_AUTHOR_NAME: 'walgit e2e',
      GIT_AUTHOR_EMAIL: 'e2e@walgit.test',
      GIT_COMMITTER_NAME: 'walgit e2e',
      GIT_COMMITTER_EMAIL: 'e2e@walgit.test',
      // Fixed timestamps so scenario 4's history hashes are reproducible
      // between the reference clone and the materialized one.
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { status, out: `${out}${err}` }
}

/** git, but a non-zero exit is a suite failure rather than a value to inspect. */
export async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const res = await git(cwd, ...args)
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed (${res.status}):\n${res.out}`)
  return res.out
}

/** A working clone of `repoId` from `node`, configured to commit. */
export async function clone(run: Run, node: WalgitNode, repoId: string, name: string) {
  const parent = run.dir(`clone-${name}`)
  const dir = path.join(parent, name)
  await gitOk(parent, 'clone', '--quiet', node.origin(repoId), dir)
  await gitOk(dir, 'config', 'user.email', 'e2e@walgit.test')
  await gitOk(dir, 'config', 'user.name', 'walgit e2e')
  return dir
}

/** One commit on the current branch. Returns its oid. */
export async function commit(dir: string, body: string): Promise<string> {
  fs.writeFileSync(path.join(dir, 'README'), body)
  await gitOk(dir, 'add', 'README')
  await gitOk(dir, 'commit', '--quiet', '-m', body.trim() || 'commit')
  return (await gitOk(dir, 'rev-parse', 'HEAD')).trim()
}
