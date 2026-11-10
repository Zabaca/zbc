// The LOCAL Worker: forms' app (src/app.ts) and its hourly sweep (src/scheduled.ts) in workerd, for `bun run dev` and the end-to-end suites (e2e/server.ts), and for nothing else.
//
// Forms has no deployed Worker. It runs inside the space's Worker (packages/space), which hands this app the request, and answers at space.northfield.example/s/ for signers.
// What this file is for is seeing and testing forms by itself: the signer's page, the operator API, a local D1 and R2, mail written to
// disk. No project has an instance that deploys it, it has no route or address (wrangler.jsonc beside it), and test/dev-worker.test.ts pins that.
//
// IT HAS NO CLIENTS PART. In the space forms is handed the Clients part's inbox face (`Env.CLIENTS_READ`) and takes a Client's names from it; here that face is an in-memory stand-in (dev/clients.ts), seeded from the `DEV_CLIENTS` var
// (a JSON list, base64, in .dev.vars) and added to by `POST /admin/api/dev-clients` (a name and, optionally, a legal name; `PUT /admin/api/dev-clients-from` reads them from a space's local preview instead), which is answered only on localhost with `ALLOW_UNAUTHENTICATED` on, like the operator bypass it sits beside.
import { createApp } from '../src/app'
import type { Env as FormsEnv } from '../src/http'
import { scheduled } from '../src/scheduled'
import { type DevClientInput, type DevClients, clientsFromSpace, devClients } from './clients'

const app = createApp()

let clients: DevClients | undefined
const clientsFor = (env: { DEV_CLIENTS?: string }): DevClients => {
  if (clients) return clients
  let seed: DevClientInput[] = []
  try {
    seed = env.DEV_CLIENTS ? (JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env.DEV_CLIENTS), (c) => c.charCodeAt(0)))) as DevClientInput[]) : []
  } catch {
    // A malformed seed is no seed.
  }
  return (clients = devClients(seed))
}

const DEV_ROUTE = /^\/admin\/api\/dev-clients(?:\/(\d+)|-from)?$/

/** Where the Clients are read from when a space's local preview is running beside this Worker (the suites of the Forms tab), instead of the stand-in's own list. */
let spaceAt: string | null = null

async function devRoute(request: Request, stand: DevClients): Promise<Response> {
  const number = DEV_ROUTE.exec(new URL(request.url).pathname)?.[1]
  if (request.method === 'GET' && number === undefined) return Response.json(stand.all())
  const body = request.method === 'GET' ? {} : ((await request.json().catch(() => null)) as Record<string, unknown> | null)
  if (body === null) return Response.json({ error: 'Expected a JSON object' }, { status: 400 })
  if (request.method === 'POST' && number === undefined) return Response.json(stand.add(body as unknown as DevClientInput), { status: 201 })
  if (request.method === 'PATCH' && number !== undefined) {
    const changed = stand.change(Number(number), body as { name?: string; legalName?: string | null; archived?: boolean })
    return changed ? Response.json(changed) : Response.json({ error: 'No such Client' }, { status: 404 })
  }
  if (request.method === 'PUT' && new URL(request.url).pathname.endsWith('-from')) {
    spaceAt = typeof body.url === 'string' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(body.url) ? body.url : null
    return Response.json({ from: spaceAt })
  }
  if (request.method === 'PUT' && number === undefined) {
    // Make the Clients part unreachable (or reachable again), to see what forms says.
    stand.down = body.down === true
    return Response.json({ down: stand.down })
  }
  return Response.json({ error: 'Not found' }, { status: 404 })
}

type Env = FormsEnv & { DEV_CLIENTS?: string }

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const stand = clientsFor(env)
    const url = new URL(request.url)
    if (DEV_ROUTE.test(url.pathname)) {
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      return local && env.ALLOW_UNAUTHENTICATED === '1' ? devRoute(request, stand) : new Response('Not found', { status: 404 })
    }
    return app.fetch(request, { ...env, CLIENTS_READ: spaceAt ? clientsFromSpace(spaceAt) : stand.face }, ctx)
  },
  scheduled: (event: { scheduledTime: number }, env: Parameters<typeof scheduled>[1], ctx: { waitUntil(p: Promise<unknown>): void }) => scheduled(event, env, ctx),
}
