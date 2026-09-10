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
import {
  type ModelUsage,
  type NonNullableUsage,
  type Options,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'

/** Default model for zbc agents. Cheapest tier that handles routine work. */
export const DEFAULT_MODEL = 'claude-haiku-4-5'

/**
 * Environment carried into an agent that does not inherit the operator's.
 *
 * Deliberately an allowlist. `denyRead` protects a credential *file*; nothing
 * protects a credential *value* sitting in the environment, and an agent with
 * `Bash` only has to run `env`. In this repository CI sets `SOPS_AGE_KEY` at
 * the step level (`.github/workflows/production.yml`, `preview.yml`), which is
 * the key that decrypts every environment's secrets — so inheriting the
 * environment would hand it to any agent invoked from that step, and egress
 * rules cannot help because the value would already be in the transcript.
 *
 * Anything an agent legitimately needs is passed explicitly via `env`.
 */
export const ESSENTIAL_ENV = [
  // Without these the subprocess does not start.
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  // Locale, or tool output encoding becomes machine-dependent.
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // How the CLI authenticates and where it points.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // Corporate proxy and custom CA, without which the API is unreachable.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const

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
   * Reasoning effort. Left unset by default, which is *not* neutral: on Opus 5
   * the client sends `output_config: { effort: 'high' }` when you say nothing,
   * so `'low'` is a real step down rather than a no-op.
   *
   * Orthogonal to `thinking` — they are separate fields on the wire and
   * compose. Adaptive thinking is already the default on Opus 5.
   */
  effort?: Options['effort']
  /**
   * Cancellation. The SDK's `Options` has `abortController`, not `signal`
   * (sdk.d.ts, `Options.abortController`), so a caller-owned controller is the
   * only way to stop a run immediately — a timeout has to be built on it.
   * Omitted by default, and the key is absent rather than `undefined`, as with
   * `effort`.
   */
  abortController?: AbortController
  /**
   * Extra environment for the subprocess, merged over the inherited environment
   * but under this module's own flags, so a caller cannot accidentally
   * re-enable attribution or non-essential traffic by passing an env bag.
   */
  env?: Record<string, string | undefined>
  /**
   * Whether the agent inherits the operator's environment. Default `true`,
   * which is safe only while the agent has no way to read it back — with
   * `tools: []` there is no `Bash` and nothing to leak to.
   *
   * Any agent that can run commands should pass `false` and name what it needs
   * via `env`. See {@link ESSENTIAL_ENV}.
   */
  inheritEnv?: boolean
  /**
   * Auto-memory. Off by default, and this one is not really about tokens:
   * `settingSources: []` does *not* suppress it, so the operator's personal
   * memory index is otherwise injected into every request as a
   * `<system-reminder>`. That is someone's notes leaking into an unrelated
   * agent, and it makes the same prompt behave differently per machine.
   */
  autoMemory?: boolean
  /**
   * The `x-anthropic-billing-header` block — `cc_version`, `cc_entrypoint`,
   * `cch` — sent as `system[0]`. Off by default: send the minimum that does
   * the job.
   *
   * Nothing is concealed by this. The first two fields restate what the
   * `User-Agent` already carries (`claude-cli/2.1.220 (external, sdk-cli,
   * agent-sdk/0.3.220)`), and `device_id` / `account_uuid` / `session_id` go up
   * in `metadata` either way. `cch` is the only field uniquely dropped; it is a
   * per-request token whose purpose is undocumented, and removing it has no
   * observable effect — including on prompt caching, since `system[0]` sits
   * outside the cached prefix.
   */
  attribution?: boolean
  /**
   * Everything the client sends that is not the agent's own API call. Off by
   * default, and it is the largest single reduction here — a default run makes
   * **ten** outbound requests to answer one prompt; with this off it makes two.
   *
   * What stops: logs to a third-party collector (`http-intake.logs.us5
   * .datadoghq.com`), `api/event_logging/v2/batch`, `api/claude_cli/bootstrap`,
   * `api/oauth/account/settings`, and two feature-flag endpoints. It also stops
   * the session-title model call, which is the part that costs money: 521 input
   * tokens to title a session no headless agent ever displays — 4.2× the real
   * call's 124.
   */
  nonessentialTraffic?: boolean
  /**
   * claude.ai account connectors. Off by default — this is the last outbound
   * request left, and it takes a run from two requests to one.
   *
   * These are MCP servers attached to the Anthropic account, not to any file,
   * which is why `mcpServers: {}` and `strictMcpConfig` do not suppress them:
   * those govern local config, and the client fetches this list from
   * `/v1/mcp_servers` on the operator's OAuth token. For an agent with
   * `tools: []` the result is discarded anyway.
   *
   * Pass `true` if an agent should reach the account's connectors — that also
   * requires the token to carry the `user:mcp_servers` scope, and it is
   * ignored entirely on API-key auth or a third-party provider.
   */
  claudeAiConnectors?: boolean
}

/** Read named variables out of the current environment, skipping unset ones. */
function pickEnv(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
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
  effort,
  abortController,
  env: extraEnv,
  inheritEnv = true,
  autoMemory = false,
  attribution = false,
  nonessentialTraffic = false,
  claudeAiConnectors = false,
}: MinimalOptions = {}): Options {
  return {
    model,
    tools,
    settingSources,
    thinking,
    ...(effort === undefined ? {} : { effort }),
    ...(abortController === undefined ? {} : { abortController }),

    // The spread is load-bearing: `env` REPLACES the subprocess environment
    // rather than merging into it, so dropping it would take PATH and HOME
    // with it and the subprocess would not start.
    //
    // Never put HOME or CLAUDE_CONFIG_DIR in here. Both break authentication in
    // ways that look like unrelated bugs: HOME hides the login Keychain (and
    // raises a "Keychain Not Found" dialog at whoever is at the machine), and
    // CLAUDE_CONFIG_DIR fails even when set to its own default value, apparently
    // by switching the CLI off Keychain and onto credentials that do not exist.
    env: {
      ...(inheritEnv ? process.env : pickEnv(ESSENTIAL_ENV)),
      ...extraEnv,
      ...(attribution ? {} : { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' }),
      ...(nonessentialTraffic ? {} : { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
    },

    // No MCP servers, and ignore any a project config tries to contribute.
    // Without `strictMcpConfig` a stray `.mcp.json` silently reintroduces the
    // tool schemas this whole module exists to avoid.
    mcpServers: {},
    strictMcpConfig: true,

    // Inline settings, not a file — this must not depend on what is on disk,
    // which is the whole point of `settingSources: []`.
    settings: {
      autoMemoryEnabled: autoMemory,
      disableClaudeAiConnectors: !claudeAiConnectors,
    },

    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  }
}

/**
 * What a run came back with: the agent's text plus the SDK's `result` message,
 * flattened. Field names follow `RunResult` in `sandboxed.ts`.
 */
export type RunOutcome = {
  /** The agent's prose, trimmed. Tool calls and thinking blocks are dropped. */
  text: string
  turns: number
  /**
   * The `result` message's `subtype`: `'success'`, `'error_during_execution'`,
   * `'error_max_turns'`, `'error_max_budget_usd'`, … — or `'unknown'` when the
   * stream ended without a `result` message at all.
   */
  stopReason: string
  isError: boolean
  errors: string[]
  usage: NonNullableUsage | undefined
  modelUsage: Record<string, ModelUsage> | undefined
  totalCostUsd: number
  sessionId: string
}

export type RunHooks = {
  /** The query function. A seam for tests; defaults to the SDK's. */
  query?: typeof query
  /**
   * Called for every SDK message as it arrives, including the ones `run` does
   * not read — `rate_limit_event` is the reason this exists. It cannot
   * influence the run.
   */
  onMessage?: (message: SDKMessage) => void
}

/**
 * Run a prompt and return what came back, `result` message included.
 *
 * `ask` is this with everything but the text dropped. Reach for `run` when the
 * caller needs usage, cost or why the run stopped — a stream that ends in an
 * error result is reported, not thrown, so the caller can classify it.
 */
export async function run(
  prompt: string,
  options: Options = minimalOptions(),
  hooks: RunHooks = {},
): Promise<RunOutcome> {
  const q = hooks.query ?? query
  let text = ''
  let outcome: Omit<RunOutcome, 'text'> = {
    turns: 0,
    stopReason: 'unknown',
    isError: true,
    errors: ['the stream ended without a result message'],
    usage: undefined,
    modelUsage: undefined,
    totalCostUsd: 0,
    sessionId: '',
  }
  for await (const message of q({ prompt, options })) {
    hooks.onMessage?.(message)
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text') text += block.text
      }
    } else if (message.type === 'result') {
      outcome = {
        turns: message.num_turns,
        stopReason: message.subtype,
        isError: message.is_error,
        errors: message.subtype === 'success' ? [] : message.errors,
        usage: message.usage,
        modelUsage: message.modelUsage,
        totalCostUsd: message.total_cost_usd,
        sessionId: message.session_id,
      }
    }
  }
  return { text: text.trim(), ...outcome }
}

/**
 * Run a prompt and collect the agent's text as a single string.
 *
 * Tool calls and thinking blocks are dropped; this returns what the agent
 * said, not what it did. Use `run()` for the result message, or `query()`
 * directly when you need the events.
 */
export async function ask(prompt: string, options: Options = minimalOptions()): Promise<string> {
  return (await run(prompt, options)).text
}
