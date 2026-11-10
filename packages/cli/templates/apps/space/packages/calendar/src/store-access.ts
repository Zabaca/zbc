import type { CalendarAccess, CalendarGrant, LiveBinding } from '@space/workspace'
import type { CalendarDO } from './durable'
import type { EngineApi, EngineMethod } from './engine'

/**
 * How a Worker reaches the calendar's store: the object's name and the typed face of its untyped `call`. No runtime import (`CalendarDO` is a type here), so `bun test` loads it, and it is the one place the name lives
 * for the callers: the space's Worker (the part, src/parts.ts, and the push entrance, src/worker.ts) and the tests.
 *
 * ── ONE OBJECT, NAMED BY A CONSTANT ──────────────────────────────────────
 * One calendar per install, in one object. Renaming the constant is a new, empty calendar (which reads Google again in full: nothing in it is the only copy of anything).
 */
export const CALENDAR_NAME = 'calendar'

/**
 * The name of the inbox's store object (`INBOX_NAME` in packages/inbox/src/store-access.ts), written here again because this package must not import the inbox (its source needs the inbox's own declaration alias to
 * compile). The space's test/wrangler.test.ts holds the two equal; a rename of one without the other would ask a different, empty inbox who is connected.
 */
export const INBOX_OBJECT_NAME = 'inbox'

/** The Worker's environment as the calendar reads it. Everything but the bindings is a plain value of the space's Worker settings (the install kit's output). */
export interface CalendarEnv {
  /** The company's live object (the space's `LIVE`), told after a change is stored. Absent where none is bound; nothing is then told. */
  LIVE?: LiveBinding
  /** The calendar store: this Worker's own class `CalendarDO`. */
  CALENDAR: DurableObjectNamespace<CalendarDO>
  /** The inbox's store, asked in-process for who is connected and for a calendar-only access token (never a refresh token). */
  INBOX: DurableObjectNamespace
  /** The https address Google's notifications are sent to (`https://inbox-push.northfield.example/calendar/push`). Unset: no channels are made and the safety resync alone keeps the calendar current. */
  CALENDAR_PUSH_URL?: string
}

/**
 * The inbox's store as the calendar asks it: who is connected, and a calendar-only access token. A fresh stub for EVERY call, never one kept: the calendar object lives for as long as it is not restarted, and a stub
 * whose target was reset or aborted (the owner's restart route of the inbox does that, with `ctx.abort`) is broken for good and fails every call after it (it once did, after an owner-triggered restart) until the holder
 * itself restarts. Cloudflare's documentation says such a stub must be recreated; getting one is cheap.
 */
export interface InboxFace {
  grants(): Promise<CalendarGrant[]>
  access(address: string, fresh: boolean): Promise<CalendarAccess>
}

export const inboxFor = (env: Pick<CalendarEnv, 'INBOX'>): InboxFace => {
  const call = (method: string, args: unknown[]) =>
    (env.INBOX.get(env.INBOX.idFromName(INBOX_OBJECT_NAME)) as unknown as { call(method: string, args: unknown[]): Promise<unknown> }).call(method, args)
  return {
    grants: () => call('calendarGrants', []) as Promise<CalendarGrant[]>,
    access: (address, fresh) => call('calendarAccess', [address, fresh]) as Promise<CalendarAccess>,
  }
}

/** The typed face of the object's untyped `call`. Also a fresh stub per call, for the same reason. */
export const engineFor = (env: Pick<CalendarEnv, 'CALENDAR'>): EngineApi => ({
  call: (method, ...args) =>
    (env.CALENDAR.get(env.CALENDAR.idFromName(CALENDAR_NAME)) as unknown as { call(method: EngineMethod, args: unknown[]): Promise<unknown> }).call(method, args) as never,
})
