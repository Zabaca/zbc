/**
 * The MCP endpoint's Workers half: a transport, and the three reads.
 *
 * Everything an agent can ASK is `shared/mcp.ts` — the tools, their schemas,
 * their descriptions and the one rule about refusals — and it is tested there
 * against a real MCP client with no runtime. What is left here is exactly the
 * part that needs one: a Streamable HTTP transport, a container round trip, and
 * a socket to the ref-event Durable Object.
 *
 * Two properties this file is responsible for keeping:
 *
 *   - **The gate is the host's own, not a second copy.** `status` and
 *     `provenance` both go through the container's `PROVENANCE_PATH`, which is
 *     already placed behind exactly the credential a clone needs and already
 *     applies the Read Challenge for a Private name (`src/http.ts`,
 *     docs/adr/0013). A refusal it makes is forwarded verbatim; the internal
 *     `REFS_PATH` read that fills in the refs happens ONLY after that refusal
 *     did not come, because it is `INTERNAL_HEADER`-gated and gates nothing
 *     itself.
 *   - **The request is served at the edge.** `watch` subscribes to the Durable
 *     Object the way a WebSocket client does — the container is never woken for
 *     it, and the manual is rendered from the same capabilities the `/llms.txt`
 *     route uses.
 */

import { StreamableHTTPTransport } from '@hono/mcp'
import { getContainer } from '@cloudflare/containers'
import { Hono } from 'hono'

import type { Capabilities } from '../shared/capabilities'
import { parseTokens } from '../shared/credentials'
import { authorizeSubscribe } from '../shared/events'
import {
  type McpDeps,
  type ProvenanceFacts,
  type Read,
  type StatusFacts,
  type WatchOutcome,
  createAgentgitMcp,
} from '../shared/mcp'
import type { Operator } from '../shared/operator'
import {
  EVENTS_PATH,
  INTERNAL_HEADER,
  MCP_PATH,
  PROVENANCE_PATH,
  REFS_PATH,
} from '../shared/protocol'
import { EVENTS_OBJECT_NAME } from './events-do'
import type { Env } from './index'

/** What a claimed name's provenance read carries about its lists. */
interface Claim {
  signers: string[]
  readers?: string[]
  ts: string
}

/**
 * Answer one MCP request.
 *
 * A fresh `McpServer` per request, like the inbox's endpoint and for the same
 * reason: a Workers isolate is per-request and holds no session, so there is no
 * long-lived server to keep. `app.all` because Streamable HTTP puts client
 * messages on POST and the server-to-client stream on GET, and a transport
 * mounted for one of them is a client that connects and then hears nothing.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  caps: Capabilities,
  operator: Operator | null,
  host: string,
): Promise<Response> {
  const server = createAgentgitMcp(deps(request, env, caps, operator, host))
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  const app = new Hono()
  app.all(MCP_PATH, (c) => transport.handleRequest(c))
  return app.fetch(request)
}

function deps(
  request: Request,
  env: Env,
  caps: Capabilities,
  operator: Operator | null,
  host: string,
): McpDeps {
  // The caller's own credential, forwarded unchanged to every gated read. An
  // MCP client sends it as an ordinary Authorization header, which is the same
  // header a clone of a Private repository presents.
  const authorization = request.headers.get('authorization')

  return {
    version: env.WALGIT_BUILD_ID ?? '0.0.0',
    host,
    caps,
    operator,

    async status(name): Promise<Read<StatusFacts>> {
      const read = await provenanceRead(env, authorization, name)
      if (!read.ok) return read
      // Only now: `REFS_PATH` is internal and judges nothing, so reading it
      // before the gate above answered would be the second copy of the gate
      // this file exists not to have.
      const refs = await readRefs(env, name)
      const claim = read.claim
      return {
        ok: true,
        // The same judgment `src/http.ts` makes of a name nobody has pushed to:
        // a repository with no refs is one that does not exist yet.
        exists: Object.keys(refs).length > 0,
        claimed: claim !== undefined,
        // Presence is the switch, and `[]` is a value — an empty Reader List
        // means the Signer List reads this and nobody else (docs/adr/0013).
        private: claim?.readers !== undefined,
        refs,
      }
    },

    async provenance(name): Promise<Read<{ repo: string; provenance: ProvenanceFacts }>> {
      const read = await provenanceRead(env, authorization, name)
      if (!read.ok) return read
      return { ok: true, repo: name, provenance: read.provenance }
    },

    watch: (name, ref, timeoutMs) => watchRef(env, caps, authorization, name, ref, timeoutMs),
  }
}

/**
 * One repository's provenance and Claim, through the container's own gate.
 *
 * The status code is carried out with the body, because the body is the
 * refusal the host wrote and `shared/mcp.ts` forwards it verbatim — a 401 for a
 * Private name an unproven reader asked about has to reach the agent saying
 * what `info/refs` would say, and nothing more.
 */
async function provenanceRead(
  env: Env,
  authorization: string | null,
  name: string,
): Promise<Read<{ provenance: ProvenanceFacts; claim?: Claim }>> {
  const headers = new Headers()
  if (authorization) headers.set('authorization', authorization)
  const response = await getContainer(env.WALGIT_CONTAINER).fetch(
    new Request(`https://walgit.internal${PROVENANCE_PATH}?repo=${encodeURIComponent(name)}`, {
      headers,
    }),
  )
  if (!response.ok) {
    const message = (await response.text()).trim()
    return {
      ok: false,
      status: response.status,
      message: message === '' ? `walgit: the host answered ${response.status}` : message,
    }
  }
  const body = (await response.json()) as { provenance?: ProvenanceFacts; claim?: Claim }
  return { ok: true, provenance: body.provenance ?? {}, claim: body.claim }
}

/** One repository's ref state, read from the Index through the container. */
async function readRefs(env: Env, name: string): Promise<Record<string, string>> {
  const response = await getContainer(env.WALGIT_CONTAINER).fetch(
    new Request(`https://walgit.internal${REFS_PATH}?repo=${encodeURIComponent(name)}`, {
      headers: { [INTERNAL_HEADER]: '1' },
    }),
  )
  // Empty rather than thrown: the gate above already said this name may be
  // read, and a refs lookup that did not answer is a repository with nothing
  // known about it — which is what `exists: false` says.
  if (!response.ok) return {}
  const body = (await response.json()) as { refs?: Record<string, string> }
  return body.refs ?? {}
}

/**
 * Wait for one ref to move, over the same socket a `watch` client uses.
 *
 * The gate is the event stream's own, in both halves: the deployment
 * credential is checked here exactly as `events()` checks it in `index.ts`, and
 * the Reader List is checked by the Durable Object against the credential this
 * request forwards (`worker/events-do.ts`). Neither is re-decided.
 *
 * Throws rather than returning a verdict when the stream cannot be reached or
 * refuses: an answer of `{ timedOut: true }` would tell an agent that nothing
 * happened, which is a different and false statement.
 */
async function watchRef(
  env: Env,
  caps: Capabilities,
  authorization: string | null,
  repo: string,
  ref: string | null,
  timeoutMs: number,
): Promise<WatchOutcome> {
  if (!caps.events) {
    throw new Error('this deployment does not serve the ref-event stream')
  }
  if (
    !authorizeSubscribe({
      authorization,
      tokens: parseTokens(env.WALGIT_HTTP_TOKENS),
      isPublic: caps.publicAccess,
    })
  ) {
    throw new Error('unauthorized')
  }

  const headers = new Headers({ upgrade: 'websocket' })
  if (authorization) headers.set('authorization', authorization)
  const stub = env.WALGIT_EVENTS.get(env.WALGIT_EVENTS.idFromName(EVENTS_OBJECT_NAME))
  const response = await stub.fetch(
    new Request(`https://walgit.internal${EVENTS_PATH}`, { headers }),
  )
  const socket = response.webSocket
  if (!socket) throw new Error(`the event stream answered ${response.status}`)
  socket.accept()

  return new Promise<WatchOutcome>((resolve, reject) => {
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close(1000, 'walgit: done')
      } catch {
        // Already gone.
      }
      run()
    }
    const timer = setTimeout(() => finish(() => resolve({ timedOut: true })), timeoutMs)

    socket.addEventListener('message', (event) => {
      let message: Record<string, unknown>
      try {
        const raw = typeof event.data === 'string' ? event.data : ''
        message = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      if (typeof message.error === 'string') {
        const error = message.error
        finish(() => reject(new Error(error)))
        return
      }
      // The handshake is current state for what was named, not a ref that
      // moved — resolving on it would make every call return immediately.
      if (message.ok === true) return
      if (typeof message.ref !== 'string') return
      const moved = message.ref
      const sha = typeof message.sha === 'string' ? message.sha : null
      finish(() => resolve({ timedOut: false, ref: moved, sha }))
    })
    socket.addEventListener('close', () =>
      finish(() => reject(new Error('the event stream closed the subscription'))),
    )
    socket.addEventListener('error', () =>
      finish(() => reject(new Error('the event stream failed'))),
    )

    // Omitting `refs` watches every ref in the repository, which is what a
    // caller that named none asked for.
    socket.send(JSON.stringify({ watch: [{ repo, ...(ref === null ? {} : { refs: [ref] }) }] }))
  })
}
