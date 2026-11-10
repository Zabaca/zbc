// The space in workerd, for the end-to-end tests of the Forms tab: the production BUNDLE (`vite build`, not the dev transform) served by
// `vite preview`, with the dev switches in .dev.vars. Access cannot be local, so ALLOW_UNAUTHENTICATED=1 makes the browser the signed-in
// person, on localhost only (the sign-in check itself is the company layer's, tested through signed assertions in test/app.test.ts);
// SPACE_FIXTURES=1 gives the Inbox and Meet invented people so the rest of the page can be seen without the inbox or meet. With `formsUrl` (a forms server
// running beside it, stack.ts) the documents a conversation lists are the real forms' (SPACE_FORMS_URL: stand-ins.ts, `withFormsAt`), not the fixtures'.
//
// forms is not behind this server: a local preview has no service binding to it. The tests start forms' own server (the real Worker, a local
// D1 and R2: packages/forms/e2e/server.ts) beside it and hand the page's calls to it (stack.ts).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { freePort } from '@space/forms/e2e/server'
import { NORTHFIELD_DECLARATION_FILE } from '../../workspace/northfield/paths'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export interface Space {
  base: string
  pid: number
  /** Stops the server and returns once it is gone; then puts `.dev.vars` back as it was. */
  kill(): Promise<void>
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The ids of every process under `root`, deepest included (vite preview starts workerd under itself). */
function descendants(root: number): number[] {
  const rows = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=']).stdout.toString().split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s*$/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => [Number(m[1]), Number(m[2])] as const)
  const seen = new Set<number>([root])
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, ppid] of rows) if (!seen.has(pid) && seen.has(ppid)) (seen.add(pid), (grew = true))
  }
  seen.delete(root)
  return [...seen]
}

/** Builds the space and serves the build on a free port (or the one named in the environment variable `portEnv`). */
export async function startSpace(opts: { portEnv?: string; build?: boolean; formsUrl?: string; fixtures?: string } = {}): Promise<Space> {
  const named = opts.portEnv ? process.env[opts.portEnv] : undefined
  const port = named ? Number(named) : await freePort()
  const base = `http://localhost:${port}`
  const devVars = `${ROOT}.dev.vars`
  const previous = existsSync(devVars) ? readFileSync(devVars, 'utf8') : null
  writeFileSync(devVars, ['ALLOW_UNAUTHENTICATED=1', `SPACE_FIXTURES=${opts.fixtures ?? '1'}`, ...(opts.formsUrl ? [`SPACE_FORMS_URL=${opts.formsUrl}`] : []), ''].join('\n'))

  if (opts.build !== false) {
    const built = Bun.spawnSync(['bunx', 'vite', 'build'], { cwd: ROOT, stderr: 'pipe', stdout: 'pipe', env: { ...process.env, SPACE_DEV_LOCAL: '1', SPACE_DECLARATION: process.env.SPACE_DECLARATION || NORTHFIELD_DECLARATION_FILE } })
    if (built.exitCode !== 0) throw new Error(`vite build failed:\n${built.stderr.toString()}\n${built.stdout.toString()}`)
  }
  if (await fetch(`${base}/api/me`).then(() => true, () => false)) throw new Error(`something already answers on ${base} (unset ${opts.portEnv ?? 'the port variable'} to be given a free one)`)
  const proc = Bun.spawn(['bunx', 'vite', 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, env: { ...process.env, SPACE_DEV_LOCAL: '1' }, stdout: process.env.SPACE_E2E_LOGS ? 'inherit' : 'ignore', stderr: process.env.SPACE_E2E_LOGS ? 'inherit' : 'ignore' })
  const deadline = Date.now() + 90_000
  let ready = false
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`the preview server exited (code ${proc.exitCode}) before it was ready on ${base}`)
    try {
      if ((await fetch(`${base}/api/me`)).ok) {
        ready = true
        break
      }
    } catch {}
    await Bun.sleep(300)
  }
  if (!ready) {
    proc.kill()
    throw new Error(`the preview server never became ready on ${base}`)
  }
  return {
    base,
    pid: proc.pid,
    async kill() {
      const tree = descendants(proc.pid)
      for (const pid of tree) {
        try {
          process.kill(pid)
        } catch {}
      }
      proc.kill()
      await Promise.race([proc.exited, Bun.sleep(8_000)])
      for (const pid of [proc.pid, ...tree].filter(alive)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      for (let i = 0; i < 30 && [proc.pid, ...tree].some(alive); i++) await Bun.sleep(100)
      if (previous === null) rmSync(devVars, { force: true })
      else writeFileSync(devVars, previous)
    },
  }
}
