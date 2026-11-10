import { createInstall, type Install } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { migrate } from '../src/schema'
import { KnowledgeStore, localApi, type StoreApi } from '../src/store'
import { memoryDatabase } from './sql-over-sqlite'

/** The clock tests start at, and what the assertions are good until. */
export const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)
/** The SPACE application's audience tag, as the Worker is deployed with it. */
export const SPACE_AUD = 'a'.repeat(64)

export const OWNER = 'tessa@northfield.example'
/** An agent's actor, as the inbox stamps Claude's: `agent:` and the token's client id. */
export const AGENT = 'agent:claude-token-id.access'

export const NORTHFIELD = createInstall(declaration)
export const BUSINESSES = NORTHFIELD.businesses().map((b) => b.id)

/** Northfield's declaration with a teammate who is not an owner, and a person of nobody's, for the doors. */
export const WITH_TEAMMATE: Install = createInstall({
  ...declaration,
  people: [...declaration.people, { address: 'dana@northfield.example', name: 'Dana', role: 'member' }],
})

/** A store over a real SQLite with the real migrations, a clock that moves only when told, and ids in order. */
export function harness(opts: { businesses?: readonly string[]; owners?: readonly string[] } = {}) {
  const mem = memoryDatabase()
  migrate(mem.sql)
  let at = T0
  let n = 0
  const store = new KnowledgeStore({
    sql: mem.sql,
    transaction: mem.transaction,
    now: () => new Date(at),
    newId: () => `e${++n}`,
    businesses: opts.businesses ?? BUSINESSES,
    owners: opts.owners ?? [OWNER],
    ownerName: 'Tessa',
  })
  const api: StoreApi = localApi(store)
  return {
    ...mem,
    store,
    api,
    tick: (ms = 60_000) => {
      at += ms
    },
    rows: <T>(sql: string): T[] => mem.db.query(sql).all() as T[],
  }
}

export type Harness = ReturnType<typeof harness>

// ── Access, stood in for ────────────────────────────────────────────────────────────────────────────────────────────────────

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))

/**
 * A stand-in for the Zero Trust organisation: its key pair, its published key set (as the `fetch` the entrypoint is handed), and a
 * signer. The same idea as the company layer's own test helper, which this package cannot import.
 */
export async function team(teamDomain = NORTHFIELD.teamDomain) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const fetchKeys = async (url: string) =>
    url === `https://${teamDomain}/cdn-cgi/access/certs`
      ? Response.json({ keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] })
      : new Response('no', { status: 404 })
  async function sign(claims: Record<string, unknown>, o: { key?: CryptoKey; exp?: number } = {}): Promise<string> {
    const head = json({ alg: 'RS256', kid: 'k1', typ: 'JWT' })
    const body = json({ iss: `https://${teamDomain}`, aud: [SPACE_AUD], exp: o.exp ?? Math.floor(T0 / 1000) + 3600, ...claims })
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, o.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
    return `${head}.${body}.${b64url(sig)}`
  }
  return { sign, fetchKeys, privateKey: pair.privateKey }
}
