// Meet's guests' side, as the space's Worker answers it (the space's ADR 0018): the call API under `/r/api`, Telnyx's webhook at
// `/r/api/phone/webhook` and the channel guests' API under `/w/api`, with its live socket. These are the routes of meet's own call page and channel guests (app.ts `mountCalls`, workspace-routes.ts `mountWorkspace`), mounted at the
// paths above and at nothing else: no `/start`, no development door, no `/api/...`.
//
// Every route authenticates itself with the credential its path takes (a call's name and a member token, meet's session cookie or a socket ticket, Telnyx's signature) and none reads the Access assertion, which
// is not there: the edge passes these paths through with no sign-in (the Access bypass applications the install kit makes for the guest paths). Nothing here imports the Workers runtime, so `bun test` drives it.

import { type Context, Hono } from 'hono'
import { type Deps, answerError, mountCalls } from './app'
import { CALL_API, GUEST_API } from './model'
import { LINE } from './phone-line'
import { mountPhonePublic } from './phone-routes'
import { mountWorkspace } from './workspace-routes'

export function createGuestApp<E extends { Bindings: object }>(depsOf: (c: Context<E>) => Deps) {
  const app = new Hono<E>()
  const deps = (c: Context) => depsOf(c as unknown as Context<E>)
  app.onError(answerError)
  app.notFound((c) => c.json({ error: 'Not found' }, 404))
  // The workspace's guests first, so the socket route, whose response must not be rebuilt, never passes through a middleware that touches headers.
  mountWorkspace(app as unknown as Hono, deps, GUEST_API)
  mountPhonePublic(app as unknown as Hono, deps)
  // Calls are a switch: an install without it answers none of the call API (a guest's page, token and media), whoever has a link. Telnyx's webhook above is the phone's and answered by its own switch.
  app.use(`${CALL_API}/*`, async (c, next) => {
    if (!deps(c).install.has('calls') && c.req.path !== LINE.webhookPath) return c.json({ error: 'Not found' }, 404)
    await next()
  })
  mountCalls(app as unknown as Hono, deps, CALL_API)
  return app
}
