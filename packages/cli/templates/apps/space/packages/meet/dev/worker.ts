// The LOCAL Worker: meet's guests' side (the call API and the channel guests', src/space-guests.ts) and the two Durable Object classes, in workerd, for `bun run dev` and the live browser checks
// (scripts/live.ts, chat.ts, audio.ts), and for nothing else.
//
// Meet has no deployed Worker. Its team side runs in the space's Worker (src/space-part.ts), its guests' side answers at
// space.northfield.example/r/ and /w/ (the space's ADR 0018), and the two classes are the space's (Cloudflare's transfer handed them over). What this file is for is
// seeing and testing the guests' page by itself: it declares the classes new, in a local store, and has no route or address (wrangler.jsonc beside it; test/dev-worker.test.ts pins that).
//
// ⚠️ NOT EXPORTED, and nothing else may be besides the default, `RoomDO` and `WorkspaceDO`: the Workers runtime treats every export of the entry module as an entrypoint and refuses to start when one
// is a string.
import { Hono } from 'hono'
import { makeCall } from '../src/calls'
import { isLocal } from '../src/door'
import { displayName } from '../src/model'
import { createGuestApp } from '../src/space-guests'
import { type MeetEnv, depsFor } from '../src/wiring'

export { RoomDO } from '../src/do'
export { WorkspaceDO } from '../src/workspace-do'

const app = new Hono<{ Bindings: MeetEnv }>()

// For the live checks only (scripts/live.ts, scripts/chat.ts): a call, made as the space makes one. A localhost run with the development bypass alone; anywhere else it is not there.
app.post('/api/dev/rooms', async (c) => {
  const d = depsFor(c.env, c.req.url)
  if (!(d.devBypass && isLocal(c))) return c.json({ error: 'Not found' }, 404)
  const name = await makeCall({ ...d, workspace: d.workspace }, d.devTeammate)
  return c.json({ name, display: displayName(name) }, 201)
})

app.route('/', createGuestApp<{ Bindings: MeetEnv }>((c) => depsFor(c.env, c.req.url)))

export default {
  fetch: app.fetch,
}
