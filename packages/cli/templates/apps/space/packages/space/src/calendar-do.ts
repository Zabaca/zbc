// The calendar's Durable Object class, as this Worker defines it (the space's ADR 0026).
//
// The class is packages/calendar/src/durable.ts, with ONE difference that is this Worker's environment and not behaviour: the way to make, move and close a call in the space's own Meet, for a booking link set to hold its meetings there. The calendar package imports
// neither the inbox nor Meet, so it cannot build that itself; this Worker holds both, so the subclass builds it over Meet's own code (packages/meet/src/booking-calls.ts) and the calendar is handed it as a plain port. The subclass overrides that method and nothing else,
// under the same exported name (the class's identity is its name).

import { CalendarDO as CalendarStoreDO } from '@space/calendar/src/durable'
import { bookingCalls } from '@space/meet/src/booking-calls'
import { BUNDLED_INSTALL } from '@space/meet/src/company'
import { spaceMeetDepsFor } from '@space/meet/src/wiring'
import { type PartsEnv, meetEnvOf } from './parts'

export class CalendarDO extends CalendarStoreDO {
  /** The Meet this Worker holds, as the owner's: absent while its two stores are not bound (a transfer in the middle), when no booking link can hold a meeting in a call. */
  protected override bookingCallsPort(env: ConstructorParameters<typeof CalendarStoreDO>[1]) {
    const worker = env as unknown as PartsEnv
    if (worker.ROOMS === undefined || worker.WORKSPACE === undefined) return undefined
    return bookingCalls(spaceMeetDepsFor(meetEnvOf(worker), BUNDLED_INSTALL))
  }
}
