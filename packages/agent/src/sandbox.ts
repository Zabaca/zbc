// The containment boundary: Anthropic's sandbox-runtime (`srt`) wrapped around
// the Claude Code CLI process.
//
// The SDK ships a `sandbox` option that runs this same engine, and it is not
// enough. The SDK applies it per *Bash command*, and `Read`, `Grep`, `Glob`,
// `Write` and `Edit` run inside the CLI process without ever shelling out — so
// nothing hands them to the kernel. Measured against the shipped configuration,
// with `denyRead: [$HOME]` set:
//
//     Bash  cat ~/.zbc-read-probe/secret.txt  -> Operation not permitted
//     Read  ~/.zbc-read-probe/secret.txt      -> the file's contents
//     Grep  ~/.zbc-read-probe                 -> the file's contents
//
// `srt` applies the same restrictions to a whole process tree. Wrapping the CLI
// with it covers every tool by construction, including the next one someone
// adds. The two cannot be combined: the kernel refuses `sandbox_apply` inside an
// existing sandbox, so leaving the SDK's `sandbox` option on kills every Bash
// command with `sandbox_apply: Operation not permitted` and exit 71.
//
// See docs/adr/0002-containment-wraps-the-cli-process.md.
import { execFile as execFileCb } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/**
 * Binaries the agent must not run, denied by making them unreadable.
 *
 * `srt` has no execute allowlist, but denying a read of the binary denies the
 * exec — verified: `security` becomes `command not found`, exit 127, while
 * every other binary under `/usr/bin` still runs. A narrow `denyRead` wins over
 * the broad `allowRead` that re-opens `/usr`.
 *
 * `security` is the load-bearing one. The CLI reads its stored credentials by
 * spawning it, so a sandbox that lets the CLI authenticate from the Keychain is
 * a sandbox where the agent can run `security find-generic-password -w -s …`
 * against every item the operator owns. That is why `requireCredentials` exists.
 */
export const DENIED_BINARIES = [
  '/usr/bin/security', // Reads the login Keychain.
  '/usr/bin/osascript', // Scripts other applications, outside the sandbox.
  '/usr/bin/open', // Launches applications outside the sandbox.
  '/usr/bin/sudo',
] as const

/**
 * Environment variables carrying a credential the CLI can use without the
 * Keychain. `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`.
 */
export const CREDENTIAL_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const

/** Filename of the generated settings, inside a workspace's config root. */
export const SETTINGS_FILE = 'srt-settings.json'

/**
 * Hosts every sandboxed run may reach.
 *
 * The registry is here so a repository's dependencies can be installed and an
 * agent can add one. It is a real widening — a request path to an allowed host
 * can carry data out — and a deliberate one, since an agent that cannot install
 * a dependency cannot work on most repositories. Splitting it into an
 * install-only phase is strictly tighter and stays available; see ADR 0004.
 */
export const ALLOWED_DOMAINS = ['api.anthropic.com', 'registry.npmjs.org'] as const

export type SandboxOptions = {
  /**
   * Extra paths the agent may read outside its workspace. Prefer redirecting a
   * tool's config into the workspace over adding one — see `workspaceEnv`.
   */
  allowRead?: string[]
  /** Extra hosts the agent may reach. `api.anthropic.com` is always included. */
  allowedDomains?: string[]
}

/**
 * Fail before an agent starts if there is no credential it can use.
 *
 * Without this the symptom is `EPERM: posix_spawn 'security'` thrown from
 * inside a minified bundle, which reads as a broken sandbox rather than a
 * missing token.
 */
export function requireCredentials(env: NodeJS.ProcessEnv = process.env): void {
  if (CREDENTIAL_ENV.some((name) => env[name])) return
  throw new Error(
    `No credential in the environment. Sandboxed agents cannot use the login ` +
      `Keychain: the CLI reads it by spawning /usr/bin/security, and a sandbox ` +
      `that allows that binary hands the agent every Keychain item too. Set one ` +
      `of ${CREDENTIAL_ENV.join(', ')} — \`claude setup-token\` mints the first.`,
  )
}

/** Absolute path of the `srt` entry point, resolved from this package. */
export function srtExecutable(): string {
  const pkg = dirname(
    Bun.resolveSync('@anthropic-ai/sandbox-runtime/package.json', import.meta.dir),
  )
  return join(pkg, 'dist', 'cli.js')
}

/**
 * Absolute path of the CLI binary the SDK would otherwise spawn.
 *
 * It ships as a versioned optional dependency (`…-darwin-arm64`) rather than
 * inside the SDK package, and is not hoisted to the root `node_modules`, so it
 * resolves from the SDK's own directory. Resolved from this module rather than
 * `process.cwd()`, or a caller running from the repo root cannot find it.
 */
export function claudeExecutable(): string {
  const sdk = dirname(Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir))
  return Bun.resolveSync(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
    sdk,
  )
}

export type SandboxTargets = {
  /** The clone. Read, write and execute — the agent's whole world. */
  dir: string
  /** Workspace-local config root. Read and write. */
  home: string
}

export type SrtSettings = {
  network: { allowedDomains: string[]; deniedDomains: string[] }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

/**
 * Settings for one workspace.
 *
 * `denyRead: ['/']` is what turns `srt`'s defaults inside out. Out of the box it
 * allows reads everywhere and denies a built-in list of credential paths — a
 * denylist protects what someone remembered. Denying the root and allowing back
 * only the toolchain protects what they did not: `~/.ssh`, `~/.aws` and the SOPS
 * age key are unreachable without anyone having had to name them.
 */
export function srtSettings(
  targets: SandboxTargets,
  { allowRead = [], allowedDomains = [] }: SandboxOptions = {},
): SrtSettings {
  const home = homedir()

  return {
    network: {
      // Seatbelt alone could never express this — it filters by socket, not by
      // hostname. `srt` runs a host-side proxy, so the allowlist is real.
      allowedDomains: [...ALLOWED_DOMAINS, ...allowedDomains],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: ['/', ...DENIED_BINARIES],
      allowRead: [
        '/usr',
        '/bin',
        '/sbin',
        '/opt',
        '/System',
        '/Library',
        '/private/etc',
        '/private/var',
        // /etc and /var are symlinks into /private on macOS, and tools hardcode
        // both spellings — curl reads the literal /etc/ssl/cert.pem.
        '/etc',
        '/var',
        '/dev',
        // Both spellings: /tmp is a symlink to /private/tmp on macOS, and srt
        // matches the literal path it is given rather than the resolved one.
        '/private/tmp',
        '/tmp',
        // The toolchain, and only the toolchain, out of $HOME.
        join(home, '.bun'),
        // The CLI binary itself resolves inside the consuming repo's
        // node_modules, which is under $HOME and therefore denied with it.
        dirname(claudeExecutable()),
        dirname(dirname(srtExecutable())),
        targets.dir,
        targets.home,
        ...allowRead,
      ],
      allowWrite: [targets.dir, targets.home, '/private/tmp', '/tmp', '/dev'],
      denyWrite: [],
    },
  }
}

/**
 * Write the settings and a shim that applies them, and return the shim's path.
 *
 * The shim goes to `pathToClaudeCodeExecutable`, so the SDK spawns it in place
 * of the CLI and the entire tool-running process tree lands inside the sandbox.
 * Both files live in the workspace and die with it.
 */
export async function writeSandboxShim(
  targets: SandboxTargets,
  options: SandboxOptions = {},
): Promise<string> {
  requireCredentials()

  const settingsPath = join(targets.home, SETTINGS_FILE)
  const shimPath = join(targets.home, 'claude-sandboxed')

  await writeFile(settingsPath, `${JSON.stringify(srtSettings(targets, options), null, 2)}\n`)
  await writeFile(
    shimPath,
    [
      '#!/bin/sh',
      '# Generated by @zbc/agent. Runs the CLI inside sandbox-runtime.',
      '#',
      '# The `--` is load-bearing. srt parses options anywhere in its argv, and',
      '# the SDK passes the CLI its own `--settings <json>` — which srt would',
      '# otherwise consume, then refuse to start because the JSON is not a path.',
      `exec ${shellQuote(process.execPath)} ${shellQuote(srtExecutable())} \\`,
      `  -s ${shellQuote(settingsPath)} -- ${shellQuote(claudeExecutable())} "$@"`,
      '',
    ].join('\n'),
  )
  await chmod(shimPath, 0o755)

  // `srt` refuses to run on an invalid settings file rather than falling back to
  // its defaults, which is the behaviour we want — but the refusal should
  // surface here, not as a failed agent run ten seconds later.
  await execFile(process.execPath, [srtExecutable(), '-s', settingsPath, '/usr/bin/true']).catch(
    (error: Error) => {
      throw new Error(`Generated sandbox settings do not load: ${error.message}`)
    },
  )

  return shimPath
}

/**
 * Run a command inside a workspace's sandbox.
 *
 * This exists because setup is not a safe thing to run on the host. `bun install`
 * executes postinstall scripts from the target repository's dependency tree —
 * arbitrary code, from the same untrusted input the sandbox exists to contain.
 * Running it host-side to save a hop would reopen the hole ADR 0002 closed, by a
 * different door.
 */
export async function runInSandbox(
  targets: SandboxTargets,
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const [command, ...rest] = argv
  if (!command) throw new Error('runInSandbox needs a command')

  return execFile(
    process.execPath,
    [srtExecutable(), '-s', join(targets.home, SETTINGS_FILE), '--', command, ...rest],
    {
      cwd: options.cwd ?? targets.dir,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...options.env },
    },
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
