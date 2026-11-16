// The leads door on the space: a machine path where the company's own site, and only it, SENDS each request a person made there (a quote form, a booking form), to become a lead.
//
// The same shape as the Clients door (clients-door.ts), held apart from it and from every other door: its own path (`leads.door.path` in the company declaration), its own Access application
// (`space-leads-access`) that admits one service token and no person, so the assertion is for ITS audience (`CF_ACCESS_AUD_LEADS`) and the token is the one this Worker was deployed with
// (`LEADS_ACCESS_CLIENT_ID`). The Worker answers the path before its person check (app.ts). One call:
//
//   POST {door}/api/leads   one request: {"id": the site's own id for it, "name", "email", "phone", "fields": {...}} and, for a lead carried over from the site's own records, "stage" and "at"
//
// The inbox decides every rule (who the person is, a fold into an open lead, the install's fields and stages, a repeat of the same id changing nothing: packages/inbox/src/space-leads.ts); this file
// carries the request in and the answer out, and the inbox tells the leads' people of a new one. Nothing is retried and nothing is half applied.

import { type Http, identify, type Install, leadsRoute, type RefusalReason, refusalStatus, type SpaceReply } from '@space/workspace'
import type { LeadFromSource } from '@space/inbox/src/space-part'
import { isRecord } from './guards'

/** The inbox part's entry for the door (`InboxPart.leadFromSource`). Absent where the store is not bound: the door then says it is not connected. */
export type LeadsDoorFace = (request: LeadFromSource) => Promise<SpaceReply<{ leadId: string; outcome: 'made' | 'folded' | 'repeat' }>>

export interface LeadsDoorEnv {
  /** The audience of the Access application on the leads door's path (`space-leads-access`). Unset or malformed refuses everyone there. */
  CF_ACCESS_AUD_LEADS?: string
  /** The client id of the token the door admits (`space-leads-access`). Unset refuses everyone there. */
  LEADS_ACCESS_CLIENT_ID?: string
}

/** The most a request's body is read from: one person's request is a few kilobytes at most. */
export const LEAD_BODY_MAX = 200_000

const NO_STORE = { 'cache-control': 'no-store' }
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status, headers: NO_STORE })

const STATUS: Record<RefusalReason, number> = { 'not-signed-in': 401, 'not-admitted': 403, 'not-found': 404, 'bad-request': 400, conflict: 409, limit: 429 }

const ID = /^[A-Za-z0-9._:-]{1,200}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const optionalText = (v: unknown, max: number): v is string | null | undefined => v === undefined || v === null || text(v, max)

/** The request in the shape the inbox takes, or the sentence that refuses it. */
export function parseLeadBody(v: unknown): { ok: true; value: LeadFromSource } | { ok: false; message: string } {
  if (!isRecord(v)) return { ok: false, message: 'Send one request as a JSON object.' }
  if (!text(v.id, 200) || !ID.test(v.id)) return { ok: false, message: 'Name the request by your own id for it (id: letters, digits and . _ : - only).' }
  if (!text(v.name, 200)) return { ok: false, message: 'The name is text of at most 200 characters.' }
  if (!optionalText(v.email, 320) || !optionalText(v.phone, 40)) return { ok: false, message: 'The email and the phone are text, or null.' }
  if (v.fields !== undefined && !isRecord(v.fields)) return { ok: false, message: 'The fields are an object of text by the keys the space declares.' }
  if (v.stage !== undefined && !text(v.stage, 40)) return { ok: false, message: 'The stage is a stage id of the space.' }
  if (v.at !== undefined && !(text(v.at, 40) && ISO.test(v.at) && !Number.isNaN(Date.parse(v.at)))) return { ok: false, message: 'When it came in (at) is a moment such as 2026-01-31T09:30:00Z.' }
  return {
    ok: true,
    value: {
      externalId: v.id,
      name: v.name,
      email: (v.email ?? null) as string | null,
      phone: (v.phone ?? null) as string | null,
      fields: v.fields ?? {},
      ...(v.stage !== undefined && { stage: v.stage as string }),
      ...(v.at !== undefined && { at: new Date(v.at as string).toISOString() }),
    },
  }
}

async function bodyOf(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > LEAD_BODY_MAX) return { ok: false, response: refuse(413, 'Too large') }
  const raw = await req.text()
  if (raw.length > LEAD_BODY_MAX) return { ok: false, response: refuse(413, 'Too large') }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false, response: refuse(400, 'Send a JSON body.') }
  }
}

/**
 * The answer for a request on the leads door, or null for a request that is not on it (the person check then goes on as always). 401 for no assertion or one that does not verify for the door's
 * audience; 403 for a verified one that is not the door's service token; 404 for a path under the door that is not its one call; 503 while the inbox is absent.
 */
export async function leadsAnswer(req: Request, env: LeadsDoorEnv, deps: { fetch: Http; now(): number; install: Install }, face?: LeadsDoorFace): Promise<Response | null> {
  const route = leadsRoute(deps.install, new URL(req.url).pathname)
  if (!route.on) return null
  const out = await identify(deps.install, req.headers, { fetch: deps.fetch, aud: env.CF_ACCESS_AUD_LEADS ?? '', now: deps.now() }, { allowServiceTokens: true })
  if (!out.ok) {
    console.warn(`leads door refused (${out.refusal}): ${out.detail}`)
    return refusalStatus(out.refusal) === 401 ? refuse(401, 'Unauthorized') : refuse(403, 'Forbidden')
  }
  if (out.identity.kind !== 'service') {
    console.warn('leads door refused: a person, where only the token may come')
    return refuse(403, 'Forbidden')
  }
  if (env.LEADS_ACCESS_CLIENT_ID === undefined || env.LEADS_ACCESS_CLIENT_ID === '' || out.identity.commonName !== env.LEADS_ACCESS_CLIENT_ID) {
    console.warn('leads door refused: a service token that is not the door’s')
    return refuse(403, 'Forbidden')
  }
  if (route.forward !== '/api/leads') return refuse(404, 'Not found')
  if (req.method.toUpperCase() !== 'POST') return refuse(405, 'Method not allowed')
  if (!face) return refuse(503, 'Email is not connected to the space, so no lead can be kept')
  try {
    const body = await bodyOf(req)
    if (!body.ok) return body.response
    const parsed = parseLeadBody(body.value)
    if (!parsed.ok) return refuse(400, parsed.message, { reason: 'bad-request' })
    const r = await face(parsed.value)
    if (r.ok) return Response.json({ value: r.value }, { headers: NO_STORE })
    return r.kind === 'refused' ? refuse(STATUS[r.reason], r.message, { reason: r.reason }) : refuse(500, r.message, { reason: r.reason })
  } catch (error) {
    console.error('leads door failed', error)
    return refuse(500, 'The lead could not be kept. Nothing was changed.')
  }
}
