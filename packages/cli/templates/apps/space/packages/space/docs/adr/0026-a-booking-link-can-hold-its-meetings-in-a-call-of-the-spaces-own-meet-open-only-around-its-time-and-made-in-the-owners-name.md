# A booking link can hold its meetings in a call of the space's own Meet, open only around its time and made in the owner's name

Status: accepted. **Amends [0025](0025-a-booking-link-is-a-public-page-where-a-visitor-takes-a-free-time-and-the-calendar-makes-the-event-with-the-link-the-owner-made-as-the-word-for-it.md)** on one line (booking into the space's own Meet call was out of scope; it is a choice of the link now) and the Meet package's [0001](../../../meet/docs/adr/0001-sfu-only-rules-in-the-room-access-on-start.md) and [0006](../../../meet/docs/adr/0006-calls-in-the-space-a-call-is-a-room-with-a-record-of-what-it-is-for-and-every-link-is-meets-own.md) on one rule each (only a signed-in teammate starts a call: there is now one named exception, and a call can have a window).

## Why

A booking link made its meetings on Google Meet. A company that runs its own calls in the space may want its visitors in them: no Google account of the visitor's is needed, and the owner finds the call where the owner's other calls are. The space's calls are 8 seats with no host controls, which is what they are; the choice is the owner's, per link.

## What is decided

### 1. "Where" is one more setting of a link

`where` is `meet` (the default, and what every link made before this keeps) or `space`. It is chosen in Settings, Calendars, offered only where the install has calls switched on (`calls` of the install, the same switch as Meet's), and Settings shows which one each link uses and which one each booking was held with. A booking keeps what it was booked with: changing a link's Where changes later bookings only.

### 2. A booking on a space-call link makes a call in the owner's name

After the time is held and Google has said the owner is free, and before the Google event, the calendar asks for one call for the booking, keyed by the booking's own id (so a retry makes none): a **meeting** with the booking's title and time, whose record belongs to the owner, with the visitor named as its one invitee. The Google event is made as before (same account, same guest, Google sends the invitation) with **no Google Meet request**; its place is the call's link, on the space's host and on the path call guests already use with no sign-in (`/r/<name>`), and its description says to join there. A booking that then fails (Google refuses the event, or a held time is let go) closes its call, and while Meet does not answer the hold stays and is looked at again, so no failed booking leaves an open call. The visitor's note is still not in the event.

The calendar imports neither the inbox nor Meet: it keeps the link's Where and the booking's call (`booking.where_kind`, `call_name`, `call_link`, `call_start`, `call_closed`) and is handed a port (`BookingCalls`, the workspace contract) to make, move and close a call and to ask whether one can be made. The space's own Durable Object class `CalendarDO` is the calendar package's class subclassed in one method (`bookingCallsPort`, as the inbox's is for its knowledge port), which builds the port over Meet's own code (`packages/meet/src/booking-calls.ts`).

### 3. The call is open only around the booked time

From 30 minutes before the start until 2 hours after the end (`BOOKING_CALL_OPENS_BEFORE_MS`, `BOOKING_CALL_CLOSES_AFTER_MS`). The window is kept in the call's Room, where a join is decided, in one function (`RoomCore.admission`): before it opens and after it closes a **new** person is refused, and the lobby says where the call stands; whoever is already in carries on past the close. A call with no window (a huddle, a call link, a meeting made in the space) has none to check and is exactly as it was: its link never closes. Only a call that has a window can be moved or closed through the port: the Room refuses a window on any other call, and the Workspace refuses to move or cancel a record that is not a booking's, so no other call can be changed through it.

### 4. A move keeps the call, a cancel closes it

A move changes the call's window and its record's time; the call and its link stay. A cancel closes it: its link then says "This is not a call." to anyone who looks or tries to join. Either one that Meet does not answer for is found by the alarm (the start the window was last set for is kept with the booking) and tried again, so the Google event and the call cannot stay apart. The event's removal by the owner at Google does not close the call: only a cancel through the booking does.

### 5. When a call cannot be made

Calls switched off since the link was made, or the month's allowance used up (the meter that already refuses new calls, `TRIP_GB`), or Meet not answering: the link says "cannot be booked right now", the same sentence as an account that cannot be written to (a visitor is told nothing of why), and Settings says why. Nothing falls back to Google Meet. The allowance is read from Meet at most every half minute for a public page.

## The rule

**The one named exception to "only a signed-in teammate starts a call":** a booking link the owner made, left on and set to the space call is the owner's word for exactly one call per booking, as it already is for one Google event and invitation per booking (0025). The port acts as the install's declared owner, is handed to the calendar's object and to nothing else (no route, no face of the space reaches it), makes a call only as a meeting with a window, once for each key, and is refused by the meter like any call. It sends no mail: the invitation is Google's.

## Consequences

- **A visitor with no sign-in now causes a call to exist on the owner's allowance.** The window, the close on cancel and the booking limits of 0025 (per address, per network, per link) keep that from being a free permanent room, and the meter's refusal of new calls past its line means the worst case is the owner's own calls refused until the month ends, not a bill.
- **A guest who uses Google Calendar sees a plain link as the place, not a "Join" button.**
- **The booked call is in Meet's own list of the owner's calls** and, as the Google event it is, in Calendar and Today: the strip of meetings those two draw leaves a booking's call out (`booking = 0` in `spaceMeetings`) so it is not shown twice.
- **A page left open on a lobby that said "not open yet"** does not change by itself: Join is still pressed once it opens, and the Room decides then.
- **The call link in an invitation is a bearer of the call, as every call link is** (100 bits). Whoever has it can join inside the window.
- **A restart of the Worker** when an install takes the update; no new open path.

## What is not here

Host controls, more than 8 seats, a waiting room, the visitor choosing Where, a phone number to dial in, both links on one meeting, and changing Where for bookings already made.
