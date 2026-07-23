import type { EncryptedDocument, SubmissionPayload } from './crypto'
import { requestPageHtml } from './page'

/**
 * The Secret Relay's request handler, deployment-agnostic: `createRelay()`
 * returns a plain fetch handler over a pluggable channel store. The worker
 * entrypoint wraps this in a Durable Object (storage-backed store); tests run
 * it directly over the in-memory default.
 *
 * The relay never sees plaintext — submissions are ciphertext encrypted to a
 * key it never receives (the channel public key lives in the URL fragment).
 */

const DEFAULT_TTL_SECONDS = 300

export interface Channel {
  keys: string[]
  reason?: string
  env?: string
  project?: string
  /** 'request' (masked key/value form) or 'editor' (YAML document editor) */
  mode?: 'request' | 'editor'
  /** editor mode: the document ciphertext, encrypted to the fragment key */
  document?: EncryptedDocument
  expiresAt: number
  submission?: SubmissionPayload | { document: EncryptedDocument }
}

export interface ChannelStore {
  get(id: string): Promise<Channel | undefined>
  put(id: string, channel: Channel): Promise<void>
  delete(id: string): Promise<void>
}

export function memoryStore(): ChannelStore {
  const channels = new Map<string, Channel>()
  return {
    async get(id) {
      return channels.get(id)
    },
    async put(id, channel) {
      channels.set(id, channel)
    },
    async delete(id) {
      channels.delete(id)
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function createRelay(store: ChannelStore = memoryStore()): {
  fetch(req: Request): Promise<Response>
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const parts = url.pathname.split('/').filter(Boolean)

      // POST /channels — open a channel
      if (req.method === 'POST' && url.pathname === '/channels') {
        const body = (await req.json()) as {
          keys?: string[]
          reason?: string
          env?: string
          mode?: 'request' | 'editor'
          document?: EncryptedDocument
          ttlSeconds?: number
        }
        const id = crypto.randomUUID()
        await store.put(id, {
          keys: body.keys ?? [],
          reason: body.reason,
          env: body.env,
          mode: body.mode ?? 'request',
          document: body.document,
          expiresAt: Date.now() + (body.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000,
        })
        return json({ id })
      }

      if (parts[0] === 'channels' && (parts.length === 2 || parts.length === 3) && parts[1]) {
        const id = parts[1]
        const channel = await store.get(id)
        if (channel && Date.now() >= channel.expiresAt) {
          await store.delete(id)
          return json({ error: 'channel expired' }, 410)
        }
        if (!channel) return json({ error: 'no such channel' }, 404)

        // GET /channels/:id — the request page the human opens
        if (req.method === 'GET' && parts.length === 2) {
          return new Response(requestPageHtml(), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }

        // GET /channels/:id/meta — what the page renders
        if (req.method === 'GET' && parts[2] === 'meta') {
          return json({
            keys: channel.keys,
            reason: channel.reason,
            env: channel.env,
            mode: channel.mode ?? 'request',
          })
        }

        // GET /channels/:id/document — editor mode: the ciphertext to edit
        if (req.method === 'GET' && parts[2] === 'document') {
          if (!channel.document) return json({ error: 'no document on this channel' }, 404)
          return json(channel.document)
        }

        // POST /channels/:id/submission — browser submits ciphertext, once
        if (req.method === 'POST' && parts[2] === 'submission') {
          if (channel.submission) return json({ error: 'already submitted' }, 409)
          channel.submission = (await req.json()) as SubmissionPayload
          await store.put(id, channel)
          return json({ ok: true })
        }

        // GET /channels/:id/submission — CLI collects the ciphertext; the
        // channel dies on first read (single-use)
        if (req.method === 'GET' && parts[2] === 'submission') {
          if (!channel.submission) return json({ error: 'not yet submitted' }, 404)
          await store.delete(id)
          return json(channel.submission)
        }
      }

      return json({ error: 'not found' }, 404)
    },
  }
}
