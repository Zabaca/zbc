/**
 * `agentgit mcp` — the same four verbs, for a client that is not a shell.
 *
 * An agent finds a tool through the registry its harness already reads, not by
 * being told a one-liner, so the CLI grows a second front door rather than a
 * second package: `npx -y @zabaca/agentgit mcp` is a stdio MCP server and every
 * MCP client can list it.
 *
 * Nothing here decides anything. Every tool is a call into the function the
 * corresponding CLI verb already calls — `runAccept`, `runSetup`, `watchOnce` —
 * so a refusal an agent gets through MCP is the refusal a person gets at the
 * prompt, word for word. What this file owns is the shape of the answer and the
 * one rule stdio imposes: **stdout belongs to the transport**, so nothing here
 * prints, ever. Diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import type { AcceptResult } from './accept'
import { realAcceptDeps, runAccept } from './accept'
import { git, remoteList, symbolicHead, toplevel } from './git'
import { originOf, parseHead, parseRemoteList, pickRemote } from './remote'
import type { SetupRequest, SetupResult } from './setup'
import { helperConfigKey, realSetupDeps, runSetup } from './setup'
import type { WatchOnceConfig, WatchOnceOutcome } from './watch'
import { envToken, watchOnce } from './watch'

/** Where an agent with no clone is pointed, and the manual it is handed. */
export const DEFAULT_HOST = 'agentgit.co'

/**
 * How long `agentgit_watch_once` waits before answering "nothing moved".
 *
 * A CLI `--once` blocks until it is interrupted, which is the right default for
 * a person. A tool call that does that is a hung session, so this one has a
 * deadline and reports reaching it.
 */
export const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60_000

/** The manual, as a resource an MCP client can read without a tool call. */
export const MANUAL_URI = 'agentgit://manual'

/** Everything the handlers touch that is not pure. Stubbed whole in tests. */
export interface McpDeps {
  /** Reported in the server's handshake, so a client can name what it is talking to. */
  version: string
  toplevel(cwd: string): string | null
  remoteList(dir: string): string
  symbolicHead(dir: string): string
  /** One git config value, or `null` where the key is unset. */
  configGet(dir: string | null, key: string): string | null
  watchOnce(config: WatchOnceConfig, timeoutMs: number): Promise<WatchOnceOutcome>
  accept(id: string, cwd: string): Promise<AcceptResult>
  setup(request: SetupRequest): Promise<SetupResult>
  /** The deployment token to present, where one is set. */
  token(): string | null
  /** The host's own `/llms.txt`, which is the manual a person would read. */
  manual(host: string): Promise<string>
}

/** An MCP tool result, in the shape `registerTool` hands straight back. */
export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  /** The SDK's result type is open; a tool may carry `_meta` and the like. */
  [key: string]: unknown
}

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const text = (value: string, isError = false): ToolResult =>
  isError
    ? { content: [{ type: 'text', text: value }], isError: true }
    : { content: [{ type: 'text', text: value }] }

/** What a clone is, as far as every tool here is concerned. */
interface Discovered {
  clone: boolean
  root: string | null
  remote: string | null
  host: string | null
  repo: string | null
  ref: string | null
  /** The remote's scheme and host, for the credential config key. */
  origin: string | null
}

const NOTHING: Discovered = {
  clone: false,
  root: null,
  remote: null,
  host: null,
  repo: null,
  ref: null,
  origin: null,
}

/**
 * The clone, read exactly as `agentgit watch` reads it.
 *
 * Deliberately the same three git calls in the same order as the CLI's
 * `resolve`: a tool that discovered a different host from the command would be
 * a second answer to a question that has one.
 */
function discover(deps: McpDeps, cwd: string): Discovered {
  const root = deps.toplevel(cwd)
  if (root === null) return NOTHING

  const remotes = parseRemoteList(deps.remoteList(root))
  const found = pickRemote(remotes)
  const url = found ? (remotes.find((remote) => remote.name === found.name)?.url ?? '') : ''
  return {
    clone: true,
    root,
    remote: found?.name ?? null,
    host: found?.host ?? null,
    repo: found?.repo ?? null,
    ref: parseHead(deps.symbolicHead(root)),
    origin: found ? originOf(url) : null,
  }
}

/**
 * The events that mean "the thing you were waiting for happened".
 *
 * Everything else a watcher emits is either context (`watching`, `merged`,
 * `collides`) or transport noise (`disconnected`), and a handoff that resolved
 * on one of those would resolve on a reconnect.
 */
const TERMINAL_EVENTS = new Set(['fetched', 'moved', 'deleted', 'proposal'])

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Where a tool acts, when the caller did not say. */
const cwdOf = (input: { cwd?: string }) => input.cwd ?? process.cwd()

export interface Handlers {
  status(input: { cwd?: string }): Promise<ToolResult>
  watchOnce(input: {
    cwd?: string
    ref?: string
    proposals?: boolean
    timeoutMs?: number
  }): Promise<ToolResult>
  accept(input: { cwd?: string; proposal: string }): Promise<ToolResult>
  setup(input: { cwd?: string; host?: string; local?: boolean }): Promise<ToolResult>
  manual(input: { cwd?: string }): Promise<ToolResult>
}

export function createHandlers(deps: McpDeps): Handlers {
  return {
    async status(input) {
      const found = discover(deps, cwdOf(input))
      const helper =
        found.origin === null ? null : deps.configGet(found.root, helperConfigKey(found.origin))
      const { origin: _origin, ...reported } = found
      return json({ ...reported, credentialHelper: helper !== null && helper !== '' })
    },

    async watchOnce(input) {
      const found = discover(deps, cwdOf(input))
      if (found.host === null || found.repo === null || found.root === null) {
        return text(
          'agentgit: no walgit clone here. Run this with cwd set to a clone of a ' +
            `https://<host>/<name>.git remote — see the ${MANUAL_URI} resource.`,
          true,
        )
      }
      const ref = input.ref ?? found.ref
      if (ref === null) {
        return text(
          'agentgit: HEAD is detached, so there is no branch to wait on. ' +
            'Check one out, or name a full ref.',
          true,
        )
      }

      const outcome = await deps.watchOnce(
        {
          host: found.host,
          origin: found.origin,
          token: deps.token(),
          targets: new Map([[found.repo, found.root]]),
          refs: [ref],
          remoteName: found.remote ?? 'origin',
          // The same rule the CLI keeps: fetch, and touch nothing else. An
          // agent's working tree is not this tool's to move.
          fetch: true,
          onChange: null,
          json: true,
          proposals: input.proposals ?? false,
        },
        input.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
      )

      if (outcome.stopped === 'refused') {
        const refusal = outcome.events.find((entry) => entry.event === 'refused')
        return text(
          `agentgit: the host refused the watch: ${refusal?.fields.error ?? 'no reason given'}`,
          true,
        )
      }

      const moved = outcome.events.toReversed().find((entry) => TERMINAL_EVENTS.has(entry.event))
      return json({
        timedOut: outcome.timedOut,
        // Named, because shape alone is ambiguous: a `deleted` ref carries no
        // sha, and an answer of `{ sha: null, timedOut: false }` would read as
        // a handoff that landed.
        event: moved?.event ?? null,
        repo: moved ? stringOrNull(moved.fields.repo) : null,
        ref: moved ? stringOrNull(moved.fields.ref) : null,
        sha: moved ? stringOrNull(moved.fields.sha) : null,
        events: outcome.events,
      })
    },

    async accept(input) {
      // Verbatim in both directions. `runAccept`'s refusals are written for
      // whoever has to act on them, and paraphrasing one here would mean an
      // agent and a person being told two different things about one tree.
      const done = await deps.accept(input.proposal, cwdOf(input))
      return done.code === 0 ? text(done.stdout) : text(done.stderr || done.stdout, true)
    },

    async setup(input) {
      const done = await deps.setup({
        host: input.host ?? null,
        global: input.local !== true,
      })
      return done.code === 0 ? text(done.stdout) : text(done.stderr || done.stdout, true)
    },

    async manual(input) {
      // The host of the clone, because a self-hosted walgit's manual states
      // that deployment's caps and not agentgit.co's — every limit in the
      // document is rendered from the capabilities the host actually enforces.
      const host = discover(deps, cwdOf(input)).host ?? DEFAULT_HOST
      try {
        return text(await deps.manual(host))
      } catch (error) {
        return text(`agentgit: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}

/**
 * The server, wired.
 *
 * Nothing below this line decides anything: it names the four tools and the one
 * resource, and hands each straight to a handler. The descriptions are written
 * for the model that reads the tool list and nothing else — that list is the
 * only documentation an MCP client sees before it calls something.
 */
export async function runMcp(deps: McpDeps): Promise<void> {
  const server = new McpServer({ name: 'agentgit', version: deps.version })
  const handlers = createHandlers(deps)
  const cwd = z
    .string()
    .optional()
    .describe('A clone to act in. Defaults to the working directory of this server.')

  server.registerTool(
    'agentgit_status',
    {
      description:
        'What agentgit sees from here: whether this is a walgit clone, and if so its host, repository name, the ref HEAD is on, and whether the credential helper a Private repository needs is configured. Reads only; provisions nothing.',
      inputSchema: { cwd },
    },
    (input) => handlers.status(input),
  )

  server.registerTool(
    'agentgit_watch_once',
    {
      description:
        'Block until a ref in this clone moves, then fetch it and say what it is now. This is the handoff primitive: call it to wait for the other agent to push. Returns { repo, ref, sha }, or { timedOut: true } when nothing moved before the deadline — it fetches and nothing else, so the branch and the working tree are left alone.',
      inputSchema: {
        cwd,
        ref: z
          .string()
          .optional()
          .describe('A full ref name, e.g. refs/heads/main. Defaults to the branch HEAD is on.'),
        proposals: z
          .boolean()
          .optional()
          .describe('Also report Proposals aimed at the branch being watched.'),
        timeoutMs: z
          .number()
          .optional()
          .describe(`How long to wait. Default ${DEFAULT_WATCH_TIMEOUT_MS}ms.`),
      },
    },
    (input) => handlers.watchOnce(input),
  )

  server.registerTool(
    'agentgit_accept',
    {
      description:
        "Accept a Proposal into the branch it targets: fetch it, merge it, push it signed. Only a key on the repository's Signer List may do this, and it needs a clean tree standing on the target branch. A conflict stops it and leaves the tree for you.",
      inputSchema: {
        cwd,
        proposal: z.string().describe("The Proposal's id — the last segment of its ref name."),
      },
    },
    (input) => handlers.accept(input),
  )

  server.registerTool(
    'agentgit_setup',
    {
      description:
        'Configure the git credential helper for a walgit host, so clone, fetch, push and watch on a Private repository need nothing typed. Writes one git config line; stores no secret.',
      inputSchema: {
        cwd,
        host: z
          .string()
          .optional()
          .describe('The walgit host. Defaults to the one this clone uses.'),
        local: z
          .boolean()
          .optional()
          .describe('Write it for this repository only, rather than globally.'),
      },
    },
    (input) => handlers.setup(input),
  )

  server.registerResource(
    'manual',
    MANUAL_URI,
    {
      title: 'agentgit manual',
      description:
        "The walgit host's own /llms.txt — push-to-create, claiming a name, Reader Lists, Proposals and the event stream, with every limit this deployment actually enforces.",
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const result = await handlers.manual({})
      const body = result.content[0]?.text ?? ''
      if (result.isError) throw new Error(body)
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }] }
    },
  )

  await server.connect(new StdioServerTransport())
}

/** The deps as they are on a real machine. */
export function realMcpDeps(version: string): McpDeps {
  return {
    version,
    toplevel,
    remoteList,
    symbolicHead,
    configGet(dir, key) {
      const run = git(dir, ['config', '--get', key])
      return run.code === 0 ? run.stdout.trim() : null
    },
    watchOnce,
    token: envToken,
    accept: (id, cwd) => runAccept({ id }, realAcceptDeps(cwd, envToken())),
    setup: (request) => runSetup(request, realSetupDeps()),
    async manual(host) {
      const response = await fetch(`https://${host}/llms.txt`)
      if (!response.ok) throw new Error(`GET https://${host}/llms.txt answered ${response.status}`)
      return response.text()
    },
  }
}
