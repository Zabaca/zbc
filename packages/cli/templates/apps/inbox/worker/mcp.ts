import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type {
  Inbox,
  InsertMessage,
  MessageFull,
  MessageMeta,
  ScheduledMeta,
  ThreadMeta,
} from './inbox-do'
import { type SendEnv, performDraftSend, performSend } from './send-op'
import { makeSnippet, newId, normalizeMsgId } from './shared'

/**
 * MCP server over the inbox — the same operations as /api/*, exposed as
 * tools for MCP clients (Claude Code, claude.ai, etc.) at POST /mcp with
 * Streamable HTTP transport (cedarpad's pattern: stateless per request, a
 * fresh McpServer each call — workers isolates hold no session).
 *
 * Auth is the SAME bearer token as /api/* — the caller checks it before
 * invoking this, and MCP clients send it as a normal Authorization header.
 * Tools call the Durable Object stub directly (a Worker cannot fetch its
 * own routes), so this file is wiring, not logic.
 */

const text = (v: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
})

/** Unwrap a SendOutcome into MCP result-or-error. */
const outcome = (o: { status: number; body: Record<string, unknown> }) => {
  if (o.status >= 400) throw new Error(String(o.body.error ?? `failed (${o.status})`))
  return text(o.body)
}

/**
 * The DO surface the tools use, with plain Promise returns. The raw
 * DurableObjectStub<Inbox> type expands workers-types' recursive RPC
 * serialization generics inside every registerTool inference and trips
 * TS2589 — this narrow view is the same calls without the type machinery.
 */
interface InboxApi {
  list(
    limit: number,
    cursor?: string,
    label?: string,
  ): Promise<{ messages: MessageMeta[]; nextCursor: string | null }>
  listThreads(
    limit: number,
    cursor?: string,
  ): Promise<{ threads: ThreadMeta[]; nextCursor: string | null }>
  getThread(threadId: string): Promise<MessageFull[]>
  get(id: string): Promise<MessageFull | null>
  search(q: string, limit: number): Promise<MessageMeta[]>
  insert(msg: InsertMessage): Promise<{ threadId: string }>
  listDrafts(limit: number): Promise<MessageMeta[]>
  updateDraft(id: string, fields: Record<string, string>): Promise<boolean>
  listScheduled(limit: number): Promise<ScheduledMeta[]>
  cancelScheduled(id: string): Promise<boolean>
  delete(id: string): Promise<string | null>
}

interface McpDeps {
  env: SendEnv & { RAW: R2Bucket }
  stub: DurableObjectStub<Inbox>
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const { env } = deps
  const stub = deps.stub as unknown as InboxApi
  const server = new McpServer({ name: 'inbox', version: '1.0.0' })

  server.registerTool(
    'list_threads',
    {
      description:
        'List conversation threads, newest first. Each row is the latest message of its thread plus thread_count. Page with cursor = the last id from the previous page.',
      inputSchema: { limit: z.number().optional(), cursor: z.string().optional() },
    },
    async ({ limit, cursor }) => text(await stub.listThreads(limit ?? 50, cursor)),
  )
  server.registerTool(
    'read_thread',
    {
      description:
        'Read every message in a thread (oldest first) with full text/html bodies and attachment metadata.',
      inputSchema: { thread_id: z.string() },
    },
    async ({ thread_id }) => {
      const messages = await stub.getThread(thread_id)
      if (!messages.length) throw new Error('thread not found')
      return text({ messages })
    },
  )
  server.registerTool(
    'list_messages',
    {
      description:
        'List individual messages, newest first (both directions; drafts and scheduled excluded). Optional label filter (see labeling). Page with cursor.',
      inputSchema: {
        limit: z.number().optional(),
        cursor: z.string().optional(),
        label: z.string().optional(),
      },
    },
    async ({ limit, cursor, label }) => text(await stub.list(limit ?? 50, cursor, label)),
  )
  server.registerTool(
    'read_message',
    {
      description: 'Read one message by id: full bodies, headers, attachment metadata.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const msg = await stub.get(id)
      if (!msg) throw new Error('message not found')
      return text(msg)
    },
  )
  server.registerTool(
    'search_messages',
    {
      description: 'Keyword search over subject + text body (case-insensitive), newest first.',
      inputSchema: { q: z.string(), limit: z.number().optional() },
    },
    async ({ q, limit }) => text({ messages: await stub.search(q, limit ?? 50) }),
  )
  server.registerTool(
    'send_email',
    {
      description:
        'Send an email now, or pass send_at (ISO timestamp) to schedule it. from defaults to DEFAULT_FROM. To reply into an existing thread, pass in_reply_to = the message_id of the message being replied to.',
      inputSchema: {
        to: z.string(),
        subject: z.string(),
        text: z.string().optional(),
        html: z.string().optional(),
        from: z.string().optional(),
        in_reply_to: z.string().optional(),
        send_at: z.string().optional(),
      },
    },
    async (input) =>
      outcome(
        await performSend(env, deps.stub, {
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          from: input.from,
          inReplyTo: input.in_reply_to,
          sendAt: input.send_at,
        }),
      ),
  )
  server.registerTool(
    'create_draft',
    {
      description:
        'Store an outbound draft without sending. All fields optional — completeness is checked at send_draft time.',
      inputSchema: {
        to: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        from: z.string().optional(),
        in_reply_to: z.string().optional(),
      },
    },
    async (input) => {
      const id = newId()
      const from = input.from ?? env.DEFAULT_FROM ?? ''
      const bodyText = input.text ?? ''
      await stub.insert({
        id,
        status: 'draft',
        direction: 'outbound',
        in_reply_to: normalizeMsgId(input.in_reply_to),
        message_id: `${id}@${from.split('@')[1] || 'localhost'}`,
        from_addr: from,
        to_addr: input.to ?? '',
        subject: input.subject ?? '',
        date: new Date().toISOString(),
        snippet: makeSnippet(bodyText, input.html ?? ''),
        text_body: bodyText,
        html_body: input.html ?? '',
        r2_key: '',
        attachments_json: '[]',
        size: bodyText.length + (input.html?.length ?? 0),
      })
      return text({ ok: true, id, status: 'draft' })
    },
  )
  server.registerTool(
    'list_drafts',
    { description: 'List unsent drafts, newest first.' },
    async () => text({ drafts: await stub.listDrafts(50) }),
  )
  server.registerTool(
    'update_draft',
    {
      description: 'Update an unsent draft. Only the fields passed change.',
      inputSchema: {
        id: z.string(),
        to: z.string().optional(),
        subject: z.string().optional(),
        text: z.string().optional(),
        html: z.string().optional(),
        from: z.string().optional(),
        in_reply_to: z.string().optional(),
      },
    },
    async ({ id, ...input }) => {
      const updated = await stub.updateDraft(id, {
        ...(input.from !== undefined ? { from_addr: input.from } : {}),
        ...(input.to !== undefined ? { to_addr: input.to } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.text !== undefined ? { text_body: input.text } : {}),
        ...(input.html !== undefined ? { html_body: input.html } : {}),
        ...(input.in_reply_to !== undefined
          ? { in_reply_to: normalizeMsgId(input.in_reply_to) }
          : {}),
        ...(input.text !== undefined || input.html !== undefined
          ? { snippet: makeSnippet(input.text ?? '', input.html ?? '') }
          : {}),
      })
      if (!updated) throw new Error('not a draft')
      return text({ ok: true, id })
    },
  )
  server.registerTool(
    'send_draft',
    {
      description: 'Send an existing draft (must have to, subject, and text or html).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => outcome(await performDraftSend(env, deps.stub, id)),
  )
  server.registerTool(
    'list_scheduled',
    {
      description:
        'List pending scheduled sends (and failed ones, with send_error), soonest first.',
    },
    async () => text({ scheduled: await stub.listScheduled(50) }),
  )
  server.registerTool(
    'cancel_scheduled',
    {
      description: 'Cancel a pending scheduled send (or dismiss a failed one). Deletes the row.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      if (!(await stub.cancelScheduled(id))) throw new Error('not a scheduled send')
      return text({ ok: true })
    },
  )
  server.registerTool(
    'delete_message',
    {
      description: 'Delete a message (any status) and its raw MIME blob.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const r2Key = await stub.delete(id)
      if (r2Key === null) throw new Error('message not found')
      if (r2Key) await env.RAW.delete(r2Key)
      return text({ ok: true })
    },
  )

  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  const app = new Hono()
  app.all('/mcp', (c) => transport.handleRequest(c))
  return app.fetch(request)
}
