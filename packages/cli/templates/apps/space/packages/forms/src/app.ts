// The API. Hono over the Db slice in records.ts, importable without the Workers runtime so `bun test` drives real
// requests through the real router against the real migration (test/local-d1.ts).
//
// Two doors, two prefixes (forms runs inside the space's Worker, which hands this app the request; forms has no address of its own):
//   /admin/api/*  an operator's: the space's check has named the person, or the Forms application's assertion is verified here.
//   /s/api/*      the public side, open to signers at the space's `/s/` path: no sign-in, every request authenticates itself (the
//                 recipient's token), and the rate limit runs first. A client's logo is on it too, which an email loads.

import { type Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { identify as identifyPerson } from '@space/workspace'
import { readLimited } from './body'
import { sha256Hex } from './bytes'
import { clientFields, clientNumber, logoType, slug } from './clients'
import { namesProblem, ownCompanyProblem, readClient, readClients } from './client-names'
import { type App, type Deps, type Env, actor, db, nowMs } from './http'
import { LIMITS, inspect } from './pdf/engine'
import { type Stage, sealCheck } from './pdf/seal-check'
import { ADMIN_API, PUBLIC_API } from './routes'
import { sealedSample } from './pdf/sample'
import { type Row, newId } from './records'
import { MAX_LOGO_BYTES } from './settings'
import { SealerUnconfigured, loadSealer } from './seal/sealer'
import { badRequest, conflict, create, decode, get, notFound, run, update } from './store'
import { VaultUnconfigured, createVault, getSealed, putSealed } from './vault'
import { type Operator, bundledInstall, operatorOf, serviceWordsOf } from './workspace'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/** A file may be this large before the Worker refuses to read it at all; the engine's own cap (20 MB) is the one an operator is told about. */
const READ_LIMIT = 30 * 1024 * 1024

/** The header a PDF's password travels in: a query string would be written into Workers Logs with the URL. */
const PASSWORD_HEADER = 'x-pdf-password'

const tooBigPdf = () => new HTTPException(413, { message: `That file is over the ${READ_LIMIT / 1048576} MB the Worker will read; the most that can be signed here is ${LIMITS.maxBytes / 1048576} MB` })

/**
 * The operator asking, by the company layer's sign-in check: a verified Access assertion for THIS application's audience,
 * then a person of this install. Anything short of that is a refusal: no assertion or an invalid one is a 401; a verified
 * one that is not a person here (another company's, a service token, an assertion naming both) is a 403. The layer fails
 * closed at every step, an unset audience included.
 */
async function identify(req: Request, env: Env, deps: Deps): Promise<{ operator: Operator } | { status: 401 | 403 }> {
  // Inside the space's Worker the one check has been made, and this asks its answer and nothing else.
  if (deps.named) {
    const operator = deps.named(req)
    return operator ? { operator } : { status: 401 }
  }
  const out = await identifyPerson(deps.install, req.headers, { fetch: deps.fetch, aud: env.CF_ACCESS_AUD ?? '', now: deps.now() })
  if (out.ok) return out.identity.kind === 'person' ? { operator: operatorOf(out.identity.person, deps.install) } : { status: 403 }
  if (out.refusal === 'no-assertion' && env.ALLOW_UNAUTHENTICATED === '1' && LOCAL_HOSTS.has(new URL(req.url).hostname)) {
    return { operator: { email: 'local@dev', name: 'Local dev', actor: 'local@dev', owner: true } }
  }
  console.warn(`access refused: ${out.detail}`)
  return { status: out.refusal === 'no-assertion' || out.refusal === 'invalid' ? 401 : 403 }
}

/** Now, from the injected clock, as the text every row stores. */
const at = (c: Context<App>) => new Date(nowMs(c)).toISOString()

/**
 * Reading the Clients list (a Client's names, whether it is archived) is the OWNER's, as Settings' reads are (the space's ADR 0021, section 6). The routes that read it refuse any other operator; a row's `client_archived` is null for one,
 * as it is when the list cannot be read.
 */
const ownerOnly = (c: Context<App>) => {
  if (!c.get('operator').owner) throw new HTTPException(403, { message: 'Only the owner can read the Clients list.' })
}

/** Which Client numbers are archived, from the Clients part: null when the operator is not the owner or the list cannot be read. */
async function archivedClients(c: Context<App>): Promise<Map<number, boolean> | null> {
  if (!c.get('operator').owner) return null
  const held = await readClients(c.env)
  return held ? new Map(held.map((k) => [k.number, k.archivedAt !== null])) : null
}

/** Whether the Client a row belongs to is archived, or null when it is not linked or that is not known. */
const archivedIn = (archived: Map<number, boolean> | null, row: Row): boolean | null => (archived && typeof row.client_number === 'number' ? (archived.get(row.client_number) ?? null) : null)

const clientIp = (req: Request) => req.headers.get('cf-connecting-ip') ?? 'unknown'

export function createApp(deps: Deps = { fetch: (u, i) => fetch(u, i), now: Date.now, install: bundledInstall }) {
  const app = new Hono<App>()

  app.use('/admin/api/*', async (c, next) => {
    const r = await identify(c.req.raw, c.env, deps)
    if ('status' in r) return c.json({ error: r.status === 401 ? 'Unauthorized' : 'Forbidden' }, r.status)
    c.set('operator', r.operator)
    c.set('deps', deps)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      // A write from a page on another site is refused. Browsers send Origin on every non-GET request and
      // Sec-Fetch-Site on all of them; a script sends neither. Without this, a form on any site could post here
      // with the Access cookie of whoever is signed in.
      const origin = c.req.header('origin')
      if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(c.req.url).origin)) {
        return c.json({ error: 'Cross-site write refused' }, 403)
      }
    }
    await next()
  })

  // THE PUBLIC SIDE (no sign-in; every request authenticates itself) is one sub-app, mounted at `/s`: `/s/` is the one prefix of the space's host that is open to signers (the space's ADR 0018), so the
  // API they use lives under it (`/s/api/s/<token>/...`, `/s/api/logo/<id>`). The rate limit and the error answers are the sub-app's own.
  const pub = new Hono<App>()
  pub.use('/api/*', async (c, next) => {
    c.set('deps', deps)
    const limited = await c.env.PUBLIC_LIMIT?.limit({ key: clientIp(c.req.raw) })
    if (limited && !limited.success) return c.json({ error: 'Too many requests' }, 429, { 'retry-after': '60' })
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    if (err instanceof SealerUnconfigured || err instanceof VaultUnconfigured) return c.json({ error: err.message }, 503)
    // A CHECK, NOT NULL, UNIQUE or FOREIGN KEY violation is the schema refusing bad input, which is the caller's error, not ours.
    const msg = String((err as Error).message ?? err)
    const constraint = /((?:CHECK|NOT NULL|UNIQUE|FOREIGN KEY|PRIMARY KEY) constraint failed.*)$/i.exec(msg)
    if (constraint) return c.json({ error: constraint[1] }, 409)
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  // ── Public ───────────────────────────────────────────────────────────────

  // The names the service says about itself (src/service.ts), for the signer's pages: its name, who runs it, where its mail comes from and where to write about one's information. Nothing here is private: every
  // email, consent and certificate already carries these words, and the privacy notice names the owner by the name their mail carries.
  pub.get('/api/service', (c) => c.json(serviceWordsOf(c.get('deps').install)))

  // A client's logo, which a signing email loads. The one object stored without a key, because it is public by design.
  pub.get('/api/logo/:id', async (c) => {
    const client = await get(db(c), 'clients', c.req.param('id'))
    if (!client || !client.logo_key) throw notFound('Logo')
    const object = await c.env.FILES.get(client.logo_key as string)
    if (!object) throw notFound('Logo')
    return new Response(await object.arrayBuffer(), {
      headers: { 'content-type': client.logo_type as string, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', etag: `"${client.logo_sha256}"` },
    })
  })

  // ── Operator ─────────────────────────────────────────────────────────────

  app.get('/admin/api/me', (c) => c.json({ ...c.get('operator'), company: c.get('deps').install.company.name }))

  // The signing settings, each with its Client's number and whether that Client is archived (null: not linked to a Client, the Clients list could not be read, or the operator is not the owner). A row made before the Clients part existed has no number and signs as it always did.
  app.get('/admin/api/clients', async (c) => {
    const rows = (await db(c).prepare('SELECT * FROM clients ORDER BY display_name COLLATE NOCASE').all<Row>()).results
    const archived = await archivedClients(c)
    return c.json(rows.map((r) => ({ ...view(decode(r)), client_archived: archivedIn(archived, r) })))
  })

  // The active Clients that have no signing settings yet: what "Set up signing" and "Link" offer. `available` is false when the Clients list could not be read. The owner's.
  app.get('/admin/api/clients-not-set-up', async (c) => {
    ownerOnly(c)
    const held = await readClients(c.env)
    if (!held) return c.json({ available: false, clients: [] })
    const taken = new Set((await db(c).prepare('SELECT client_number FROM clients WHERE client_number IS NOT NULL').all<Row>()).results.map((r) => r.client_number))
    return c.json({ available: true, clients: held.filter((k) => k.archivedAt === null && !taken.has(k.number)).map((k) => ({ number: k.number, name: k.name, legalName: k.legalName })) })
  })

  // Set up signing for a Client: its number, the short name and the settings. The NAMES come from the Client (the Clients part's inbox face), never from the body.
  app.post('/admin/api/clients', async (c) => {
    ownerOnly(c)
    const body = await json(c.req.raw)
    const fields = clientFields(body, false)
    const shortName = slug(body.slug)
    const number = clientNumber(body.client_number)
    const client = await readClient(c.env, number)
    if (client.archivedAt !== null) throw conflict(`${client.name} is archived. Put it back in Settings before setting up signing for it.`)
    if (client.legalName === null) throw badRequest(`${client.name} has no legal name yet. Give it one on its page in Settings: a signed document names it.`)
    const problem = namesProblem({ name: client.name, legalName: client.legalName })
    if (problem) throw badRequest(problem)
    const notCompany = ownCompanyProblem(serviceWordsOf(c.get('deps').install), client)
    if (notCompany) throw badRequest(notCompany)
    if (await db(c).prepare('SELECT id FROM clients WHERE client_number = ?').bind(number).first()) throw conflict(`${client.name} already has signing settings`)
    const id = newId()
    const now = at(c)
    try {
      const row = await create(db(c), actor(c), 'clients', { id, slug: shortName, client_number: number, display_name: client.name, legal_name: client.legalName, ...fields, created_at: now, updated_at: now })
      return c.json(view(row), 201)
    } catch (e) {
      const message = String((e as Error).message)
      if (/UNIQUE constraint failed: clients\.slug/i.test(message)) throw conflict(`A client with the slug ${shortName} already exists`)
      if (/UNIQUE constraint failed: clients\.client_number/i.test(message)) throw conflict(`${client.name} already has signing settings`)
      throw e
    }
  })

  // Link a row made before the Clients part existed to a Client the operator picks. Nothing is matched by name. The row takes the Client's names (one name) and keeps its id, its logo and everything it has signed.
  app.put('/admin/api/clients/:id/link', async (c) => {
    ownerOnly(c)
    const id = c.req.param('id')
    const body = await json(c.req.raw)
    for (const k of Object.keys(body)) if (k !== 'client_number') throw badRequest(`${k} cannot be set here (allowed: client_number)`)
    const row = await get(db(c), 'clients', id)
    if (!row) throw notFound('Client')
    if (row.client_number != null) throw conflict('This client is already linked to a Client')
    const number = clientNumber(body.client_number)
    const client = await readClient(c.env, number)
    if (client.archivedAt !== null) throw conflict(`${client.name} is archived. Put it back in Settings before linking to it.`)
    const problem = namesProblem({ name: client.name, legalName: client.legalName })
    if (problem) throw badRequest(problem)
    const notCompany = ownCompanyProblem(serviceWordsOf(c.get('deps').install), client)
    if (notCompany) throw badRequest(notCompany)
    if (await db(c).prepare('SELECT id FROM clients WHERE client_number = ?').bind(number).first()) throw conflict(`${client.name} already has signing settings`)
    const patch: Row = { client_number: number, display_name: client.name, ...(client.legalName !== null && { legal_name: client.legalName }) }
    try {
      return c.json(view(await update(db(c), actor(c), 'clients', id, patch, at(c), 'link')))
    } catch (e) {
      if (/UNIQUE constraint failed: clients\.client_number/i.test(String((e as Error).message))) throw conflict(`${client.name} already has signing settings`)
      throw e
    }
  })

  app.get('/admin/api/clients/:id', async (c) => {
    const row = await get(db(c), 'clients', c.req.param('id'))
    if (!row) throw notFound('Client')
    return c.json({ ...view(row), client_archived: archivedIn(await archivedClients(c), row) })
  })

  app.patch('/admin/api/clients/:id', async (c) => {
    const body = await json(c.req.raw)
    if ('slug' in body) throw badRequest('A client\'s slug cannot be changed')
    const row = await update(db(c), actor(c), 'clients', c.req.param('id'), clientFields(body, true), at(c))
    return c.json(view(row))
  })

  // The logo is the request body itself (a PNG or a JPEG, up to 256 KB), so no multipart parser is involved.
  app.put('/admin/api/clients/:id/logo', async (c) => {
    const id = c.req.param('id')
    const client = await get(db(c), 'clients', id)
    if (!client) throw notFound('Client')
    const bytes = await readLimited(c.req.raw, MAX_LOGO_BYTES, () => badRequest(`The logo is over ${MAX_LOGO_BYTES / 1024} KB, which is the most`))
    if (bytes.length === 0) throw badRequest('The logo is empty')
    const type = logoType(bytes)
    if (!type) throw badRequest('The logo must be a PNG or a JPEG')
    const sha = await sha256Hex(bytes)
    const key = `logos/${id}/${sha}`
    await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } })
    const row = await update(db(c), actor(c), 'clients', id, { logo_key: key, logo_type: type, logo_sha256: sha }, at(c))
    if (client.logo_key && client.logo_key !== key) await c.env.FILES.delete(client.logo_key as string)
    return c.json(view(row))
  })

  // A sealed sample in the client's branding: what the first working service produces.
  app.get('/admin/api/clients/:id/sample.pdf', async (c) => {
    const client = await get(db(c), 'clients', c.req.param('id'))
    if (!client) throw notFound('Client')
    const sealer = await loadSealer(c.env)
    let logo: { bytes: Uint8Array; type: 'image/png' | 'image/jpeg' } | null = null
    if (client.logo_key) {
      const object = await c.env.FILES.get(client.logo_key as string)
      if (object) logo = { bytes: new Uint8Array(await object.arrayBuffer()), type: client.logo_type as 'image/png' | 'image/jpeg' }
    }
    const done = await sealedSample({ client: client as never, logo, sealer, service: serviceWordsOf(c.get('deps').install), at: new Date(nowMs(c)), id: newId() })
    if (!done.ok) throw badRequest(done.refusal.message)
    return new Response(done.value.bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${client.slug}-sealed-sample.pdf"`, 'cache-control': 'no-store' } })
  })

  app.get('/admin/api/audit', async (c) => {
    const client = c.req.query('client') ?? null
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500)
    const rows = (await db(c).prepare('SELECT * FROM audit WHERE (?1 IS NULL OR client_id = ?1) ORDER BY id DESC LIMIT ?2').bind(client, limit).all<Row>()).results
    return c.json(rows.map((r) => ({ ...r, before: r.before ? JSON.parse(r.before as string) : null, after: r.after ? JSON.parse(r.after as string) : null })))
  })

  // The seal's state: which certificate, until when, and the root's fingerprint a PDF's certificate page prints.
  app.get('/admin/api/seal', async (c) => {
    try {
      const s = await loadSealer(c.env)
      const daysLeft = Math.floor((Date.parse(s.notAfter) - nowMs(c)) / 86_400_000)
      return c.json({ configured: true, subject: s.subject, notAfter: s.notAfter, daysLeft, rootFingerprint: s.rootFingerprint, certFingerprint: s.certFingerprint, level: s.timestampAuthority ? 'B-T' : 'B-B' })
    } catch (e) {
      if (e instanceof SealerUnconfigured) return c.json({ configured: false, reason: e.message })
      throw e
    }
  })

  // The operator-only seal check: run the whole PDF chain on a file (the request body) or, with no body, on the
  // largest file the service accepts, and report. `?report=1` returns the report alone; otherwise the sealed PDF,
  // with the report in the x-seal-report header. The first deploy runs it with no body and reads the CPU time
  // from Workers Logs (wrangler.jsonc, limits). Every run is an audit row.
  app.post('/admin/api/seal-check', async (c) => {
    const sealer = await loadSealer(c.env)
    const body = await readLimited(c.req.raw, READ_LIMIT, tooBigPdf)
    const result = await sealCheck({ service: serviceWordsOf(c.get('deps').install), bytes: body.length > 0 ? body : undefined, password: c.req.header(PASSWORD_HEADER) || undefined, sealer, at: new Date(nowMs(c)), stage: stageOf(c.req.query('stage')), syntheticMb: Math.min(25, Math.max(1, Number(c.req.query('mb')) || 19)) })
    if (!result.ok) return c.json({ refused: result.refusal }, 422)
    const { bytes, report } = result.value
    await run(db(c), [
      {
        statements: [db(c).prepare('INSERT INTO audit (actor, action, client_id, entity, entity_id, after) VALUES (?, ?, NULL, ?, ?, ?)').bind(actor(c), 'seal-check', 'seal', report.outputSha256, JSON.stringify(report))],
        result: null,
      },
    ])
    if (c.req.query('report') === '1') return c.json(report)
    return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'x-seal-report': encodeURIComponent(JSON.stringify(report)), 'cache-control': 'no-store' } })
  })

  // What a PDF is, without sealing it: the operator's pre-flight, and the same call the PDF upload makes.
  app.post('/admin/api/inspect', async (c) => {
    const r = await inspect(await readLimited(c.req.raw, READ_LIMIT, tooBigPdf), { password: c.req.header(PASSWORD_HEADER) || undefined })
    if (!r.ok) return c.json({ refused: r.refusal }, 422)
    const { pages, fields, ...rest } = r.value
    return c.json({ ...rest, pages: pages.map(({ geometry: _g, ...p }) => p), fields })
  })

  // The vault's storage half, proven live: a throwaway object under a fresh data key (R2's SSE-C), read back with
  // the key, refused without it and with another, then deleted. The first deploy runs it; a bucket that stored the
  // object readably would show here.
  app.post('/admin/api/storage-check', async (c) => {
    const vault = createVault(c.env)
    const { key } = await vault.newDataKey('storage-check')
    const other = crypto.getRandomValues(new Uint8Array(32))
    const objectKey = `checks/${newId()}`
    const payload = crypto.getRandomValues(new Uint8Array(1024))
    const out: Record<string, unknown> = { masterVersion: vault.currentVersion }
    try {
      await putSealed(c.env.FILES, objectKey, key, payload)
      const back = await getSealed(c.env.FILES, objectKey, key)
      out.roundTrip = back !== null && back.length === payload.length && back.every((b, i) => b === payload[i])
      for (const [name, k] of [['refusedWithoutKey', null], ['refusedWithAnotherKey', other]] as const) {
        try {
          const o = await (k ? c.env.FILES.get(objectKey, { ssecKey: k.slice().buffer as ArrayBuffer }) : c.env.FILES.get(objectKey))
          out[name] = o === null ? 'missing' : false
        } catch {
          out[name] = true
        }
      }
    } finally {
      await c.env.FILES.delete(objectKey)
    }
    return c.json(out)
  })

  // The route tables (src/routes/index.ts): a new route adds a line there, not here.
  for (const mount of ADMIN_API) mount(app)
  for (const mount of PUBLIC_API) mount(pub)

  app.all('/admin/api/*', () => {
    throw notFound('Route')
  })
  pub.all('/api/*', () => {
    throw notFound('Route')
  })
  app.route('/s', pub)

  // The admin's screens are the space's own page (packages/space, the Forms tab); what they ask for is this app's operator API, above. Forms has no admin page to serve.
  return app
}

const stageOf = (s: string | undefined): Stage => (s === 'prepare' || s === 'finish' ? s : 'all')

async function json(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw badRequest('Expected a JSON object body')
  }
}

/** A client as the admin sees it: no storage keys, and whether it has a logo. */
function view(row: Row) {
  const { logo_key, logo_type, ...rest } = row
  return { ...rest, has_logo: Boolean(logo_key), logo_type: logo_type ?? null }
}

