// The route tests' harness: the real router over the real migration, every admin request carrying an assertion signed
// by test/keys.ts and verified exactly as production verifies Cloudflare's, an in-memory R2 that honours the customer
// key, and a throwaway seal. Shared by the route tests.
import { resetJwksCache } from '@space/workspace'
import { createApp } from '../src/app'
import { type DevClients, devClients } from '../dev/clients'
import type { Env } from '../src/http'
import type { Outgoing } from '../src/mail'
import { coreFor } from '../src/signing'
import { type Install, bundledInstall } from '../src/workspace'
import { AUD, TEAM, accessStandIn } from './keys'
import { memoryStore, openLocalD1 } from './local-d1'
import { testSealEnv } from './seal-fixture'

// Northfield's Access, and a second company's: each publishes its keys at its own team domain only.
export const LANE_TEAM = 'brightwater.cloudflareaccess.com'
const standIns: Record<string, Awaited<ReturnType<typeof accessStandIn>>> = {
  [TEAM]: await accessStandIn(TEAM),
  [LANE_TEAM]: await accessStandIn(LANE_TEAM),
}
const sealEnv = await testSealEnv()

// 2026-10-31 13:00 Pacific.
export const NOON = Date.UTC(2026, 9, 31, 20, 0)
export const TESSA = { email: 'tessa@northfield.example' }
export const MASTER_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')

/** The Worker over `install` (Northfield's by default), behind that company's own Access. */
export function harness(extraEnv: Partial<Env> = {}, install: Install = bundledInstall) {
  const access = standIns[install.teamDomain] ?? standIns[TEAM]!
  // The operator the helpers act as: the install's owner (Tessa in Northfield's), signing in at the declared address.
  const owner = { email: install.people.find((p) => install.isOwner(p))!.signIn }
  let clock = NOON
  const app = createApp({ fetch: access.deps.fetch, now: () => clock, install })
  let env: Env
  let sqlite: ReturnType<typeof openLocalD1>['db']
  let files: ReturnType<typeof memoryStore>
  // The mail binding, faked: every message is kept here, and a test can make the next ones fail.
  const outbox: Outgoing[] = []
  const mail = { failWith: null as string | null }
  // The Clients part, stood in for: forms takes a Client's names from it (src/client-names.ts), so a client is set up for a Client made here first.
  let clients: DevClients

  const reset = () => {
    resetJwksCache()
    clock = NOON
    const local = openLocalD1()
    sqlite = local.db
    files = memoryStore()
    outbox.length = 0
    mail.failWith = null
    clients = devClients()
    env = { DB: local.d1, FILES: files, ASSETS: { fetch: async () => new Response('asset') }, CF_ACCESS_AUD: AUD, FORMS_DATA_KEY: MASTER_KEY, CLIENTS_READ: clients.face, ...sealEnv, EMAIL: { send: async (m: Outgoing) => (mail.failWith ? Promise.reject(new Error(mail.failWith)) : (outbox.push(m), { messageId: `msg-${outbox.length}` })) }, ...extraEnv }
  }
  reset()

  async function request(headers: Record<string, string>, method: string, path: string, body?: BodyInit | null, host = 'space.northfield.example') {
    const res = await app.request(`https://${host}${path}`, { method, headers, body }, env)
    return res
  }

  async function call(claims: Record<string, unknown> | null, method: string, path: string, json?: unknown, opts: { host?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers }
    if (claims) headers['cf-access-jwt-assertion'] = await access.sign({ exp: Math.floor(clock / 1000) + 600, ...claims })
    if (json !== undefined) headers['content-type'] = 'application/json'
    const res = await request(headers, method, path, json === undefined ? undefined : JSON.stringify(json), opts.host)
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, body: (type.includes('json') ? await res.json().catch(() => null) : null) as any, headers: res.headers, res }
  }

  return {
    reset,
    outbox,
    mail,
    /** The signing core over this harness's bindings and clock, for what no route exposes yet (an agent's actions). */
    core: () => coreFor(env, () => clock, install),
    call,
    request,
    app,
    sign: access.sign,
    /** This company's Access stand-in, for the reads the space asks over the binding: its key fetch, and the harness clock. */
    access: { fetch: access.deps.fetch, now: () => clock },
    install,
    /** An assertion signed by another organisation's Access (its key, its issuer), for a person who is not of this install's team. */
    signAs: (team: string, claims: Record<string, unknown>) => standIns[team]!.sign({ exp: Math.floor(clock / 1000) + 600, ...claims }),
    env: () => env,
    files: () => files,
    /** The install's owner, named for Northfield's; in another company's install it is that company's owner. */
    tessa: (method: string, path: string, json?: unknown) => call(owner, method, path, json),
    setClock: (ms: number) => (clock = ms),
    sql: <T = Record<string, unknown>>(text: string, ...binds: unknown[]) => sqlite.query(text).all(...(binds as any[])) as T[],
    /** The Clients part's stand-in: make a Client here, change or archive it, or take it down. */
    clients: () => clients,
    /**
     * A Client made in the stand-in (its names are `display_name` and `legal_name`, which are the Client's and not the request's) and signing set up for it. The rest of `overrides` are the signing settings.
     * Returns the row as the admin sees it, and the Client's number with it.
     */
    async makeClient(overrides: Record<string, unknown> = {}) {
      const { display_name = 'Pinecrest', legal_name = 'Pinecrest Roofing, CPAs', ...settings } = overrides
      const client = clients.add({ name: display_name as string, legalName: legal_name as string })
      const r = await call(owner, 'POST', '/admin/api/clients', { slug: 'pinecrest', client_number: client.number, reply_to: 'office@pinecrest.example', ...settings })
      if (r.status !== 201) throw new Error(`makeClient failed: ${r.status} ${JSON.stringify(r.body)}`)
      return r.body as { id: string; slug: string; display_name: string; client_number: number }
    },
  }
}
