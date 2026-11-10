/**
 * The Worker's one public entrance: Gmail's push, and the mail server's, at the install's push host (`inbox-push.northfield.example`).
 *
 * Pub/Sub cannot sign in to Access, so Google's push arrives on a hostname of its own that no Access application covers. On THAT hostname the
 * Worker answers the push path and nothing else: any other path or method is a 404, and nothing else is served on any hostname at all. This is
 * the whole of what the Worker's `fetch` does outside `vite dev`: there is no page and no address
 * for people (the inbox's team-facing part runs in the space's Worker, in-process). It accepts the push only with a
 * Google-signed token for the push service account and this endpoint (gmail/push.ts), and when the settings are unset there is no push hostname at all
 * (every POST to the path is refused). The hostname is recognised by the install's push host as well as by the setting, so a deploy with the setting
 * missing still refuses everything there. A request on any other hostname, the inbox's retired address included, is a 404 and reaches nothing.
 */

import { Hono } from 'hono'
import type { JWTVerifyGetKey } from 'jose'
import type { Env, StoreApi } from './app'
import { PUSH_PATH, pushedAddress, pushSettings, verifyPush } from './gmail/push'
import { bundledInstall } from './workspace'

/** A push is a few hundred bytes. Anything bigger is not read. */
const MAX_PUSH_BODY = 64 * 1024

/** The mail server's push path: `/api/jmap/push/<mailbox id>/<token>` (src/jmap/room.ts `PUSH_PATH_PREFIX`), and nothing else on any hostname is answered besides Gmail's. */
const JMAP_PUSH_PATH = /^\/api\/jmap\/push\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{32,128})$/

export interface PushDeps {
  /** The store for this request. The Durable Object in production, a SQLite in tests. */
  store: (env: Env) => StoreApi
  /** Google's signing keys, for the push. Injected so tests serve their own and need no network. */
  pushKeys?: JWTVerifyGetKey
  /** The install's push hostname (`Install.gmailPushHost()`), which this door answers whether or not the settings are there; null where the install has no Gmail. The bundle's by default. */
  pushHost?: string | null
}

/** The mail server's push: the body is read only if it does not say it is too big, parsed if it is JSON, and handed on; whatever it says is a hint. */
async function receiveJmap(
  env: Env,
  deps: PushDeps,
  req: { header(name: string): string | undefined; text(): Promise<string> },
  mailboxId: string,
  token: string,
): Promise<Response> {
  const declared = Number(req.header('content-length') ?? '0')
  const raw = declared > MAX_PUSH_BODY ? '' : await req.text()
  let body: unknown = null
  try {
    body = raw.length > 0 && raw.length <= MAX_PUSH_BODY ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  const accepted = await deps.store(env).call('receiveJmapPush', mailboxId, token, body)
  return accepted ? new Response(null, { status: 204 }) : Response.json({ error: 'Not found.' }, { status: 404 })
}

export function createPushApp(deps: PushDeps) {
  const app = new Hono<{ Bindings: Env }>()

  // Nothing of ours may be framed or kept: the same two headers on every answer, refusals included.
  app.use('*', async (c, next) => {
    await next()
    const res = new Response(c.res.body, c.res)
    res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
    res.headers.set('X-Frame-Options', 'DENY')
    res.headers.set('Cache-Control', 'no-store')
    c.res = res
  })

  app.all('*', async (c) => {
    const push = pushSettings(c.env)
    const url = new URL(c.req.url)
    const installHost = deps.pushHost === undefined ? bundledInstall.gmailPushHost() : deps.pushHost
    const host = push.ok ? push.host : installHost
    if (host === null || (url.hostname !== host && url.hostname !== installHost))
      return c.json({ error: 'Not found.' }, 404)
    // The mail server's push (a JMAP mailbox): the one other path this hostname answers, naming the mailbox and carrying the random token the inbox kept when it made the
    // subscription. A wrong token or a mailbox that is none is a 404, exactly as any other path is, so the door says nothing about which mailboxes exist. What the server sends is a hint (a verification code for the
    // subscription the inbox made, or "something changed"), and the answer is given at once; the work is the alarm's.
    const jmap = JMAP_PUSH_PATH.exec(url.pathname)
    if (jmap && c.req.method === 'POST') return receiveJmap(c.env, deps, c.req, jmap[1] as string, jmap[2] as string)
    const path = push.ok ? push.path : PUSH_PATH
    if (c.req.method !== 'POST' || url.pathname !== path) return c.json({ error: 'Not found.' }, 404)

    const outcome = await verifyPush(c.env, c.req.raw, deps.pushKeys)
    if (!outcome.ok) {
      console.warn(`push refused: ${outcome.detail}`)
      return c.json({ error: 'Refused.' }, 401)
    }
    // Past this point the push is Google's, and it is still only a hint. Whatever is wrong with its body, it is acknowledged: a refusal would only make
    // Pub/Sub send the same thing again. An error from the store is a 500, which is right: that one SHOULD be retried.
    const raw = await c.req.text()
    let body: unknown = null
    try {
      body = raw.length <= MAX_PUSH_BODY ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    await deps.store(c.env).call('receivePush', pushedAddress(body))
    return c.body(null, 204)
  })

  return app
}
