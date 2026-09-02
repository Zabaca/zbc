/**
 * The JSON adapter: bearer-authed `/api/*` over the Inbox. One of the two
 * adapters (the other is `mcp.ts`) — it parses HTTP, calls a command or a
 * read, and renders the result. No mutation logic lives here.
 *
 * It is a module rather than a block inside `index.ts` for the same reason
 * `handleMcp` is: `index.ts` is the Workers entry and imports the Inbox
 * Durable Object, which imports `cloudflare:workers` — a specifier bun cannot
 * resolve, so a test can never load it. Everything here reaches the DO through
 * the `InboxStore` interface, so `worker/commands.test.ts` can drive both
 * adapters against the same in-memory fake.
 */
import PostalMime from 'postal-mime'
import * as commands from './commands'
import type { DraftBody, SendBody, SendEnv } from './commands'
import type { InboxStore } from './inbox-do'

export interface ApiEnv extends SendEnv {
  RAW: R2Bucket
}

export interface ApiDeps {
  env: ApiEnv
  store: InboxStore
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const { env, store } = deps
  const url = new URL(request.url)
  const { pathname } = url

  // GET /api/messages?limit=&cursor=&label=
  if (pathname === '/api/messages' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const cursor = url.searchParams.get('cursor') ?? undefined
    const label = url.searchParams.get('label') ?? undefined
    return json(await store.list(Number.isFinite(limit) ? limit : 50, cursor, label))
  }

  // GET /api/search?q=&limit= — keyword match over subject + text body
  if (pathname === '/api/search' && request.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    if (!q.trim()) return json({ error: 'required: q' }, 400)
    const limit = Number(url.searchParams.get('limit') ?? '50')
    return json({ messages: await store.search(q.trim(), Number.isFinite(limit) ? limit : 50) })
  }

  // GET /api/threads?limit=&cursor= — newest-first, one row per thread
  if (pathname === '/api/threads' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const cursor = url.searchParams.get('cursor') ?? undefined
    return json(await store.listThreads(Number.isFinite(limit) ? limit : 50, cursor))
  }

  // GET /api/threads/:id — all messages in the thread, oldest-first
  const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/)
  if (threadMatch && request.method === 'GET') {
    const messages = await store.getThread(threadMatch[1]!)
    return messages.length ? json({ messages }) : json({ error: 'not found' }, 404)
  }

  // POST /api/send — immediate, or queued for the DO alarm when sendAt set
  if (pathname === '/api/send' && request.method === 'POST') {
    let body: SendBody
    try {
      body = (await request.json()) as SendBody
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }
    const outcome = await commands.send(env, store, body)
    return json(outcome.body, outcome.status)
  }

  // GET /api/scheduled — pending + failed scheduled sends, soonest first
  if (pathname === '/api/scheduled' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    return json({ scheduled: await store.listScheduled(Number.isFinite(limit) ? limit : 50) })
  }

  // DELETE /api/scheduled/:id — cancel a pending (or dismiss a failed) send
  const schedMatch = pathname.match(/^\/api\/scheduled\/([^/]+)$/)
  if (schedMatch && request.method === 'DELETE') {
    const outcome = await commands.cancelScheduled(store, schedMatch[1]!)
    return json(outcome.body, outcome.status)
  }

  // POST /api/drafts — store an outbound message without sending it
  if (pathname === '/api/drafts' && request.method === 'POST') {
    let body: DraftBody
    try {
      body = (await request.json()) as DraftBody
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }
    const outcome = await commands.createDraft(env, store, body)
    return json(outcome.body, outcome.status)
  }

  // GET /api/drafts
  if (pathname === '/api/drafts' && request.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    return json({ drafts: await store.listDrafts(Number.isFinite(limit) ? limit : 50) })
  }

  // PUT /api/drafts/:id | POST /api/drafts/:id/send
  const draftMatch = pathname.match(/^\/api\/drafts\/([^/]+)(\/send)?$/)
  if (draftMatch) {
    const [, draftId, sendSuffix] = draftMatch

    if (!sendSuffix && request.method === 'PUT') {
      let body: DraftBody
      try {
        body = (await request.json()) as DraftBody
      } catch {
        return json({ error: 'invalid JSON body' }, 400)
      }
      const outcome = await commands.updateDraft(store, draftId!, body)
      return json(outcome.body, outcome.status)
    }

    if (sendSuffix && request.method === 'POST') {
      const outcome = await commands.sendDraft(env, store, draftId!)
      return json(outcome.body, outcome.status)
    }
    if (!sendSuffix && request.method === 'GET') {
      const draft = await store.get(draftId!)
      return draft && draft.status === 'draft' ? json(draft) : json({ error: 'not a draft' }, 404)
    }
    // Deliberately NOT commands.deleteMessage: this route deletes drafts and
    // only drafts, refusing anything else, where the command deletes a row of
    // any status. Two different operations that happen to share a verb.
    if (!sendSuffix && request.method === 'DELETE') {
      const draft = await store.get(draftId!)
      if (!draft || draft.status !== 'draft') return json({ error: 'not a draft' }, 404)
      await store.delete(draftId!)
      return json({ ok: true })
    }
  }

  // GET /api/messages/:id/attachments/:n — raw bytes of one attachment.
  // Re-parses the R2 MIME blob per request (cheap at the 5 MiB cap) rather
  // than pre-splitting attachments at write time.
  const attMatch = pathname.match(/^\/api\/messages\/([^/]+)\/attachments\/(\d+)$/)
  if (attMatch && request.method === 'GET') {
    const msg = await store.get(attMatch[1]!)
    if (!msg) return json({ error: 'not found' }, 404)
    if (!msg.r2_key) return json({ error: 'no raw MIME (outbound message)' }, 404)
    const obj = await env.RAW.get(msg.r2_key)
    if (!obj) return json({ error: 'raw MIME missing from R2' }, 404)
    const parsed = await PostalMime.parse(await obj.arrayBuffer())
    const n = Number(attMatch[2])
    const att = (parsed.attachments ?? [])[n]
    if (!att) return json({ error: `no attachment at index ${n}` }, 404)
    const body =
      typeof att.content === 'string' ? new TextEncoder().encode(att.content) : att.content
    return new Response(body, {
      headers: {
        'content-type': att.mimeType || 'application/octet-stream',
        'content-disposition': `attachment; filename="${(att.filename ?? 'attachment').replace(/["\r\n]/g, '')}"`,
        'cache-control': 'no-store',
      },
    })
  }

  // /api/messages/:id[/raw]
  const match = pathname.match(/^\/api\/messages\/([^/]+)(\/raw)?$/)
  if (match) {
    const [, id, rawSuffix] = match

    if (rawSuffix && request.method === 'GET') {
      const msg = await store.get(id!)
      if (!msg) return json({ error: 'not found' }, 404)
      if (!msg.r2_key) return json({ error: 'no raw MIME (outbound message)' }, 404)
      const obj = await env.RAW.get(msg.r2_key)
      if (!obj) return json({ error: 'raw MIME missing from R2' }, 404)
      return new Response(obj.body, {
        headers: { 'content-type': 'message/rfc822', 'cache-control': 'no-store' },
      })
    }

    if (!rawSuffix && request.method === 'GET') {
      const msg = await store.get(id!)
      return msg ? json(msg) : json({ error: 'not found' }, 404)
    }

    if (!rawSuffix && request.method === 'DELETE') {
      const outcome = await commands.deleteMessage(env, store, id!)
      return json(outcome.body, outcome.status)
    }
  }

  return json({ error: 'not found' }, 404)
}
