// A Workspace is a disposable clone of a target repository, created outside
// $HOME so an agent's reads can be confined by denying the real one.
//
// The shape is a security invariant, not a convenience, which is why this
// module owns it rather than taking a directory from the caller. Three ways to
// get it wrong all leave an agent that appears to work perfectly:
//
//   - a `git worktree`, whose `.git` is a pointer into the origin's
//     `.git/worktrees/` — every git command then reaches into the denied path
//   - a `--shared` / `--reference` clone, whose `objects/info/alternates`
//     points at the origin for the same effect
//   - a clone under $HOME, where `denyRead` cannot be applied without also
//     denying the workspace
//
// See docs/adr/0001-coding-agents-work-in-a-disposable-clone.md.
import { execFile as execFileCb } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

const execFile = promisify(execFileCb)

const git = async (args: string[], cwd?: string): Promise<string> => {
  const { stdout } = await execFile('git', args, {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Identity the agent's commits are authored with, so its work is attributable. */
export const AGENT_IDENTITY = { name: 'zbc agent', email: 'agent@zbc.local' } as const

export type Workspace = {
  /** Root of the disposable tree. Everything below is thrown away together. */
  root: string
  /** The clone itself — the agent's working directory. */
  dir: string
  /** Absolute path of the repository this was cloned from. */
  repo: string
  /** Branch the agent commits to. */
  branch: string
  /** Commit the branch started from, so `collect` can list what was added. */
  base: string
  /** Workspace-local config root that `GIT_CONFIG_GLOBAL`/`XDG_CONFIG_HOME` point at. */
  home: string
  /** Remove the whole tree. Safe to call more than once. */
  dispose(): Promise<void>
}

export type CreateWorkspaceOptions = {
  /** Repository to clone. Defaults to the current working directory. */
  repo?: string
  /** Branch name for the agent's work. Defaults to a unique `agent/<id>`. */
  branch?: string
  /**
   * Where the workspace tree is created. Defaults to the system temp dir.
   * Must not be inside `$HOME` — that is what makes `denyRead` possible.
   */
  root?: string
}

/**
 * Clone `repo` into a disposable tree and check out a fresh branch.
 *
 * `--no-hardlinks` is a containment requirement, not a preference. A local
 * clone hardlinks its object store by default, and a hardlink is not a path —
 * it is a second name for the same inode. The sandbox permits writes under the
 * workspace, so writing through one of those names corrupts the *origin*:
 *
 *     chmod u+w <clone>/.git/objects/xx/yyyy && echo x > <clone>/.git/objects/xx/yyyy
 *     git -C <origin> cat-file -p HEAD:a.txt
 *     fatal: loose object xxyyyy… is corrupt
 *
 * That is a write path out of a workspace whose whole promise is that it has
 * none, and `dispose()` cannot undo it. The cost is one object-store copy.
 *
 * An `alternates` file is the same class of leak by a different route, so it is
 * asserted against rather than assumed absent.
 */
export async function createWorkspace({
  repo = process.cwd(),
  branch,
  root = tmpdir(),
}: CreateWorkspaceOptions = {}): Promise<Workspace> {
  const repoPath = resolve(repo)
  // Resolved through symlinks before the guard, or the guard is decorative: a
  // root that is a symlink into $HOME passes a `resolve()`-only check and then
  // lands somewhere `denyRead: [$HOME]` covers, leaving an agent that cannot
  // read its own workspace and an error a long way from its cause.
  const rootPath = await realpath(resolve(root)).catch(() => resolve(root))

  if (isInside(rootPath, homedir())) {
    throw new Error(
      `Workspace root ${rootPath} is inside $HOME. The sandbox denies reads under ` +
        `$HOME, so a workspace there would be unreadable by the agent working in it. ` +
        `Pass a root outside $HOME (the default, ${tmpdir()}, already is).`,
    )
  }

  // Fail here rather than with an opaque clone error three lines later.
  const toplevel = await git(['-C', repoPath, 'rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`${repoPath} is not a git repository, so there is nothing to clone.`)
  })

  // Resolved, because the system temp dir is a symlink on macOS (/var/folders →
  // /private/var/folders). Git and the sandbox both work in realpaths, so
  // handing out the unresolved one makes every path comparison a coin flip.
  const workspaceRoot = await realpath(await mkdtemp(join(rootPath, 'zbc-agent-')))
  const dir = join(workspaceRoot, 'repo')
  const home = join(workspaceRoot, 'home')

  await git(['clone', '--quiet', '--no-hardlinks', toplevel, dir])

  // Defensive: a clone that borrows objects from the origin reads into the
  // denied path on the first command that needs a missing object, and the
  // failure is remote from the cause.
  const alternates = await readFile(join(dir, '.git/objects/info/alternates'), 'utf8').catch(
    () => null,
  )
  if (alternates !== null) {
    await rm(workspaceRoot, { recursive: true, force: true })
    throw new Error(
      `Clone borrows objects from ${alternates.trim()}, which the sandbox denies. ` +
        `The workspace must be a plain clone — not --shared or --reference.`,
    )
  }

  const branchName = branch ?? `agent/${workspaceRoot.split('zbc-agent-')[1]}`
  const base = await git(['-C', dir, 'rev-parse', 'HEAD'])
  await git(['-C', dir, 'checkout', '--quiet', '-b', branchName])

  // Git config goes in the workspace, not in an `allowRead` hole punched into
  // $HOME. Every tool that reads a dotfile should get this treatment: redirect
  // it inward rather than widening the sandbox outward.
  await mkdir(join(home, 'xdg', 'git'), { recursive: true })
  await writeFile(
    join(home, 'gitconfig'),
    `[user]\n\tname = ${AGENT_IDENTITY.name}\n\temail = ${AGENT_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n`,
  )
  await writeFile(join(home, 'xdg', 'git', 'ignore'), '')

  return {
    root: workspaceRoot,
    dir,
    repo: toplevel,
    branch: branchName,
    base,
    home,
    dispose: () => rm(workspaceRoot, { recursive: true, force: true }),
  }
}

/**
 * Environment that points the toolchain's config at the workspace.
 *
 * `HOME` is conspicuously absent and must stay that way: redirecting it hides
 * the login Keychain, which 401s the CLI and raises a system dialog.
 */
export function workspaceEnv(workspace: Workspace): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: join(workspace.home, 'gitconfig'),
    XDG_CONFIG_HOME: join(workspace.home, 'xdg'),
  }
}

export type SandboxOptions = {
  /**
   * Extra paths re-allowed inside the denied `$HOME`. Only executables should
   * need this — config belongs in the workspace via `workspaceEnv`.
   */
  allowRead?: string[]
  /** Hosts the agent may reach. `api.anthropic.com` is always included. */
  allowedDomains?: string[]
}

/**
 * Toolchain paths under `$HOME` that must stay readable for anything to run.
 * Only executables and runtime data — deliberately not config.
 */
function toolchainPaths(): string[] {
  const home = homedir()
  return [
    process.execPath, // the bun/node binary running this
    join(home, '.bun'),
    join(home, '.local', 'share', 'claude'), // the Claude Code CLI itself
    join(home, '.nvm'),
  ]
}

/**
 * Sandbox policy for a workspace.
 *
 * Every field here was load-bearing under test. In particular
 * `allowUnsandboxedCommands: false`: with it left at the default, an agent that
 * hits `Operation not permitted` will simply retry with Bash's
 * `dangerouslyDisableSandbox` parameter and succeed.
 */
export function sandboxFor(
  _workspace: Workspace,
  { allowRead = [], allowedDomains = [] }: SandboxOptions = {},
): NonNullable<Options['sandbox']> {
  return {
    enabled: true,
    // Never `false`. Silent degradation means an unsandboxed agent and no signal.
    failIfUnavailable: true,
    // The OS boundary is doing the work, so there is nothing for a prompt to add
    // — and a headless run has no one to answer it.
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,

    filesystem: {
      // Deny the whole of $HOME and re-allow the toolchain. `allowRead` only
      // re-allows *within* a `denyRead` region — on its own it does nothing,
      // which is why the deny has to be this broad to be an allowlist at all.
      denyRead: [homedir()],
      allowRead: [...toolchainPaths(), ...allowRead],
    },

    // Reads being open would not matter much without egress; together they are
    // how a read becomes a leak.
    network: {
      allowedDomains: ['api.anthropic.com', ...allowedDomains],
      strictAllowlist: true,
    },
  }
}

export type Collected = {
  branch: string
  /** Commits the agent added, newest first. Empty means it committed nothing. */
  commits: string[]
}

/**
 * Fetch the agent's branch out of a workspace and into the real repository.
 *
 * This is the only moment work crosses the containment boundary, and it is
 * always host-initiated — the workspace's `origin` points into denied territory,
 * so the agent cannot push even if told to. Nothing is merged: the branch lands
 * as a ref for a human to review.
 */
export async function collect(workspace: Workspace): Promise<Collected> {
  const commits = (
    await git(['-C', workspace.dir, 'log', '--oneline', `${workspace.base}..${workspace.branch}`])
  )
    .split('\n')
    .filter(Boolean)

  if (commits.length > 0) {
    await git([
      '-C',
      workspace.repo,
      'fetch',
      workspace.dir,
      `${workspace.branch}:${workspace.branch}`,
    ])
  }

  return { branch: workspace.branch, commits }
}

/** True when `path` is `parent` or sits beneath it. */
function isInside(path: string, parent: string): boolean {
  const a = resolve(path)
  const b = resolve(parent)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}
