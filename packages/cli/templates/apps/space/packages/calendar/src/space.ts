/**
 * The calendar as the space calls it: what the Calendar tab, Today's events and Settings, Calendars are drawn from and change. It runs INSIDE the space's Worker (the company layer's ADR 0003), a function over an `EngineApi`:
 * in the Worker the typed face of the Durable Object `CalendarDO` (src/durable.ts, reached by `engineFor` in src/store-access.ts, which src/parts.ts in the space makes), and in `bun test` the engine itself in the same process.
 *
 * EVERY METHOD is handed the person the space's ONE sign-in check named (`SignedIn`); the assertion was verified once, by the space, and is not here, and no service token comes through (a token is never a person).
 * This app's own rule is the only step left: it admits the install's owner and nobody else (the accounts are the owner's), so a teammate who is not an owner is `not-admitted`, even though Cloudflare signed them.
 */

import {
  answered,
  type CalendarForSpace,
  failed,
  type Failed,
  type Install,
  NOT_ADMITTED,
  type Refused,
  refused,
  type SignedIn,
  type SpaceReply,
} from '@space/workspace'
import type { EngineApi, Result } from './engine'

export const FAULT = 'The calendar could not answer that. Nothing was changed.'

export interface SpaceCalendarDeps {
  engine: EngineApi
  install: Install
}

/** An engine result as the contract's reply. */
function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : refused(r.reason, r.error)
}

/** The space's face, over the engine. */
export function createSpaceCalendar(deps: SpaceCalendarDeps): CalendarForSpace {
  const { engine, install } = deps

  /** Run `fn` as the owner; nothing it throws leaves as an exception, and what it throws is logged to the Worker's tail and never shown. */
  async function asOwner<R>(asker: SignedIn, what: string, fn: () => Promise<R>): Promise<R | Refused | Failed> {
    if (!install.isOwner(asker.person)) {
      console.warn('calendar: signed in but not an owner')
      return refused('not-admitted', NOT_ADMITTED)
    }
    try {
      return await fn()
    } catch (error) {
      console.error(`calendar: ${what} failed`, error)
      return failed(FAULT)
    }
  }

  return {
    calendars: (asker) => asOwner(asker, 'calendars', async () => reply(await engine.call('calendars'))),
    agenda: (asker, from, to) => asOwner(asker, 'agenda', async () => reply(await engine.call('agenda', from, to))),
    event: (asker, id) => asOwner(asker, 'event', async () => reply(await engine.call('event', id))),
    setShown: (asker, calendarId, shown) => asOwner(asker, 'setShown', async () => reply(await engine.call('setShown', calendarId, shown))),
    syncNow: (asker) => asOwner(asker, 'syncNow', async () => reply(await engine.call('syncNow'))),
  }
}
