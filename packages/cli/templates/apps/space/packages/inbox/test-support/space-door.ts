import { agentRoute } from '@space/workspace'
import { bundledInstall } from '../src/workspace'
import { AGENT, AGENT_AUD, type harness, mint } from './harness'

/**
 * Claude's script's way in, as it is once it goes through the space: a stand-in for Cloudflare Access on the agent path, a stand-in for the space's
 * hand-over, and the inbox's own Claude's-door router (the harness's copy of the space's one check in front of it) behind them. Only the two outside things are stood in for; the path mapping is
 * the company layer's (`agentRoute`, the function the space itself uses), and the inbox's half is the real router over a real SQLite.
 * The space's own half (its Worker, its refusals) is proven in packages/space/test/agent.test.ts against a stand-in inbox.
 */

export const CLIENT_ID = AGENT.common_name
export const CLIENT_SECRET = 'not-a-real-secret'

export interface Door {
  /** The `fetch` of Claude's script (`CliIo.fetch`), over the token's two headers. */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** What the inbox received, as the space handed it on: path and the headers that matter. */
  received: { method: string; path: string; headers: Record<string, string | null> }[]
}

export function throughSpace(h: ReturnType<typeof harness>, secret = CLIENT_SECRET): Door {
  const received: Door['received'] = []
  return {
    received,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      const at = new URL(url)
      // Access on the path: the token's two headers, or turned away. Only the application on that path admits the token.
      const route = agentRoute(bundledInstall, at.pathname)
      if (at.hostname !== 'space.northfield.example' || !route.on) return new Response('Forbidden', { status: 403 })
      if (headers.get('CF-Access-Client-Id') !== CLIENT_ID || headers.get('CF-Access-Client-Secret') !== secret) {
        return new Response('Forbidden', { status: 403 })
      }
      // The space: the inbox's own path, without the cookie and without the token's two headers, the assertion as it came.
      if (route.forward === null) return Response.json({ error: 'Not found.' }, { status: 404 })
      const forwarded = new Headers(headers)
      forwarded.delete('cookie')
      forwarded.delete('cf-access-client-id')
      forwarded.delete('cf-access-client-secret')
      forwarded.set('cf-access-jwt-assertion', await mint(AGENT, { audience: AGENT_AUD }))
      received.push({
        method: init.method ?? 'GET',
        path: route.forward + at.search,
        headers: { cookie: forwarded.get('cookie'), clientSecret: forwarded.get('cf-access-client-secret') },
      })
      return h.app.request(
        `https://space.northfield.example${route.forward}${at.search}`,
        { ...init, headers: forwarded },
        h.env,
      )
    },
  }
}
