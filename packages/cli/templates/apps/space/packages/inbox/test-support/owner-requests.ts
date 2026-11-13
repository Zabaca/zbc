import { text } from '../src/store/store'
import { isWhole, SEND_FIELDS, SEND_NAMES_NO_TEXT } from '../src/types'
import { AGENT, asHttp, type harness, ownerDraft } from './harness'
import { OWNER_EMAIL } from './owner'

/**
 * Tessa's side of the inbox's rules, driven the way his requests used to reach them: the owner has no router any more (the space
 * calls the entrypoint, and Claude's door admits Claude alone), so a test that wants "Tessa did this" calls the same store, Mailroom or Assistant method the deleted route
 * called, with `OWNER_EMAIL` as the actor, and the arguments the route passed. Answers `{ status, json }` as the route did, so a test keeps its assertions on both.
 *
 * It is a table from (method, path) to a call, and nothing more: the rules are the store's. The few the route itself held (a revision that is not whole, a body that names
 * more than a send may carry, a switch that is not a boolean) are kept here exactly as the route had them, so a test of the store's refusal is not pre-empted by a refusal
 * the route made first; a test OF one of those checks belongs on Claude's door, where the route still is, or on the space's method.
 *
 * Reads (GET) go to Claude's door as the agent: they are the same reads for either.
 */

type H = ReturnType<typeof harness>
type Answer = { status: number; json: any; headers?: Headers; text?: string }
type Call = (name: string, ...args: unknown[]) => Promise<Answer>
type Body = Record<string, any>
type Handler = (id: string, b: Body, call: Call, query: URLSearchParams, kind: string) => Promise<Answer> | Answer

const NEEDS_REV = 'Say which version of the draft you were shown: the rev `drafts` printed for it. Nothing was changed.'
const NEEDS_BOOLEAN = 'Say which: {"enabled": true} or {"enabled": false}.'
const NEEDS_SENT = 'Say whether it went out: {"sent": true} or {"sent": false}.'
const sendsOnly = (b: Body) => Object.keys(b).every((k) => (SEND_FIELDS as readonly string[]).includes(k))
const whole = (v: unknown) => (isWhole(v) ? v : null)
const refuse = (status: number, error: string): Answer => ({ status, json: { error } })

function editDraft(id: string, b: Body, call: Call): Promise<Answer> | Answer {
  if (!isWhole(b.rev)) return refuse(422, NEEDS_REV)
  const patch: Record<string, unknown> = { rev: b.rev }
  for (const key of ['subject', 'body', 'why'] as const) if (key in b) patch[key] = text(b[key])
  if (typeof b.copyEveryone === 'boolean') patch.copyEveryone = b.copyEveryone
  if (b.cc !== undefined) patch.cc = b.cc
  return call('updateDraft', id, patch, OWNER_EMAIL)
}

function deleteDraft(id: string, call: Call, query: URLSearchParams): Promise<Answer> | Answer {
  const given = query.get('rev') ?? ''
  if (!/^\d+$/.test(given)) return refuse(422, NEEDS_REV)
  return call('deleteDraft', id, OWNER_EMAIL, Number(given))
}

function sendDraft(id: string, b: Body, call: Call): Promise<Answer> | Answer {
  if (!sendsOnly(b)) return refuse(422, SEND_NAMES_NO_TEXT)
  return call(
    'sendDraft',
    id,
    { rev: whole(b.rev), through: whole(b.through), instruction: b.instruction },
    OWNER_EMAIL,
  )
}

function markSent(id: string, b: Body, call: Call): Promise<Answer> {
  const sentAt = typeof b.sentAt === 'string' && b.sentAt !== '' ? b.sentAt : undefined
  return call('markSent', id, sentAt, OWNER_EMAIL)
}

function resolveSend(id: string, b: Body, call: Call): Promise<Answer> | Answer {
  if (typeof b.sent !== 'boolean') return refuse(422, NEEDS_SENT)
  return call('resolveSend', id, b.sent, OWNER_EMAIL)
}

function chat(id: string, b: Body, call: Call): Promise<Answer> {
  const asked = {
    instruction: text(b.instruction),
    draftId: typeof b.draftId === 'string' ? b.draftId : null,
    rev: b.rev,
    body: b.body,
    subject: b.subject,
  }
  return call('chat', id, asked, OWNER_EMAIL)
}

function closeOrReopen(id: string, kind: string, b: Body, call: Call): Promise<Answer> {
  return call('changeConversation', id, kind, OWNER_EMAIL, Number.isInteger(b.through) ? b.through : null)
}

function setSwitch(
  method: 'setClaudeSending' | 'setAssistant',
  id: string | null,
  b: Body,
  call: Call,
): Promise<Answer> | Answer {
  if (typeof b.enabled !== 'boolean') return refuse(422, NEEDS_BOOLEAN)
  return id === null ? call(method, b.enabled, OWNER_EMAIL) : call(method, id, b.enabled, OWNER_EMAIL)
}

/** Each owner route that was deleted (the ones that remain are Claude's, and go through `h.request`): its verb, its path, and the call it made. The first capture is the id the path names; `kind` is a second one (close or reopen). */
const ROUTES: [string, RegExp, Handler][] = [
  ['PATCH', /^\/api\/drafts\/([^/]+)$/, (id, b, call) => editDraft(id, b, call)],
  ['DELETE', /^\/api\/drafts\/([^/]+)$/, (id, _b, call, query) => deleteDraft(id, call, query)],
  ['POST', /^\/api\/drafts\/([^/]+)\/send$/, (id, b, call) => sendDraft(id, b, call)],
  ['POST', /^\/api\/messages\/([^/]+)\/mark-sent$/, (id, b, call) => markSent(id, b, call)],
  ['POST', /^\/api\/messages\/([^/]+)\/unmark-sent$/, (id, _b, call) => call('unmarkSent', id, OWNER_EMAIL)],
  ['POST', /^\/api\/messages\/([^/]+)\/resolve-send$/, (id, b, call) => resolveSend(id, b, call)],
  [
    'POST',
    /^\/api\/conversations\/([^/]+)\/(close|reopen)$/,
    (id, b, call, _q, kind) => closeOrReopen(id, kind, b, call),
  ],
  ['POST', /^\/api\/conversations\/([^/]+)\/chat$/, (id, b, call) => chat(id, b, call)],
  ['PUT', /^\/api\/settings\/(claude-sending)$/, (_id, b, call) => setSwitch('setClaudeSending', null, b, call)],
  ['PUT', /^\/api\/mailboxes\/([^/]+)\/assistant$/, (id, b, call) => setSwitch('setAssistant', id, b, call)],
]

export async function ownerRequest(
  h: H,
  method: string,
  path: string,
  body?: Body,
  headers: Record<string, string> = {},
): Promise<Answer> {
  if (method === 'GET') return h.request(AGENT, method, path, body, headers)
  const b = body ?? {}
  if (method === 'POST' && path === '/api/drafts') return ownerDraft(h, b)

  const [route = '', query = ''] = path.split('?')
  const store = h.store as unknown as { call(method: string, ...args: unknown[]): Promise<unknown> }
  const call: Call = async (name, ...args) => asHttp(await store.call(name, ...args))
  for (const [verb, pattern, handler] of ROUTES) {
    const m = verb === method ? route.match(pattern) : null
    if (m) return handler(m[1] ?? '', b, call, new URLSearchParams(query), m[2] ?? '')
  }
  throw new Error(
    `ownerRequest has no call for ${method} ${path}: the route was deleted, so say what it did by calling the method`,
  )
}

/** `h.request(who, ...)` for a test that is parametrised by who acts: the owner by method calls, anyone else through Claude's door. */
export function as(
  h: H,
  who: Record<string, unknown> | null,
  method: string,
  path: string,
  body?: Body,
  headers: Record<string, string> = {},
) {
  if (who !== null && 'email' in who && who.email === OWNER_EMAIL) return ownerRequest(h, method, path, body, headers)
  return h.request(who, method, path, body, headers)
}
