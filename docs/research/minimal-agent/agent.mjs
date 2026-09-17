// Minimal-token Claude Agent SDK setup.
//
// Measured against SDK defaults on claude-haiku-4-5 (see README.md):
//   23,355 input tokens  ->  661 input tokens   (-97.2%)
//
// Run:  CLAUDE_CODE_ATTRIBUTION_HEADER=0 bun agent.mjs "your prompt"
import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * Options that strip everything the SDK sends by default but doesn't need.
 *
 * @param {object}   [o]
 * @param {string[]} [o.tools]  Built-in tools to keep. `[]` (the default) sends
 *                              no tool schemas at all — the single biggest
 *                              saving, since schemas are 55–76% of a default
 *                              request body. Name only what the task needs,
 *                              e.g. ['Read', 'Grep'].
 * @param {string}   [o.model]
 * @param {string}   [o.systemPrompt]  Omit to send the SDK's 146-char stub.
 *                                     A short string replaces it; the
 *                                     `claude_code` preset adds ~11k chars.
 */
export function minimalOptions({ tools = [], model = 'claude-haiku-4-5', systemPrompt } = {}) {
  return {
    model,

    // No tool schemas. This is the lever that matters: -75.9% on its own.
    tools,

    // SDK isolation mode. Skips ~/.claude/settings.json, .claude/settings.json
    // and .claude/settings.local.json — which also stops CLAUDE.md, project
    // skills and filesystem hooks being injected. -22.1% on its own.
    // Add 'project' back if you actually want CLAUDE.md.
    settingSources: [],

    // No MCP servers, and ignore any declared in project config.
    mcpServers: {},
    strictMcpConfig: true,

    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  }
}

/** Collect an agent's text response as a single string. */
export async function ask(prompt, options = minimalOptions()) {
  let out = ''
  for await (const message of query({ prompt, options })) {
    if (message.type !== 'assistant') continue
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text') out += block.text
    }
  }
  return out.trim()
}

if (import.meta.main) {
  const prompt = process.argv.slice(2).join(' ') || 'Reply with exactly: OK'
  console.log(await ask(prompt))
}
