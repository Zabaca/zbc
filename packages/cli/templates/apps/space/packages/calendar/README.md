# calendar

The calendars of the Google accounts an install has connected, in one place in the space: a Calendar tab (an agenda by day, a week and a month grid, and an event's card), Today's Later today and Tomorrow, and Settings, Calendars. Read only. Terms are in [`CONTEXT.md`](CONTEXT.md); why it was built this way is [the space's ADR 0020](../space/docs/adr/0020-the-calendar-is-the-seventh-tab-over-a-store-of-its-own-synced-from-google-by-push-and-it-reads-through-the-inboxs-one-grant.md); how to work in it is [`CLAUDE.md`](CLAUDE.md); the one-time Google step and the hand test are [`docs/runbooks/calendar-google-setup.md`](docs/runbooks/calendar-google-setup.md).

**This package is a library, with no Worker of its own.** The Durable Object class `CalendarDO` (`src/durable.ts`) is exported by the space's Worker (the space package's `src/index.ts`) and declared there as a new class; the tab, Today and Settings call this package's code in the space's Worker.

## What it is

- **A store of its own** (`src/schema.ts`, `src/store.ts`): accounts, their calendars, the events and the push channels, in one SQLite. It is a copy of Google's calendars, read again in full if lost.
- **A sync** (`src/sync.ts`, `src/engine.ts`): for each shown calendar a first full read, then incremental reads from Google's sync token, woken by Google's push notifications, with channels replaced before they end, a slow safety resync, a full read again on a 410, and a backoff on failure. Nothing polls and nothing reads through: the tab and Today read the store.
- **The inbox's one grant** (`src/google.ts`): the calendar asks the inbox's store, in-process, who is connected and for an access token limited to the calendar permission. It holds no refresh token and has no client of its own.
- **A face for the space** (`src/space.ts`; contract the workspace package's `src/calendar.ts`): `calendars`, `agenda`, `event`, `setShown`, `syncNow`, each taking the person the space's one sign-in check named and admitting the owner alone.
- **Google's notification door** (`src/push-door.ts`): `POST /calendar/push` on the push host, answered by the space's Worker (the space package's `src/worker.ts`).

## Checks (in a worktree)

```
bun install        # at the worktree root
bun run test       # from the calendar package: over a fake Google that answers as Google's documents say
bun run typecheck
```

The space's screens over the calendar's stand-in (the space package's `src/stand-in-calendar.ts`, `SPACE_FIXTURES=1`): from the space package, `bun test e2e/calendar.test.ts e2e/calendar-lapsed.test.ts` (with `CALENDAR_SHOTS=<dir>` they write each screen at 1440 and 390 pixels).
