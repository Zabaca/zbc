// What a workspace needs before an agent can work in it.
//
// A restore returns *state*, not a running system. The container that held the
// dependencies and the dev server is gone, and nothing about a snapshot brings
// processes back. So every invocation runs an init pass that establishes
// whatever the snapshot deliberately did not carry.
//
// Locally the workspace does not die between turns, so this looks like it only
// matters in the cloud. It does not: a fresh clone has no `node_modules` either,
// and without this an agent gets a repository it cannot build in.
//
// Two properties, both learned by their absence:
//
//   Idempotent — it cannot tell a cold workspace from a restored one, so every
//   step is conditional and safe to repeat.
//
//   Loud — an init that half-works is invisible. The agent starts against
//   missing dependencies and spends its turn "fixing" import errors that are
//   really a failed install.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runInSandbox } from './sandbox'
import { type Workspace, workspaceScratchEnv } from './workspace'

export type InitResult = {
  /** What ran, in order. Empty means the workspace was already ready. */
  steps: string[]
  ms: number
}

/** A step: something to do, and how to tell whether it is already done. */
export type InitStep = {
  name: string
  /** True when this step still needs to run. */
  needed: (workspace: Workspace) => boolean
  argv: string[]
}

/**
 * Lockfile → install command.
 *
 * Detection is by lockfile rather than by `package.json`, because the lockfile
 * is what says which installer the repository actually uses. A repo with no
 * lockfile gets nothing, which is correct: guessing an installer and running it
 * would write one and change the repository.
 */
export const INSTALL_STEPS: InitStep[] = [
  {
    name: 'bun install',
    needed: (w) => existsSync(join(w.dir, 'bun.lock')) || existsSync(join(w.dir, 'bun.lockb')),
    argv: ['bun', 'install', '--frozen-lockfile'],
  },
  {
    name: 'npm ci',
    needed: (w) => existsSync(join(w.dir, 'package-lock.json')),
    argv: ['npm', 'ci'],
  },
  {
    name: 'pnpm install',
    needed: (w) => existsSync(join(w.dir, 'pnpm-lock.yaml')),
    argv: ['pnpm', 'install', '--frozen-lockfile'],
  },
]

/** True when dependencies are already present, so an install can be skipped. */
function installed(workspace: Workspace): boolean {
  return existsSync(join(workspace.dir, 'node_modules'))
}

/**
 * Prepare a workspace for an agent. Runs before every invocation.
 *
 * Everything happens *inside* the sandbox. `bun install` executes postinstall
 * scripts from the target repository's dependency tree — arbitrary code from
 * untrusted input — and running that on the host to save a hop would reopen the
 * hole ADR 0002 closed. That is also why `registry.npmjs.org` is in
 * `ALLOWED_DOMAINS`: the install needs it, and so does an agent asked to add a
 * dependency.
 */
export async function initialize(
  workspace: Workspace,
  steps: InitStep[] = INSTALL_STEPS,
): Promise<InitResult> {
  const t0 = Date.now()
  const ran: string[] = []

  // Only the first matching installer. A repository with two lockfiles is a
  // repository with a problem, and running both would make it worse.
  const install = installed(workspace) ? undefined : steps.find((step) => step.needed(workspace))

  if (install) {
    try {
      await runInSandbox(workspace, install.argv, { env: workspaceScratchEnv(workspace) })
      ran.push(install.name)
    } catch (error) {
      const err = error as { stderr?: string; message?: string }
      // Loud, and with the reason attached. Left to fail quietly, this surfaces
      // later as an agent confidently debugging its own missing dependencies.
      throw new Error(
        `Workspace setup failed at "${install.name}" in ${workspace.dir}.\n` +
          `The agent was not started — it would have run against a repository it ` +
          `cannot build in.\n\n${(err.stderr || err.message || '').slice(-1500)}`,
        { cause: error },
      )
    }
  }

  return { steps: ran, ms: Date.now() - t0 }
}
