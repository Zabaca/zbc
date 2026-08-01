# @zbc/agent

The base every zbc agent is built on: a Claude Agent SDK configuration that
sends **97% fewer input tokens** than the SDK's defaults.

```ts
import { ask, minimalOptions } from '@zbc/agent'

await ask('Classify this ticket as bug/feature/question: ...')
await ask('Summarise this file', minimalOptions({ tools: ['Read'] }))
```

## Why this package exists

Out of the box the SDK ships 11 tool schemas and every settings source it can
find. That is 23,355 input tokens before the agent has done anything. Stripping
both lands the same query at 661.

| Configuration | Body | Tools | Input tokens | |
|---|---:|---:|---:|---|
| SDK defaults | 85,461 | 11 | 23,355 | — |
| `tools: []` | 20,983 | 0 | 5,628 | −75.9% |
| `settingSources: []` | 67,078 | 11 | 18,201 | −22.1% |
| tools + settings + no MCP | 3,037 | 0 | 661 | −97.2% |
| **`minimalOptions()`** | **1,027** | **0** | **124** | **−99.5%** |

Output tokens move too. With thinking left on, `"Reply with exactly: OK"` cost
100 output tokens, **93 of them thinking** about a four-word instruction. With
`thinking: { type: 'disabled' }` it costs 4.

Every number came from capturing the real request through a local proxy and
reading `usage` off the response stream. Method and the full field-by-field
comparison across clients: [`docs/research/claude-code-wire.html`](../../docs/research/claude-code-wire.html).

**Tool schemas are the lever.** They are 55–76% of a default request body. The
SDK's own system prompt is a single 62-character sentence — there is nothing to
win by rewriting it, and no reason to supply one unless the agent needs actual
instructions.

## What each default costs you

| Default | You lose |
|---|---|
| `tools: []` | All file, shell and web access. The agent produces text only. |
| `settingSources: []` | `CLAUDE.md`, project skills, filesystem hooks, all three settings files. Pass `['project']` for CLAUDE.md. |
| `mcpServers: {}` + `strictMcpConfig` | Every MCP server, including any a project config contributes. |
| `thinking: { type: 'disabled' }` | Extended reasoning. Fine for classification and extraction; pass `{ type: 'adaptive' }` for anything that needs to think. |
| `settings: { autoMemoryEnabled: false }` | Nothing you want. See below. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Auto-update checks, feature-flag lookups, and the session title. See below. |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0` | The `system[0]` billing block. Discloses nothing new — see below. |

### Auto-memory is a correctness fix, not a token one

`settingSources: []` does **not** suppress auto-memory. Without
`autoMemoryEnabled: false`, every request carries a `<system-reminder>`
containing the operator's personal memory index — on the machine this was
measured on, notes about Prose spacing tokens and NATS JWT auth, injected into
an agent doing none of those things.

That is three problems, only one of which is cost: someone's notes leak into an
unrelated agent, the same prompt behaves differently per machine, and CI
behaves differently from a laptop. Turning it off took the user turn from 2,128
characters to 386.

Nothing is locked in — spread the result and override anything:

```ts
minimalOptions({ tools: ['Read', 'Grep'], settingSources: ['project'] })
```

Ask for `Grep`/`Glob` by name if you want them. The SDK defers them behind
`ToolSearch` whenever `Bash` is present, on the assumption Bash covers search;
drop Bash and they are promoted automatically.

Adding tools back is also the point at which to consider adding instructions.
By default this gives you a capable model with **no operating guidance** — that
is fine for classification and summarisation, and thin once an agent has tools.

## Two things to know before deploying

**Don't put this behind a gateway if it keeps any tools.** With a custom
`ANTHROPIC_BASE_URL`, deferred tool loading is disabled: all 28 tools ship
eagerly instead of 11, tool bytes go 41 KB → 88 KB, and the body reaches 115 KB
even with the smallest possible system prompt. With the default `tools: []`
there are no schemas to expand, so a gateway costs nothing.

**Most of what the client sends is not your API call.** Answering one prompt
took **ten outbound requests** on SDK defaults, of which one was the agent's:

```
api/claude_cli/bootstrap          api/claude_code_grove
api/oauth/account/settings        api/claude_code_penguin_mode
api/eval/<id>                     api/event_logging/v2/batch
v1/mcp_servers                    http-intake.logs.us5.datadoghq.com/api/v2/logs
v1/messages  <- the agent         v1/messages  <- session title generation
```

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` takes that to two, and it is the
only one of the four disable-flags that does anything measurable here
(`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` added
nothing on top of it). It also stops third-party egress: those Datadog logs
leave Anthropic's infrastructure entirely.

The part that costs money is the session title — a second model call, **521
input tokens**, 4.2× the real call's 124, to name a session no headless agent
ever displays.

**`CLAUDE_CODE_ATTRIBUTION_HEADER=0` conceals nothing.** It removes the
`system[0]` block carrying `cc_version` / `cc_entrypoint` / `cch`, worth ~110
bytes and **0 tokens**. The first two fields restate the `User-Agent`
(`claude-cli/2.1.220 (external, sdk-cli, agent-sdk/0.3.220)`), and `device_id` /
`account_uuid` / `session_id` travel in `metadata` regardless — so this is not a
way to be anonymous, just a way to stop repeating yourself. It has no effect on
prompt caching: `cch` changes per request but sits outside the cached prefix,
and toggling it does not invalidate an existing cache (verified — a request with
the header off read 23,238 tokens from a cache created with it on).

## Development

```bash
bun run dev "your prompt"   # run the CLI
bun test src                # levers are pinned by tests
bun run typecheck
```

The tests assert the defaults rather than the SDK: a change that quietly
reinstates tool schemas or settings loading costs ~20k tokens per call and
nothing else in the repo would notice.
