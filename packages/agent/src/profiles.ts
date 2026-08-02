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
import { caveman } from './traits'

export { caveman } from './traits'

export type Profile = MinimalOptions & {
  /** What this agent is for. Not sent — this is for whoever picks a profile. */
  description: string
}

/**
 * Profiles reachable through `askAs` — one prompt in, text out.
 *
 * `coding` is deliberately not here. It cannot run without a Workspace to be
 * confined to, so it has its own entry point (`code()` in `./coding`) rather
 * than an interface that would let someone start it pointed at their own
 * checkout with no sandbox.
 */
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
