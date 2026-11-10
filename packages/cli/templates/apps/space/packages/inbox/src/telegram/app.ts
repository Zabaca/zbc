/**
 * The Telegram bridge's door: the inbox's router for the one machine that pushes the owner's Telegram into it, as a function.
 *
 * Like Claude's door (`createApp` in src/app.ts) it runs IN THE SPACE'S WORKER and verifies nothing: the space checked the Access assertion once, for the audience of the
 * Access application on the bridge's path (`space-telegram-access`: a service token only, packages/space/src/telegram.ts), and handed this router the token it verified
 * (`Deps.named`, put in a WeakMap keyed by the Request). What is left is the inbox's own rule: only the bridge's token, by its id (`TELEGRAM_ACCESS_CLIENT_ID`, a var of the
 * space), is admitted. Claude's token is refused here, and the bridge's token is refused on Claude's door: each machine has its own token on its own path
 * (packages/workspace/docs/adr/0002, amended).
 *
 * It serves seven calls and nothing else (src/telegram/wire.ts): push, events, work, outcomes, status, media, which takes one photo or voice note's bytes for a message the space asked for, and
 * picture, which gives the bridge the one picture of a send it is being offered. No page, no other file out, no read of mail, nothing of Claude's.
 */

import { type Context, Hono } from 'hono'
import type { ServiceIdentity, StoreApi } from '../app'
import type { Result } from '../store/store'
import {
  LIMITS,
  parseEvents,
  parseMediaQuery,
  parseOutcomes,
  parsePictureQuery,
  parsePush,
  parseStatus,
  parseWorkRequest,
  TELEGRAM_SMALL_FILE_MAX_BYTES,
  TELEGRAM_VIDEO_MAX_BYTES,
} from './wire'

export interface TelegramEnv {
  /** The Access client id of the bridge's service token (a var; an id is not a credential). Unset, the router admits nobody. */
  TELEGRAM_ACCESS_CLIENT_ID?: string
}

export interface TelegramDeps {
  /** The store for this request: the Durable Object in production, a SQLite in tests. */
  store: (env: TelegramEnv) => StoreApi
  /** Given by the space's Worker: the token its check verified for this very request. Absent or null, the answer is a 401. */
  named: (req: Request) => ServiceIdentity | null
}

const refuseBody = (error: string) => ({ error })

/** The most any one file may weigh at the door, whatever its kind: the larger of the two limits. The door refuses past it before it reads a byte; the keeper then holds the file to its own kind's limit. */
const MOST_BYTES = Math.max(TELEGRAM_SMALL_FILE_MAX_BYTES, TELEGRAM_VIDEO_MAX_BYTES)

/** A body read to its end into memory, or null as soon as it passes `max` bytes (the rest is not read). */
async function readUpTo(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A store result as the answer: the value, or the refusal with its status. */
const answer = (c: Context, r: Result<unknown>) => (r.ok ? c.json(r.value) : c.json(refuseBody(r.error), r.status))

export function createTelegramApp(deps: TelegramDeps) {
  const app = new Hono<{ Bindings: TelegramEnv }>()

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
    const expected = (c.env.TELEGRAM_ACCESS_CLIENT_ID ?? '').trim().toLowerCase()
    if (expected === '' || identity.commonName !== expected) {
      console.warn('telegram door: named but not the bridge')
      return c.json(refuseBody('This account has no access to the Telegram door.'), 403)
    }
    // The seven calls and nothing else; the bridge sends nothing but POST.
    const path = new URL(c.req.url).pathname
    if (
      !['/api/push', '/api/events', '/api/work', '/api/outcomes', '/api/status', '/api/media', '/api/picture'].includes(
        path,
      )
    )
      return c.json(refuseBody('Not found.'), 404)
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
    return answer(c, await deps.store(c.env).call('pushTelegram', parsed.value))
  })

  app.post('/api/events', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseEvents(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('telegramEvents', parsed.value))
  })

  app.post('/api/work', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseWorkRequest(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('telegramWork', parsed.value))
  })

  app.post('/api/outcomes', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseOutcomes(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('telegramOutcomes', parsed.value))
  })

  app.post('/api/status', async (c) => {
    const raw = await body(c.req.raw)
    if (!raw.ok) return c.json(refuseBody(raw.error), 400)
    const parsed = parseStatus(raw.value)
    if (!parsed.ok) return c.json(refuseBody(parsed.error), 422)
    return answer(c, await deps.store(c.env).call('telegramStatus', parsed.value))
  })

  // A photo, a voice note, a picture or a video the space asked for (an `owed` item of kind `media`): the file is the body, and the query says whose it is. The store keeps it only for a message it is waiting on.
  //
  // The body is NOT read here. A video is up to 50 MB; a Durable Object's RPC carries 32 MiB at most and the Worker holds 128 MB with everything else in it, so the body goes on as the stream it arrived as and the
  // bucket takes it from the stream. That needs its length first (R2 writes a stream only of a known length): the bridge's `Content-Length`, which the keeper then holds the stream to, byte for byte. A request
  // with none (a proxy that sent it chunked) is read up to the small files' limit in memory, which is all a photo, a voice note or a picture can be, and a larger one is refused (411); one past the largest limit of
  // any kind is refused before a byte is read (413), and the keeper holds it to the limit of the file's own kind.
  app.post('/api/media', async (c) => {
    const q = parseMediaQuery({ account: c.req.query('account'), chat: c.req.query('chat'), id: c.req.query('id') })
    if (!q.ok) return c.json(refuseBody(q.error), 422)
    const declared = c.req.header('content-length')
    let length = declared !== undefined && /^\d{1,12}$/.test(declared) ? Number(declared) : null
    if (length !== null && length > MOST_BYTES) {
      return c.json(refuseBody('The file is larger than the inbox copies.'), 413)
    }
    let body: ReadableStream<Uint8Array> | null = c.req.raw.body
    if (!body) return c.json(refuseBody('Expected the file as the body.'), 400)
    if (length === null) {
      const small = await readUpTo(body, TELEGRAM_SMALL_FILE_MAX_BYTES)
      if (small === null) return c.json(refuseBody('Send the length of the file.'), 411)
      length = small.length
      body = new Response(small as unknown as BodyInit).body as ReadableStream<Uint8Array>
    }
    return answer(c, await deps.store(c.env).call('keepTelegramMedia', { ...q.value, body, length }))
  })

  // The picture of a send the bridge is being offered: the one call that gives a file OUT. The query names the account, the send and the random id the bridge was offered it under; the store answers
  // only while that very send is owed, carries a picture, was offered and may still be offered (`telegramPictureFor`), and anything else is a refusal after which the bridge sends nothing. The answer is the
  // bytes, as the type the inbox sniffed them to be, and changes nothing (an unfollowed call). Claude's door has no such route.
  app.post('/api/picture', async (c) => {
    const q = parsePictureQuery({
      account: c.req.query('account'),
      message: c.req.query('message'),
      random: c.req.query('random'),
    })
    if (!q.ok) return c.json(refuseBody(q.error), 422)
    const got = await deps.store(c.env).call('readTelegramPicture', q.value)
    if (!got.ok) return c.json(refuseBody(got.error), got.status)
    return new Response(got.value.bytes as unknown as BodyInit, {
      headers: { 'content-type': got.value.type, 'content-length': String(got.value.bytes.length) },
    })
  })

  app.all('*', (c) => c.json(refuseBody('Not found.'), 404))
  return app
}
