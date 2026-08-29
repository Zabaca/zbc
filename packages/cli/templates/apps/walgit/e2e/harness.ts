/**
 * The machinery the scenarios share: a real walgit node they can kill, a
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

import { INTERNAL_HEADER } from '../src/http'
import type { ObjectStore } from '../src/store'
import { storeFromEnv } from '../src/store-env'
import { ulid } from '../src/ulid'
import {
  ANNOUNCE_PATH,
  EVENTS_PATH,
  type Handshake,
  type RefEvent,
  type WatchEntry,
  authorizeAnnounce,
  authorizeSubscribe,
  encode,
  handshake,
  parseAnnounce,
  parseWatch,
  watchCovers,
  watchedRepos,
} from '../worker/events'
import { Outbox } from '../worker/outbox'

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

// ── The events endpoint ─────────────────────────────────────────────────────

interface SocketData {
  watch: WatchEntry[] | null
  outbox: Outbox | null
}

/**
 * The other end of the ref-event stream, for the scenarios that need one.
 *
 * In production this is a Worker holding a Durable Object; here it is a Bun
 * server holding the sockets in memory. That substitution is the one place in
 * this file where something is not the production article, and it is bounded on
 * purpose: everything that DECIDES anything — whether the announce credential
 * is good, what a `watch` message means, which sockets an announcement reaches,
 * what goes on the wire, and what happens to a subscriber that stops draining —
 * is imported from `worker/events.ts` and `worker/outbox.ts`, the same modules
 * the Worker calls. What stands in for the Durable Object is accept, remember,
 * send, forget, which is what `worker/events-do.ts` says it is and no more.
 *
 * The alternative would be a Workers runtime inside the suite, which the
 * scenarios do not need: the wiring they prove — a hook that fires, an
 * announcement that authenticates, a socket that receives — is all on the
 * container's side of that boundary, and every part of it here is real.
 */
export class EventsEndpoint {
  /** The secret the container's push path presents (`WALGIT_EVENTS_TOKEN`). */
  readonly token = 'walgit-e2e-events'
  port = 0
  /** Every announcement the push path published, in arrival order. */
  readonly announced: RefEvent[] = []
  private server: ReturnType<typeof Bun.serve> | null = null
  private refsNode: WalgitNode | null = null
  private readonly subscribers = new Set<Subscriber>()
  // Bun has no `getWebSockets()`; tracking them is the one piece of bookkeeping
  // the Durable Object gets from its runtime and this does not.
  private readonly live = new Set<Bun.ServerWebSocket<SocketData>>()

  async start(): Promise<void> {
    this.port = await freePort()
    // Arrow handlers throughout: they close over `this`, which is what lets the
    // decisions stay methods on this class rather than free functions holding a
    // reference to it.
    this.server = Bun.serve<SocketData, Record<string, never>>({
      port: this.port,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: async (request, server) => {
        const url = new URL(request.url)

        if (url.pathname === ANNOUNCE_PATH) {
          if (request.method !== 'POST')
            return new Response('method not allowed\n', { status: 405 })
          if (!authorizeAnnounce(request.headers.get('authorization'), this.token)) {
            return new Response('unauthorized\n', { status: 401 })
          }
          const parsed = parseAnnounce(await request.json().catch(() => null))
          if (!parsed.ok) return new Response(`${parsed.error}\n`, { status: 400 })
          this.announced.push(...parsed.value)
          return Response.json({ ok: true, delivered: this.broadcast(parsed.value) })
        }

        if (url.pathname !== EVENTS_PATH) return new Response('not found\n', { status: 404 })
        // Exactly the credential a read of the repository needs, checked with
        // the function the Worker checks it with.
        const allowed = authorizeSubscribe({
          authorization: request.headers.get('authorization'),
          tokens: [TOKEN],
          isPublic: false,
        })
        if (!allowed) return new Response('unauthorized\n', { status: 401 })
        if (server.upgrade(request, { data: { watch: null, outbox: null } })) return undefined
        return new Response('expected a websocket upgrade\n', { status: 426 })
      },
      websocket: {
        open: (ws) => {
          this.live.add(ws)
        },
        message: async (ws, raw) => {
          const parsed = parseWatch(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
          if (!parsed.ok) {
            ws.send(encode({ error: parsed.error }))
            return
          }
          let refsByRepo: Record<string, Record<string, string>>
          try {
            refsByRepo = await this.currentRefs(watchedRepos(parsed.value))
          } catch (err) {
            ws.send(encode({ error: `could not read current refs: ${(err as Error).message}` }))
            return
          }
          // Read, record, answer — the order `events-do.ts` keeps, so a push
          // landing mid-handshake cannot fall between the two.
          ws.data.watch = parsed.value
          ws.send(encode(handshake(parsed.value, refsByRepo)))
        },
        close: (ws) => {
          this.live.delete(ws)
          ws.data.watch = null
          ws.data.outbox = null
        },
      },
    })
  }

  /** Where the container announces to (`WALGIT_EVENTS_URL`). */
  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /**
   * The node whose Index answers a handshake.
   *
   * Set after the node starts, because the node needs this endpoint's URL at
   * boot — the same circularity the deployment has, resolved the same way: the
   * container is told where to announce, and the socket layer asks the
   * container for refs when a subscriber arrives.
   */
  refsFrom(node: WalgitNode): void {
    this.refsNode = node
  }

  /** Connect a subscriber and complete its handshake. */
  async subscribe(watch: WatchEntry[]): Promise<Subscriber> {
    const subscriber = new Subscriber(`ws://127.0.0.1:${this.port}${EVENTS_PATH}`)
    this.subscribers.add(subscriber)
    await subscriber.open(watch)
    return subscriber
  }

  stop(): void {
    for (const subscriber of this.subscribers) subscriber.close()
    this.subscribers.clear()
    this.server?.stop(true)
    this.server = null
  }

  /** Fan one announcement out, through the real `Outbox`. */
  private broadcast(events: readonly RefEvent[]): number {
    let delivered = 0
    for (const ws of this.live) {
      const watch = ws.data.watch
      if (!watch) continue
      const wanted = events.filter((event) => watchCovers(watch, event))
      if (wanted.length === 0) continue
      ws.data.outbox ??= new Outbox({
        // Bun exposes the buffer as a method and the policy is written against
        // a property, so the adapter is here and the policy stays untouched.
        get bufferedAmount() {
          return ws.getBufferedAmount()
        },
        send: (data) => {
          ws.send(data)
        },
        close: (code, reason) => {
          ws.close(code, reason)
        },
      })
      delivered += ws.data.outbox.offer(wanted).sent
    }
    return delivered
  }

  /**
   * Ref state from the node's Index, over the container's internal endpoint —
   * the same request `events-do.ts` makes, header and all.
   */
  private async currentRefs(repos: string[]): Promise<Record<string, Record<string, string>>> {
    const node = this.refsNode
    if (!node) throw new Error('e2e: the events endpoint has no node to read refs from')
    const byRepo: Record<string, Record<string, string>> = {}
    for (const repo of repos) {
      const response = await fetch(
        `http://127.0.0.1:${node.port}/_walgit/refs?repo=${encodeURIComponent(repo)}`,
        { headers: { [INTERNAL_HEADER]: '1' } },
      )
      if (!response.ok) throw new Error(`refs lookup for ${repo}: ${response.status}`)
      const body = (await response.json()) as { refs?: Record<string, string> }
      byRepo[repo] = body.refs ?? {}
    }
    return byRepo
  }
}

/**
 * A client on the stream.
 *
 * A real WebSocket to a real port, so a scenario asserting that a sha arrived
 * is asserting that it crossed a socket — the wiring failure this exists to
 * catch is precisely one a direct call to the fan-out would not see.
 */
export class Subscriber {
  /** Every event message received after the handshake, in arrival order. */
  readonly events: RefEvent[] = []
  handshake: Handshake | null = null
  private socket: WebSocket | null = null

  constructor(private readonly url: string) {}

  async open(watch: WatchEntry[]): Promise<void> {
    const socket = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    } as never)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('subscriber could not connect')), {
        once: true,
      })
    })
    const handshaken = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no handshake within 10s')), 10_000)
      socket.addEventListener('message', (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as Handshake | RefEvent | { error: string }
        if ('error' in message) {
          clearTimeout(timer)
          reject(new Error(`subscriber refused: ${message.error}`))
          return
        }
        if ('ok' in message) {
          clearTimeout(timer)
          this.handshake = message
          resolve()
          return
        }
        this.events.push(message)
      })
    })
    socket.send(JSON.stringify({ watch }))
    await handshaken
  }

  /** Wait for an event matching `match`, or fail after `timeoutMs`. */
  async next(match: (event: RefEvent) => boolean, timeoutMs = 10_000): Promise<RefEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.events.find(match)
      if (found) return found
      await sleep(25)
    }
    throw new Error(
      `no matching ref event within ${timeoutMs}ms; saw ${JSON.stringify(this.events)}`,
    )
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
