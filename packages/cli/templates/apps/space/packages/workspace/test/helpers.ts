import { readFileSync } from 'node:fs'
import { createInstall, type Install } from '../src'

export const NORTHFIELD_FILE = new URL('../../workspace/northfield/workspace.json', import.meta.url)
export const PINECREST_FILE = new URL('./fixtures/pinecrest.json', import.meta.url)

export const readJson = (file: URL): unknown => JSON.parse(readFileSync(file, 'utf8'))
export const northfield = (): Install => createInstall(readJson(NORTHFIELD_FILE))
export const lane = (): Install => createInstall(readJson(PINECREST_FILE))

export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
export const AUD = 'a'.repeat(64)

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))

/** A stand-in for one Zero Trust organisation: its key pair, its published key set, and a signer. */
export async function team(teamDomain: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  let fetches = 0
  const fetch = async (url: string) => {
    fetches++
    if (url !== `https://${teamDomain}/cdn-cgi/access/certs`) return new Response('no', { status: 404 })
    return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] })
  }
  async function sign(claims: Record<string, unknown>, o: { key?: CryptoKey; kid?: string; exp?: number } = {}) {
    const head = json({ alg: 'RS256', kid: o.kid ?? 'k1', typ: 'JWT' })
    const body = json({ iss: `https://${teamDomain}`, aud: [AUD], exp: o.exp ?? Math.floor(T0 / 1000) + 3600, ...claims })
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, o.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
    return `${head}.${body}.${b64url(sig)}`
  }
  return { sign, fetch, fetches: () => fetches, privateKey: pair.privateKey }
}

export const asserted = (jwt: string) => new Headers({ 'cf-access-jwt-assertion': jwt })
