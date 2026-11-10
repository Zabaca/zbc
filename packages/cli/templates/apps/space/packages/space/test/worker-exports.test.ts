// The Worker as it is exported (src/index.ts): the handler and the Durable Object classes it owns, and nothing else. `cloudflare:workers` exists only in the Workers runtime, so it is stood in
// for here with the base classes the stores need; a bun test cannot load the real one. The runtime treats every export of the entry module as an entrypoint and refuses to start
// when one is a string, which `vite dev` tolerates and the built Worker does not, so this holds the line (as packages/inbox/test/worker-exports.test.ts does for the inbox).
import { expect, mock, test } from 'bun:test'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}))

test('the module exports the handler and the stores’ classes, and nothing else', async () => {
  const mod = (await import('../src/index')) as Record<string, unknown>
  expect(Object.keys(mod).sort()).toEqual(['CalendarDO', 'ClientsDO', 'InboxDO', 'KnowledgeDO', 'LiveDO', 'RoomDO', 'WorkspaceDO', 'default'])
  expect(typeof (mod.default as { fetch: unknown }).fetch).toBe('function')
  // The four entrances (src/worker.ts): people and Gmail's push, Cloudflare's mail, the delivery reports, the two crons.
  for (const entrance of ['scheduled', 'email', 'queue']) expect(typeof (mod.default as Record<string, unknown>)[entrance], entrance).toBe('function')
})

test('each class is the very one the other package defines, so the old Worker and this one run the same store code', async () => {
  const mod = (await import('../src/index')) as Record<string, unknown>
  const knowledge = (await import('@space/knowledge/src/durable')) as Record<string, unknown>
  const rooms = (await import('@space/meet/src/do')) as Record<string, unknown>
  const workspace = (await import('@space/meet/src/workspace-do')) as Record<string, unknown>
  const inbox = (await import('@space/inbox/src/durable')) as Record<string, unknown>
  expect(mod.KnowledgeDO).toBe(knowledge.KnowledgeDO)
  // The inbox's class is the other package's, subclassed for ONE method (the knowledge port, asked in-process here), under the same name.
  expect(Object.getPrototypeOf(mod.InboxDO as object)).toBe(inbox.InboxDO)
  expect((mod.InboxDO as { name: string }).name).toBe('InboxDO')
  // The live object is the space's own: it was never another Worker's, and holds no store (src/live-do.ts).
  const live = (await import('../src/live-do')) as Record<string, unknown>
  expect(mod.LiveDO).toBe(live.LiveDO)
  // The calendar's store is the calendar package's own class, made new here (declared under `exports` with no transfer).
  const calendar = (await import('@space/calendar/src/durable')) as Record<string, unknown>
  expect(mod.CalendarDO).toBe(calendar.CalendarDO)
  // The Clients part's store is the clients package's own class, made new here (declared under `exports` with no transfer).
  const clients = (await import('@space/clients/src/durable')) as Record<string, unknown>
  expect(mod.ClientsDO).toBe(clients.ClientsDO)
  expect(mod.RoomDO).toBe(rooms.RoomDO)
  expect(mod.WorkspaceDO).toBe(workspace.WorkspaceDO)
})
