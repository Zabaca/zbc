// The review profile: an agent that reads code and reports on it, contained by
// the same Workspace the coding profile uses.
//
// It is `coding` with two deliberate inversions. It cannot write — a reviewer
// that can edit the code under review is not a reviewer, it is a second author
// — and it runs at high effort rather than low, because a review is a handful
// of turns whose entire value is catching what a cheaper pass would miss.
import { type Options, query } from '@anthropic-ai/claude-agent-sdk'
import { type MinimalOptions, minimalOptions } from './index'
import {
  type SandboxOptions,
  type Workspace,
  createWorkspace,
  sandboxFor,
  workspaceEnv,
} from './workspace'

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
  // Safe only because the workspace lives outside $HOME: CLAUDE.md discovery
  // walks up the directory tree, and from a repo under $HOME it reaches the
  // user's own home-directory CLAUDE.md.
  settingSources: ['project'],
  thinking: { type: 'adaptive' },
  systemPrompt: REVIEW_PROMPT,
} as const satisfies MinimalOptions & { description: string }

export type ReviewOptions = SandboxOptions & {
  /** Repository to review. Defaults to the current working directory. */
  repo?: string
  /** Branch checked out in the workspace. Defaults to a unique `agent/<id>`. */
  branch?: string
  /** Cap on agent turns. Left unset, the SDK decides. */
  maxTurns?: number
  /** Overrides applied over the profile — tools, model, effort, and so on. */
  overrides?: MinimalOptions
}

export type ReviewResult = {
  /** Kept open deliberately: the caller owns `dispose()`. */
  workspace: Workspace
  /** The review. A reviewer leaves no commits, so this is the whole product. */
  text: string
  turns: number
  stopReason: string
  usage: Record<string, unknown>
  totalCostUsd: number
}

/**
 * Options for a reviewer confined to a workspace.
 *
 * Split out from `review()` so the composition is inspectable without running
 * anything — the sandbox is the security boundary, and a test should be able to
 * assert its shape.
 */
export function reviewerOptions(workspace: Workspace, options: ReviewOptions = {}): Options {
  const { description: _description, ...profile } = reviewer

  return {
    ...minimalOptions({
      ...profile,
      ...options.overrides,
      env: { ...workspaceEnv(workspace), ...options.overrides?.env },
    }),

    cwd: workspace.dir,
    sandbox: sandboxFor(workspace, {
      allowRead: options.allowRead,
      allowedDomains: options.allowedDomains,
    }),

    // The sandbox is the boundary, not the permission prompt — and a headless
    // run has nobody to answer one. Everything this bypasses is already denied
    // at the kernel by `sandboxFor`.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,

    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  }
}

/**
 * Review `target` — a git ref range like `main..feature`, or a path — against a
 * fresh workspace.
 *
 * Returns with the workspace still on disk so the caller can follow up in it,
 * and owns `dispose()`. There is no `collect()` step here: the agent cannot
 * write, so the review in `text` is the only thing produced.
 */
export async function review(target: string, options: ReviewOptions = {}): Promise<ReviewResult> {
  const workspace = await createWorkspace({
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
  })

  try {
    let text = ''
    let turns = 0
    let stopReason = 'unknown'
    let usage: Record<string, unknown> = {}
    let totalCostUsd = 0

    for await (const message of query({
      prompt: reviewPrompt(target),
      options: reviewerOptions(workspace, options),
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
      text: text.trim(),
      turns,
      stopReason,
      usage,
      totalCostUsd,
    }
  } catch (error) {
    // Unlike `code()`, nothing is left behind worth keeping on failure either —
    // but the successful path still hands the workspace back to the caller.
    await workspace.dispose()
    throw error
  }
}

/**
 * The user turn. `target` is passed through verbatim rather than interpreted:
 * a ref range and a path read the same way to git, and guessing which one this
 * is would only be wrong occasionally, which is the worst frequency.
 */
export function reviewPrompt(target: string): string {
  return `Review: ${target}\n\nThis is either a git ref range or a path in this repository. Work out which, examine it, and report your findings.`
}
