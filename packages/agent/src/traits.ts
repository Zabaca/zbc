// A Trait is an instruction layer that composes onto any profile.
//
// The type is the whole design: a Trait carries a `systemPrompt` and nothing
// else. It cannot name a tool, a model, a workspace or a sandbox setting, so
// there is no combination of traits that widens what an agent can do — only what
// it is told. That is what makes them safe to stack freely, and why the
// containment tests stay valid for every combination rather than per-profile.
//
// The SDK supports the composition natively: `systemPrompt` accepts `string[]`,
// and its preset form accepts `append`. Neither is a workaround.
import type { MinimalOptions } from './index'

export type Trait = {
  /** What this layer is for. Not sent — this is for whoever picks one. */
  description: string
  /** Appended after the base profile's instructions. Later traits win. */
  systemPrompt: string
}

/** A profile whose `systemPrompt` may have been rewritten by layering. */
export type Layered<P> = Omit<P, 'systemPrompt'> & Pick<MinimalOptions, 'systemPrompt'>

/**
 * Layer traits onto a profile.
 *
 * Order matters and is deliberate: traits append after the base, so a trait can
 * override the profile it is applied to. Stacking `[a, b]` lets `b` override `a`.
 *
 * The return type widens `systemPrompt` rather than preserving the profile's
 * literal type. Preserving it would be a lie — a profile declaring
 * `systemPrompt: 'You review code…'` comes back holding an array.
 */
export function withTraits<P extends MinimalOptions>(base: P, ...traits: Trait[]): Layered<P> {
  if (traits.length === 0) return base

  const added = traits.map((trait) => trait.systemPrompt)
  const prompt = base.systemPrompt

  // The preset carries its own text and cannot be concatenated with it, so the
  // SDK's own `append` is the only correct seam.
  if (prompt && typeof prompt === 'object' && 'type' in prompt && prompt.type === 'preset') {
    return {
      ...base,
      systemPrompt: { ...prompt, append: [prompt.append, ...added].filter(Boolean).join('\n\n') },
    }
  }

  const existing = Array.isArray(prompt) ? prompt : prompt ? [prompt] : []
  return { ...base, systemPrompt: [...existing, ...added] }
}

/**
 * Terse output. Drops articles, filler and pleasantries; keeps technical terms,
 * identifiers and code verbatim.
 *
 * Measured on a Haiku explanation task: +80 input, −229 output, −48% cost. A
 * trait only pays for itself when the instruction is cheaper than the verbosity
 * it removes, so this one is kept short and a test fails if it grows past 600
 * characters without re-measuring.
 *
 * Not for prose deliverables — commit bodies, docs, anything user-facing.
 */
export const caveman: Trait = {
  description: 'Terse output. Cuts response tokens roughly in half.',
  systemPrompt: [
    'Answer in terse fragments. Drop articles, filler, hedging, pleasantries.',
    'No preamble, no restating the question, no summary at the end.',
    'Keep exact: identifiers, code, numbers, units, file paths, error strings.',
    'Never abbreviate a technical term or invent shorthand for one.',
    'If the answer is one word, reply with one word.',
  ].join(' '),
}

/**
 * Say what was verified and what was assumed.
 *
 * The repository's own rule, and the one that pays for itself fastest on
 * anything that reports findings: an agent that hedges into confident prose is
 * worse than one that says nothing, because the hedge is invisible downstream.
 */
export const evidence: Trait = {
  description: 'Verify before asserting; mark anything unverified as unverified.',
  systemPrompt: [
    'Do not assert what you have not checked. If you claim something is already',
    'fixed, expected, pre-existing, unused, or safe, show the command or the',
    'file:line you read to know it.',
    'Where you could not check, say "unverified" in those words rather than',
    'hedging into confident prose.',
    'Distinguish what you observed from what you inferred, and say which is which.',
  ].join(' '),
}

/**
 * Stay inside the task.
 *
 * Turns are the cost of an agentic run, not tokens — an agent that explores a
 * repository before making a one-line change spends most of its budget deciding
 * where to start. This is the instruction the e2e prompt has always carried
 * inline; a trait makes it reusable.
 */
export const focused: Trait = {
  description: 'No exploration beyond the task. Fewer turns, lower cost.',
  systemPrompt: [
    'Do only what was asked. Read what you need to do it and nothing more.',
    'Do not survey the repository, refactor adjacent code, fix unrelated',
    'problems, or add tests that were not requested — mention them instead.',
    'If the task is ambiguous, state the reading you chose and proceed.',
  ].join(' '),
}

/**
 * Commit when finished.
 *
 * Without this, `collect()` returns `commits: []` unless the caller happened to
 * write "commit your work" into the task, and the agent's changes die with the
 * workspace. It is a trait rather than a profile because it is pure instruction:
 * the ability to commit comes from `Bash`, which the profile already grants.
 *
 * Only meaningful on a profile that can write. On `review` it is inert, which is
 * the correct behaviour rather than a footgun — the reviewer has no `Write` or
 * `Edit`, so there is nothing for it to commit.
 */
export const committing: Trait = {
  description: 'Commit finished work, so collect() has something to fetch.',
  systemPrompt: [
    'When the work is complete, stage it and commit: `git add -A` then',
    '`git commit`. Uncommitted work is discarded, so a run that ends without a',
    'commit produced nothing.',
    'Write the message in the style of the repository’s recent history —',
    'read `git log` if you are unsure. Say what changed and why; do not describe',
    'the process of changing it.',
    'Never amend, rebase, force-push, or touch a branch other than the one you',
    'are on. Never push.',
  ].join('\n'),
}

/** Traits available by name, for callers that select one from configuration. */
export const traits = { caveman, evidence, focused, committing } satisfies Record<string, Trait>

export type TraitName = keyof typeof traits
