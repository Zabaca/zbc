import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * The CLI-level test seam: a throwaway zbc project on disk, and the real `zbc`
 * binary run against it as a subprocess. argv in, exit code + stdout + files
 * out — nothing reaches inside a command.
 *
 * It lives here rather than inside one test file because three commands now
 * need it (`secret`, `apply --json`, `list`), and a second copy is how the two
 * would drift about what a minimal project contains.
 */

const CLI = path.join(import.meta.dir, '../index.ts')

const createdRoots: string[] = []

export interface ProjectOptions {
  /** The one environment the project declares. Default `production`. */
  env?: string
  /** Contents of `packages/infra/environments/<env>/secrets.yaml`. Omit for none. */
  secrets?: string
  /** Instance files to write into the environment directory, by file name. */
  instances?: Record<string, string>
}

/** Minimal zbc project: zbc.config.ts + one environment dir. */
export function makeProject(opts: ProjectOptions = {}): string {
  const env = opts.env ?? 'production'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zbc-cli-test-'))
  createdRoots.push(root)
  fs.writeFileSync(
    path.join(root, 'zbc.config.ts'),
    `export default { project: 'testproj', environments: ['${env}'] }\n`,
  )
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'testproj', workspaces: ['packages/*'], private: true }),
  )
  const infraDir = path.join(root, 'packages/infra')
  fs.mkdirSync(infraDir, { recursive: true })
  fs.writeFileSync(path.join(infraDir, 'package.json'), JSON.stringify({ name: 'infra' }))
  const envDir = path.join(root, 'packages/infra/environments', env)
  fs.mkdirSync(envDir, { recursive: true })
  if (opts.secrets !== undefined) {
    fs.writeFileSync(path.join(envDir, 'secrets.yaml'), opts.secrets)
  }
  for (const [file, source] of Object.entries(opts.instances ?? {})) {
    fs.writeFileSync(path.join(envDir, file), source)
  }
  return root
}

/** Remove every project `makeProject` created. Call from the suite's `afterEach`. */
export function cleanupProjects(): void {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CliProc {
  proc: ReturnType<typeof Bun.spawn>
  /** Resolves with all captured stdout once the process exits. */
  result: Promise<CliResult>
  /** Waits until stdout matches `re`, returning the first capture group (or whole match). */
  waitForStdout(re: RegExp): Promise<string>
}

/** Spawn the CLI without waiting for exit, so the test can play the browser. */
export function spawnCli(cwd: string, args: string[], env: Record<string, string> = {}): CliProc {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  let stdoutSoFar = ''
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const waiters: Array<{ re: RegExp; resolve: (m: string) => void }> = []
  const capture = (m: RegExpMatchArray): string => m[1] ?? m[0]
  const done = (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      stdoutSoFar += decoder.decode(value, { stream: true })
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]!
        const m = stdoutSoFar.match(waiter.re)
        if (m) {
          waiters.splice(i, 1)
          waiter.resolve(capture(m))
        }
      }
    }
    return stdoutSoFar
  })()
  return {
    proc,
    result: (async () => {
      const [stdout, stderr, exitCode] = await Promise.all([
        done,
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ])
      return { exitCode, stdout, stderr }
    })(),
    waitForStdout(re: RegExp) {
      const m = stdoutSoFar.match(re)
      if (m) return Promise.resolve(capture(m))
      return new Promise<string>((resolve) => waiters.push({ re, resolve }))
    },
  }
}

/** Run the CLI to completion. */
export async function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CliResult> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}
