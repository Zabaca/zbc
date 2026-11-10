// The routes meet answers INSIDE the space's Worker besides its methods (space-meet.ts): the phone's. Nothing else of meet is here: no call API, no guests' door, and no socket (a teammate's page hears of chat from the space's live object).
//
// The phone is the dial pad's own requests (phone-routes.ts, `mountPhoneTeammates`), under /space/phone; they run for the person the space's ONE sign-in check named (the company layer's ADR 0003),
// who is put in a WeakMap keyed by the very Request the app is handed (src/space-part.ts), so it is for that request alone and for nothing a later one could reach. A request the map
// does not hold is a 401, and nothing here reads an assertion or a cookie. Meet's own phone rules decide what that person may do (the declaration's `phone.people`, the owner of the line, the minutes).
//
// The guests' app (space-guests.ts) mounts nothing under /space, and this one mounts nothing of the guests': a path that is not the phone's is a 404.

import { type Context, Hono } from 'hono'
import { NOT_SIGNED_IN } from '@space/workspace'
import { type MeetPartDeps, answerError } from './app'
import { mountPhoneTeammates } from './phone-routes'

export function createSpaceApp<E extends { Bindings: object }>(depsOf: (c: Context<E>) => MeetPartDeps, named: (req: Request) => string | null) {
  const app = new Hono<E>()
  const deps = (c: Context) => depsOf(c as unknown as Context<E>)
  app.onError(answerError)
  const space = new Hono()
  space.use('*', async (c, next) => (named(c.req.raw) === null ? c.json({ error: NOT_SIGNED_IN }, 401) : next()))
  // The address that names the person, as the phone core takes it.
  mountPhoneTeammates(space, deps, (c) => named(c.req.raw) ?? '')
  app.route('/space', space)
  return app
}
