# Runbook: an email's calendar part, shown as a card

An email whose only content is a calendar part (a guest's answer to an invitation, an invitation, an update, a cancellation) used to read as an empty bubble with a file under it. The inbox now reads the calendar part once, when the mail arrives, and keeps a short summary on the message; a conversation draws a card from it, a list row whose newest email has no words is listed under one line of it, and Claude's script prints that line. **One migration (20, store version 21), one-way: bookmark before the deploy, and an undo build keeps migrations 12 to 20.** No new binding, secret or switch.

## What the code does

- **The summary.** `src/calendar-summary.ts` (the reader) and the workspace package's `src/calendar-summary.ts` (the type and the words). It reads the first calendar part of an email, a person's included (it closes nothing, unlike the event key of `inbox-calendar-updates.md`): what the part is from its METHOD and SEQUENCE (REQUEST at sequence 0 an invitation, above it an update, CANCEL a cancellation, REPLY the answering guest's PARTSTAT, COUNTER a proposal of another time, anything else with an event a plain event), the first event's title, time, place, organizer and guests, whether it repeats and which occurrence, the guest's note, the iCalendar id, and how many more events the part holds. Every text is cut (title and place to 200 characters, a note to 500, a name to 100) and stripped of control characters; no link is kept; a part over 256 KB is not read; a part it cannot read is no summary and the email is stored as it always was.
- **Times** are read to moments: a UTC time, a time in a zone the runtime knows, a time in a Windows zone name through the fixed table `WINDOWS_ZONES`, else through the offsets the part's own VTIMEZONE block gives. A floating time or a zone none of these resolves is kept as written with its zone's name and shown so ("the part gave no time zone", "in <zone>, which the space could not read"), never guessed. The page draws every moment on the company's clock (the declaration's `company.timeZone`).
- **At arrival, in each parser.** The Gmail parser reads the part from the message as fetched. Gmail often keeps a file's bytes apart (an `attachmentId`): then the Mailroom asks Gmail for that one file (`getAttachment`, a second call, for a calendar email only: `Mailroom.parse`). That call failing leaves the email stored with no summary (NULL, so the pass below may read it) and never fails the sync. The raw-mail parser (a business mailbox, and the install's own mail server through the same code) reads it from the parsed message. Telegram has none.
- **The column.** `message.calendar`: the summary as JSON; the text `none` for a message looked at that has no summary; NULL for one not looked at.
- **What the space is told.** A message in a conversation answer carries its summary (`InboxMessage.calendar`, with `fromYou`: the organizer is the person asking, or for the owner any address of theirs). A list row whose newest email has no words carries the summary's one line as its snippet (`MailStore.listLine`). Claude's `conversation` carries the summary on each message and, on one with no words, `calendarLine`. The send rule and the script's commands are unchanged.
- **The one-time pass over mail already stored** (`Mailroom.summariseStoredCalendarMail`, the sibling of the event-key pass and shaped the same): stored inbound Gmail mail with no summary and not looked at, that lists a calendar file (declared type, or a name ending in .ics), carries an event key, or has no words, is read again from Gmail (the calendar file asked for when Gmail keeps it apart) and summarised as new mail is. At most 100 a run (`CALENDAR_PASS_PER_RUN`), with the alarm asked for again while more are left; `none` is recorded so nothing is read twice; an account in its backoff or with a lapsed grant is left for later and the pass is not done while it has mail left; three failures in a row end the run (`CALENDAR_PASS_FAILURES`); one message Gmail will not give is logged and recorded `none`. A setting row (`calendar_summaries_backfilled`) says it is done, and the audit trail has `message.calendar-summaries-backfilled`. **It runs after the run's notifications**, never before them. A business mailbox's and the mail server's old mail is not passed over: it shows its card only if its calendar part arrives again.
- **Safe to stop and resume.** Each message is recorded as it is read, in its own statement; the candidates are always "no summary and not looked at", so a run cut short by the object restarting, an alarm limit or Gmail failing leaves the rest for the next run.

## Before the deploy

1. `bun scripts/inbox.ts bookmark` and note the bookmark (the undo point; migration 20 is one-way).
2. Note the counts (`bun scripts/inbox.ts mailbox`: messages and conversations).

## Apply

An apply of the space (the inbox runs in its Worker): `bunx @zabaca/zbc apply <env> space`. It is the operator's word to deploy.

## After the deploy

1. The counts are unchanged (the migration adds a column and rewrites nothing).
2. The first alarm after the deploy starts the pass: with about 1,400 stored messages only the candidates are read (a calendar file in the list, an event key, or no words), most likely a few dozen to a hundred or so, in one or two runs of up to 100, each a Gmail read per message and a second for a file kept apart: about a minute in all. `wrangler tail <space worker>` shows `mailroom: reading stored calendar summaries failed` only if Gmail refused, and `message.calendar-summaries-backfilled` is in the audit trail once it is done.
3. Open the conversation of someone who answered an invitation: a card ("<guest> accepted", declined, said maybe, proposed a new time) in place of the empty bubble, the file's chip under it, the time on the company's clock. The Inbox list's line for it says the same words.
4. The calendar files are written to the documented shapes in the tests, not captured: read one real invitation, one real update, one cancellation and one real answer, and compare the card with Gmail's own. A Gmail calendar file that does not show is worth a look at `message.calendar` (`none` means the part held no event or could not be read; NULL means the file could not be fetched at arrival and the pass has not reached it).
5. Open in Calendar (the owner, where the event is in the Calendar tab) opens that event's card.

## Undo

Redeploy a build of the old code that still carries migration 20 (the column stays, unused): cards and lines go, nothing else changes. Or restore the bookmark.
