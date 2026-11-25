/**
 * The texts bridge's door: the inbox's router for the one machine that pushes the owner's texts into it, as a function.
 *
 * Like Claude's door (`createApp` in src/app.ts) and the Telegram bridge's (src/telegram/app.ts) it runs IN THE SPACE'S WORKER and verifies nothing: the space checked the Access assertion once, for the audience of the
 * Access application on the bridge's path (`space-texts-access`: a service token only, packages/space/src/texts.ts), and handed this router the token it verified (`Deps.named`, put in a WeakMap keyed by the Request).
 * What is left is the inbox's own rule: only the bridge's token, by its id (`TEXTS_ACCESS_CLIENT_ID`, a var of the space), is admitted. Claude's token and the Telegram bridge's are refused here, and this token is
 * refused on theirs: each machine has its own token on its own path (packages/workspace/docs/adr/0002, amended).
 *
 * It serves five calls and nothing else (src/texts/wire.ts): push, events, work, outcomes and status. No page, no file out, no read of mail, nothing of Claude's.
 */

import { type Context, Hono } from 'hono'
import type { ServiceIdentity, StoreApi } from '../app'
import type { Result } from '../store/store'
import { LIMITS, parseEvents, parseOutcomes, parsePush, parseStatus, parseWorkRequest } from './wire'

export interface TextsEnv {
  /** The Access client id of the bridge's service token (a var; an id is not a credential). Unset, the router admits nobody. */
  TEXTS_ACCESS_CLIENT_ID?: string
}

export interface TextsDeps {
  /** The store for this request: the Durable Object in production, a SQLite in tests. */
  store: (env: TextsEnv) => StoreApi
  /** Given by the space's Worker: the token its check verified for this very request. Absent or null, the answer is a 401. */
  named: (req: Request) => ServiceIdentity | null
}

const refuseBody = (error: string) => ({ error })

/** A store result as the answer: the value, or the refusal with its status. */
const answer = (c: Context, r: Result<unknown>) => (r.ok ? c.json(r.value) : c.json(refuseBody(r.error), r.status))

/** The five calls the door serves, by path. */
export const TEXTS_CALLS = ['/api/push', '/api/events', '/api/work', '/api/outcomes', '/api/status'] as const

export function createTextsApp(deps: TextsDeps) {
  const app = new Hono<{ Bindings: TextsEnv }>()

  // Nothing of ours may be framed and no answer may be kept: on every response, the refusals included.
  app.use('*', async (c, next) => {
    await next()
    const res = new Response(c.res.body, c.res)
    res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
    res.headers.set('X-Frame-Options', 'DENY')
    res.headers.set('Cache-Control', 'no-store')
    c.res = res
  })

  // EVERY request is checked: the bridge's token by its id, and nobody else.
  app.use('*', async (c, next) => {
    const identity = deps.named(c.req.raw)
    if (identity === null) return c.json(refuseBody('Present the service token.'), 401)
    const expected = (c.env.TEXTS_ACCESS_CLIENT_ID ?? '').trim().toLowerCase()
    if (expected === '' || identity.commonName !== expected) {
      console.warn('texts door: named but not the bridge')
      return c.json(refuseBody('This account has no access to the texts door.'), 403)
    }
    // The five calls and nothing else; the bridge sends nothing but POST.
    const path = new URL(c.req.url).pathname
    if (!(TEXTS_CALLS as readonly string[]).includes(path)) return c.json(refuseBody('Not found.'), 404)
    if (c.req.method !== 'POST') return c.json(refuseBody('Not found.'), 404)
    const origin = c.req.header('origin')
    if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(c.req.url).origin)) {
      return c.json(refuseBody('Cross-site write refused.'), 403)
    }
    return next()
  })

  /** The body as JSON, bounded: one request can never be the whole store. */
  const body = async (req: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> => {
    const raw = await req.text()
    if (raw.length > LIMITS.body) return { ok: false, error: 'The body is too large.' }
    try {
      return { ok: true, value: JSON.parse(raw) }
    } catch {
      return { ok: false, error: 'Expected a JSON object body.' }
    }
  }

  app.post('/api/push', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parsePush(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('pushTexts', parsed.value))
  })

  app.post('/api/events', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseEvents(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('textsEvents', parsed.value))
  })

  app.post('/api/work', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseWorkRequest(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('textsWork', parsed.value))
  })

  app.post('/api/outcomes', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseOutcomes(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('textsOutcomes', parsed.value))
  })

  app.post('/api/status', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseStatus(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('textsStatus', parsed.value))
  })

  app.all('*', (c) => c.json(refuseBody('Not found.'), 404))
  return app
}
