/**
 * `git http-backend` as a CGI child.
 *
 * git ships the smart-HTTP server as a CGI program, and reimplementing the pack
 * protocol in TypeScript to avoid one process would be a strictly worse copy of
 * something git already gets right. So this is a CGI gateway: environment in,
 * request body on stdin, CGI headers + body on stdout.
 *
 * Both directions are STREAMED. A clone is one long response and a push is one
 * long request; buffering either would make repository size a memory limit.
 */

import * as path from 'node:path'

import type { BackendRequest } from './http'

export async function runGitHttpBackend(req: BackendRequest): Promise<Response> {
  const { request, repo, pathInfo } = req
  const url = new URL(request.url)

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    // GIT_PROJECT_ROOT + PATH_INFO is how http-backend addresses the repo; it
    // re-joins them itself, so PATH_INFO stays the client's path, already
    // validated by the handler that called us.
    GIT_PROJECT_ROOT: path.dirname(repo.dir),
    GIT_HTTP_EXPORT_ALL: '1',
    // Authorization happened at the handler. Setting REMOTE_USER is what tells
    // http-backend the request is authenticated, which it requires before it
    // will serve git-receive-pack (a push) at all.
    REMOTE_USER: 'walgit',
    PATH_INFO: pathInfo,
    REQUEST_METHOD: request.method,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    CONTENT_TYPE: request.headers.get('content-type') ?? '',
    HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
    // Suppresses caching of the ref advertisement, which is what makes a fetch
    // after someone else's push see the new refs.
    HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
    GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
  }

  // Every WALGIT_* variable is forwarded because the push hooks are spawned by
  // git, three processes down, and this explicit env map is the only place the
  // chain can be broken. A hook that cannot see the store configuration
  // refuses the push — correct, but a confusing way to discover a typo here.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('WALGIT_') && value !== undefined) env[key] = value
  }

  const child = Bun.spawn(['git', 'http-backend'], {
    env,
    stdin: request.body ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // git's own diagnostics, and every hook's. Drained rather than dropped for
  // two reasons that are really one: a 64 KiB pipe nobody reads eventually
  // blocks the child mid-push, and a refusal reached at `reference-transaction`
  // has nowhere else to go. Only `pre-receive` output rides the sideband to the
  // client — a `prepared` hook that exits non-zero makes git die with "ref
  // updates aborted by hook", and its stderr is the CGI's, not the connection's.
  // So this is the one place a publish-time refusal is readable at all.
  void drainToStderr(child.stderr)

  const { headers, rest } = await readCgiHeaders(child.stdout)
  const status = Number(headers.get('status')?.slice(0, 3) ?? 200)
  headers.delete('status')

  return new Response(concatStream(rest, child.stdout), { status, headers })
}

/**
 * Copy the child's stderr to ours, and swallow every failure doing it.
 *
 * Deliberately not awaited: the response streams, and a push is a long request
 * whose diagnostics arrive throughout it. A failure here is a child that is
 * already gone, which leaves nothing to log and must never touch the push.
 */
async function drainToStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      process.stderr.write(value)
    }
  } catch {
    return
  }
}

/** Read up to the CGI header terminator, returning the leftover first chunk. */
async function readCgiHeaders(
  stdout: ReadableStream<Uint8Array>,
): Promise<{ headers: Headers; rest: Uint8Array }> {
  const reader = stdout.getReader()
  let buffer = new Uint8Array(0)
  try {
    for (;;) {
      const split = findHeaderEnd(buffer)
      if (split) {
        const headers = parseHeaders(new TextDecoder().decode(buffer.subarray(0, split.end)))
        return { headers, rest: buffer.subarray(split.bodyStart) }
      }
      const { done, value } = await reader.read()
      if (done) throw new Error('git http-backend produced no CGI headers')
      const next = new Uint8Array(buffer.length + value.length)
      next.set(buffer)
      next.set(value, buffer.length)
      buffer = next
    }
  } finally {
    reader.releaseLock()
  }
}

/** CGI allows either line ending, and git http-backend emits bare LF. */
function findHeaderEnd(buffer: Uint8Array): { end: number; bodyStart: number } | null {
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 10 && buffer[i + 1] === 10) return { end: i, bodyStart: i + 2 }
    if (
      i + 3 < buffer.length &&
      buffer[i] === 13 &&
      buffer[i + 1] === 10 &&
      buffer[i + 2] === 13 &&
      buffer[i + 3] === 10
    ) {
      return { end: i, bodyStart: i + 4 }
    }
  }
  return null
}

function parseHeaders(raw: string): Headers {
  const headers = new Headers()
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return headers
}

/** Emit the bytes already read, then the rest of the child's stdout. */
function concatStream(
  head: Uint8Array,
  tail: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      if (head.length > 0) controller.enqueue(head)
      for await (const chunk of tail as unknown as AsyncIterable<Uint8Array>) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}
