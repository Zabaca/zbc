// The base every zbc agent is built on. Its one opinion is that the Agent SDK's
// defaults are wrong for us: out of the box a query ships 11 tool schemas and
// every settings source it can find, which costs 23,355 input tokens before the
// agent has done anything. Stripping both lands the same query at 661 — a 97%
// cut, measured on the wire, not estimated. See README.md for the method.
//
// The saving is almost entirely tool schemas. They are 55-76% of a default
// request body; the SDK's own system prompt is one 62-character sentence, so
// there is nothing to win there and no reason to hand-write a replacement
// unless the agent actually needs instructions.
import { type Options, query } from '@anthropic-ai/claude-agent-sdk'

/** Default model for zbc agents. Cheapest tier that handles routine work. */
export const DEFAULT_MODEL = 'claude-haiku-4-5'

export type MinimalOptions = {
  /**
   * Built-in tools to keep. `[]` — the default — sends no tool schemas at all,
   * which is the single biggest saving available. Name only what the agent
   * needs, e.g. `['Read', 'Grep']`.
   *
   * Ask for `Grep`/`Glob` explicitly if you want them: the SDK defers them
   * behind `ToolSearch` whenever `Bash` is present, on the assumption that
   * Bash covers search. With no Bash they are promoted automatically.
   */
  tools?: string[]
  model?: string
  /**
   * Omit to send the SDK's own 62-character identity line and nothing else.
   * A string replaces it. `{ type: 'preset', preset: 'claude_code' }` pulls in
   * the full Claude Code prompt — roughly 29,000 characters, so reach for it
   * only when the agent genuinely needs Claude Code's operating instructions.
   */
  systemPrompt?: Options['systemPrompt']
  /**
   * Filesystem settings to load. `[]` — the default — is SDK isolation mode:
   * no `~/.claude/settings.json`, no `.claude/settings.json`, no
   * `.claude/settings.local.json`, and therefore no CLAUDE.md, no project
   * skills and no filesystem hooks. Pass `['project']` to get CLAUDE.md back.
   */
  settingSources?: Options['settingSources']
  /**
   * Extended thinking. Disabled by default: on a one-shot classification the
   * model spent 93 of 100 output tokens thinking about "Reply with exactly:
   * OK". Pass `{ type: 'adaptive' }` (or `'enabled'` with a budget on older
   * models) for agents that actually need to reason.
   */
  thinking?: Options['thinking']
  /**
   * Auto-memory. Off by default, and this one is not really about tokens:
   * `settingSources: []` does *not* suppress it, so the operator's personal
   * memory index is otherwise injected into every request as a
   * `<system-reminder>`. That is someone's notes leaking into an unrelated
   * agent, and it makes the same prompt behave differently per machine.
   */
  autoMemory?: boolean
}

/**
 * Options that strip everything the SDK sends by default but an agent rarely
 * needs. Spread the result to extend it — every field stays overridable.
 */
export function minimalOptions({
  tools = [],
  model = DEFAULT_MODEL,
  systemPrompt,
  settingSources = [],
  thinking = { type: 'disabled' },
  autoMemory = false,
}: MinimalOptions = {}): Options {
  return {
    model,
    tools,
    settingSources,
    thinking,

    // No MCP servers, and ignore any a project config tries to contribute.
    // Without `strictMcpConfig` a stray `.mcp.json` silently reintroduces the
    // tool schemas this whole module exists to avoid.
    mcpServers: {},
    strictMcpConfig: true,

    // Inline settings, not a file — this must not depend on what is on disk,
    // which is the whole point of `settingSources: []`.
    settings: { autoMemoryEnabled: autoMemory },

    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  }
}

/**
 * Run a prompt and collect the agent's text as a single string.
 *
 * Tool calls and thinking blocks are dropped; this returns what the agent
 * said, not what it did. Use `query()` directly when you need the events.
 */
export async function ask(prompt: string, options: Options = minimalOptions()): Promise<string> {
  let out = ''
  for await (const message of query({ prompt, options })) {
    if (message.type !== 'assistant') continue
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text') out += block.text
    }
  }
  return out.trim()
}
