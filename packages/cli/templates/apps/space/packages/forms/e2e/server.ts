// The real Worker in workerd, for the end-to-end tests and the spike: the production BUNDLE (`vite build`, not the dev
// transform) served by `vite preview` over a local D1 and R2, with a throwaway seal and master key in .dev.vars.
// Access cannot be local, so ALLOW_UNAUTHENTICATED=1 makes the browser the operator, on localhost only; the
// sign-in check is the company layer's, and the door is tested with signed assertions in test/app.test.ts and test/company.test.ts.
import { dlopen, ptr } from 'bun:ffi'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { makeSealCerts } from '../scripts/certs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export interface Server {
  base: string
  pid: number
  /** Stops the server and everything under it, and returns once they are gone; then puts `.dev.vars` back as it was. */
  kill(): Promise<void>
  /** Resident memory (KB) and CPU seconds of workerd, the process the Worker runs in. */
  sample(): { rssKb: number; cpuSeconds: number; pids: number[] }
  /** Resident memory (KB) only, cheap enough to poll in a tight loop. */
  rss(): number
  /** The seal certificates this server was started with. */
  certs: Awaited<ReturnType<typeof makeSealCerts>>
}

// Resident memory of one process in microseconds, from libSystem's proc_pidinfo (PROC_PIDTASKINFO, whose second
// 64-bit field is the resident size), so a sampler can poll fast enough to catch the peak of a request that takes
// 70 ms. `ps` takes longer than that to answer.
const libSystem = dlopen('/usr/lib/libSystem.B.dylib', { proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' } })
const taskInfo = new BigUint64Array(12)
export function residentKb(pid: number): number {
  const n = libSystem.symbols.proc_pidinfo(pid, 4, 0n, ptr(taskInfo), 96)
  return n === 96 ? Number(taskInfo[1]! / 1024n) : 0
}

const escaped = (s: string) => s.replace(/\n/g, '\\n')

function parseCpu(t: string): number {
  // ps cputime: [[dd-]hh:]mm:ss.ss
  const [dayPart, rest] = t.includes('-') ? t.split('-') : ['0', t]
  const parts = rest!.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Number(dayPart) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
}

function descendants(root: number): { pid: number; rss: number; cpu: number; command: string }[] {
  const out = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss=,time=,command=']).stdout.toString().split('\n')
  const rows = out
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cpu: parseCpu(m[4]!), command: m[5]! }))
  const seen = new Set<number>([root])
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) (seen.add(r.pid), (grew = true))
  }
  return rows.filter((r) => seen.has(r.pid) && r.pid !== root)
}

/** True when something can be bound to the port on this address (a port can be free on one address family and taken on the other). */
const bindable = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })

/**
 * A port nothing is using on either address family. `vite preview` listens on `localhost`, which Node resolves to ::1 or 127.0.0.1
 * depending on the machine, and a second server on the other family would share the port number without any error: a browser and a
 * `fetch` could then be answered by different servers. So the port is taken from the system (port 0) and then checked on both.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const { port: got } = probe.address() as { port: number }
        probe.close(() => resolve(got))
      })
    })
    if ((await bindable(port, '::1')) && (await bindable(port, '127.0.0.1'))) return port
  }
  throw new Error('no free port found')
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Starts the Worker. Every call gets a port of its own unless one is named in the environment variable `portEnv` (for the person who
 * wants a fixed address while debugging), so two test files, or two checkouts' runs, can never share a server.
 */
export async function startServer(opts: { portEnv?: string; build?: boolean; clients?: { number?: number; name: string; legalName?: string | null; archived?: boolean }[] } = {}): Promise<Server> {
  const named = opts.portEnv ? process.env[opts.portEnv] : undefined
  const port = named ? Number(named) : await freePort()
  const base = `http://localhost:${port}`
  const certs = await makeSealCerts(new Date(), 2048)
  const masterKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  const devVars = `${ROOT}dev/.dev.vars`
  const previous = existsSync(devVars) ? readFileSync(devVars, 'utf8') : null
  writeFileSync(devVars, ['ALLOW_UNAUTHENTICATED=1', `FORMS_DATA_KEY="${masterKey}"`, `FORMS_SEAL_KEY="${escaped(certs.seal.keyPem)}"`, `FORMS_SEAL_CERT_CHAIN="${escaped(certs.seal.certPem + certs.root.certPem)}"`, ...(opts.clients ? [`DEV_CLIENTS="${Buffer.from(JSON.stringify(opts.clients)).toString('base64')}"`] : []), ''].join('\n'))

  if (opts.build !== false) {
    const built = Bun.spawnSync(['bunx', 'vite', 'build', '--config', 'dev/vite.config.ts'], { cwd: ROOT, stderr: 'pipe', stdout: 'pipe' })
    if (built.exitCode !== 0) throw new Error(`vite build failed:\n${built.stderr.toString()}\n${built.stdout.toString()}`)
  }
  // A fresh local database and bucket every run, so a changed migration is the one under test (a database already
  // migrated would keep its old schema). This is also what `bun run dev` uses, so running the e2e clears its data.
  rmSync(`${ROOT}.wrangler/state`, { recursive: true, force: true })
  const migrated = Bun.spawnSync(['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'forms-records', '--local', '--config', 'dev/wrangler.jsonc', '--persist-to', '.wrangler/state'], { cwd: ROOT, stderr: 'pipe', stdout: 'pipe' })
  if (migrated.exitCode !== 0) throw new Error(`local migrations failed:\n${migrated.stderr.toString()}\n${migrated.stdout.toString()}`)

  // A port named by hand may already be in use: a server that answers there would be mistaken for ours (its database and mail files
  // are not ours), so an answering port is a refusal, not a server to reuse.
  if (await fetch(`${base}/admin/api/me`).then(() => true, () => false)) throw new Error(`something already answers on ${base}; another e2e run is using this port (unset ${opts.portEnv ?? 'the port variable'} to be given a free one)`)
  const proc = Bun.spawn(['bunx', 'vite', 'preview', '--config', 'dev/vite.config.ts', '--port', String(port), '--strictPort'], { cwd: ROOT, stdout: process.env.FORMS_E2E_LOGS ? 'inherit' : 'ignore', stderr: process.env.FORMS_E2E_LOGS ? 'inherit' : 'ignore' })
  const deadline = Date.now() + 90_000
  let ready = false
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`the preview server exited (code ${proc.exitCode}) before it was ready on ${base}`)
    try {
      if ((await fetch(`${base}/admin/api/me`)).ok) {
        ready = true
        break
      }
    } catch {}
    await Bun.sleep(300)
  }
  if (!ready) {
    proc.kill()
    throw new Error(`preview server never became ready on ${base}`)
  }
  let workerdPids: number[] | null = null
  return {
    base,
    pid: proc.pid,
    certs,
    async kill() {
      const tree = descendants(proc.pid).map((d) => d.pid)
      for (const pid of tree) {
        try {
          process.kill(pid)
        } catch {}
      }
      proc.kill()
      // Wait for the exit instead of firing and forgetting: the next file's server writes the same `.wrangler/state` and `.dev.vars`,
      // and a database still being closed by this one must not be under it.
      await Promise.race([proc.exited, Bun.sleep(8_000)])
      const left = () => [proc.pid, ...tree].filter(alive)
      for (const pid of left()) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      for (let i = 0; i < 30 && left().length > 0; i++) await Bun.sleep(100)
      if (previous === null) rmSync(devVars, { force: true })
      else writeFileSync(devVars, previous)
    },
    rss() {
      workerdPids ??= descendants(proc.pid).filter((d) => /workerd/.test(d.command)).map((d) => d.pid)
      return workerdPids.reduce((n, pid) => n + residentKb(pid), 0)
    },
    sample() {
      const workerd = descendants(proc.pid).filter((d) => /workerd/.test(d.command))
      return { rssKb: workerd.reduce((n, d) => n + d.rss, 0), cpuSeconds: workerd.reduce((n, d) => n + d.cpu, 0), pids: workerd.map((d) => d.pid) }
    },
  }
}
