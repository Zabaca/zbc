# Minimal-token Agent SDK setup

A Claude Agent SDK configuration that sends 97% fewer input tokens than the SDK's
defaults, and the measurements behind it.

Every number here came from capturing real requests through a local mitmproxy and
reading `usage` off the response stream — not from estimating. Method and full
field-by-field comparison: [`../claude-code-wire.html`](../claude-code-wire.html).

## The measurements

`claude-haiku-4-5`, same working directory, same prompt (`"Reply with exactly: OK"`).
Input tokens are `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
from the response's `message_delta`.

| Configuration | Body bytes | Tools | Input tokens | |
|---|---:|---:|---:|---|
| SDK defaults | 85,461 | 11 | **23,355** | — |
| `tools: []` | 20,983 | 0 | **5,628** | −75.9% |
| `settingSources: []` | 67,078 | 11 | **18,201** | −22.1% |
| both, plus no MCP | 3,036 | 0 | **661** | **−97.2%** |
| …plus attribution header off | 2,926 | 0 | **661** | −97.2% |

## Why tool schemas are the lever

The system prompt is the wrong thing to optimise. On a default SDK request the
system prompt is **146 characters** — 0.3% of the body — while tool schemas are
**41 KB, or 55%**. Switching the SDK from the `claude_code` preset to its default
system prompt deletes every instruction Claude Code ships with and saves 13% of the
request. Dropping the tool schemas saves 76%.

If you need tools, name only the ones the task uses:

```js
minimalOptions({ tools: ['Read', 'Grep'] })
```

Native builds may serve search through Bash `find`/`grep` rather than the dedicated
`Grep`/`Glob` tools, so list those explicitly if you want them.

## What each lever costs you

| Lever | You lose |
|---|---|
| `tools: []` | All file, shell and web access. The agent can only produce text. |
| `settingSources: []` | `CLAUDE.md`, project skills, filesystem hooks, and all three settings files. Pass `['project']` to get `CLAUDE.md` back. |
| `mcpServers: {}` + `strictMcpConfig` | Every MCP server, including ones declared in project config. |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | The `x-anthropic-billing-header` block. Worth ~110 bytes and, at this scale, **0 measured tokens** — include it for the reduced client-version disclosure, not for the savings. |

The SDK's default system prompt is already nearly empty, so there is nothing to strip
there — but note what that means: **by default the SDK gives you a capable agent with
no operating instructions.** It ships all 11 tools and none of the guidance that tells
Claude Code how to use them. If you add tools back, consider adding
`systemPrompt: { type: 'preset', preset: 'claude_code' }` too, or writing your own.

## Usage

```bash
bun add @anthropic-ai/claude-agent-sdk
CLAUDE_CODE_ATTRIBUTION_HEADER=0 bun agent.mjs "summarise this changelog"
```

```js
import { ask, minimalOptions } from './agent.mjs'

await ask('Classify this ticket as bug/feature/question: ...')
await ask('Summarise README.md', minimalOptions({ tools: ['Read'] }))
```

## One caveat worth keeping

Do not combine this with a custom `ANTHROPIC_BASE_URL`. Off first-party, Claude Code
disables deferred tool loading: all 28 tools ship eagerly instead of 11, tool bytes go
41 KB → 88 KB, and the body grows to 115 KB **even with the smallest possible system
prompt**. Setting `tools: []` still works there, but if you keep any tools, a gateway
costs you far more than the system prompt ever saved.
