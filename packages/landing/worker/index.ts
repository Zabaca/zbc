/**
 * zbc-landing Worker: fronts the statically exported Next.js site (the `out/`
 * dir, via the ASSETS binding) and serves the two dynamic `/api` routes that
 * used to be Next SSR route handlers.
 */
import { mintUserJwt } from './nats-jwt'

/** Live-cursor tokens are short-lived on purpose, so a leaked one expires fast. */
const TOKEN_TTL_SECONDS = 300
/** The only subject prefix a landing visitor may publish/subscribe on. */
const CURSOR_SUBJECT = 'landing.cursors.>'

export interface Env {
  /** Workers static-assets binding → Next's `out/` export. */
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  /** NATS WebSocket URL (wrangler var). */
  NATS_URL?: string
  /** APP account identity public key, A... (wrangler var, public). */
  NATS_ACCOUNT_ID?: string
  /** APP account signing-key seed, SA... (worker secret). Never sent to a client. */
  NATS_ACCOUNT_SIGNING_SEED?: string
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

    // Per-session NATS auth for the live-cursor layer (app/live-cursors.tsx).
    // The browser gets a freshly minted, short-lived, subject-scoped bearer JWT,
    // never a long-lived credential. 503 when NATS auth is unconfigured; the
    // UI degrades to `unavailable`.
    if (pathname === '/api/nats-token') {
      const { NATS_URL, NATS_ACCOUNT_ID, NATS_ACCOUNT_SIGNING_SEED } = env
      if (!NATS_URL || !NATS_ACCOUNT_ID || !NATS_ACCOUNT_SIGNING_SEED) {
        return Response.json({ error: 'NATS auth not configured' }, { status: 503 })
      }

      let jwt: string
      try {
        jwt = mintUserJwt({
          signingSeed: NATS_ACCOUNT_SIGNING_SEED,
          accountId: NATS_ACCOUNT_ID,
          subject: CURSOR_SUBJECT,
          ttlSeconds: TOKEN_TTL_SECONDS,
          name: 'landing-cursors',
        })
      } catch {
        // Never leak the signing key or a stack trace to a public endpoint.
        return Response.json({ error: 'failed to mint token' }, { status: 500 })
      }

      // no-store: every visitor must get their own fresh token, never a cached one.
      return Response.json(
        { url: NATS_URL, jwt, expiresInMs: TOKEN_TTL_SECONDS * 1000 },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    // Everything else: the static Next export.
    return env.ASSETS.fetch(request)
  },
}
