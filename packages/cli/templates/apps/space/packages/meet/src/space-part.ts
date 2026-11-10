// Meet's part of the space, as the space's Worker holds it (the company layer's ADR 0003).
//
// One value with two faces: the methods of `MeetForSpace` (space-meet.ts), called in-process with the person the space's check named, and `fetch`, which hands the dial pad's requests
// to meet's own routes (space-app.ts) for that same person. Both run over the Durable Objects the Worker binds (src/wiring.ts), whoever owns their classes
// at the moment: meet's Worker before the transfer, the space's after, and the code is the same file.
//
// Nothing here imports the Workers runtime, so `bun test` drives it.

import type { Install, MeetForSpace, SignedIn } from '@space/workspace'
import { createSpaceApp } from './space-app'
import { serveForSpace, spaceMeet } from './space-meet'
import { type MeetPartEnv, partDepsFor, spaceMeetDepsFor } from './wiring'

export interface MeetPart extends MeetForSpace {
  /**
   * A phone request (`/space/phone...`), as the space received it but for its cookie, with the person the check named. There is no socket here: a teammate's page hears of changes from the space's live object.
   * Any other path is a 404: this reaches none of meet's other routes.
   */
  fetch(request: Request, who: SignedIn): Promise<Response>
}

/**
 * The part, made once per Worker `createApp`: the Hono app inside it is built on first use and kept. `install` is the company the space serves, the one its sign-in check names people from; omitted, the
 * bundle's (`@meet/declaration`), which is the same file in a deployed Worker.
 */
export function createMeetPartFactory(install?: Install): (env: MeetPartEnv) => MeetPart {
  const named = new WeakMap<Request, string>()
  let app: ReturnType<typeof createSpaceApp<{ Bindings: MeetPartEnv }>> | undefined
  const routes = () => (app ??= createSpaceApp<{ Bindings: MeetPartEnv }>((c) => partDepsFor(c.env, c.req.url, install), (req) => named.get(req) ?? null))
  return (env) => ({
    ...spaceMeet(spaceMeetDepsFor(env, install)),
    fetch: (request, who) =>
      serveForSpace(request, (r) => {
        named.set(r, who.person.address)
        return routes().fetch(r, env)
      }),
  })
}
