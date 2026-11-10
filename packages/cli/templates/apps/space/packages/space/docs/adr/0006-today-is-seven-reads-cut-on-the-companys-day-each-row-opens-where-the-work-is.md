# Today is seven reads, cut on the company's day, and each row opens where the work is

Status: accepted. Builds on
[0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md) (the merge Today borrows keys from) and on the
contract in `packages/workspace` (`inbox-for-space.ts`, `meet-for-space.ts`, `forms-for-space.ts`). The sections and their sources are in the table below.

**Superseded in part by [0009](0009-calls-are-cards-in-their-conversation-and-the-phone-is-meets-screen-held-by-the-shell.md):** Today now asks meet for its meetings too (an eighth read, `meetings`), shows them in Later today and Tomorrow, says why a call with people in it is shown (made, invited, or a huddle in one of the person's conversations), and lists voicemails and missed calls in Waiting on you. Where this ADR says "seven reads", "no source yet" for meetings, or that calls the person was invited to or that belong to their conversation come with that record, read 0009. The rest stands.

## What Today asks

Seven reads, in parallel, each given `ANSWER_WITHIN_MS` and each allowed to fail alone (`src/today.ts`): the inbox's `people` and `drafts`; meet's `conversations` and `liveCalls`; forms'
`documents`, three times (not yet sent, out for signature, finished since the company's midnight). The answer says how each fared (`sources`), so a part that did not answer leaves the others on the
page with one line saying what Today is missing, as Conversations does; and **Today never says "Nothing needs you" while a part is missing**. A part that says no (meet admits a teammate only, the inbox
its owner only) reads quietly, as a decision and not a fault.

| Section | From |
|---|---|
| Happening now | meet `liveCalls`: calls with someone in them that the person made |
| Later today, Tomorrow | meet `meetings` (eight reads in all; see [0009](0009-calls-are-cards-in-their-conversation-and-the-phone-is-meets-screen-held-by-the-shell.md)) |
| Waiting on you | inbox `people` (open, outside Bulk, newest message came in, or unread) and meet `conversations` (unread direct messages; a channel's unread messages are not "waiting on you") |
| Drafts not sent | inbox `drafts`, and forms' `documents` in state `draft` |
| Waiting on others | forms' `documents` in `sent`, `prepared`, `sealing`, with `notSigned` |
| Signed and back | forms' `documents` in `completed`, finished since the company's midnight |

## Calls: one new read in meet, and who made a call

Meet's index of calls (the ledger instance's `calls` table) held a name and a time, and only the owner could make a call. Today shows a person the calls that are theirs, so the index now
records **who made the call** (`started_by`, the declaration's address for the person, written by the start route), and `SpaceMeet.liveCalls` looks inside the newest 30 calls in the index, asks each
call's own object who is in it now, and answers those with someone in them that the asker made. A call made before the column existed has no maker and is read as the owner's, the only person who could
make one. Calls the person was **invited to**, and calls that **belong to their conversation**, come with [0009](0009-calls-are-cards-in-their-conversation-and-the-phone-is-meets-screen-held-by-the-shell.md) (`MeetLiveCall.why` says which). Nothing about the people in a call, or its
chat, is in the answer. The link to join is made by the page on meet's own address (`https://meet.<your-domain>/r/<name>`, from the origin `Me` says meet is at), opens in a tab of its own, and is never
on the space's address.

## "Today" is the company's day

The Worker runs in UTC, the browser is wherever the person is, and neither is the company's. "Completed today" is since midnight **in `company.timeZone`**, and Later today and Tomorrow are the two days
that follow the moment it is asked, cut the same way. The day is found from the zone's own clock (`dayAround`), so it is 25 hours long on the day California's clocks go back and 23 on the day they
go forward, and a document finished at 11:59 pm Pacific is yesterday's although in UTC it is the same day. A meeting's time is shown on the company's clock, with the zone named.

## A row is a handle, and the page makes the link

Today holds nothing to act on, so a row carries a fact and a handle: the key of the conversation it opens (the same key the Conversations list gives that person, taken from the same merge, so the
conversation view opens it; a contact with no row opens by `mail:<contactId>`), a call's name, a document's id. **No address is built in the Worker.** A document carries no conversation until [0010](0010-a-document-sent-from-a-conversation-carries-one-ref-and-is-found-by-any-and-the-card-is-forms-read-drawn-by-time.md), so
every document opens in the Forms tab at its own page (`/forms#/envelopes/<id>`, which is now `/forms/envelopes/<id>`: [ADR 0007](0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md); forms' own route, which forms keeps after the hash); Forms is its own sign-in, so that link is a full page load. A row's
"where" tag says Conversations, Forms or Meet.

A thread several of one person's contacts, or several people, are on is one row naming them all. A section shows its newest twelve and says how many more there are, with a link to where they are;
an app that had more than one screen says so once. No message body and no draft body is in the answer: the last line said, a subject, a name.

## Not here

- **Live updates.** Today is read again when the page is shown again, once a minute while it is visible, and when the service worker says a notification was kept quiet for this page, as Conversations'
  mail is; it does not open meet's socket. A call that starts shows within a minute.
- **Meetings.** The sections and their bucketing by the company's day are built and tested with literal meetings; the page says meetings are not listed yet, and says there are none only once something lists them
  (`meetingsListed`). How a meeting is made is in ADR 0009.
- **@mentions, voicemails and missed calls** in Waiting on you: they exist when meet's mentions and the phone do.
