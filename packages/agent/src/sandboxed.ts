// The composition every sandboxed profile shares.
//
// This exists because the containment was written twice — once in `coding`, once
// in `review` — byte-identical apart from which constant it spread. That is the
// wrong thing to have two copies of. A boundary that is duplicated is a boundary
// where one copy can drift, and the drift produces an agent that works perfectly
// and is no longer contained, which nothing else in the repo would notice.
//
// A profile now says what an agent *is*. This says where it runs and what it
// cannot reach, once.
import { type Options, query } from '@anthropic-ai/claude-agent-sdk'
import { type MinimalOptions, minimalOptions } from './index'
import type { SandboxOptions } from './sandbox'
import { type Trait, withTraits } from './traits'
import { type Workspace, createWorkspace, workspaceEnv } from './workspace'

export type SandboxedProfile = MinimalOptions & {
  /** What this agent is for. Not sent — this is for whoever picks a profile. */
  description: string
  /**
   * Shapes the caller's input into the user turn. Omitted means pass it through,
   * which is right for a free-form task and wrong for a target that needs
   * framing — see `review`.
   */
  prompt?: (input: string) => string
}

export type RunOptions = SandboxOptions & {
  /**
   * Workspace to run in. Omitted, a fresh one is created and handed back.
   *
   * Pass one to keep working in the same clone across calls — the agent sees the
   * files it already changed, and `collect()` still runs once at the end. A
   * workspace the caller supplied is the caller's: failure will not dispose it.
   */
  workspace?: Workspace
  /**
   * Session to continue, from a previous `RunResult.sessionId`.
   *
   * Requires `workspace`, and the same one: the CLI keeps session transcripts
   * under `CLAUDE_CONFIG_DIR`, which points inside the workspace, so a fresh
   * workspace has no history to resume and would silently start over.
   */
  resume?: string
  /** Repository to work on. Defaults to the current working directory. */
  repo?: string
  /** Branch checked out in the workspace. Defaults to a unique `agent/<id>`. */
  branch?: string
  /** Cap on agent turns. Left unset, the SDK decides. */
  maxTurns?: number
  /** Instruction layers applied over the profile. Cannot widen capability. */
  traits?: Trait[]
  /** Overrides applied over the profile — tools, model, effort, and so on. */
  overrides?: MinimalOptions
}

export type RunResult = {
  /** Kept open deliberately: the caller owns `collect()` and `dispose()`. */
  workspace: Workspace
  /** Pass back as `resume`, with this same workspace, to continue the session. */
  sessionId: string
  /** The agent's prose. What it *did* is in the workspace, not here. */
  text: string
  turns: number
  stopReason: string
  usage: Record<string, unknown>
  totalCostUsd: number
}

/**
 * Options for any profile confined to a workspace.
 *
 * Split out from `runSandboxed` so the composition is inspectable without
 * running anything — this is the security boundary, and a test should be able to
 * assert its shape without spending money.
 */
export function sandboxedOptions(
  profile: SandboxedProfile,
  workspace: Workspace,
  options: RunOptions = {},
): Options {
  const { description: _description, prompt: _prompt, ...preset } = profile

  return {
    ...minimalOptions({
      ...withTraits(preset, ...(options.traits ?? [])),
      ...options.overrides,
      env: { ...workspaceEnv(workspace), ...options.overrides?.env },
      // After the overrides, so it cannot be switched back on by accident.
      // `denyRead` protects a credential *file*; nothing protects a credential
      // *value* in the environment, and an agent with Bash only has to run
      // `env`. Name what an agent needs in `overrides.env`.
      inheritEnv: false,
    }),

    cwd: workspace.dir,

    // The containment. The SDK spawns this instead of the CLI; it runs the real
    // binary inside sandbox-runtime, so every tool lands in the boundary rather
    // than only the ones that shell out. See docs/adr/0002.
    //
    // The SDK's own `sandbox` option is deliberately absent and must stay so:
    // the kernel refuses `sandbox_apply` inside an existing sandbox, and setting
    // it kills every Bash command with exit 71.
    pathToClaudeCodeExecutable: workspace.shim,

    // The kernel is the boundary, not the permission prompt — and a headless run
    // has nobody to answer one. Everything this bypasses is already denied by
    // the sandbox, which is what makes it safe to bypass.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,

    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  }
}

/**
 * Run a profile against a fresh workspace.
 *
 * Returns with the workspace still on disk. That is the point: `collect()` is a
 * separate, host-initiated step so a human decides what enters the real
 * repository, and uncommitted work stays recoverable until `dispose()`.
 */
export async function runSandboxed(
  profile: SandboxedProfile,
  input: string,
  options: RunOptions = {},
): Promise<RunResult> {
  if (options.resume !== undefined && options.workspace === undefined) {
    throw new Error(
      'resume needs the workspace the session ran in. Session transcripts live ' +
        'under CLAUDE_CONFIG_DIR, which points inside the workspace, so a fresh ' +
        'one has no history and the agent would silently start over.',
    )
  }

  // A caller-supplied workspace is the caller's to dispose, including on failure
  // — the point of passing one is that it outlives the call.
  const owned = options.workspace === undefined
  const workspace =
    options.workspace ??
    (await createWorkspace({
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.allowRead === undefined ? {} : { allowRead: options.allowRead }),
      ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
    }))

  try {
    let text = ''
    let turns = 0
    let stopReason = 'unknown'
    let usage: Record<string, unknown> = {}
    let totalCostUsd = 0
    let sessionId = ''

    for await (const message of query({
      prompt: profile.prompt ? profile.prompt(input) : input,
      options: sandboxedOptions(profile, workspace, options),
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') text += block.text
        }
      }
      if (message.type === 'result') {
        turns = message.num_turns ?? 0
        stopReason = message.subtype ?? 'unknown'
        usage = (message.usage ?? {}) as Record<string, unknown>
        totalCostUsd = message.total_cost_usd ?? 0
        sessionId = message.session_id
      }
    }

    return { workspace, sessionId, text: text.trim(), turns, stopReason, usage, totalCostUsd }
  } catch (error) {
    // Only when we created it. A successful run always leaves the workspace for
    // the caller, and a borrowed one is never ours to throw away.
    if (owned) await workspace.dispose()
    throw error
  }
}
