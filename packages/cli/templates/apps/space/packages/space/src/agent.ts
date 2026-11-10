// Claude's door on the space: one path where a machine, and only that one, is let in.
//
// Claude's script reaches the inbox at `space.northfield.example/agent/inbox/api/...` (apps.inbox.agentPath in the company declaration) with the service token it
// is issued. That path is behind an Access application of its own (the `space-agent-access` instance) that admits that token and no person, so
// the assertion on these requests is for ITS audience (`CF_ACCESS_AUD_AGENT`) and not the space's. The Worker answers the path before its person check
// (app.ts), and this file is the rest, the sibling of forms.ts:
//
//   - the assertion must verify for the agent application's audience and be a SERVICE TOKEN. A person's, however genuine, is refused here, and a token
//     is refused everywhere else on the host (whoIsAsking, app.ts, still admits people only);
//   - the request goes on to the inbox's router IN THIS WORKER (not over a service binding to a separate inbox Worker's
//     `ClaudeInbox` entrypoint, which no longer exists), at the inbox's own `/api/...` path, without the cookie, without the token's own two headers and WITHOUT THE ASSERTION: the check was made here, once, and the
//     router is handed the token it verified (packages/inbox/src/space-part.ts), admits Claude's token by its id and nobody else, and verifies nothing again. The space holds no rule of the inbox's and no secret.
//
// Why this is allowed when the company layer's ADR 0001 said no service token comes through the space: packages/workspace/docs/adr/0002.

import type { ServiceIdentity } from '@space/inbox/src/app'
import { agentRoute, type Http, identify, type Install, refusalStatus } from '@space/workspace'

/** The inbox's router for Claude's door, in this Worker (`InboxPart.claude`): a request and the service token the check verified for it. Absent where the inbox's store is not bound: the door then says it is not connected. */
export type ClaudeDoor = (request: Request, who: ServiceIdentity) => Promise<Response>

export interface AgentEnv {
  /** The audience of the Access application on the agent path (`space-agent-access`). Unset or malformed refuses everyone there. */
  CF_ACCESS_AUD_AGENT?: string
}

/** What goes to the inbox: the request as it came, at the inbox's path, without the cookie, without the token's own headers and without the assertion (the check was made here). */
export function agentRequest(req: Request, inboxPath: string): Request {
  const url = new URL(req.url)
  url.pathname = inboxPath
  const headers = new Headers(req.headers)
  headers.delete('cookie')
  // Access has used these to admit the request; the secret half goes no further than this Worker.
  headers.delete('cf-access-client-id')
  headers.delete('cf-access-client-secret')
  headers.delete('cf-access-jwt-assertion')
  return new Request(url, { method: req.method, headers, body: req.body, redirect: 'manual', ...(req.body ? { duplex: 'half' } : {}) } as RequestInit)
}

const refuse = (status: 401 | 403 | 404 | 503, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })

/**
 * The answer for a request on Claude's door, or null for a request that is not on it (the person check then goes on as always).
 *
 * 401 for no assertion or one that does not verify for the agent audience; 403 for a verified one that is not a service token (a person, a token and
 * a person at once); 404 for a path under the door that is not the inbox's API; 503 while the binding is absent. Nothing is told that the refusals
 * differ in why (`detail` goes to the Worker's tail only).
 */
export async function agentAnswer(
  req: Request,
  env: AgentEnv,
  deps: { fetch: Http; now(): number; install: Install },
  claude?: ClaudeDoor,
): Promise<Response | null> {
  const route = agentRoute(deps.install, new URL(req.url).pathname)
  if (!route.on) return null
  const out = await identify(deps.install, req.headers, { fetch: deps.fetch, aud: env.CF_ACCESS_AUD_AGENT ?? '', now: deps.now() }, { allowServiceTokens: true })
  if (!out.ok) {
    console.warn(`agent door refused (${out.refusal}): ${out.detail}`)
    return refusalStatus(out.refusal) === 401 ? refuse(401, 'Unauthorized') : refuse(403, 'Forbidden')
  }
  if (out.identity.kind !== 'service') {
    console.warn('agent door refused: a person, where only the token may come')
    return refuse(403, 'Forbidden')
  }
  if (route.forward === null) return refuse(404, 'Not found')
  if (!claude) return refuse(503, 'The inbox is not connected to the space')
  return claude(agentRequest(req, route.forward), out.identity)
}
