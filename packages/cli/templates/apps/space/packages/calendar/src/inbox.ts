/**
 * The calendar as the inbox is given it, for Claude's script (the space's ADR 0023): the second face of the calendar, over the same engine as the space's, and in-process like the Clients' and the knowledge app's inbox faces.
 *
 * It takes NO person, and this is the whole of why it is safe to: the rule in front of its three writes (the owner's switch is on, the call carries the owner's instruction, both recorded) is the inbox's, applied in its router before any of
 * them is asked, and the only holder of this face is the inbox's part (packages/space/src/parts.ts hands it nowhere else). The space's own face (src/space.ts) has no method that calls a write, and `test/space-contract.test.ts` holds that.
 *
 * Every method answers a `SpaceReply` as data. What goes wrong that is not a decision (Google did not answer, the store threw) is logged to the Worker's tail with no token in it, and reported in the words below.
 */

import { answered, type CalendarForInbox, failed, refused, type SpaceReply } from '@space/workspace'
import type { EngineApi, Result } from './engine'

/** What a read that failed says. */
export const READ_FAULT = 'The calendar could not answer that. Nothing was changed.'
/** What a write that did not end cleanly says: Google may or may not have done it, so the one safe next step is to look. */
export const WRITE_FAULT = 'The calendar could not tell whether Google did that. Read `calendar events` before trying again: it may have been done.'

export interface InboxCalendarDeps {
  engine: EngineApi
}

function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : refused(r.reason, r.error)
}

export function createInboxCalendar(deps: InboxCalendarDeps): CalendarForInbox {
  const { engine } = deps

  async function run<T>(what: string, fault: string, fn: () => Promise<Result<T>>): Promise<SpaceReply<T>> {
    try {
      return reply(await fn())
    } catch (error) {
      // The message of an error here is Google's own sentence or the runtime's; the token is in neither. It goes to the Worker's tail and never to the caller.
      console.error(`calendar: ${what} failed`, error instanceof Error ? error.message : 'not an error')
      return failed(fault)
    }
  }

  return {
    events: (from, to) => run('events (for Claude)', READ_FAULT, () => engine.call('claudeEvents', from, to)),
    invite: (input) => run('invite', WRITE_FAULT, () => engine.call('claudeInvite', input)),
    move: (id, input) => run('move', WRITE_FAULT, () => engine.call('claudeMove', id, input)),
    cancel: (id) => run('cancel', WRITE_FAULT, () => engine.call('claudeCancel', id)),
  }
}
