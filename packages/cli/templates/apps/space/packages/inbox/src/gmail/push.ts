import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

/**
 * The public entrance, and the whole of its defence.
 *
 * Pub/Sub cannot sign in to Cloudflare Access, so the push arrives on a hostname
 * of its own that no Access application covers (the install's push host, e.g. inbox-push.northfield.example). That
 * makes this check the only thing between the internet and the inbox's one
 * public route, and it is as safe as it is strict. A push is accepted ONLY when
 * it carries a Google-signed token that:
 *
 *   - verifies against Google's published keys (the SIGNATURE);
 *   - names Google as its ISSUER, so a token some other identity provider signed
 *     is not accepted;
 *   - names this endpoint as its AUDIENCE, so a token Google minted for some other
 *     service's endpoint is not accepted;
 *   - belongs to the PUSH SERVICE ACCOUNT, so a token Google minted for any other
 *     account, our own included, is not accepted; and
 *   - has that account's address VERIFIED.
 *
 * Fails CLOSED: with either setting unset it refuses every request, a real push
 * included, rather than skipping a check it cannot make. An audience that meant
 * "do not check the audience" would accept every token Google ever minted.
 *
 * A valid push carries nothing the inbox believes. Its body is a hint that the
 * mailbox moved; the history is read from Gmail with the cursor.
 */

/**
 * The push path as it is DEPLOYED (the endpoint the install's Google setup declares). The push HOST is the install's (the declaration's `gmailPush.host`,
 * `Install.gmailPushHost()`), which the Worker recognises as well as the settings below, so it treats the push hostname as the push hostname even when the settings are unset: a
 * misconfigured deploy must refuse everything there, and not fall through to the Access check as though it were the app. test/push-endpoint.test.ts holds the three places together.
 */
export const PUSH_PATH = '/api/gmail/push'

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/** Both spellings Google has issued. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export interface PushEnv {
  /** The full push URL, which is also the token's audience. Set at deploy time from the Google module. */
  GMAIL_PUSH_ENDPOINT?: string
  /** The service account the subscription signs its tokens as. */
  GMAIL_PUSH_SERVICE_ACCOUNT?: string
}

export type PushSettings = { ok: true; host: string; path: string; audience: string; account: string } | { ok: false }

/** What the Worker answers on the push hostname, or `ok: false` when it is not configured. */
export function pushSettings(env: PushEnv): PushSettings {
  const endpoint = (env.GMAIL_PUSH_ENDPOINT ?? '').trim()
  const account = (env.GMAIL_PUSH_SERVICE_ACCOUNT ?? '').trim().toLowerCase()
  if (endpoint === '' || account === '') return { ok: false }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false }
  }
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '' || url.pathname === '/') return { ok: false }
  return { ok: true, host: url.hostname, path: url.pathname, audience: endpoint, account }
}

export type PushOutcome = { ok: true } | { ok: false; detail: string }

const remote: { keys?: JWTVerifyGetKey } = {}

/** One key set kept across requests: jose re-fetches only on an unknown `kid`. */
const googleKeys: JWTVerifyGetKey = (header, token) => {
  remote.keys ??= createRemoteJWKSet(new URL(GOOGLE_CERTS_URL))
  return remote.keys(header, token)
}

export async function verifyPush(
  env: PushEnv,
  request: Request,
  keys: JWTVerifyGetKey = googleKeys,
): Promise<PushOutcome> {
  const settings = pushSettings(env)
  if (!settings.ok) {
    return {
      ok: false,
      detail:
        'GMAIL_PUSH_ENDPOINT or GMAIL_PUSH_SERVICE_ACCOUNT is not set (or is not an https URL with a path), so no ' +
        'push can be checked and every one is refused. Both are set by the space instance at deploy time, from inbox-google.ts.',
    }
  }
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')
  if (!match?.[1]) return { ok: false, detail: 'no bearer token' }

  try {
    const { payload } = await jwtVerify(match[1], keys, {
      issuer: GOOGLE_ISSUERS,
      audience: settings.audience,
      algorithms: ['RS256'],
      clockTolerance: 0,
    })
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
    if (email !== settings.account) return { ok: false, detail: 'the token is for a different account' }
    if (payload.email_verified !== true) return { ok: false, detail: 'the token has an unverified email' }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: `the token did not verify: ${error instanceof Error ? error.message : 'unknown'}` }
  }
}

/**
 * What a push says, as far as it is read at all: the mailbox it is about. The
 * history id in it is NEVER used as the cursor (it is a hint that the mailbox
 * moved, and Gmail drops and reorders them), so it is not even returned.
 */
export function pushedAddress(body: unknown): string | null {
  try {
    const message = (body as { message?: { data?: unknown } } | null)?.message
    if (typeof message?.data !== 'string') return null
    const binary = atob(message.data.replace(/-/g, '+').replace(/_/g, '/'))
    const decoded: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
    const address = (decoded as { emailAddress?: unknown } | null)?.emailAddress
    return typeof address === 'string' ? address.trim().toLowerCase() : null
  } catch {
    return null
  }
}
