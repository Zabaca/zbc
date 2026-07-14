/**
 * zbc-landing Worker — fronts the statically exported Next.js site (the `out/`
 * dir, via the ASSETS binding) and serves the two dynamic `/api` routes that
 * used to be Next SSR route handlers.
 */
export interface Env {
  /** Workers static-assets binding → Next's `out/` export. */
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  /** NATS WebSocket URL (wrangler var). */
  NATS_URL?: string
  /** NATS auth user (wrangler var). */
  NATS_USER?: string
  /** NATS auth password (worker secret from secrets.yaml). */
  NATS_PASSWORD?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    // Runtime-freshness smoke test: fresh JSON on every hit.
    if (pathname === '/api/hello') {
      return Response.json({
        message: 'hello from the Cloudflare Worker API route',
        at: new Date().toISOString(),
      })
    }

    // NATS creds for the live-cursor layer (app/live-cursors.tsx). 503 when any
    // of the three is unset — the UI degrades to `unavailable`.
    if (pathname === '/api/nats-config') {
      const { NATS_URL, NATS_USER, NATS_PASSWORD } = env
      if (!NATS_URL || !NATS_USER || !NATS_PASSWORD) {
        return Response.json({ error: 'NATS env not configured' }, { status: 503 })
      }
      // This credential is public by construction — the page is public and hands
      // it to every visitor. It is not a secret; it is a rate-limit boundary.
      // nats-server.conf scopes it to publish/subscribe on `landing.cursors.>`
      // only, so a leaked copy can move cursors and nothing else. Anything with
      // real authority must never be served from here.
      return Response.json({ url: NATS_URL, user: NATS_USER, password: NATS_PASSWORD })
    }

    // Everything else: the static Next export.
    return env.ASSETS.fetch(request)
  },
}
