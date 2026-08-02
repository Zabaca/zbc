// A local console for watching an agent work and answering it.
//
//   bun run ui
//
// Binds to 127.0.0.1 only, and that is not cosmetic: this process holds the
// credential and will run an agent against any repository it is pointed at. It
// is a developer tool for one machine, not a service.
//
// It exists because a run is minutes of tool calls and the API surfaces only the
// final text. Watching one is how you find out that an agent spent nine turns
// looking for a file, and following up is how you fix it without starting over.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { coding } from './../src/coding'
import { reviewer } from './../src/review'
import { type RunResult, type SandboxedProfile, runSandboxed } from './../src/sandboxed'
import { type Trait, traits } from './../src/traits'
import { collect } from './../src/workspace'

const PROFILES: Record<string, SandboxedProfile> = { coding, review: reviewer }
const PORT = Number(process.env.PORT ?? 4319)

/**
 * Runs that are still open.
 *
 * A workspace outlives the request that made it — that is the whole point of the
 * design — so the server holds it until the operator collects or disposes. A
 * process restart abandons them on disk under the temp root; they are inert
 * clones, but they are not free.
 */
type Session = { result: RunResult; profile: SandboxedProfile; busy: boolean }
const sessions = new Map<string, Session>()

type Client = { send(data: string): void }
const clients = new Set<Client>()

function broadcast(event: Record<string, unknown>) {
  const payload = JSON.stringify(event)
  for (const client of clients) client.send(payload)
}

/** Trim an SDK message to what a person watching actually wants to see. */
function summarise(message: SDKMessage): Record<string, unknown> | null {
  if (message.type === 'assistant') {
    const parts: Record<string, unknown>[] = []
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text' && block.text.trim()) {
        parts.push({ kind: 'text', text: block.text })
      }
      if (block.type === 'tool_use') {
        const input = block.input as Record<string, unknown>
        // One line, not the whole payload: a Write's input is the entire file.
        const detail =
          (input?.file_path as string) ??
          (input?.command as string) ??
          (input?.pattern as string) ??
          ''
        parts.push({ kind: 'tool', name: block.name, detail: String(detail).slice(0, 160) })
      }
    }
    return parts.length ? { type: 'parts', parts } : null
  }

  if (message.type === 'result') {
    return {
      type: 'done',
      turns: message.num_turns,
      cost: message.total_cost_usd,
      stop: message.subtype,
      sessionId: message.session_id,
    }
  }

  return null
}

async function start(body: {
  profile: string
  prompt: string
  repo?: string
  resumeFrom?: string
  traits?: string[]
}) {
  const profile = PROFILES[body.profile]
  if (!profile) throw new Error(`Unknown profile: ${body.profile}`)

  const previous = body.resumeFrom ? sessions.get(body.resumeFrom) : undefined
  if (body.resumeFrom && !previous) throw new Error('That session is gone — it was disposed.')
  if (previous?.busy) throw new Error('That session is still running.')

  const repo = resolve(body.repo?.trim() || process.cwd())
  if (!previous && !existsSync(repo)) throw new Error(`No such directory: ${repo}`)

  const chosen: Trait[] = (body.traits ?? []).flatMap(
    (name) => traits[name as keyof typeof traits] ?? [],
  )

  if (previous) previous.busy = true
  broadcast({ type: 'started', profile: body.profile, prompt: body.prompt, resumed: !!previous })

  try {
    const result = await runSandboxed(profile, body.prompt, {
      ...(previous
        ? { workspace: previous.result.workspace, resume: previous.result.sessionId }
        : { repo }),
      traits: chosen,
      onMessage: (message) => {
        const event = summarise(message)
        if (event) broadcast(event)
      },
    })

    sessions.delete(body.resumeFrom ?? '')
    sessions.set(result.sessionId, { result, profile, busy: false })
    broadcast({
      type: 'ready',
      sessionId: result.sessionId,
      workspace: result.workspace.dir,
      branch: result.workspace.branch,
      // A reviewer produces no commits, so collect is meaningless for it.
      collectable: profile === coding,
    })
  } catch (error) {
    if (previous) previous.busy = false
    broadcast({ type: 'failed', error: (error as Error).message })
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',

  async fetch(request, srv) {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      return srv.upgrade(request) ? undefined : new Response('expected websocket', { status: 400 })
    }

    if (url.pathname === '/') {
      return new Response(Bun.file(new URL('./index.html', import.meta.url)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (request.method === 'POST') {
      const body = (await request.json()) as Record<string, string>
      try {
        if (url.pathname === '/run') {
          // Deliberately not awaited: the response frees the browser and the run
          // reports over the socket. The catch is not optional — an unawaited
          // rejection takes the whole process down, so a bad repo path would
          // answer {ok:true} and then kill the server.
          void start(body as never).catch((error: Error) => {
            broadcast({ type: 'failed', error: error.message })
          })
          return Response.json({ ok: true })
        }

        const session = sessions.get(body.sessionId ?? '')
        if (!session) return Response.json({ error: 'unknown session' }, { status: 404 })

        if (url.pathname === '/collect') {
          const collected = await collect(session.result.workspace)
          return Response.json(collected)
        }

        if (url.pathname === '/dispose') {
          await session.result.workspace.dispose()
          sessions.delete(body.sessionId as string)
          return Response.json({ ok: true })
        }
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 })
      }
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    open(ws) {
      clients.add(ws)
    },
    close(ws) {
      clients.delete(ws)
    },
    message() {},
  },
})

console.log(`\n  zbc agent console  →  http://127.0.0.1:${server.port}`)
console.log(`  profiles: ${Object.keys(PROFILES).join(', ')}`)
console.log(`  traits:   ${Object.keys(traits).join(', ')}\n`)
