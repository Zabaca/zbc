// The coding profile: an agent that edits code, contained by a Workspace.
//
// This is the one profile where the base module's thesis does not apply. Tool
// schemas for the set below are 7,404 input tokens against the base package's
// 124, and the Claude Code preset adds ~3,148 more. Both sit in the cached
// prefix, so the recurring cost is a cache read; there is nothing to win by
// trimming them and a working agent to lose.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import {
  type RunOptions,
  type RunResult,
  type SandboxedProfile,
  runSandboxed,
  sandboxedOptions,
} from './sandboxed'
import type { Workspace } from './workspace'

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
} as const satisfies SandboxedProfile

export type CodeOptions = RunOptions
export type CodeResult = RunResult

/** Options for a coding agent confined to `workspace`. */
export function codingOptions(workspace: Workspace, options: CodeOptions = {}): Options {
  return sandboxedOptions(coding, workspace, options)
}

/**
 * Run a coding task against a fresh workspace.
 *
 * The agent commits nothing unless told to. Pass the `committing` trait, or say
 * so in the task, or `collect()` will report `commits: []` and the work will die
 * with the workspace.
 */
export function code(task: string, options: CodeOptions = {}): Promise<CodeResult> {
  return runSandboxed(coding, task, options)
}
