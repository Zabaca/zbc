// The review profile: an agent that reads code and reports on it, contained by
// the same Workspace the coding profile uses.
//
// It is `coding` with two deliberate inversions. It cannot write — a reviewer
// that can edit the code under review is not a reviewer, it is a second author
// — and it runs at high effort rather than low, because a review is a handful
// of turns whose entire value is catching what a cheaper pass would miss.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import {
  type RunOptions,
  type RunResult,
  type SandboxedProfile,
  runSandboxed,
  sandboxedOptions,
} from './sandboxed'
import type { Workspace } from './workspace'

export const REVIEW_MODEL = 'claude-opus-5'

/**
 * Built-in tools the review profile carries.
 *
 * No `Write`, no `Edit`: the containment argument for those is the same as the
 * coding profile's, but the reason to omit them here is the job itself. Shipping
 * them would also ship the invitation to use them.
 *
 * `Bash` stays — `git diff` and `git log` are how a review of a ref range is
 * done at all — and `Grep`/`Glob` are named explicitly because the SDK defers
 * them behind `ToolSearch` whenever `Bash` is present.
 *
 * No `WebSearch`/`WebFetch` — `strictAllowlist` blocks their egress, so
 * including them would ship schemas for tools that always fail.
 */
export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const

/**
 * Instructions for the reviewer.
 *
 * Hand-written rather than Claude Code's preset: the preset's `# Doing tasks`
 * section steers the model towards implementing what it finds, which is the one
 * thing this agent must not do. What is left is short on purpose — it is paid
 * once per request, and a longer prompt buys nothing a review of this shape
 * needs.
 */
export const REVIEW_PROMPT = [
  'You review code. You do not change it: never modify, create or delete a file,',
  'and never commit. Your entire output is the review.',
  '',
  'Read the code before judging it. Use git diff and git log for history.',
  '',
  'Report each finding as:',
  '- a file:line reference,',
  '- a severity — critical, major, or minor,',
  '- what breaks, as a concrete scenario: the input, the state, or the sequence',
  '  of events that produces the wrong result. "This could be racy" is not a',
  '  finding; "two concurrent apply() calls both pass the exists check and the',
  '  second clobbers the first" is.',
  '',
  'If you cannot describe how a finding fails, you do not understand it yet —',
  'go read more, or drop it.',
  '',
  'Report nothing rather than pad. A review with no findings is a valid review',
  'and a useful one. Do not fill it with naming, formatting or style preferences;',
  'the linter owns those. Correctness, security, data loss and breaking changes',
  'are what you are for.',
].join('\n')

/**
 * What the review agent *is*, independent of where it runs.
 *
 * High effort is the deliberate opposite of `coding`'s low. Effort is unset by
 * default and that is not neutral — on Opus 5 saying nothing already sends
 * `'high'` — so this is stated rather than omitted, to make it a decision
 * someone has to undo on purpose.
 */
export const reviewer = {
  description: 'Reviews code without touching it. Opus 5, high effort, read-only tools.',
  model: REVIEW_MODEL,
  effort: 'high',
  tools: [...REVIEW_TOOLS],
  // Same trade as the coding profile, including the part the workspace does not
  // solve: 'project' loads the cloned repo's .claude/settings.json and its hooks.
  // See the note in coding.ts.
  settingSources: ['project'],
  thinking: { type: 'adaptive' },
  systemPrompt: REVIEW_PROMPT,
  prompt: reviewPrompt,
} as const satisfies SandboxedProfile

export type ReviewOptions = RunOptions
export type ReviewResult = RunResult

/** Options for a reviewer confined to `workspace`. */
export function reviewerOptions(workspace: Workspace, options: ReviewOptions = {}): Options {
  return sandboxedOptions(reviewer, workspace, options)
}

/**
 * Review `target` — a git ref range like `main..feature`, or a path.
 *
 * There is no `collect()` step: the agent cannot write, so the review in `text`
 * is the whole product. The workspace still comes back open, and disposing it is
 * the caller's.
 */
export function review(target: string, options: ReviewOptions = {}): Promise<ReviewResult> {
  return runSandboxed(reviewer, target, options)
}

/**
 * The user turn. `target` is passed through verbatim rather than interpreted: a
 * ref range and a path read the same way to git, and guessing which one this is
 * would only be wrong occasionally, which is the worst frequency.
 */
export function reviewPrompt(target: string): string {
  return `Review: ${target}\n\nThis is either a git ref range or a path in this repository. Work out which, examine it, and report your findings.`
}
