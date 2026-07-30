// Shell-outs to wrangler, for the things the REST API will not do with an API
// token: `/containers/applications/{id}/instances` answers NOT_ENABLED and the
// cloudchamber paths reject the token outright, while wrangler's own session
// succeeds. Log tailing and ssh have no REST equivalent at all.
import type { Subprocess } from 'bun'

export type Instance = {
  id: string
  name: string
  state: string
  location: string
  created: string
}

function env() {
  // Inherit whatever c9s resolved, so wrangler does not prompt for a fresh login.
  return { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '' }
}

export async function instances(appId: string): Promise<Instance[]> {
  const p = Bun.spawn(['bunx', 'wrangler', 'containers', 'instances', appId, '--json'], {
    env: env(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(p.stdout).text()
  if ((await p.exited) !== 0)
    throw new Error((await new Response(p.stderr).text()).trim().slice(0, 300))
  return parseInstances(out)
}

/**
 * wrangler prints progress and banner lines around its JSON, so find the payload
 * rather than parsing the lot. Throws on anything it cannot read: returning `[]`
 * would render as "none running", which is a lie the reader has no way to catch.
 * Tries each `[` in turn, since a bracketed timestamp or spinner can precede the
 * payload and shift the naive first-bracket guess.
 */
export function parseInstances(stdout: string): Instance[] {
  const end = stdout.lastIndexOf(']')
  const candidates: string[] = []
  for (let i = stdout.indexOf('['); i !== -1 && i < end; i = stdout.indexOf('[', i + 1)) {
    candidates.push(stdout.slice(i, end + 1))
  }
  if (candidates.length === 0)
    throw new Error(`no JSON array in wrangler output: ${stdout.trim().slice(0, 120)}`)

  let raw: unknown
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c)
      if (Array.isArray(parsed)) {
        raw = parsed
        break
      }
    } catch {
      // Try the next `[`: this one was chatter, not the payload.
    }
  }
  if (!Array.isArray(raw)) {
    throw new Error(`could not parse wrangler output as JSON: ${stdout.trim().slice(0, 120)}`)
  }

  return raw.map((r) => {
    const o = r as Record<string, unknown>
    return {
      id: String(o.id ?? o.instance_id ?? ''),
      name: String(o.name ?? ''),
      state: String(o.state ?? o.status ?? '-'),
      location: String(o.location ?? '-'),
      created: String(o.created_at ?? o.created ?? ''),
    }
  })
}

/** Streams `wrangler tail`. Caller kills the subprocess when the pane closes. */
export function tail(worker: string, onLine: (line: string) => void): Subprocess {
  const p = Bun.spawn(['bunx', 'wrangler', 'tail', worker, '--format', 'pretty'], {
    env: env(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) onLine(l)
    }
  }
  void pump(p.stdout as ReadableStream<Uint8Array>)
  void pump(p.stderr as ReadableStream<Uint8Array>)
  return p
}

/**
 * Hands the whole terminal to `wrangler containers ssh` and waits. The caller
 * must unmount Ink first: two things writing the same tty renders neither.
 */
export function sshSync(appId: string): number {
  const p = Bun.spawnSync(['bunx', 'wrangler', 'containers', 'ssh', appId], {
    env: env(),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  return p.exitCode ?? 0
}
