import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Hono } from 'hono'
import { z } from 'zod'
import * as commands from './commands'
import type { SendEnv } from './commands'
import type { InboxStore } from './inbox-do'

/**
 * MCP server over the inbox — the same operations as /api/*, exposed as
 * tools for MCP clients (Claude Code, claude.ai, etc.) at POST /mcp with
 * Streamable HTTP transport (cedarpad's pattern: stateless per request, a
 * fresh McpServer each call — workers isolates hold no session).
 *
 * Auth is the SAME bearer token as /api/* — the caller checks it before
 * invoking this, and MCP clients send it as a normal Authorization header.
 *
 * This file is wiring, not logic: every mutation is a call into `commands.ts`
 * — the same function `api.ts` calls — and every read is a single `store.*`
 * call. Nothing here decides what a mutation does.
 */

const text = (v: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
})

/** Unwrap a command Outcome into MCP result-or-error. */
const outcome = (o: { status: number; body: Record<string, unknown> }) => {
  if (o.status >= 400) throw new Error(String(o.body.error ?? `failed (${o.status})`))
  return text(o.body)
}

interface McpDeps {
  env: SendEnv & { RAW: R2Bucket }
  store: InboxStore
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const { env, store } = deps
  const server = new McpServer({ name: 'inbox', version: '1.0.0' })

  server.registerTool(
    'list_threads',
    {
      description:
        'List conversation threads, newest first. Each row is the latest message of its thread plus thread_count. Page with cursor = the last id from the previous page.',
      inputSchema: { limit: z.number().optional(), cursor: z.string().optional() },
    },
    async ({ limit, cursor }) => text(await store.listThreads(limit ?? 50, cursor)),
  )
  server.registerTool(
    'read_thread',
    {
      description:
        'Read every message in a thread (oldest first) with full text/html bodies and attachment metadata.',
      inputSchema: { thread_id: z.string() },
    },
    async ({ thread_id }) => {
      const messages = await store.getThread(thread_id)
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
    async ({ limit, cursor, label }) => text(await store.list(limit ?? 50, cursor, label)),
  )
  server.registerTool(
    'read_message',
    {
      description: 'Read one message by id: full bodies, headers, attachment metadata.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const msg = await store.get(id)
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
    async ({ q, limit }) => text({ messages: await store.search(q, limit ?? 50) }),
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
        await commands.send(env, store, {
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
    async (input) =>
      outcome(
        await commands.createDraft(env, store, {
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          from: input.from,
          inReplyTo: input.in_reply_to,
        }),
      ),
  )
  server.registerTool(
    'list_drafts',
    { description: 'List unsent drafts, newest first.' },
    async () => text({ drafts: await store.listDrafts(50) }),
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
    async ({ id, ...input }) =>
      outcome(
        await commands.updateDraft(store, id, {
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          from: input.from,
          inReplyTo: input.in_reply_to,
        }),
      ),
  )
  server.registerTool(
    'send_draft',
    {
      description: 'Send an existing draft (must have to, subject, and text or html).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => outcome(await commands.sendDraft(env, store, id)),
  )
  server.registerTool(
    'list_scheduled',
    {
      description:
        'List pending scheduled sends (and failed ones, with send_error), soonest first.',
    },
    async () => text({ scheduled: await store.listScheduled(50) }),
  )
  server.registerTool(
    'cancel_scheduled',
    {
      description: 'Cancel a pending scheduled send (or dismiss a failed one). Deletes the row.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => outcome(await commands.cancelScheduled(store, id)),
  )
  server.registerTool(
    'delete_message',
    {
      description: 'Delete a message (any status) and its raw MIME blob.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const result = await commands.deleteMessage(env, store, id)
      // The one place an adapter renders a command's error in its own words:
      // this tool has always said 'message not found' where the JSON route
      // says 'not found', and MCP clients see the string. The command decides
      // WHETHER it is a 404; the tool only spells it.
      if (result.status === 404) throw new Error('message not found')
      return outcome(result)
    },
  )

  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  const app = new Hono()
  app.all('/mcp', (c) => transport.handleRequest(c))
  return app.fetch(request)
}
