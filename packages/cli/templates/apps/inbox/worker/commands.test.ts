/**
 * The inbox has one set of mutations and two adapters over them.
 *
 * This file is written as the contract for that sentence. Most of it exercises
 * `commands.ts` directly; the last block drives the SAME operation through
 * `handleApi` (the JSON routes) and `handleMcp` (the MCP tools) and asserts
 * they agree — that is the case that would fail if a future change edited one
 * adapter's copy of a mutation instead of the command.
 *
 * The fakes are hand-written and passed in explicitly (no mocking library, as
 * everywhere else in this repo): `fakeStore()` is an in-memory `InboxStore`,
 * `fakeEnv()` records what the Email binding and the R2 bucket were asked to
 * do. Neither `index.ts` nor `inbox-do.ts` is imported at runtime — they reach
 * for `cloudflare:workers`, which bun cannot resolve, which is exactly why the
 * two adapters are their own modules.
 */
import { describe, expect, test } from 'bun:test'
import { handleApi } from './api'
import * as commands from './commands'
import type { InboxStore, InsertMessage, MessageFull } from './inbox-do'
import { handleMcp } from './mcp'

const FROM = 'inbox@mail.example.com'

/**
 * A stored row: what `insert` was given, with the defaults the DO applies.
 * `status` widens past InsertMessage's because the DO's alarm can also leave a
 * row 'failed', and cancelScheduled has to treat that one as cancellable.
 */
type Row = Omit<InsertMessage, 'status'> & {
  status: 'draft' | 'scheduled' | 'sent' | 'failed'
  thread_id: string
}

interface FakeStore extends InboxStore {
  rows: Map<string, Row>
  seed(row: Partial<Row> & { id: string }): Row
}

/**
 * An in-memory InboxStore. It reproduces only the rules the commands depend
 * on: a draft is the only patchable/sendable row, `delete` distinguishes "no
 * such row" (null) from "no raw MIME" (''), and drafts/scheduled rows get no
 * thread until they are actually sent.
 */
function fakeStore(): FakeStore {
  const rows = new Map<string, Row>()
  return {
    rows,
    seed(row) {
      const full: Row = {
        message_id: '',
        from_addr: FROM,
        to_addr: 'someone@example.com',
        subject: '',
        date: '',
        snippet: '',
        text_body: '',
        html_body: '',
        r2_key: '',
        attachments_json: '[]',
        size: 0,
        direction: 'outbound',
        in_reply_to: '',
        status: 'sent',
        thread_id: row.id,
        ...row,
      } as Row
      rows.set(full.id, full)
      return full
    },
    insert(msg) {
      const status = msg.status ?? 'sent'
      const thread_id = status === 'sent' ? msg.id : ''
      rows.set(msg.id, { ...msg, status, thread_id })
      return { threadId: thread_id }
    },
    get(id) {
      const row = rows.get(id)
      return row
        ? ({ ...row, attachments: [], label: '', created_at: '' } as unknown as MessageFull)
        : null
    },
    updateDraft(id, fields) {
      const row = rows.get(id)
      if (!row || row.status !== 'draft') return false
      Object.assign(row, fields)
      return true
    },
    markDraftSent(id, date) {
      const row = rows.get(id)
      if (!row || row.status !== 'draft') return null
      row.status = 'sent'
      row.date = date
      row.thread_id = id
      return { threadId: id }
    },
    cancelScheduled(id) {
      const row = rows.get(id)
      if (!row || (row.status !== 'scheduled' && row.status !== 'failed')) return false
      rows.delete(id)
      return true
    },
    delete(id) {
      const row = rows.get(id)
      if (!row) return null
      rows.delete(id)
      return row.r2_key
    },
    list: () => ({ messages: [], nextCursor: null }),
    listThreads: () => ({ threads: [], nextCursor: null }),
    getThread: () => [],
    search: () => [],
    listDrafts: () => [],
    listScheduled: () => [],
  }
}

interface FakeEnv {
  DEFAULT_FROM?: string
  EMAIL: { send(message: Record<string, unknown>): Promise<void> }
  RAW: { delete(key: string): Promise<void>; get(key: string): Promise<null> }
  sent: Array<Record<string, unknown>>
  r2Deleted: string[]
}

/** An env whose Email binding and R2 bucket record every call. */
function fakeEnv(opts: { from?: string | undefined; failSend?: string } = {}): FakeEnv {
  const sent: Array<Record<string, unknown>> = []
  const r2Deleted: string[] = []
  return {
    ...(opts.from === undefined ? {} : { DEFAULT_FROM: opts.from }),
    sent,
    r2Deleted,
    EMAIL: {
      async send(message) {
        if (opts.failSend) throw new Error(opts.failSend)
        sent.push(message)
      },
    },
    RAW: {
      async delete(key) {
        r2Deleted.push(key)
      },
      async get() {
        return null
      },
    },
  }
}

/**
 * The worker's env is a Workers-runtime type (R2Bucket, the Email binding);
 * the fake is structurally what the commands actually touch. One cast, here,
 * rather than a `any` at every call site.
 */
const asEnv = (env: FakeEnv) =>
  env as unknown as Parameters<typeof commands.send>[0] & {
    RAW: { delete(key: string): Promise<void> }
  }

describe('createDraft', () => {
  test('inserts an outbound draft with a synthetic message id under the from-domain', async () => {
    const store = fakeStore()
    const env = fakeEnv({ from: FROM })
    const outcome = await commands.createDraft(asEnv(env), store, {
      to: 'a@b.com',
      subject: 'Hi',
      text: 'body',
      html: '<p>h</p>',
    })

    expect(outcome.status).toBe(201)
    const id = outcome.body.id as string
    expect(outcome.body).toEqual({ ok: true, id, status: 'draft' })

    const row = store.rows.get(id)!
    expect(row.status).toBe('draft')
    expect(row.direction).toBe('outbound')
    expect(row.message_id).toBe(`${id}@mail.example.com`)
    expect(row.from_addr).toBe(FROM)
    expect(row.to_addr).toBe('a@b.com')
    expect(row.snippet).toBe('body')
    expect(row.size).toBe('body'.length + '<p>h</p>'.length)
    // A draft is not in a thread until it is actually sent.
    expect(row.thread_id).toBe('')
  })

  test('takes the snippet from html when there is no text, and localhost when there is no from', async () => {
    const store = fakeStore()
    const outcome = await commands.createDraft(asEnv(fakeEnv()), store, {
      html: '<p>hello  there</p>',
    })
    const row = store.rows.get(outcome.body.id as string)!
    expect(row.snippet).toBe('hello there')
    expect(row.from_addr).toBe('')
    expect(row.message_id).toBe(`${row.id}@localhost`)
  })

  test('normalizes the in-reply-to message id', async () => {
    const store = fakeStore()
    const outcome = await commands.createDraft(asEnv(fakeEnv({ from: FROM })), store, {
      inReplyTo: '<abc@example.com>',
    })
    expect(store.rows.get(outcome.body.id as string)!.in_reply_to).toBe('abc@example.com')
  })
})

describe('send', () => {
  test('refuses a message with no recipient, subject, or body', async () => {
    const store = fakeStore()
    const env = fakeEnv({ from: FROM })
    for (const body of [
      { to: '', subject: 'x', text: 'y' },
      { to: 'a@b.com', subject: '', text: 'y' },
      { to: 'a@b.com', subject: 'x' },
    ]) {
      const outcome = await commands.send(asEnv(env), store, body)
      expect(outcome).toEqual({
        status: 400,
        body: { error: 'required: to, subject, and text or html' },
      })
    }
    expect(env.sent).toHaveLength(0)
    expect(store.rows.size).toBe(0)
  })

  test('refuses when there is no from address anywhere', async () => {
    const outcome = await commands.send(asEnv(fakeEnv()), fakeStore(), {
      to: 'a@b.com',
      subject: 'x',
      text: 'y',
    })
    expect(outcome.status).toBe(400)
    expect(outcome.body.error).toBe('no from address (set DEFAULT_FROM or pass from)')
  })

  test('queues rather than dispatches when sendAt is in the future', async () => {
    const store = fakeStore()
    const env = fakeEnv({ from: FROM })
    const sendAt = '2099-01-01T00:00:00.000Z'
    const outcome = await commands.send(asEnv(env), store, {
      to: 'a@b.com',
      subject: 'S',
      text: 't',
      sendAt,
    })

    expect(outcome.status).toBe(202)
    const id = outcome.body.id as string
    expect(outcome.body).toEqual({ ok: true, id, status: 'scheduled', sendAt })
    expect(env.sent).toHaveLength(0)

    const row = store.rows.get(id)!
    expect(row.status).toBe('scheduled')
    expect(row.scheduled_at).toBe(sendAt)
    expect(row.date).toBe(sendAt)
  })

  test('refuses an unparseable sendAt without touching the store', async () => {
    const store = fakeStore()
    const outcome = await commands.send(asEnv(fakeEnv({ from: FROM })), store, {
      to: 'a@b.com',
      subject: 'S',
      text: 't',
      sendAt: 'tuesday',
    })
    expect(outcome).toEqual({ status: 400, body: { error: 'sendAt is not a valid date' } })
    expect(store.rows.size).toBe(0)
  })

  test('dispatches now and records the outbound row in a thread', async () => {
    const store = fakeStore()
    const env = fakeEnv({ from: FROM })
    const outcome = await commands.send(asEnv(env), store, {
      to: 'a@b.com',
      subject: 'N',
      text: 't',
      inReplyTo: '<prior@example.com>',
    })

    expect(outcome.status).toBe(200)
    const id = outcome.body.id as string
    expect(outcome.body).toEqual({
      ok: true,
      id,
      from: FROM,
      to: 'a@b.com',
      messageId: `${id}@mail.example.com`,
      threadId: id,
    })
    expect(env.sent).toEqual([
      {
        from: FROM,
        to: 'a@b.com',
        subject: 'N',
        text: 't',
        headers: {
          'In-Reply-To': '<prior@example.com>',
          References: '<prior@example.com>',
        },
      },
    ])
    expect(store.rows.get(id)!.status).toBe('sent')
  })

  test('reports a dispatch failure as 502 and stores nothing', async () => {
    const store = fakeStore()
    const outcome = await commands.send(
      asEnv(fakeEnv({ from: FROM, failSend: 'provider down' })),
      store,
      { to: 'a@b.com', subject: 'N', text: 't' },
    )
    expect(outcome).toEqual({ status: 502, body: { error: 'send failed: provider down' } })
    expect(store.rows.size).toBe(0)
  })
})

describe('sendDraft', () => {
  test('404s on an unknown id and on a row that is not a draft', async () => {
    const store = fakeStore()
    store.seed({ id: 'sent1', status: 'sent' })
    const env = fakeEnv({ from: FROM })
    for (const id of ['nope', 'sent1']) {
      expect(await commands.sendDraft(asEnv(env), store, id)).toEqual({
        status: 404,
        body: { error: 'not a draft' },
      })
    }
    expect(env.sent).toHaveLength(0)
  })

  test('400s on an incomplete draft', async () => {
    const store = fakeStore()
    store.seed({ id: 'd1', status: 'draft', to_addr: '', subject: 'x', text_body: 'y' })
    const outcome = await commands.sendDraft(asEnv(fakeEnv({ from: FROM })), store, 'd1')
    expect(outcome).toEqual({
      status: 400,
      body: { error: 'draft incomplete: needs to, subject, and text or html' },
    })
  })

  test('dispatches a complete draft and flips it to sent', async () => {
    const store = fakeStore()
    store.seed({ id: 'd1', status: 'draft', to_addr: 'a@b.com', subject: 'S', text_body: 'body' })
    const env = fakeEnv({ from: FROM })
    const outcome = await commands.sendDraft(asEnv(env), store, 'd1')

    expect(outcome).toEqual({
      status: 200,
      body: { ok: true, id: 'd1', from: FROM, to: 'a@b.com', threadId: 'd1' },
    })
    expect(env.sent).toHaveLength(1)
    expect(store.rows.get('d1')!.status).toBe('sent')
  })
})

describe('updateDraft', () => {
  test('404s on a message that is not an unsent draft', async () => {
    const store = fakeStore()
    store.seed({ id: 'sent1', status: 'sent', subject: 'original' })
    expect(await commands.updateDraft(store, 'sent1', { subject: 'changed' })).toEqual({
      status: 404,
      body: { error: 'not a draft' },
    })
    expect(store.rows.get('sent1')!.subject).toBe('original')
  })

  test('changes only the fields it was given, and recomputes the snippet with a body', async () => {
    const store = fakeStore()
    store.seed({
      id: 'd1',
      status: 'draft',
      to_addr: 'a@b.com',
      subject: 'old',
      text_body: 'old body',
      snippet: 'old body',
    })

    expect(await commands.updateDraft(store, 'd1', { subject: 'new' })).toEqual({
      status: 200,
      body: { ok: true, id: 'd1' },
    })
    const afterSubject = store.rows.get('d1')!
    expect(afterSubject.subject).toBe('new')
    expect(afterSubject.to_addr).toBe('a@b.com')
    // Neither body was touched, so the snippet is left alone.
    expect(afterSubject.snippet).toBe('old body')

    await commands.updateDraft(store, 'd1', { text: 'new body' })
    expect(store.rows.get('d1')!.snippet).toBe('new body')
  })

  /**
   * Characterization, not endorsement. The snippet is computed from the patch
   * alone, so patching only `html` on a draft that has a text body writes a
   * snippet describing the html while `text_body` — what `makeSnippet` prefers,
   * and what actually goes out — is untouched. Both adapter copies did this
   * before the command existed; see the note on `updateDraft`. If you are here
   * because you fixed it, this is the assertion to change.
   */
  test('derives the snippet from the patch, not from the patched row', async () => {
    const store = fakeStore()
    store.seed({
      id: 'd1',
      status: 'draft',
      text_body: 'quarterly numbers attached',
      html_body: '<p>quarterly numbers attached</p>',
      snippet: 'quarterly numbers attached',
    })

    await commands.updateDraft(store, 'd1', { html: '<p>see revised deck</p>' })

    const row = store.rows.get('d1')!
    expect(row.text_body).toBe('quarterly numbers attached')
    expect(row.snippet).toBe('see revised deck')
  })
})

describe('deleteMessage', () => {
  test('deletes the row and its raw MIME blob', async () => {
    const store = fakeStore()
    store.seed({ id: 'm1', status: 'sent', r2_key: 'msgs/m1' })
    const env = fakeEnv()

    expect(await commands.deleteMessage(asEnv(env), store, 'm1')).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(env.r2Deleted).toEqual(['msgs/m1'])
    expect(store.rows.has('m1')).toBe(false)
  })

  /**
   * The behaviour fix this refactor carries. A row with no raw MIME — a draft,
   * a scheduled send, anything outbound — has r2_key ''. The JSON route used
   * to test `!r2Key`, so it deleted the row and then answered 404; the MCP
   * tool tested `=== null` and was right. One command, the MCP reading.
   */
  test('answers 200 for a deleted row that never had raw MIME, and touches no R2 object', async () => {
    const store = fakeStore()
    store.seed({ id: 'd1', status: 'draft', r2_key: '' })
    const env = fakeEnv()

    expect(await commands.deleteMessage(asEnv(env), store, 'd1')).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(env.r2Deleted).toEqual([])
    expect(store.rows.has('d1')).toBe(false)
  })

  test('404s on an unknown id', async () => {
    const env = fakeEnv()
    expect(await commands.deleteMessage(asEnv(env), fakeStore(), 'nope')).toEqual({
      status: 404,
      body: { error: 'not found' },
    })
    expect(env.r2Deleted).toEqual([])
  })
})

describe('cancelScheduled', () => {
  test('404s on an id that is not a scheduled or failed send', async () => {
    const store = fakeStore()
    store.seed({ id: 'sent1', status: 'sent' })
    for (const id of ['nope', 'sent1']) {
      expect(await commands.cancelScheduled(store, id)).toEqual({
        status: 404,
        body: { error: 'not a scheduled send' },
      })
    }
    expect(store.rows.has('sent1')).toBe(true)
  })

  test('deletes a scheduled row and a failed one', async () => {
    const store = fakeStore()
    store.seed({ id: 'sch1', status: 'scheduled' })
    store.seed({ id: 'fail1', status: 'failed' })
    for (const id of ['sch1', 'fail1']) {
      expect(await commands.cancelScheduled(store, id)).toEqual({ status: 200, body: { ok: true } })
    }
    expect(store.rows.size).toBe(0)
  })
})

/**
 * A row with the two fields a fresh insert cannot share — its generated id and
 * the wall-clock date — replaced by what IS comparable: the id is dropped, and
 * the synthetic message_id keeps only its domain.
 */
function comparableRow(row: Row): Record<string, unknown> {
  const { id: _id, date: _date, message_id, ...rest } = row
  return { ...rest, message_id_domain: message_id.split('@')[1] }
}

/**
 * Adapter equivalence. Each case runs one operation through both adapters
 * against two fresh fakes and compares what reached the store and what came
 * back. The responses are also pinned to literals captured from the code as it
 * stood before the commands existed, so this block doubles as the byte-identity
 * check for the refactor.
 */
describe('the two adapters', () => {
  async function callApi(
    store: InboxStore,
    env: FakeEnv,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await handleApi(
      new Request(`https://inbox.test${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      }),
      { env: asEnv(env), store },
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  async function callTool(
    store: InboxStore,
    env: FakeEnv,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const res = await handleMcp(
      new Request('https://inbox.test/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }),
      { env: asEnv(env), store },
    )
    const frame = (await res.text()).split('\n').find((line) => line.startsWith('data: '))
    if (!frame) throw new Error('no MCP data frame in the response')
    const message = JSON.parse(frame.slice(6)) as {
      result?: { isError?: boolean; content: Array<{ text: string }> }
      error?: { message: string }
    }
    if (!message.result) throw new Error(`MCP protocol error: ${message.error?.message}`)
    return { isError: message.result.isError === true, text: message.result.content[0]!.text }
  }

  test('create a draft the same way, field for field', async () => {
    const viaJson = fakeStore()
    const viaMcp = fakeStore()
    const env = fakeEnv({ from: FROM })
    const input = {
      to: 'a@b.com',
      subject: 'Hi',
      text: 'body',
      html: '<p>h</p>',
      from: 'me@mail.example.com',
    }

    const jsonRes = await callApi(viaJson, env, 'POST', '/api/drafts', {
      ...input,
      inReplyTo: '<prior@example.com>',
    })
    const mcpRes = await callTool(viaMcp, env, 'create_draft', {
      ...input,
      in_reply_to: '<prior@example.com>',
    })

    // The pre-refactor responses, to the byte.
    expect(jsonRes.status).toBe(201)
    expect(jsonRes.body).toEqual({ ok: true, id: jsonRes.body.id, status: 'draft' })
    expect(mcpRes.isError).toBe(false)
    const mcpBody = JSON.parse(mcpRes.text) as Record<string, unknown>
    expect(mcpBody).toEqual({ ok: true, id: mcpBody.id, status: 'draft' })

    // And the rows they inserted, which is the part that used to agree only by
    // coincidence. id and date are the only fields that may differ.
    const [jsonRow] = [...viaJson.rows.values()]
    const [mcpRow] = [...viaMcp.rows.values()]
    expect(comparableRow(jsonRow!)).toEqual(comparableRow(mcpRow!))
  })

  test('update a draft the same way', async () => {
    const viaJson = fakeStore()
    const viaMcp = fakeStore()
    const env = fakeEnv({ from: FROM })
    for (const store of [viaJson, viaMcp]) {
      store.seed({ id: 'd1', status: 'draft', subject: 'old', text_body: 'old', snippet: 'old' })
    }

    const jsonRes = await callApi(viaJson, env, 'PUT', '/api/drafts/d1', {
      subject: 'new',
      text: 'fresh',
    })
    const mcpRes = await callTool(viaMcp, env, 'update_draft', {
      id: 'd1',
      subject: 'new',
      text: 'fresh',
    })

    expect(jsonRes).toEqual({ status: 200, body: { ok: true, id: 'd1' } })
    expect(mcpRes).toEqual({
      isError: false,
      text: JSON.stringify({ ok: true, id: 'd1' }, null, 2),
    })
    expect(viaJson.rows.get('d1')).toEqual(viaMcp.rows.get('d1')!)
  })

  test('delete a message the same way, R2 object included', async () => {
    const viaJson = fakeStore()
    const viaMcp = fakeStore()
    const jsonEnv = fakeEnv()
    const mcpEnv = fakeEnv()
    for (const store of [viaJson, viaMcp]) store.seed({ id: 'm1', r2_key: 'msgs/m1' })

    const jsonRes = await callApi(viaJson, jsonEnv, 'DELETE', '/api/messages/m1')
    const mcpRes = await callTool(viaMcp, mcpEnv, 'delete_message', { id: 'm1' })

    expect(jsonRes).toEqual({ status: 200, body: { ok: true } })
    expect(mcpRes).toEqual({ isError: false, text: JSON.stringify({ ok: true }, null, 2) })
    expect(jsonEnv.r2Deleted).toEqual(['msgs/m1'])
    expect(mcpEnv.r2Deleted).toEqual(['msgs/m1'])
    expect(viaJson.rows.size).toBe(0)
    expect(viaMcp.rows.size).toBe(0)
  })

  test('delete a keyless row the same way — both 200, neither touching R2', async () => {
    const viaJson = fakeStore()
    const viaMcp = fakeStore()
    const jsonEnv = fakeEnv()
    const mcpEnv = fakeEnv()
    for (const store of [viaJson, viaMcp]) store.seed({ id: 'd1', status: 'draft', r2_key: '' })

    // Before this refactor the JSON route answered 404 here, after deleting the
    // row; the MCP tool answered ok. They now answer the same thing.
    expect(await callApi(viaJson, jsonEnv, 'DELETE', '/api/messages/d1')).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(await callTool(viaMcp, mcpEnv, 'delete_message', { id: 'd1' })).toEqual({
      isError: false,
      text: JSON.stringify({ ok: true }, null, 2),
    })
    expect(jsonEnv.r2Deleted).toEqual([])
    expect(mcpEnv.r2Deleted).toEqual([])
  })

  test('report a missing message as not-found, each in its own words', async () => {
    const env = fakeEnv()
    expect(await callApi(fakeStore(), env, 'DELETE', '/api/messages/nope')).toEqual({
      status: 404,
      body: { error: 'not found' },
    })
    // The tool has always spelled it this way; MCP clients see the string, so
    // the wording is preserved even though the decision is now the command's.
    expect(await callTool(fakeStore(), env, 'delete_message', { id: 'nope' })).toEqual({
      isError: true,
      text: 'message not found',
    })
  })

  test('refuse an incomplete send the same way', async () => {
    const env = fakeEnv({ from: FROM })
    const body = { to: 'a@b.com', subject: '', text: 'y' }
    expect(await callApi(fakeStore(), env, 'POST', '/api/send', body)).toEqual({
      status: 400,
      body: { error: 'required: to, subject, and text or html' },
    })
    expect(await callTool(fakeStore(), env, 'send_email', body)).toEqual({
      isError: true,
      text: 'required: to, subject, and text or html',
    })
    expect(env.sent).toHaveLength(0)
  })

  test('cancel a scheduled send the same way', async () => {
    const viaJson = fakeStore()
    const viaMcp = fakeStore()
    const env = fakeEnv()
    for (const store of [viaJson, viaMcp]) store.seed({ id: 'sch1', status: 'scheduled' })

    expect(await callApi(viaJson, env, 'DELETE', '/api/scheduled/sch1')).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(await callTool(viaMcp, env, 'cancel_scheduled', { id: 'sch1' })).toEqual({
      isError: false,
      text: JSON.stringify({ ok: true }, null, 2),
    })
    expect(await callApi(viaJson, env, 'DELETE', '/api/scheduled/sch1')).toEqual({
      status: 404,
      body: { error: 'not a scheduled send' },
    })
    expect(await callTool(viaMcp, env, 'cancel_scheduled', { id: 'sch1' })).toEqual({
      isError: true,
      text: 'not a scheduled send',
    })
  })

  test('the JSON adapter still rejects a malformed body before any command runs', async () => {
    const store = fakeStore()
    for (const path of ['/api/send', '/api/drafts']) {
      const res = await handleApi(
        new Request(`https://inbox.test${path}`, { method: 'POST', body: 'not json' }),
        { env: asEnv(fakeEnv({ from: FROM })), store },
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid JSON body' })
    }
    expect(store.rows.size).toBe(0)
  })
})
