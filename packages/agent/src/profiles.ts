// Profiles are named `MinimalOptions` presets. The base module decides what an
// agent *sends*; a profile decides what an agent *is* — its instructions, its
// tools, its model tier.
//
// The split matters because the two are optimised against different budgets.
// minimalOptions() attacks input tokens, where tool schemas dominate. A profile
// mostly attacks output tokens, where the only lever is the system prompt. An
// agent with no profile already costs 124 input tokens; there is nothing left
// to win there, so a profile that earns its keep does so on what comes back.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { type MinimalOptions, ask, minimalOptions } from './index'

export type Profile = MinimalOptions & {
  /** What this agent is for. Not sent — this is for whoever picks a profile. */
  description: string
}

/**
 * Terse output. Drops articles, filler and pleasantries; keeps technical terms,
 * identifiers and code verbatim.
 *
 * The prompt is the entire cost of a profile, so it is worth keeping short: at
 * these volumes an instruction paid once per request has to save more than it
 * costs. This one is ~330 characters and reliably halves the response.
 *
 * Do not use where the output is read by people who did not ask for it, or
 * where prose is the deliverable — commit bodies, docs, anything user-facing.
 * It is for machine-consumed text and for operators who opted in.
 */
export const caveman: Profile = {
  description: 'Terse output. Cuts response tokens roughly in half.',
  systemPrompt: [
    'Answer in terse fragments. Drop articles, filler, hedging, pleasantries.',
    'No preamble, no restating the question, no summary at the end.',
    'Keep exact: identifiers, code, numbers, units, file paths, error strings.',
    'Never abbreviate a technical term or invent shorthand for one.',
    'If the answer is one word, reply with one word.',
  ].join(' '),
}

export const profiles = { caveman } satisfies Record<string, Profile>

export type ProfileName = keyof typeof profiles

/**
 * Options for a named profile, with per-call overrides.
 *
 * Overrides win, so a profile is a starting point rather than a lock:
 * `profileOptions('caveman', { tools: ['Read'] })`.
 */
export function profileOptions(name: ProfileName, overrides: MinimalOptions = {}): Options {
  const { description: _description, ...preset } = profiles[name]
  return minimalOptions({ ...preset, ...overrides })
}

/** `ask()` bound to a profile. */
export function askAs(
  name: ProfileName,
  prompt: string,
  overrides: MinimalOptions = {},
): Promise<string> {
  return ask(prompt, profileOptions(name, overrides))
}
