// The Clients door on the space: a third path where a machine, and only that one, is let in, to PUSH Clients.
//
// An outside system that keeps Clients of its own (a company's own website, say) tells the space about them at `space.northfield.example/agent/clients/api/...` (clientsDoor.path in the company declaration) with a service token of
// its own. The space never asks it and binds nothing of its own to it. That path is behind an Access application of its own (the
// `space-clients-access` instance) that admits that token and no person, so the assertion on these requests is for ITS audience (`CF_ACCESS_AUD_CLIENTS`), not the space's and not Claude's or the bridge's. The Worker
// answers the path before its person check (app.ts), and this file is the sibling of agent.ts and telegram.ts, with one difference: it is not forwarded to the inbox, it is answered here, over the Clients part:
//
//   - the assertion must verify for the Clients application's audience and be a SERVICE TOKEN whose client id is the one this Worker was deployed with (`CLIENTS_ACCESS_CLIENT_ID`). A person's, however genuine, is
//     refused here, a token is refused everywhere else on the host (whoIsAsking, app.ts, still admits people only), and the other two machines' tokens are for other applications and so other audiences;
//   - what it can do is what `ClientsForSource` offers (packages/workspace/src/clients.ts) for the ONE source the declaration names, and nothing else:
//       GET  {door}/api/clients                  every Client of the source in the space, by the source's id
//       PUT  {door}/api/clients/{id}             make or bring up to date one Client (idempotent)
//       POST {door}/api/clients/{id}/gone        the source says the Client is gone (it is marked and kept)
//       PUT  {door}/api/clients                  the full set, as {"clients": [...]}: what is missing is marked gone (all or nothing)
//     The part decides every rule (who wins a name, numbers, what a bad shape is); this file carries the request in and the answer out. Nothing is retried and nothing is half applied.
//
// Why a machine other than Claude's and the bridge's is allowed through the space: packages/workspace/docs/adr/0002, amended for it.

import { type ClientsForSource, clientsRoute, type Http, identify, type Install, type RefusalReason, refusalStatus, type SpaceReply } from '@space/workspace'
import { isRecord } from './guards'

/** The Clients part's face for the source, in this Worker (`Parts.clientsDoor`). Absent where the store is not bound: the door then says it is not connected. */
export type ClientsDoorFace = ClientsForSource

export interface ClientsDoorEnv {
  /** The audience of the Access application on the Clients door's path (`space-clients-access`). Unset or malformed refuses everyone there. */
  CF_ACCESS_AUD_CLIENTS?: string
  /** The client id of the token the door admits (`space-clients-access`). Unset refuses everyone there: the assertion's token must be this one. */
  CLIENTS_ACCESS_CLIENT_ID?: string
}

/** The most a body is read from: a single Client is a few hundred bytes, so a full set of `CLIENT_SYNC_MAX` Clients of ordinary size is well under this. A set stuffed to every field's limit could be larger, and is refused whole with a 413 (nothing is half applied). */
export const DOOR_BODY_MAX = 4_000_000

const NO_STORE = { 'cache-control': 'no-store' }
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status, headers: NO_STORE })

/** How a refusal of the part is told to a machine: the status says what kind, the message says why. */
const STATUS: Record<RefusalReason, number> = { 'not-signed-in': 401, 'not-admitted': 403, 'not-found': 404, 'bad-request': 400, conflict: 409, limit: 429 }

/** The part's reply as the door's answer: the value as JSON, or a refusal or a fault with its sentence. */
function answer<T>(r: SpaceReply<T>): Response {
  if (r.ok) return Response.json({ value: r.value }, { headers: NO_STORE })
  return r.kind === 'refused' ? refuse(STATUS[r.reason], r.message, { reason: r.reason }) : refuse(500, r.message, { reason: r.reason })
}

/** A request's JSON body, or the response that refuses it: too large (413), or not JSON (400). */
async function bodyOf(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > DOOR_BODY_MAX) return { ok: false, response: refuse(413, 'Too large') }
  const text = await req.text()
  if (text.length > DOOR_BODY_MAX) return { ok: false, response: refuse(413, 'Too large') }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, response: refuse(400, 'Send a JSON body.') }
  }
}

/** The four calls, by method and path. A path under the door that is none of them is a 404, and a known path with another method a 405. */
async function dispatch(req: Request, path: string, face: ClientsDoorFace): Promise<Response> {
  const parts = path.split('/')
  // ['', 'api', 'clients'] | ['', 'api', 'clients', id] | ['', 'api', 'clients', id, 'gone']
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'clients' || parts.length > 5 || parts.length < 3) return refuse(404, 'Not found')
  const method = req.method.toUpperCase()
  if (parts.length === 3) {
    if (method === 'GET') return answer(await face.list())
    if (method !== 'PUT') return refuse(405, 'Method not allowed', {})
    const body = await bodyOf(req)
    if (!body.ok) return body.response
    if (!isRecord(body.value) || !Array.isArray(body.value.clients) || Object.keys(body.value).length !== 1) return refuse(400, 'Send the full set as {"clients": [...]}.', { reason: 'bad-request' })
    return answer(await face.sync(body.value.clients as never))
  }
  let id: string
  try {
    id = decodeURIComponent(parts[3] as string)
  } catch {
    return refuse(400, 'That is not a Client id.', { reason: 'bad-request' })
  }
  if (parts.length === 4) {
    if (method !== 'PUT') return refuse(405, 'Method not allowed')
    const body = await bodyOf(req)
    if (!body.ok) return body.response
    return answer(await face.upsert(id, body.value as never))
  }
  if (parts[4] !== 'gone') return refuse(404, 'Not found')
  if (method !== 'POST') return refuse(405, 'Method not allowed')
  return answer(await face.gone(id))
}

/**
 * The answer for a request on the Clients door, or null for a request that is not on it (the person check then goes on as always).
 *
 * 401 for no assertion or one that does not verify for the Clients audience; 403 for a verified one that is not a service token (a person, a token and a person at once) or is not the door's token; 404 for a path under
 * the door that is not an API path of it; 503 while the store is absent. Nothing is told that the refusals differ in why (`detail` goes to the Worker's tail only).
 */
export async function clientsAnswer(
  req: Request,
  env: ClientsDoorEnv,
  deps: { fetch: Http; now(): number; install: Install },
  face?: ClientsDoorFace,
): Promise<Response | null> {
  const route = clientsRoute(deps.install, new URL(req.url).pathname)
  if (!route.on) return null
  const out = await identify(deps.install, req.headers, { fetch: deps.fetch, aud: env.CF_ACCESS_AUD_CLIENTS ?? '', now: deps.now() }, { allowServiceTokens: true })
  if (!out.ok) {
    console.warn(`clients door refused (${out.refusal}): ${out.detail}`)
    return refusalStatus(out.refusal) === 401 ? refuse(401, 'Unauthorized') : refuse(403, 'Forbidden')
  }
  if (out.identity.kind !== 'service') {
    console.warn('clients door refused: a person, where only the token may come')
    return refuse(403, 'Forbidden')
  }
  if (env.CLIENTS_ACCESS_CLIENT_ID === undefined || env.CLIENTS_ACCESS_CLIENT_ID === '' || out.identity.commonName !== env.CLIENTS_ACCESS_CLIENT_ID) {
    console.warn('clients door refused: a service token that is not the door’s')
    return refuse(403, 'Forbidden')
  }
  if (route.forward === null) return refuse(404, 'Not found')
  if (!face) return refuse(503, 'The Clients are not connected to the space')
  try {
    return await dispatch(req, route.forward, face)
  } catch (error) {
    // The part answers faults as data; this is a fault of the door itself. Nothing of it is shown.
    console.error('clients door failed', error)
    return refuse(500, 'The Clients could not answer that. Nothing was changed.')
  }
}
