/**
 * The Model Context Protocol surface, as a value.
 *
 * An agent finds a tool through the registry its harness already reads. The
 * first version of this shipped as a stdio server an agent's harness spawned
 * (`npx -y @zabaca/agentgit mcp`), and both ways it could fail to start were
 * spawn problems rather than protocol ones: a cold npx cache racing the
 * client's startup timeout, and a workspace checkout resolving the unlinked
 * package. A URL has neither failure mode, so the server moved to the host
 * that already answers every other question about a repository.
 *
 * **It carries only what the host can answer without the agent's disk.** A
 * name's state, a ref moving, who pushed it, and the manual. Accepting a
 * Proposal, configuring a credential helper and fetching into a clone are the
 * skill's, as shell commands — they act on a tree this process cannot see, and
 * a tool that pretended otherwise would be a tool that could only fail.
 *
 * Nothing here reaches anything. Every fact comes through `McpDeps`, whose
 * implementations (`worker/mcp.ts`) are the container round trip and the event
 * socket — which is what lets the whole surface be driven by a real MCP client
 * in `src/mcp.test.ts` with no runtime at all. `shared/`'s one rule holds: this
 * module imports no runtime, and both halves may compile it (docs/adr/0010).
 *
 * The one rule it DOES own is the refusal: a read that the host refused is
 * reported as a refusal and nothing else. `status` on a Private name a caller
 * cannot prove a key for must not leak refs, existence or the lists alongside
 * the 401 — that is the property `info/refs` has, and the reason both reading
 * tools go through the host's own gated routes rather than a second copy of
 * the gate.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { Capabilities } from './capabilities'
import { renderLlms } from './llms'
import type { Operator } from './operator'
import { REF_NAME, REPO_ID } from './protocol'

/** The manual, as a resource a client can read without calling a tool. */
export const MANUAL_URI = 'agentgit://manual'

/**
 * The longest a single `agentgit_watch` holds a request open.
 *
 * A watch is a long poll over the ref-event stream, and the request it holds
 * open is a Worker invocation — so the cap is the HOST's, not the caller's. A
 * client that wants to wait longer calls again, and loses nothing by it:
 * events are latest-state, so the next call's answer is current state rather
 * than a replay it might have missed (docs/adr/0009).
 */
export const MAX_WATCH_MS = 5 * 60_000

/** What a read of a repository answered, or the refusal the host made. */
export type Read<T> = ({ ok: true } & T) | { ok: false; status: number; message: string }

/** One repository's state, as the host sees it. */
export interface StatusFacts {
  /** Anything has ever been pushed to this name. */
  exists: boolean
  /** It holds a Signer List, so a stranger's push is refused (docs/adr/0012). */
  claimed: boolean
  /** It holds a Reader List, so a stranger's read is refused (docs/adr/0013). */
  private: boolean
  /** Ref name → sha, as the Index holds it. */
  refs: Record<string, string>
}

/** Who moved each ref, as the host recorded it (docs/adr/0011). */
export type ProvenanceFacts = Record<string, { signer: string; ts: string }>

/** What a watch saw: a ref that moved, or the deadline. */
export type WatchOutcome = { timedOut: false; ref: string; sha: string | null } | { timedOut: true }

/**
 * Everything the tools touch that this module cannot compute.
 *
 * `status` and `provenance` return a `Read`, never throw, because a refusal is
 * an ANSWER the host made and has to survive the trip verbatim — turning a 401
 * into an exception here is how a refusal becomes "something went wrong".
 * `watch` may throw: an event stream that cannot be reached is not a verdict
 * about the repository, and reporting it as one would be a lie.
 */
export interface McpDeps {
  /** Reported in the handshake, so a client can name what it is talking to. */
  version: string
  /** This deployment's hostname, for the manual and for naming it in an error. */
  host: string
  /** What this deployment offers (`shared/capabilities.ts`). */
  caps: Capabilities
  /** Who runs it (`shared/operator.ts`), or nobody. */
  operator: Operator | null
  status(name: string): Promise<Read<StatusFacts>>
  provenance(name: string): Promise<Read<{ repo: string; provenance: ProvenanceFacts }>>
  watch(name: string, ref: string | null, timeoutMs: number): Promise<WatchOutcome>
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  [key: string]: unknown
}

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const refuse = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
})

/**
 * The name grammar, applied before the host is asked.
 *
 * The same `REPO_ID` every other entry point applies (`src/repo.ts`,
 * `shared/events.ts`): a name one surface accepts and another rejects is a
 * repository half the service can see. Refused here rather than forwarded so a
 * path-shaped name never becomes a request at all.
 */
function badName(name: string): string | null {
  return REPO_ID.test(name)
    ? null
    : `agentgit: "${name}" is not a repository name here — one flat segment of letters, digits, dot, dash or underscore, starting with a letter or a digit.`
}

/**
 * The MCP server this host serves, wired over `deps`.
 *
 * Returned unconnected: the transport is the caller's, which is what lets one
 * function serve a Streamable HTTP request in the Worker and an in-memory pair
 * in a test. The descriptions are written for the model that reads the tool
 * list and nothing else — that list is the only documentation an MCP client
 * sees before it calls something.
 */
export function createAgentgitMcp(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'agentgit', version: deps.version })

  const name = z
    .string()
    .describe('The repository name — the `<name>` in `https://host/<name>.git`.')

  server.registerTool(
    'agentgit_status',
    {
      description:
        'What the host knows about a repository name: whether anything has been pushed to it, whether it holds a Signer List (claimed, so a stranger cannot push), whether it holds a Reader List (private, so a stranger cannot read), and every ref with its sha. Reads only; creates nothing. A free name answers exists: false rather than an error, so this is how you check before claiming one.',
      inputSchema: { name },
    },
    async (input): Promise<ToolResult> => {
      const bad = badName(input.name)
      if (bad) return refuse(bad)
      const read = await deps.status(input.name)
      if (!read.ok) return refuse(read.message)
      return json({
        name: input.name,
        exists: read.exists,
        claimed: read.claimed,
        private: read.private,
        // An array rather than the map the Index holds: a tool result is read
        // by a model, and a list of {ref, sha} survives truncation in a way an
        // object whose KEYS are the interesting part does not.
        refs: Object.entries(read.refs).map(([ref, sha]) => ({ ref, sha })),
        signedPushes: deps.caps.signedPushes,
      })
    },
  )

  server.registerTool(
    'agentgit_watch',
    {
      description:
        'Block until a ref in a repository moves, then say what it is now. This is the handoff primitive: call it to wait for the other agent to push. Answers { ref, sha } when one moves, or { timedOut: true } when none did before the deadline — which is an answer, not a failure, so call it again to keep waiting. It touches no clone: fetching what it reports is yours to do.',
      inputSchema: {
        name,
        ref: z
          .string()
          .optional()
          .describe('A full ref name, e.g. refs/heads/main. Omit to watch every ref.'),
        timeoutMs: z
          .number()
          .optional()
          .describe(`How long to wait, capped at ${MAX_WATCH_MS}ms by the host.`),
      },
    },
    async (input): Promise<ToolResult> => {
      const bad = badName(input.name)
      if (bad) return refuse(bad)
      const ref = input.ref ?? null
      if (ref !== null && !REF_NAME.test(ref)) {
        return refuse(`agentgit: "${ref}" is not a full ref name — refs/heads/main, not main.`)
      }
      // The host's cap, not the caller's (see `MAX_WATCH_MS`).
      const timeoutMs = Math.min(input.timeoutMs ?? MAX_WATCH_MS, MAX_WATCH_MS)
      let outcome: WatchOutcome
      try {
        outcome = await deps.watch(input.name, ref, timeoutMs)
      } catch (error) {
        // Named rather than hung, and the HOST is named: a watch that cannot
        // reach the event stream is a fact about this deployment, and a client
        // told only "failed" has nothing to retry against.
        return refuse(
          `agentgit: could not watch ${input.name} on ${deps.host}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      return json({
        timedOut: outcome.timedOut,
        repo: input.name,
        // Spelled out rather than left off, because shape alone is ambiguous: a
        // deleted ref carries no sha, and `{ sha: null }` on its own reads as a
        // handoff that landed.
        ref: outcome.timedOut ? null : outcome.ref,
        sha: outcome.timedOut ? null : outcome.sha,
      })
    },
  )

  server.registerTool(
    'agentgit_provenance',
    {
      description:
        'Who pushed a ref: the SSH key fingerprint that signed the push, and when it landed. A key, never a user — there are no accounts here. A ref nobody signed answers signer: null, which is the ordinary answer, because signing is opt-in.',
      inputSchema: {
        name,
        ref: z.string().describe('A full ref name, e.g. refs/heads/main.'),
      },
    },
    async (input): Promise<ToolResult> => {
      const bad = badName(input.name)
      if (bad) return refuse(bad)
      const read = await deps.provenance(input.name)
      if (!read.ok) return refuse(read.message)
      const entry = read.provenance[input.ref]
      return json({
        repo: input.name,
        ref: input.ref,
        signer: entry?.signer ?? null,
        ts: entry?.ts ?? null,
      })
    },
  )

  server.registerResource(
    'manual',
    MANUAL_URI,
    {
      title: 'agentgit manual',
      description:
        "This host's own /llms.txt — push-to-create, claiming a name, Reader Lists, Proposals and the event stream, with every limit this deployment actually enforces.",
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          // The same renderer the `/llms.txt` route calls, over the same
          // capabilities: one document, two ways to it, and no second copy to
          // promise a limit this deployment does not have.
          text: renderLlms(deps.host, deps.caps, deps.operator),
        },
      ],
    }),
  )

  return server
}
