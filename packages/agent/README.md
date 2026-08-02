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

| Configuration             |      Body | Tools | Input tokens |            |
| ------------------------- | --------: | ----: | -----------: | ---------- |
| SDK defaults              |    85,461 |    11 |       23,355 | —          |
| `tools: []`               |    20,983 |     0 |        5,628 | −75.9%     |
| `settingSources: []`      |    67,078 |    11 |       18,201 | −22.1%     |
| tools + settings + no MCP |     3,037 |     0 |          661 | −97.2%     |
| **`minimalOptions()`**    | **1,027** | **0** |      **124** | **−99.5%** |

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

| Default                                      | You lose                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tools: []`                                  | All file, shell and web access. The agent produces text only.                                                             |
| `settingSources: []`                         | `CLAUDE.md`, project skills, filesystem hooks, all three settings files. Pass `['project']` for CLAUDE.md.                |
| `mcpServers: {}` + `strictMcpConfig`         | Every MCP server, including any a project config contributes.                                                             |
| `thinking: { type: 'disabled' }`             | Extended reasoning. Fine for classification and extraction; pass `{ type: 'adaptive' }` for anything that needs to think. |
| `settings: { autoMemoryEnabled: false }`     | Nothing you want. See below.                                                                                              |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Auto-update checks, feature-flag lookups, and the session title. See below.                                               |
| `settings.disableClaudeAiConnectors`         | claude.ai account connectors. Pass `claudeAiConnectors: true` to restore.                                                 |
| `CLAUDE_CODE_ATTRIBUTION_HEADER=0`           | The `system[0]` billing block. Discloses nothing new — see below.                                                         |

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

`disableClaudeAiConnectors: true` removes the last one, leaving **a single
outbound request**. `/v1/mcp_servers` fetches the MCP servers attached to the
Anthropic _account_ — claude.ai connectors — which is why `mcpServers: {}` and
`strictMcpConfig` never suppressed it: those govern local config files, while
this list is fetched with the operator's OAuth token. An agent with `tools: []`
discards the result.

The equivalent env var is `ENABLE_CLAUDEAI_MCP_SERVERS=0`, and note the trap:
despite the `ENABLE_` name, the client tests it for a _falsy_ string
(`0`/`false`/`no`/`off`), so `=0` disables and `=1` does nothing. The settings
key is clearer, which is why this package uses it.

**`CLAUDE_CODE_ATTRIBUTION_HEADER=0` conceals nothing.** It removes the
`system[0]` block carrying `cc_version` / `cc_entrypoint` / `cch`, worth ~110
bytes and **0 tokens**. The first two fields restate the `User-Agent`
(`claude-cli/2.1.220 (external, sdk-cli, agent-sdk/0.3.220)`), and `device_id` /
`account_uuid` / `session_id` travel in `metadata` regardless — so this is not a
way to be anonymous, just a way to stop repeating yourself. It has no effect on
prompt caching: `cch` changes per request but sits outside the cached prefix,
and toggling it does not invalidate an existing cache (verified — a request with
the header off read 23,238 tokens from a cache created with it on).

## Profiles

`minimalOptions()` decides what an agent _sends_. A profile decides what it
_is_ — instructions, tools, model tier — and composes through the base, so it
cannot quietly undo a lever (there is a test for that).

```ts
import { askAs, profileOptions } from '@zbc/agent/profiles'

await askAs('caveman', 'What is a bloom filter and when would you use one?')
await askAs('caveman', 'Summarise this', { tools: ['Read'] }) // overrides win
```

The two layers optimise different budgets. The base attacks **input** tokens,
where tool schemas dominate — at 124 tokens there is nothing left to win. A
profile attacks **output**, where the system prompt is the only lever.

### `caveman`

Terse fragments; articles, filler and hedging dropped; identifiers, code,
numbers and paths kept verbatim. Measured on `"What is a bloom filter and when
would you use one?"`:

|            | Input |  Output | Cost per 1k runs |
| ---------- | ----: | ------: | ---------------: |
| no profile |   131 |     415 |            $2.21 |
| `caveman`  |   211 | **186** |        **$1.14** |

The prompt costs +80 input and saves 229 output — **−55% output, −48% cost**,
because output bills 5× input on Haiku. A profile only pays for itself if the
instruction is cheaper than the verbosity it removes, so the prompt is kept
short and a test fails if it grows past 600 characters without re-measuring.

Not for prose deliverables or anything user-facing — commit bodies, docs,
customer-visible text. It is for machine-consumed output and operators who
opted in.

### `coding`

An agent that edits code. It is the one profile that inverts everything above:
it costs **7,404 input tokens** of tool schemas against the base package's 124,
plus ~3,148 for Claude Code's own system prompt. Both sit in the cached prefix,
so the recurring cost is a cache read — there is nothing to win by trimming them
and a working agent to lose.

Because it needs `Bash`, it does not run in your checkout. It runs in a
**Workspace** — a disposable clone outside `$HOME` — with the CLI itself wrapped
in [`sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime):
reads denied everywhere and allowed back only for the toolchain and the
workspace, egress allow-listed to `api.anthropic.com`.

The wrapping is the point. The SDK ships a `sandbox` option that runs the same
engine, but applies it per _Bash command_ — and `Read`, `Grep` and `Glob` never
shell out, so nothing hands them to the kernel. Under that configuration, with
`$HOME` denied, `cat ~/.ssh/id_ed25519` was refused and `Read` on the same path
returned the file. Wrapping the process covers every tool, including the next one
someone adds.

A credential must be in the environment — `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token`, or an API key. The CLI's usual path is to read the login
Keychain by spawning `/usr/bin/security`, and a sandbox that allows that binary
lets the agent read every Keychain item too, so it is denied.

```ts
import { code } from '@zbc/agent/coding'
import { collect } from '@zbc/agent/workspace'

const run = await code('Fix the failing test in src/parser.ts')

const { branch, commits } = await collect(run.workspace) // fetch, do not merge
await run.workspace.dispose()
```

`code()` returns with the workspace still on disk. Nothing is merged and nothing
is cleaned up: `collect()` fetches the agent's branch into your repository as a
ref for you to review, and that fetch is host-initiated — the workspace's
`origin` sits inside denied territory, so the agent cannot push even if told to.

Verified end to end, from inside a real run:

```
cat ~/.zshrc            → cat: Operation not permitted
Read tool on ~/.zshrc   → EPERM: operation not permitted, stat
curl example.com        → CONNECT tunnel failed, response 403
author                  → zbc agent <agent@zbc.local>
```

`review` is the read-only sibling: `Read, Grep, Glob, Bash`, no `Write`/`Edit`,
Opus 5 at **high** effort — the inverse of `coding`'s low, because a review is a
few turns whose whole value is catching what a cheaper pass misses.

```ts
import { review } from '@zbc/agent/review'

const r = await review('main..my-feature')
console.log(r.text) // the review is the product; it leaves no commits
await r.workspace.dispose()
```

The reasoning is in two ADRs:
[`0001`](./docs/adr/0001-coding-agents-work-in-a-disposable-clone.md) for the
workspace and the host-side collect,
[`0002`](./docs/adr/0002-containment-wraps-the-cli-process.md) for the
containment — including why the two sandboxes cannot be layered, which
environment variables are load-bearing in which direction, and the one thing the
boundary still does not cover: the agent can read the credential it is using.
Read `0002` before widening anything.

## Development

```bash
bun run dev "your prompt"   # run the CLI
bun test src                # levers are pinned by tests
bun run typecheck
bun run e2e                 # live containment check — spends ~$0.14, macOS only
```

The tests assert the defaults rather than the SDK: a change that quietly
reinstates tool schemas or settings loading costs ~20k tokens per call and
nothing else in the repo would notice.
