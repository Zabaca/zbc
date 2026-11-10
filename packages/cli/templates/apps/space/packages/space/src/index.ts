// The Worker entrypoint. The router lives in app.ts so `bun test` can import it.
//
// ⚠️ NOT EXPORTED, and nothing else may be besides the default, `CalendarDO`, `ClientsDO`, `InboxDO`, `KnowledgeDO`, `LiveDO`, `RoomDO` and `WorkspaceDO`: the Workers runtime treats every export of the entry module as an
// entrypoint and refuses to start when one is a string. All six are Durable Object CLASSES; four of them this Worker owns once the transfers have handed them over (the knowledge store, meet's two and the
// inbox's); their code is the other packages' files, shared with those packages' own Workers
// (the knowledge forwarder, meet's guest side; the inbox's class is a subclass here, see src/inbox-do.ts), and they are declared in the Worker's settings under `exports` (and,
// before the transfer, bound by the owning Worker's name). `LiveDO` (src/live-do.ts) and `CalendarDO` (the calendar's store, packages/calendar/src/durable.ts; the space's ADR 0020) and `ClientsDO` (the Clients part's store, packages/clients/src/durable.ts; the space's ADR 0021) are the three that were never another Worker's: all are declared as NEW classes under `exports`, `LiveDO` holding no store, `CalendarDO` a copy of Google's calendars that is read again in full if it is lost, and `ClientsDO` the one list of Clients, which is NOT a copy: a Client made in the space is only there.
// Each part the other apps hand over adds its classes here, and test/worker-exports.test.ts pins the list.
import { createApp } from './app'
import { createWorker } from './worker'

export { CalendarDO } from '@space/calendar/src/durable'
export { ClientsDO } from '@space/clients/src/durable'
export { InboxDO } from './inbox-do'
export { KnowledgeDO } from '@space/knowledge/src/durable'
export { LiveDO } from './live-do'
export { RoomDO } from '@space/meet/src/do'
export { WorkspaceDO } from '@space/meet/src/workspace-do'

const app = createApp()

// The entrances are src/worker.ts: people and Gmail's push on `fetch` (told apart by hostname), Cloudflare's mail on `email`, the delivery reports on `queue`, the two crons on `scheduled` (the daily pass
// and meet's five-minute sweep). The cron triggers are in this Worker's wrangler file, and in no other Worker's.
export default createWorker({ team: (request, env, ctx) => app.fetch(request, env, ctx) })
