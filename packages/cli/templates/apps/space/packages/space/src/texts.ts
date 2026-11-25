// The texts bridge's door on the space: another path where a machine, and only that one, is let in.
//
// The texts bridge (a process that runs outside the space, paired with the owner's phone) pushes the owner's texts into the inbox at `space.northfield.example/agent/texts/api/...` (texts.path in the company declaration) with a
// service token of its own, "texts bridge". That path is behind an Access application of its own (the `space-texts-access` instance) that admits that token and no person, so the assertion on these requests is for
// ITS audience (`CF_ACCESS_AUD_TEXTS`), not the space's, not Claude's and not the Telegram bridge's. The Worker answers the path before its person check (app.ts), and this file is the sibling of telegram.ts:
//
//   - the assertion must verify for the bridge application's audience and be a SERVICE TOKEN. A person's, however genuine, is refused here, and a token is refused everywhere else on the host
//     (whoIsAsking, app.ts, still admits people only). Claude's token and the Telegram bridge's are for other audiences and so other applications: an assertion minted for either does not verify here;
//   - the request goes on to the inbox's bridge router IN THIS WORKER, at the inbox's own `/api/...` path, without the cookie, without the token's own two headers and WITHOUT THE ASSERTION: the check was made
//     here, once, and the router is handed the token it verified (packages/inbox/src/space-part.ts), admits the bridge's token by its id and nobody else, and serves five calls (packages/inbox/src/texts/app.ts).
//     The space holds no rule of the inbox's and no secret.
//
// Why a machine is allowed through the space: packages/workspace/docs/adr/0002, amended for it.

import type { ServiceIdentity } from '@space/inbox/src/app'
import { type Http, identify, type Install, refusalStatus, textsRoute } from '@space/workspace'
import { agentRequest } from './agent'

/** The inbox's router for the texts bridge's door, in this Worker (`InboxPart.texts`): a request and the service token the check verified for it. Absent where the inbox's store is not bound: the door then says it is not connected. */
export type TextsDoor = (request: Request, who: ServiceIdentity) => Promise<Response>

export interface TextsEnv {
  /** The audience of the Access application on the bridge's path (`space-texts-access`). Unset or malformed refuses everyone there. */
  CF_ACCESS_AUD_TEXTS?: string
}

const refuse = (status: 401 | 403 | 404 | 503, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })

/**
 * The answer for a request on the texts bridge's door, or null for a request that is not on it (the person check then goes on as always).
 *
 * 401 for no assertion or one that does not verify for the texts bridge audience; 403 for a verified one that is not a service token (a person, a token and a person at once); 404 for a path under the door
 * that is not an API path; 503 while the binding is absent. Nothing is told that the refusals differ in why (`detail` goes to the Worker's tail only).
 */
export async function textsAnswer(
  req: Request,
  env: TextsEnv,
  deps: { fetch: Http; now(): number; install: Install },
  bridge?: TextsDoor,
): Promise<Response | null> {
  const route = textsRoute(deps.install, new URL(req.url).pathname)
  if (!route.on) return null
  const out = await identify(
    deps.install,
    req.headers,
    { fetch: deps.fetch, aud: env.CF_ACCESS_AUD_TEXTS ?? '', now: deps.now() },
    { allowServiceTokens: true },
  )
  if (!out.ok) {
    console.warn(`texts door refused (${out.refusal}): ${out.detail}`)
    return refusalStatus(out.refusal) === 401 ? refuse(401, 'Unauthorized') : refuse(403, 'Forbidden')
  }
  if (out.identity.kind !== 'service') {
    console.warn('texts door refused: a person, where only the token may come')
    return refuse(403, 'Forbidden')
  }
  if (route.forward === null) return refuse(404, 'Not found')
  if (!bridge) return refuse(503, 'The inbox is not connected to the space')
  return bridge(agentRequest(req, route.forward), out.identity)
}
