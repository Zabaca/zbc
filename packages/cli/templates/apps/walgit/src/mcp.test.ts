/**
 * The MCP endpoint, driven the way a client drives it.
 *
 * `shared/mcp.ts` is the server as a VALUE — an `McpServer` over injected deps
 * — so the whole of it is exercisable here with no Workers runtime, no socket
 * and no container, exactly as `shared/telemetry.ts` is. What the Worker adds
 * (`worker/mcp.ts`) is a transport and the real deps.
 *
 * Every assertion below goes through a real MCP `Client` over the SDK's
 * in-memory transport: `tools/list`, `tools/call`, `resources/read`. That is
 * deliberately the only surface used — a test that called a handler function
 * would be testing an arrangement of this file rather than the protocol an
 * agent actually speaks.
 */

import { describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { capabilitiesFrom } from '../shared/capabilities'
import { renderLlms } from '../shared/llms'
import { MANUAL_URI, type McpDeps, createAgentgitMcp } from '../shared/mcp'

const CAPS = capabilitiesFrom({ WALGIT_PUBLIC: '1', WALGIT_PUSH_CERT_SEED: 'seed' })

/** Deps that refuse everything, so each test states only what it needs. */
function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    version: '1.2.3',
    host: 'walgit.test',
    caps: CAPS,
    operator: null,
    async status() {
      return { ok: true, exists: false, claimed: false, private: false, refs: {} }
    },
    async provenance() {
      return { ok: true, repo: '', provenance: {} }
    },
    async watch() {
      return { timedOut: true }
    },
    ...overrides,
  }
}

/** A connected client, talking to a server built over `d`. */
async function connect(d: McpDeps): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([createAgentgitMcp(d).connect(serverSide), client.connect(clientSide)])
  return client
}

/** The JSON a tool answered with, or the refusal text when it refused. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: { type: string; text: string }[]
  }
  const text = result.content[0]?.text ?? ''
  return { isError: result.isError === true, text }
}

describe('the tool list', () => {
  test('names the three tools an agent can reach without a clone', async () => {
    const client = await connect(deps())
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort()
    // Exactly these three, and the literal list is the point: the endpoint
    // carries only what the host can answer without the agent's disk, so a
    // tool that wrote to a clone appearing here is the regression.
    expect(listed).toEqual(['agentgit_provenance', 'agentgit_status', 'agentgit_watch'])
  })
})

describe('agentgit_status', () => {
  test('a name nobody has pushed reads as not existing, rather than as an error', async () => {
    const client = await connect(deps())
    const { isError, text } = await call(client, 'agentgit_status', { name: 'nothing-here' })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual({
      name: 'nothing-here',
      exists: false,
      claimed: false,
      private: false,
      refs: [],
      signedPushes: true,
    })
  })

  test('reports the refs, the Signer List and the Reader List of a name that exists', async () => {
    const client = await connect(
      deps({
        async status(name) {
          expect(name).toBe('alpha')
          return {
            ok: true,
            exists: true,
            claimed: true,
            private: true,
            refs: { 'refs/heads/main': 'a'.repeat(40) },
          }
        },
      }),
    )
    const { text } = await call(client, 'agentgit_status', { name: 'alpha' })
    expect(JSON.parse(text)).toEqual({
      name: 'alpha',
      exists: true,
      claimed: true,
      private: true,
      refs: [{ ref: 'refs/heads/main', sha: 'a'.repeat(40) }],
      signedPushes: true,
    })
  })

  test('a Private name refuses an unproven reader, and says nothing else about it', async () => {
    const client = await connect(
      deps({
        async status() {
          return { ok: false, status: 401, message: 'walgit: unauthorized' }
        },
      }),
    )
    const { isError, text } = await call(client, 'agentgit_status', { name: 'secret' })
    expect(isError).toBe(true)
    expect(text).toContain('walgit: unauthorized')
    // The refusal is the WHOLE answer: nothing about refs, existence or the
    // lists leaks alongside it, which is the property `info/refs` has.
    expect(text).not.toContain('refs/')
    expect(text).not.toContain('claimed')
  })

  test('a name the grammar refuses never reaches the host', async () => {
    let asked = false
    const client = await connect(
      deps({
        async status() {
          asked = true
          return { ok: true, exists: false, claimed: false, private: false, refs: {} }
        },
      }),
    )
    const { isError } = await call(client, 'agentgit_status', { name: '../etc' })
    expect(isError).toBe(true)
    expect(asked).toBe(false)
  })
})

describe('agentgit_watch', () => {
  test('answers with the ref and the sha it moved to', async () => {
    const client = await connect(
      deps({
        async watch(name, ref) {
          expect([name, ref]).toEqual(['alpha', 'refs/heads/main'])
          return { timedOut: false, ref: 'refs/heads/main', sha: 'b'.repeat(40) }
        },
      }),
    )
    const { isError, text } = await call(client, 'agentgit_watch', {
      name: 'alpha',
      ref: 'refs/heads/main',
    })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual({
      timedOut: false,
      repo: 'alpha',
      ref: 'refs/heads/main',
      sha: 'b'.repeat(40),
    })
  })

  test('a deadline reached is an answer, not a failure', async () => {
    const client = await connect(deps())
    const { isError, text } = await call(client, 'agentgit_watch', { name: 'alpha' })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual({ timedOut: true, repo: 'alpha', ref: null, sha: null })
  })

  test('waits no longer than five minutes, whatever the caller asks for', async () => {
    let waited = 0
    const client = await connect(
      deps({
        async watch(_name, _ref, timeoutMs) {
          waited = timeoutMs
          return { timedOut: true }
        },
      }),
    )
    // A request holds a Worker open, so the cap is the host's and not the
    // client's — an hour asked for is five minutes waited.
    await call(client, 'agentgit_watch', { name: 'alpha', timeoutMs: 3_600_000 })
    expect(waited).toBe(300_000)
    await call(client, 'agentgit_watch', { name: 'alpha', timeoutMs: 1_000 })
    expect(waited).toBe(1_000)
  })

  test('a host that cannot be reached is named, not hung', async () => {
    const client = await connect(
      deps({
        async watch() {
          throw new Error('event stream unreachable')
        },
      }),
    )
    const { isError, text } = await call(client, 'agentgit_watch', { name: 'alpha' })
    expect(isError).toBe(true)
    expect(text).toContain('walgit.test')
    expect(text).toContain('event stream unreachable')
  })
})

describe('agentgit_provenance', () => {
  test('says who pushed a ref, and when', async () => {
    const client = await connect(
      deps({
        async provenance(name) {
          expect(name).toBe('alpha')
          return {
            ok: true,
            repo: 'alpha',
            provenance: {
              'refs/heads/main': { signer: 'SHA256:abc', ts: '2026-09-19T00:00:00.000Z' },
              'refs/heads/other': { signer: 'SHA256:def', ts: '2026-09-18T00:00:00.000Z' },
            },
          }
        },
      }),
    )
    const { text } = await call(client, 'agentgit_provenance', {
      name: 'alpha',
      ref: 'refs/heads/main',
    })
    expect(JSON.parse(text)).toEqual({
      repo: 'alpha',
      ref: 'refs/heads/main',
      signer: 'SHA256:abc',
      ts: '2026-09-19T00:00:00.000Z',
    })
  })

  test('a ref nobody signed is an answer with no signer, not a refusal', async () => {
    const client = await connect(deps())
    const { isError, text } = await call(client, 'agentgit_provenance', {
      name: 'alpha',
      ref: 'refs/heads/main',
    })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual({
      repo: 'alpha',
      ref: 'refs/heads/main',
      signer: null,
      ts: null,
    })
  })

  test('a Private name refuses here exactly as it does for status', async () => {
    const client = await connect(
      deps({
        async provenance() {
          return { ok: false, status: 401, message: 'walgit: unauthorized' }
        },
      }),
    )
    const { isError, text } = await call(client, 'agentgit_provenance', {
      name: 'secret',
      ref: 'refs/heads/main',
    })
    expect(isError).toBe(true)
    expect(text).toContain('walgit: unauthorized')
  })
})

describe('the manual', () => {
  test('is the host’s own /llms.txt, rendered from the same capabilities', async () => {
    const client = await connect(deps())
    const read = await client.readResource({ uri: MANUAL_URI })
    const first = read.contents[0]
    expect(first?.mimeType).toBe('text/markdown')
    // The independent source of truth is the renderer the `/llms.txt` route
    // itself calls — one document, two ways to it, and no second copy to drift.
    expect(first && 'text' in first ? first.text : null).toBe(renderLlms('walgit.test', CAPS, null))
  })
})
