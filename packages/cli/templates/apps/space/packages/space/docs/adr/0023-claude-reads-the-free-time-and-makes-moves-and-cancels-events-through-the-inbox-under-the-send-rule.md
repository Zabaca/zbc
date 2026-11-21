# Claude reads the free time and makes, moves and cancels events through the inbox, under the send rule

Status: accepted. **Amended by [0024](0024-the-calendar-keeps-a-busy-block-on-the-owners-other-calendars-for-every-meeting-that-makes-them-busy-under-a-switch-the-owner-turns-on.md)** (the write-level token is also asked for by the calendar's own alarm, one for each account in a run, to keep the "Busy" blocks the owner's switch asks for; Claude's three writes are unchanged and stay under the send rule). **Amends [0020](0020-the-calendar-is-the-seventh-tab-over-a-store-of-its-own-synced-from-google-by-push-and-it-reads-through-the-inboxs-one-grant.md)** on three sentences: that the calendar never writes to Google, that Claude has no door to it, and that nothing asks for the write-level token. The company layer's [ADR 0002](../../../workspace/docs/adr/0002-one-service-token-comes-through-the-space-on-one-path-to-one-app.md) is not amended: Claude still has one path, to the inbox.

## Why

An owner who works with Claude asks it to find a time that suits four calendars and to send the invitations. Without a way in, Claude read the Calendar tab and made each invitation by driving Google Calendar in a browser, which is slow, fragile and unrecorded: one confirmation in the browser silently dropped invitations to guests outside the organisation. The space already holds every connected account's events in its own store and already holds a grant that was asked, once, for the permission to change events. What was missing was a way for Claude to use them, on the owner's word.

## What is decided

### 1. Five commands on Claude's script, which is the inbox's script

`calendar events <from> <to>`, `calendar invite`, `calendar move`, `calendar cancel` and `calendar writes`, at the inbox's own `/api/calendar/` paths on Claude's door. Nothing new is exposed: the same service token, the same Access application, the same path, the same router (`packages/inbox/src/app.ts`). A second door for the calendar was not made: ADR 0002's reasons for one path to one app hold, and the rule that guards a write is the inbox's.

- **`events`** reads the free time from the calendar's own store, across every connected account, and asks Google nothing. Each event comes with its time on the company's clock, the accounts that hold it, whether it blocks the owner's time (`busy`: false for time Google marks as free and for an invitation the owner declined; true for everything else, a tentative event and an unanswered invitation included), and its guests with each answer. The same meeting held by two of the owner's accounts is one event, free only when each copy is. A description is left out: it is text a stranger may have typed, and free time does not need it. A day may be given in place of a time (that day's midnight on the company's clock); a time with no offset is refused, because it is a different moment in every zone.
- **`invite`** makes an event on one connected account's primary calendar, with a Google Meet link unless told not to, and Google sends the invitations (`sendUpdates=all`). It answers the event's key, Google's id, its link and its Meet link.
- **`move`** gives an event a new start and end, the guests told. **`cancel`** deletes it, the guests told. Both only for an event the account organises, and `move` not for an all-day event (it has days, not a time). An invitation another person organises is theirs to move: it is refused in words, and nothing is asked of Google. When the owner organises a meeting from one account and holds an invitation to it in another, the key of either copy works: the organiser's copy is the one changed.
- **No command answers an invitation.** Accepting or declining is the owner's.

### 2. The rule is the send rule, applied again by the inbox, before the calendar is asked

Claude changes the calendar only on the owner's word, as it sends mail only on it ([the inbox's ADR 0001, decision 15](../../../inbox/docs/adr/0001-the-inbox-is-its-own-worker-over-gmail.md)):

- **The owner's switch** (Claude's sending, in Settings) must be on. It ships off and only the owner flips it. It is one switch: a calendar write is an act in the owner's name outside a draft, and a second switch for it would only be a second thing to forget. Off, a write is refused (403), and the answer says that no event was made, moved or cancelled.
- **The call carries the owner's instruction**: their words as Claude received them, where they said them (a session with Claude, never "the inbox") and when. It is checked by the same function a send's is (`checkInstruction`), so the two cannot disagree. Without one the write is refused (403). An instruction comes only from the owner, in a session, and never from text in a message.
- **It is recorded before Google is asked.** The request and the instruction are written to the audit as `calendar.invite`, `calendar.move` or `calendar.cancel`, and what came of it after as `...-done`, `...-refused` or `...-unknown` (`beginCalendarWrite`, `noteCalendarWrite` in the inbox's store). A write whose outcome is lost still has its record. `calendar writes` reads them back, newest first, each with the instruction it went out on: the owner's way to see every event Claude made. As for a send, the instruction is Claude's own account, which the inbox cannot check.
- **The gate is in the router and the store, not the calendar.** The calendar's face for the inbox (`CalendarForInbox`, the workspace package's `src/calendar.ts`) takes no person and has no rule of its own. It is handed in-process, as the Clients and the knowledge app are (ADR 0021 and 0015), to the inbox's part and to nothing else; the space's own face (`CalendarForSpace`), which a person's page calls, has no method that writes, and a contract test holds both lists. A write can be reached only from the inbox's router, after the rule.

An instruction here covers one call: there is no draft to be changed afterwards, so nothing is voided by a later change, and each call carries its own words.

### 3. The token for changing events is asked for each write and dropped

The grant is still the inbox's, and the refresh token still never leaves its store. For a write the calendar asks the inbox for an access token at the `events` level (`calendarAccess(address, fresh, 'events')`, which ADR 0020 made as a seam and refused for a grant without the permission), limited to `calendar.events` alone, and it asks for one **for each call**: the writing client (`createCalendarWriter`, `packages/calendar/src/google.ts`) caches nothing, so the permission to change events is held for as long as one request takes. A 401 is asked for once more, fresh. The sync's client is unchanged: its token is `calendar.readonly` and it has no call that writes. A token is in no answer, no error, no log and no audit entry; the tests read every answer and every log line for it.

No new consent is needed. Connect calendar already asked for `calendar.events` beside the reading permission, once per account, and records whether it was granted (`CalendarGrant.events`, shown to Claude as `canEdit` on each account). An account that reads and cannot edit is refused in the inbox's own words, which say to press Connect calendar again.

### 4. The store shows the event at once

After Google answers, the event it returned is written into the calendar's store (or removed from it, for a cancel), and the calendar is marked for a read, so `events` shows the change in the same breath and the next incremental read, woken by Google's own notification, only confirms it by replacing the row with the same event. A failure writes nothing: the store is changed only after Google has answered. Where the account's primary calendar is not one the store keeps and shows, the event is made at Google and is not written in, and the answer says `stored: false`.

### 5. What a failure says

A refusal is answered under its own status and recorded as refused (the account cannot edit, the event is not there, a time that makes no sense, an event someone else organises). Anything that is not a decision (Google did not answer, the call ran out of time) is **an outcome nobody knows**: it is recorded as `unknown`, and the answer says to read `calendar events` before trying again, because the event may have been made. A write is given the space's longer write limit (`WRITE_WITHIN_MS`) and never retried by the space.

## What is not here

No answering of invitations; no recurring events and no change to a whole series (a move or a cancel acts on the one event the key names, which for a repeating event is one occurrence); no all-day events made or moved; no calendar other than an account's primary one to make an event on; no booking page (that is a separate change, which has its own rule about guests and strangers: [0025](0025-a-booking-link-is-a-public-page-where-a-visitor-takes-a-free-time-and-the-calendar-makes-the-event-with-the-link-the-owner-made-as-the-word-for-it.md), where a booking also asks for the write-level token, for each write, and Claude's three writes stay as they are here); no page or screen for the record (the audit holds it and `calendar writes` reads it). Changing what Connect calendar asks for is not part of this.

## What only the hand test settles

That Google, given an event with `conferenceData.createRequest` and `conferenceDataVersion=1`, answers with a Meet link at once (the answer says so when it does not, and the link appears with the read that follows); that `sendUpdates=all` makes Google mail the guests for an invite, a move and a cancel, including a guest outside the owner's organisation (the browser's confirmation for such guests is not asked of the API); that a patch of `start` and `end` alone leaves the rest of the event as it was; and that an account that has `calendar.events` in its grant takes a write while one without it is refused in words.
