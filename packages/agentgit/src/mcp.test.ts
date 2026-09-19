/**
 * The MCP tool handlers, over a git that is not there.
 *
 * The seam is `createHandlers(deps)`: everything above it is
 * `McpServer.registerTool` wiring, and a test of that would be a test of the
 * SDK. Everything below it — `runAccept`, `runSetup`, `watchOnce` — already has
 * its own seam and its own suite, so what is asserted here is the part that is
 * only true of the tool surface: what an agent gets back, including when the
 * answer is "nothing moved" or "I refused".
 */

import { describe, expect, test } from 'bun:test'

import { type McpDeps, createHandlers } from './mcp'
import type { SetupRequest } from './setup'

/** `git remote -v` for a clone of `my-thing` on agentgit.co. */
const REMOTE_V =
  'origin\thttps://agentgit.co/my-thing.git (fetch)\n' +
  'origin\thttps://agentgit.co/my-thing.git (push)\n'

const deps = (over: Partial<McpDeps> = {}): McpDeps => ({
  version: '9.9.9',
  toplevel: () => '/work/clone',
  remoteList: () => REMOTE_V,
  symbolicHead: () => 'refs/heads/main\n',
  configGet: () => null,
  watchOnce: async () => ({ timedOut: true, stopped: null, events: [] }),
  accept: async () => ({ stdout: '', stderr: '', code: 0 }),
  setup: async () => ({ stdout: '', stderr: '', code: 0 }),
  manual: async () => '',
  ...over,
})

/** What the agent actually reads: the one text block, parsed back. */
const body = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? 'null')

describe('agentgit_status', () => {
  test('names the host, the repository and the ref of the clone it was run in', async () => {
    const handlers = createHandlers(deps())

    const result = await handlers.status({})

    expect(result.isError).toBeUndefined()
    expect(body(result)).toEqual({
      clone: true,
      root: '/work/clone',
      remote: 'origin',
      host: 'agentgit.co',
      repo: 'my-thing',
      ref: 'refs/heads/main',
      credentialHelper: false,
    })
  })

  test('reports a configured credential helper', async () => {
    const handlers = createHandlers(deps({ configGet: () => '!agentgit credential' }))

    expect(body(await handlers.status({})).credentialHelper).toBe(true)
  })

  test('outside a clone it answers, rather than failing', async () => {
    const handlers = createHandlers(deps({ toplevel: () => null }))

    const result = await handlers.status({})

    expect(result.isError).toBeUndefined()
    expect(body(result)).toEqual({
      clone: false,
      root: null,
      remote: null,
      host: null,
      repo: null,
      ref: null,
      credentialHelper: false,
    })
  })

  test('a clone whose remote is not a walgit URL has no host to name', async () => {
    const handlers = createHandlers(
      deps({ remoteList: () => 'origin\tgit@github.com:zabaca/zbc.git (fetch)\n' }),
    )

    const answer = body(await handlers.status({}))

    expect(answer.clone).toBe(true)
    expect(answer.host).toBeNull()
    expect(answer.repo).toBeNull()
  })
})

describe('agentgit_watch_once', () => {
  test('answers with the repository, ref and sha of the ref that moved', async () => {
    const handlers = createHandlers(
      deps({
        watchOnce: async () => ({
          timedOut: false,
          stopped: 'once',
          events: [
            { event: 'watching', fields: { host: 'agentgit.co' } },
            {
              event: 'fetched',
              fields: {
                repo: 'my-thing',
                ref: 'refs/heads/main',
                sha: 'd4e5f6a7b8c9',
                local: 'd4e5f6a7b8c9',
                current: true,
              },
            },
          ],
        }),
      }),
    )

    const answer = body(await handlers.watchOnce({}))

    expect(answer.timedOut).toBe(false)
    expect(answer.repo).toBe('my-thing')
    expect(answer.ref).toBe('refs/heads/main')
    expect(answer.sha).toBe('d4e5f6a7b8c9')
  })

  test('watches the branch the clone is on, for the repository the remote names', async () => {
    const seen: { repo: string; refs: string[]; host: string }[] = []
    const handlers = createHandlers(
      deps({
        watchOnce: async (config) => {
          seen.push({
            host: config.host,
            repo: [...config.targets.keys()].join(','),
            refs: [...config.refs],
          })
          return { timedOut: true, stopped: null, events: [] }
        },
      }),
    )

    await handlers.watchOnce({})

    expect(seen).toEqual([
      {
        host: 'agentgit.co',
        repo: 'my-thing',
        refs: ['refs/heads/main'],
      },
    ])
  })

  test('an explicit ref wins over the branch HEAD is on', async () => {
    let refs: string[] = []
    const handlers = createHandlers(
      deps({
        watchOnce: async (config) => {
          refs = [...config.refs]
          return { timedOut: true, stopped: null, events: [] }
        },
      }),
    )

    await handlers.watchOnce({ ref: 'refs/heads/release' })

    expect(refs).toEqual(['refs/heads/release'])
  })

  test('nothing moved before the deadline is an answer, not a failure', async () => {
    const handlers = createHandlers(deps())

    const result = await handlers.watchOnce({ timeoutMs: 1 })

    expect(result.isError).toBeUndefined()
    expect(body(result)).toEqual({ timedOut: true, repo: null, ref: null, sha: null, events: [] })
  })

  test('a refusal from the host comes back as an error naming what it refused', async () => {
    const handlers = createHandlers(
      deps({
        watchOnce: async () => ({
          timedOut: false,
          stopped: 'refused',
          events: [{ event: 'refused', fields: { error: 'unknown repository my-thing' } }],
        }),
      }),
    )

    const result = await handlers.watchOnce({})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('unknown repository my-thing')
  })

  test('outside a clone there is nothing to watch, and it says so', async () => {
    const handlers = createHandlers(deps({ toplevel: () => null }))

    const result = await handlers.watchOnce({})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('clone')
  })
})

describe('agentgit_accept', () => {
  test('hands back what the accept flow printed', async () => {
    const handlers = createHandlers(
      deps({
        accept: async () => ({
          stdout: 'fix-auth → main: merged, pushed a1b2c3d4\n',
          stderr: '',
          code: 0,
        }),
      }),
    )

    const result = await handlers.accept({ proposal: 'fix-auth' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('fix-auth → main: merged, pushed a1b2c3d4\n')
  })

  test('a refusal comes back verbatim, as an error', async () => {
    const handlers = createHandlers(
      deps({
        accept: async () => ({
          stdout: '',
          stderr: 'agentgit: your tree is dirty; commit or stash before accepting\n',
          code: 1,
        }),
      }),
    )

    const result = await handlers.accept({ proposal: 'fix-auth' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      'agentgit: your tree is dirty; commit or stash before accepting\n',
    )
  })

  test('it accepts in the directory it was pointed at', async () => {
    const seen: { id: string; cwd: string }[] = []
    const handlers = createHandlers(
      deps({
        accept: async (id, cwd) => {
          seen.push({ id, cwd })
          return { stdout: '', stderr: '', code: 0 }
        },
      }),
    )

    await handlers.accept({ cwd: '/work/other', proposal: 'add-me' })

    expect(seen).toEqual([{ id: 'add-me', cwd: '/work/other' }])
  })
})

describe('agentgit_setup', () => {
  test('writes the helper globally unless asked for this repository only', async () => {
    const asked: SetupRequest[] = []
    const handlers = createHandlers(
      deps({
        setup: async (request) => {
          asked.push(request)
          return { stdout: 'configured\n', stderr: '', code: 0 }
        },
      }),
    )

    await handlers.setup({})
    await handlers.setup({ host: 'agentgit.co', local: true })

    expect(asked).toEqual([
      { host: null, global: true },
      { host: 'agentgit.co', global: false },
    ])
  })

  test('reports what it wrote', async () => {
    const handlers = createHandlers(
      deps({
        setup: async () => ({
          stdout:
            "git config --global credential.https://agentgit.co.helper '!agentgit credential'\n",
          stderr: '',
          code: 0,
        }),
      }),
    )

    expect((await handlers.setup({})).content[0]?.text).toContain(
      "credential.https://agentgit.co.helper '!agentgit credential'",
    )
  })

  test('a failure to write it is an error carrying git’s own message', async () => {
    const handlers = createHandlers(
      deps({
        setup: async () => ({ stdout: '', stderr: 'agentgit: git config failed\n', code: 1 }),
      }),
    )

    const result = await handlers.setup({})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('agentgit: git config failed\n')
  })
})

describe('agentgit://manual', () => {
  test('reads the manual of the host this clone belongs to', async () => {
    const asked: string[] = []
    const handlers = createHandlers(
      deps({
        remoteList: () => 'origin\thttps://git.example.test/my-thing.git (fetch)\n',
        manual: async (host) => {
          asked.push(host)
          return `# ${host}\n`
        },
      }),
    )

    const result = await handlers.manual({})

    expect(asked).toEqual(['git.example.test'])
    expect(result.content[0]?.text).toBe('# git.example.test\n')
  })

  test('outside a clone it reads agentgit.co, which is the manual an agent came for', async () => {
    const asked: string[] = []
    const handlers = createHandlers(
      deps({
        toplevel: () => null,
        manual: async (host) => {
          asked.push(host)
          return 'manual'
        },
      }),
    )

    await handlers.manual({})

    expect(asked).toEqual(['agentgit.co'])
  })

  test('a host that will not serve it is an error, not an empty manual', async () => {
    const handlers = createHandlers(
      deps({
        manual: async () => {
          throw new Error('GET https://agentgit.co/llms.txt answered 503')
        },
      }),
    )

    const result = await handlers.manual({})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('503')
  })
})
