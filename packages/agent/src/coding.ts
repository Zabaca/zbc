// The coding profile: an agent that edits code, contained by a Workspace.
//
// This is the one profile where the base module's thesis does not apply. Tool
// schemas for the set below are 7,404 input tokens against the base package's
// 124, and the Claude Code preset adds ~3,148 more. Both sit in the cached
// prefix, so the recurring cost is a cache read; there is nothing to win by
// trimming them and a working agent to lose.
import { type Options, query } from '@anthropic-ai/claude-agent-sdk'
import { type MinimalOptions, minimalOptions } from './index'
import { type SandboxOptions, type Workspace, createWorkspace, workspaceEnv } from './workspace'

export const CODING_MODEL = 'claude-opus-5'

/**
 * Built-in tools the coding profile carries.
 *
 * `Grep`/`Glob` are named explicitly because the SDK defers them behind
 * `ToolSearch` whenever `Bash` is present. They cost ~1,240 tokens once, in the
 * cached prefix, and save far more in output: `grep -r` through Bash dumps
 * unfiltered matches into context on every call.
 *
 * No `WebSearch`/`WebFetch` — `strictAllowlist` blocks their egress, so
 * including them would ship schemas for tools that always fail.
 */
export const CODING_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] as const

/**
 * What the coding agent *is*, independent of where it runs.
 *
 * `systemPrompt` is Claude Code's own preset rather than something hand-written:
 * the SDK's default is a 62-character identity line with no coding guidance at
 * all, and the preset's `# Doing tasks` and `# Executing actions with care`
 * sections are ~7,000 characters of tested behaviour.
 *
 * `excludeDynamicSections` moves the working directory and git status out of the
 * cached system prompt and into the first user message. Since every run gets a
 * fresh workspace path, leaving them in rewrites 1,343 tokens at cache-write
 * pricing on every session start — measured at 3.4x the cost of an otherwise
 * identical request.
 */
export const coding = {
  description: 'Edits code inside a disposable clone. Opus 5, low effort, Claude Code preset.',
  model: CODING_MODEL,
  effort: 'low',
  tools: [...CODING_TOOLS],
  // Two separate risks, only one of which the workspace solves.
  //
  // CLAUDE.md discovery walks up the directory tree, so from a repo under $HOME
  // it would also load the operator's own home-directory CLAUDE.md. Putting the
  // workspace in a temp root terminates that walk — that part is handled.
  //
  // What remains: 'project' also loads the *cloned repo's* .claude/settings.json,
  // hooks included, and that file arrives from the target repository — the same
  // untrusted input everything else here defends against. We accept it because
  // the targets are our own repositories and the clone is disposable; point this
  // at a repo you did not write and that assumption is gone. Note the asymmetry
  // with `strictMcpConfig`, which exists precisely to stop a stray .mcp.json.
  settingSources: ['project'],
  thinking: { type: 'adaptive' },
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    excludeDynamicSections: true,
  },
} as const satisfies MinimalOptions & { description: string }

export type CodeOptions = SandboxOptions & {
  /** Repository to work on. Defaults to the current working directory. */
  repo?: string
  /** Branch for the agent's work. Defaults to a unique `agent/<id>`. */
  branch?: string
  /** Cap on agent turns. Left unset, the SDK decides. */
  maxTurns?: number
  /** Overrides applied over the profile — tools, model, effort, and so on. */
  overrides?: MinimalOptions
}

export type CodeResult = {
  /** Kept open deliberately: the caller owns `collect()` and `dispose()`. */
  workspace: Workspace
  branch: string
  /** The agent's prose. What it *did* is in the workspace, not here. */
  text: string
  turns: number
  stopReason: string
  usage: Record<string, unknown>
  totalCostUsd: number
}

/**
 * Options for an agent confined to a workspace.
 *
 * Split out from `code()` so the composition is inspectable without running
 * anything — the sandbox is the security boundary, and a test should be able to
 * assert its shape.
 */
export function codingOptions(workspace: Workspace, options: CodeOptions = {}): Options {
  const { description: _description, ...profile } = coding

  return {
    ...minimalOptions({
      ...profile,
      ...options.overrides,
      env: { ...workspaceEnv(workspace), ...options.overrides?.env },
      // After the overrides, so it cannot be switched back on by accident. An
      // agent with Bash can run `env`; denyRead protects credential files, not
      // credential values. Name what this agent needs in `overrides.env`.
      inheritEnv: false,
    }),

    cwd: workspace.dir,

    // The containment. The SDK spawns this instead of the CLI; it runs the real
    // binary inside sandbox-runtime, so every tool lands in the boundary rather
    // than only the ones that shell out.
    //
    // The SDK's own `sandbox` option is deliberately absent: it cannot be
    // combined with this one. The kernel refuses `sandbox_apply` inside an
    // existing sandbox, so enabling it kills every Bash command with exit 71.
    pathToClaudeCodeExecutable: workspace.shim,

    // The kernel is the boundary, not the permission prompt — and a headless
    // run has nobody to answer one. Everything this bypasses is already denied
    // by the profile, which is what makes it safe to bypass.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,

    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  }
}

/**
 * Run a coding task against a fresh workspace.
 *
 * Returns with the workspace still on disk. That is the point: `collect()` is a
 * separate, host-initiated step so a human decides what enters the real
 * repository, and uncommitted work stays recoverable until `dispose()`.
 */
export async function code(task: string, options: CodeOptions = {}): Promise<CodeResult> {
  const workspace = await createWorkspace({
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.allowRead === undefined ? {} : { allowRead: options.allowRead }),
    ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
  })

  try {
    let text = ''
    let turns = 0
    let stopReason = 'unknown'
    let usage: Record<string, unknown> = {}
    let totalCostUsd = 0

    for await (const message of query({
      prompt: task,
      options: codingOptions(workspace, options),
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
      }
    }

    return {
      workspace,
      branch: workspace.branch,
      text: text.trim(),
      turns,
      stopReason,
      usage,
      totalCostUsd,
    }
  } catch (error) {
    // Only on failure — a successful run leaves the workspace for `collect()`.
    await workspace.dispose()
    throw error
  }
}
