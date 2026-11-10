// A stand-in for Cloudflare Access: our own RSA key, our own JWKS served through the injected fetch, our own signed
// assertions. No network.
import type { Http } from '@space/workspace'

export const TEAM = 'northfield.cloudflareaccess.com'
export const AUD = 'a'.repeat(64)

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** One Zero Trust organisation's Access: its own key, published at its own team domain and nowhere else. */
export async function accessStandIn(team = TEAM) {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  let fetches = 0
  const deps: { now: () => number; fetch: Http } = {
    now: () => Date.now(),
    fetch: async (url) => {
      fetches++
      if (url !== `https://${team}/cdn-cgi/access/certs`) return new Response('no', { status: 404 })
      return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] })
    },
  }
  async function sign(claims: Record<string, unknown>, opts: { key?: CryptoKey; kid?: string; aud?: string } = {}) {
    const h = enc({ alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })
    const p = enc({ iss: `https://${team}`, aud: [opts.aud ?? AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims })
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? pair.privateKey, new TextEncoder().encode(`${h}.${p}`))
    return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
  }
  return { deps, sign, fetches: () => fetches, privateKey: pair.privateKey }
}
