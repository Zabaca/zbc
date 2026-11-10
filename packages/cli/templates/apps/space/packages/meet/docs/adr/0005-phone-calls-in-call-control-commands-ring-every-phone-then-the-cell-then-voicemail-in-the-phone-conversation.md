# Calls in: Call Control commands from meet's webhook, a leg for each phone, the cell screened with "press 1", and voicemail in a Phone conversation only the install's people are in

Status: accepted, for taking calls only. The product choice: meet rings every registered teammate at once for 20 seconds; then the line's cell rings for 15 seconds, showing the caller's own
number, screened with "press 1 to answer" if Telnyx supports that; then a voicemail of up to 3 minutes. Voicemails are kept until
deleted and emailed without the audio. No live call is ever recorded. Phones in meet calls (a bridge) are not built.

As with [ADR 0004](0004-phone-telnyx-behind-one-client-calls-held-until-meet-approves-rules-in-the-workspace-object.md), the code was written from Telnyx's public documentation before any account existed, and none of the requests was run then.
What the documentation does not say is listed in "What is not confirmed", and each of those is a step of the hand test at the end.
Nothing here can be tried against Telnyx from a development checkout; the tests run the real rules against a fake Telnyx that records what it
was asked, and the browser check plays Telnyx's events through the stand-in's unsigned route.

## 1. The mechanism: Call Control commands from the webhook, not TeXML

Telnyx offers two ways to say what happens to a call to a number: **Call Control** (the call arrives as a webhook event, the application
answers with commands, each command is a request to `/v2/calls/...`) and **TeXML** (the application answers the webhook with an XML
document, and Telnyx carries it out: `<Dial>` with several `<Number>` or `<Sip>` nouns, `<Gather>`, `<Record>`).

meet uses **Call Control**, because calls out already are Call Control (ADR 0004) and because of what the rules for calls in need to see:

- **The connection is already a Call Control one.** The credential connection has a webhook (`webhook_api_version: 2`) and parks calls,
  and the number is attached to it. A TeXML plan needs the number on a TeXML application, which is a different connection with its own
  webhook that answers with XML. That would put the line's two halves on two kinds of connection, with the browser phones (credentials on
  the first) reached from the second only through `<Sip>`, which nothing here proves.
- **The rules need each event, in the Workspace object.** First to answer wins and the rest are let go, the cell is skipped past the
  month's cap, a cell that does not press 1 is let go, minutes are counted per leg once, and a recording becomes a message and emails.
  `PhoneCore` already takes one event and returns actions as data (ADR 0004, section 3); calls in add the stages to it, with the same
  tests over real SQLite. A TeXML plan would put the sequence in Telnyx's hands and give meet only the callbacks, so the decisions would be
  split between an XML document and the events about it.
- **Press 1 is a documented Call Control command.** `gather_using_speak` says a prompt and waits for keys on an answered leg, and reports
  `call.gather.ended`. (TeXML's equivalent is `<Number url=...>` returning a `<Gather>`. It is not needed.)
- **Ringing several phones at once** is the one place TeXML looked easier ("Telnyx's TeXML dial rings several browsers at once").
  The Call Control `Dial` documents `to` as "a DID or SIP URI ... Multiple DID or SIP URIs can be provided using an array of strings" and
  does not say whether they ring together or one after another. So **meet makes one leg per person**, which is documented and ordinary,
  and decides the winner itself: the first `call.answered` meet receives takes the call (the core is single threaded, so two answers a
  moment apart are told apart exactly), and every other leg is hung up.

The price is the same in both (Telnyx's per-minute API charge counts on every leg). Nothing here uses the
transfer command, which costs $0.10 each time (ADR 0004, section 2): every leg is a `Dial`.

## 2. The flow

A call to the line's number arrives as `call.initiated` with `direction: incoming` and `state: parked`. It is held parked, **not
answered**, so the caller hears ringing, until someone takes it or the voicemail starts. The core works it in stages; each is started by an
event and described to the router as actions.

| Stage | Starts when | What meet asks Telnyx |
|---|---|---|
| meet | the call arrives | one `Dial` per teammate with a phone registered, to `sip:<their credential's user name>@sip.telnyx.com`, `link_to` the parked call, `bridge_intent: true` (so Telnyx shows the caller's own number), `timeout_secs` the line's ring seconds (20), no `bridge_on_answer`, no recording |
| taken | a ring leg's `call.answered`, the first one | `hangup` the other ring legs; `answer` the parked call; when its `call.answered` arrives, `bridge` it to the ring leg |
| cell | every ring leg has ended unanswered (or none was made), a cell is set, and the month's minutes are not used up | one `Dial` to the cell, same link and intent, `from` the caller's number, 15 seconds |
| screening | the cell leg's `call.answered` | `gather_using_speak` "Call for `<company>`. Press 1 to answer." on the cell leg: one key, only `1`, one try |
| taken (cell) | `call.gather.ended` with digits `1` | `answer` the parked call, then `bridge` it to the cell leg |
| voicemail | the cell is skipped, did not answer, or did not press 1 | `answer` the parked call; on `call.answered`, `speak` the greeting; on `call.speak.ended`, `record_start` (mp3, one channel, a beep first, at most 180 seconds); on `call.recording.saved`, a voicemail |

Everything else is bookkeeping: a ring leg's hang-up (declined, timed out, could not be reached) ends only that leg, and the call moves on
when none is left; the caller's hang-up at any point ends every other leg; a call that was taken ends when the person (or the cell) hangs up.

**The cell's `from` and a refusal.** The cell shows the caller's own number. Telnyx documents that with `bridge_intent`
the new leg's `from` is overwritten by the linked call's, which is what is wanted. If Telnyx nevertheless refuses a `from` that is not one
of the account's (a 400 or 422), meet rings again from the line's number, so a person's phone rings with the wrong number rather than not
at all.

**Registration.** Telnyx has no list of who is logged in, so meet rings every teammate who has a credential (everyone who has ever
opened the phone). A phone that is not logged in fails at once (its leg hangs up), which is the same as having declined. The page's
registration is that of calls out: one tab, one login.

**No cell set, no cell ringing.** The cell and the ring seconds are the line's settings (section 6). With no cell set, or the month's cap
reached, the call goes from meet straight to voicemail. Nothing in the repo holds a number; the cell is set in the page.

**Never refused.** A call in is never refused or cut short by the month's cap, the 911 setup, or anything else: past the cap only the cell
is skipped, because it is the only leg that costs meet a second billed leg on purpose. A call with nobody to ring and no cell is answered
and takes a message.

**Only a call that is still live is worked.** A call whose caller has hung up, or that has been wound up, is not rung, answered, greeted or
recorded for any more: the ring legs' and the cell's hang-up reports that follow the caller's own (Telnyx reports each) end them and go
no further, so the cell is never dialed for a caller who is gone. The same holds for the cron's tidy-up and for a ring request that
Telnyx refuses after the caller left.

**The voicemail caller is let go.** When the recording is saved meet hangs up the caller's leg (a silent caller, an answering machine or a
robocall would otherwise stay on and be counted against the month). If the greeting or the recording never finishes, the cron hangs the
caller up once the greeting, 3 minutes and a margin have passed (`VOICEMAIL_DEADLINE_MS`, 270 seconds from the answer; the cron runs every
5 minutes, so at most about 10), and counts what it ran.

**Events out of order.** A leg whose hang-up is processed before its answer is over: the answer is recorded, its minutes are counted (as
for a call out), and nothing is sent to it. A person (or the cell) who took the call and left before the caller's own answer arrived sends
the caller to the voicemail without a second `answer`: the one already on its way starts the greeting.

## 3. What is trusted about an event, and what the rules for calls out do now

ADR 0004 left "an incoming call" alone because it did not exist yet. It exists now, and **it is decided before every rule written for a
call out**, so nothing written for those can swallow it or mistake it:

- A call to meet's number is `call.initiated`, direction `incoming` (or `inbound`), whose `to` is the line's number or the emergency number
  of a person on the phone list (a dispatcher's callback may come to either). Whatever its state, whoever called, it is one. It carries no
  ticket and needs none; it is never hung up for lacking one, and never logged as refused.
- A **911 dispatcher's callback**, which calls out left unanswered, arrives as exactly this and rings like any other call: past the cap, with
  no 911 setup, with nobody registered (then it is answered and takes a message).
- The **in-flight rule** (an event with no browser client state, for a number meet is dialing this moment, is meet's own leg) applies only to
  events that are not a call in. A test places a call to the line's number while a dial to the line's number is out and shows it rings.
- The rules for **calls out are untouched**: the ticket, the nonce on the leg meet dials, the in-flight rule, the browser-call test
  ("outgoing, or Telnyx's `parked`, and never incoming"). The tests for calls out pass as written except one, whose title said an incoming
  call to the line's number is left alone; it now says a call to a number that is **not** meet's is.
- **A leg meet made for a call in is known by Telnyx's id for it, or, until the router has stored that id, by client state** of the form
  `meet:<call id>:<64-bit nonce>:<leg row>`: the nonce is the call's and the leg row says which leg. Client state alone never decides:
  the id is only taken for a leg whose row has none yet, and only with the right nonce. Forged states (a wrong nonce, no leg, another call's
  id) change nothing; a test covers each. Every leg has a row in `phone_legs` before Telnyx names it, so an event that beats the reply to the
  request that made the leg still finds it.
- A leg whose request is still out when the call moves on, or the caller hangs up, is hung up the moment it comes back (the cron asks
  again, as for abandoned legs of calls out). The leg that took the call is never one.
- Every webhook is still behind the Ed25519 signature check, and a Worker with no phone configured still answers 404.

## 4. Where the state lives

All in the Workspace object, in the phone core's own tables (ADR 0004, section 3; ADR 0001's rules). Nothing in `WS_SCHEMA` or `PHONE_TABLES`'
first statements was edited:

- **New tables** (added to `PHONE_TABLES`, every one `CREATE TABLE IF NOT EXISTS`): `phone_settings` (the cell and the ring seconds),
  `phone_legs` (every leg of a call in: the caller's, each ring leg, the cell's), `phone_voicemails` (the recording's id at Telnyx, the
  caller's number, the length, the message it posted, deleted or not).
- **New columns** (added to `PHONE_ADDITIONS`, each added by `ALTER TABLE` only when `PRAGMA table_info` says it is missing): on
  `phone_calls`, `direction`, `from_number`, `stage`, `answered_by`, `bridge_to` and `closed`; and on the workspace's `messages`, `extra`
  (added to `WS_ADDITIONS`), which holds what a message from the phone carries beside its words. A test builds a workspace as calls out left
  it (`PHONE_V1` in `test/old-schemas.ts`, with `WS_SCHEMA`, rows in both), opens it with this code, and checks every table and column
  arrived, what was there reads as before (an old call is a call out), and the new parts work on it.
- **A call in is a row of `phone_calls`** with `direction = 'in'`, and the log shows it to every teammate with the phone (it is the
  line's, not a person's). Its outcome is `ringing` while it is worked, then `answered`, `forwarded`, `voicemail` or `missed`.
- **Minutes**: the caller's leg and the cell's leg, each from its answer to its end, rounded up to the minute and counted once, in the
  month the leg ended in (as ADR 0004 said: "forwarded legs will count each leg"). A person's browser leg is not counted,
  as a call out's is not. The meter only adds: it never refuses a call in. The 80% and 100% emails still come from the one place.

## 5. The Phone conversation, and who can see, play and delete

A new kind of conversation, `phone`, named "Phone", in the workspace's own `conversations` table. **Every teammate is in it from the
moment they are on the list** (it is made, and each teammate added, when they first arrive at the teammates' door, and again whenever the
phone posts), and **no one else ever is**: the only code that adds a member to it is `joinPhone`, which refuses a guest, a person off the
list and anyone not active. Its messages come from "Phone", a sender that is not a person (`person_id = 'phone'`, no row in `people`).
It reuses messages, unread, live delivery and the change feed, so a voicemail reaches every open page over the socket.

- **Only the phone posts.** The phone core is handed a `PhoneDesk` (post, remove, who to email), built by the workspace core and
  deliberately **not among `WS_METHODS`**, so the router has no way to post as the phone. The workspace's own routes refuse the Phone
  conversation: sending (403), editing (the author is not a person, 403), deleting through the message route (403; the phone's own route
  below does it), adding or inviting a person to it (400), renaming, leaving (400), archiving (404).
- **No guest, through either door.** At the guests' door (`/api/w`) the guest's bootstrap lists none, and its history, send, read mark,
  join and members routes answer 404 or 403; at the teammates' door (`/start/api/w`) a guest's cookie is no sign-in at all (401). The
  change feed gives a guest nothing of it, however far back they ask. The tests drive each route through both doors with a guest who
  is in a channel.
- **Voicemail audio is reached only through the teammates' door.** `GET /start/api/w/phone/voicemail/<message id>/audio` (a teammate, any
  teammate: the Phone conversation is every teammate's, whether or not they are on the phone list) fetches the recording from Telnyx
  by its id **each time** (`GET /recordings/<id>`, then the `download_urls.mp3` it names, fetched **without** meet's key) and passes the
  sound on: audio content type only, no caching, `Range` passed through for seeking. **The browser is never given a Telnyx address**: the
  page's player points at meet's own route, the message a browser receives names a voicemail by a number of meet's own, and a test checks
  that nothing in the answer's headers or the message mentions Telnyx. The guests' door has no phone route at all.
- **Deleting** (`DELETE /start/api/w/phone/messages/<id>`, a teammate): the recording is deleted at Telnyx (`DELETE /recordings/<id>`; a 404
  counts as gone), and only then is the message removed for everyone. If Telnyx will not delete it, nothing is deleted here and the person
  is told, so a voicemail whose sound is still stored never looks gone. A missed call's line is deleted the same way with nothing to delete
  at Telnyx.
- **The email** names the number and the length, never the audio (nothing is transcribed), with a fixed subject ("You have a voicemail on
  meet"), to each active teammate who has opened meet, under the same off switch as direct-message nudges (`nudges_off`), and counted
  in the hour's email allowance (`mail_log` kind `voicemail`, joining the other kinds in the one limit).
- **A 911 call from meet is posted here too**, which ADR 0004 left for when the conversation existed: who dialed, and the address given to
  the emergency service, once for the page's report and Telnyx's webhook of the same call together (the same one-per-two-minutes claim as
  the owner's email), after the call has been handed to Telnyx, never before. It is a record: it cannot be deleted from the page. 933,
  Telnyx's test line, posts nothing.
- **A missed call that left no message** is a line in the same conversation ("Missed call from (213) 555-0199"), with Call back. A caller
  who hangs up while the message is being recorded is waited for: the recording is saved a moment later and becomes the voicemail; if
  its event never comes, the cron's tidy-up (a call still being worked after 10 minutes, with its legs hung up) settles it as missed.

## 6. The settings, and what meet does not hold

The line's cell and the ring seconds are **settings in the page** (the Phone panel's "Calls to the number" card), kept in
`phone_settings`, **editable by an owner of the install alone** (`install.isOwner`, `packages/workspace`). Another teammate with the dial pad is refused by the server (403), sees the settings read-only (the status says `canEditLine`), and can still call and answer. The cell must be a number meet could call out to (a US number that is not
premium, Canada, the Caribbean or a territory), and never one of meet's own numbers (a call would ring itself); the ring seconds are a
whole number from 5 to 40, default 20. The cell's own ring is fixed at 15 seconds (`LINE.inbound.cellRingSeconds`). **No number is in the
repo**: with no cell set, a call goes from meet straight to voicemail, and the page says so. The emergency, cap and credit emails go to the first owner declared.

**The greeting is Telnyx's spoken voice** (`LINE.inbound.greeting`, in the voice `LINE.inbound.voice`). Recording an owner's own greeting
is **left out**: it needs the browser to record and upload sound, somewhere to keep it (meet has no file storage; Telnyx's
media storage would be a second API surface), and a playback command in place of `speak`. That is a feature of its own, not a small one.

## 7. The page

The browser phone (`@telnyx/webrtc`, behind `PhoneSdk`) now tells the page of a call ringing it (`incoming`, with the caller's number as
Telnyx names it, `answer`, `decline`). A banner above everything in the main column says who is calling with Answer and Decline, the tab's
title flashes against the usual one, and a two-tone ring (two seconds on, four off) plays from the browser's own audio (a page the browser
has given no sound yet shows the banner and flashes without it). One call at a time: a second ring while one rings or a call is on is let
go, which sends it on to the other phones, the cell or the voicemail. Declining lets only that phone go; the others ring on. The stand-in
phone of a localhost run learns of a ring from the stand-in Telnyx's record of the legs meet rang, and answers or declines through the
same unsigned route, so the browser check drives the real rules.

## Choices that might surprise

- **A leg per person, not a TeXML dial**, for the reasons in section 1; meet picks the winner.
- **The caller's leg is not answered while ringing.** Leaving it parked means the caller hears ringing and meet
  pays for no answered leg until someone takes the call. If Telnyx cannot hold it that long (the first hand-test step), the fallback is to
  answer at once and play a ringtone.
- **Minutes count the caller's leg and the cell's**, not every leg of every call: the person's browser leg is not counted, as for a call
  out (ADR 0004).
- **The settings are an owner's alone** (the line's cell, ring time and greeting), kept as one rule, not a second list. (An early build let
  any phone person change them; that was a defect, and a test now pins it.)
- **Premium exchanges** are refused inside an ordinary area code too: 976 and the N11 exchanges (311, 411, 911 ...), as a number to call
  and as the cell. ADR 0004's table refused premium by area code only, so `+1 626 976 xxxx` passed.
- **No pause switch** and **no settable monthly cap**, as in ADR 0004.
- **Left out**: a greeting recorded in an owner's own voice (section 6); dial-in and phones in meet calls.

## What is not confirmed (each is a step of the hand test)

Each of these was looked for in Telnyx's documentation and not found, or found ambiguous. The payload fields meet **assumed**
are marked.

1. **That a call to the number reaches the webhook at all.** Telnyx's webhook reference shows `call.initiated` with `direction: incoming` and
   `state: parked` for Call Control, and says an incoming call must be followed by answer, hangup or reject. It does not say a *credential
   connection* with a webhook does the same for a call to a number attached to it; one Telnyx page says inbound calls to on-demand telephony
   credentials are "limited to direct SIP URI calling". **Assumed**: `payload.call_control_id`, `to` (the number, E.164), `from`, `direction`
   (`incoming`), `state` (`parked`), `connection_id`. If it does not arrive, the number needs a Call Control application (a different
   connection) and its id in place of the credential connection's in the ring legs; the rules do not change.
2. **That a parked, unanswered incoming call keeps ringing for the caller** for as long as the stages take (up to 20 s for meet, 15 s for the
   cell, up to 6 s of screening: about 41 s at the defaults), and that the caller's carrier does not give up first. Fallback: answer at once
   and play a ringtone.
3. **That a `Dial` to `sip:<user name>@sip.telnyx.com` rings an API-made credential's logged-in browser**, and what a leg to a credential
   that is not logged in does (meet treats any hang-up of a ring leg that was not answered the same way, whatever its `hangup_cause`).
4. **`to` as an array** (several SIP URIs in one `Dial`): the documentation does not say whether they ring together. Not used.
5. **That `link_to` with `bridge_intent: true` makes the cell (and the browsers) see the caller's own number**, and name. Documented as
   "the `from` number will be overwritten by the `from` number from the linked call"; not seen. And that Telnyx accepts `from` as the
   caller's number at all (meet retries from the line's number on a 400 or 422).
6. **`timeout_secs` on `Dial`** ends an unanswered leg with `call.hangup` (documented, 5 to 600 seconds); the `hangup_cause` for it
   is not relied on.
7. **The order answer, `call.answered` on the caller's leg, then `bridge`.** Telnyx says a command on an unanswered call is refused ("has
   not been answered yet"), so meet waits for the caller's `call.answered` before bridging; whether that is needed, whether `bridge` on
   an unanswered *incoming* leg would answer it, and whether the bridged leg's hang-up ends the caller's (meet also asks) are not stated.
8. **`call.gather.ended`'s payload.** The command is documented; the event's fields are not. **Assumed**: `payload.digits` (a string, `"1"`)
   and `payload.status`. Any answer but `1`, including none, sends the caller to the voicemail, so a wrong field name sends every forwarded
   call to the voicemail rather than connecting the wrong person.
9. **That `gather_using_speak` and `speak` accept the voice and language meet sends.** The `gather_using_speak` page makes `voice` required, in
   the form `<Provider>.<Model>.<VoiceId>` or a provider name; meet sends `Polly.Joanna` with `en-US` (`LINE.inbound.voice` is the one place
   to change it) and sends `maximum_tries: 1`, `valid_digits: "1"`, `timeout_millis: 6000`. What the spoken prompts cost (Telnyx's
   text-to-speech is billed apart) is not counted in the cost estimates.
10. **`call.speak.ended`** is assumed to exist and to need no field: meet starts the recording when it arrives. If it never does, the caller
    hears the greeting and then nothing.
11. **`call.recording.saved`'s payload.** The event is documented; its fields are not. **Assumed**: `payload.recording_id`, and
    `payload.recording_started_at` and `payload.recording_ended_at` (ISO times) for the length. With the times missing the length reads
    0 sec. The recording can be saved after the caller hangs up (handled).
12. **Retrieving a recording.** `GET /recordings/<id>` documents `data.download_urls.mp3` and `.wav` and `duration_millis`; not how long a
    download link lasts (meet fetches it at once, per play), whether the storage honours `Range` (meet passes it on; a storage that
    ignores it sends the whole file), or whether the file is served with an audio content type (meet forces one).
13. **How long Telnyx keeps a recording.** Its support article says recordings "are stored for 1 year if you do not delete them", and that the
    year may change. The product promise is "kept until deleted". A voicemail older than a year may be gone from Telnyx; the player then
    says so (a 404). Copying each voicemail somewhere meet keeps would make "until deleted" true, at the cost of the audio no longer
    only living at Telnyx; that is an owner's call, not built. Whether storage is free is also not stated.
14. **`DELETE /recordings/<id>`** is documented (it returns the recording); a 404 is treated as already gone.
15. **Telnyx's own limits against what a call in uses.** The outbound voice profile allows 3 calls at once. A call in with one person's phone
    ringing is two legs (the caller's and the ring leg); with two people and the cell, up to four. Whether ring legs to SIP URIs, and the
    parked caller, count, and whether the profile's US-only and price ceiling apply to legs to a SIP URI, is not stated. If ring legs are
    refused, `LINE.telnyx.concurrentCalls` is the lever, and it is the owner's (it is a spend control).
16. **A person's own 911 number** (`phone.people` entries with their own `emergencyNumber`) must be on the connection for a callback to it to reach meet;
    the setup script attaches only the line's number. (Per-person numbers are the declaration's `phone.people`, workspace ADR 0004.)
17. **What a dispatcher's callback looks like**, beyond arriving as a call to the number (ADR 0004's step 6 said to look). Meet treats it as
    any call in.
18. **The browser SDK**, from its type declarations: `call.direction === 'inbound'`, `call.options.remoteCallerNumber`, `answer()`, `hangup()`,
    and a `callUpdate` notification in state `ringing`. Whether it raises one before `ringing` (meet treats any state that is not ended as
    ringing), and whether a background tab rings at all, are for the hand test.

## Hand test, once the account exists

From the operator's checkout, after ADR 0004's hand test has passed (the phone is Ready, a call out works). Telnyx's dashboard
call log open beside it, and `GET /start/api/w/phone` and the `Phone` conversation in the page.

1. **Settings.** In Phone, set the ring to 20 and the cell to the owner's cell. They stay after a reload.
2. **A call arrives (item 1).** Call the line's number from another phone with meet open. Telnyx's log should show a call on the connection and
   meet's webhook an incoming `call.initiated`; the page rings (banner, sound, flashing title) with the caller's number. If nothing rings
   and Telnyx's log shows the call going to a registered credential directly, or an event meet cannot read, stop here: it is item 1.
3. **The caller hears ringing, not silence (item 2).** Let it ring through to the cell: the caller should hear ringing for about 40 seconds
   and not be sent anywhere by their carrier. If they hear silence or are cut off, use the fallback (answer at once, play a ringtone).
4. **Answer in meet.** Answer it: sound both ways; hang up from either side; the log says Answered by the person with the minutes; Telnyx bills the
   caller's leg. Repeat with a second person's phone registered (two tabs of two people) and answer on one: the other stops ringing.
5. **Decline.** Decline on the only phone: the cell should ring at once, showing the caller's own number (item 5). If it shows the line's
   number, the retry in section 2 ran: see Telnyx's refusal in the Worker's log.
6. **Screening (item 8).** Answer the cell: it should say "Call for `<company>`. Press 1 to answer." Press 1: the caller is connected. Do not press
   anything (or let the cell's own voicemail answer): the cell hangs up and the caller hears the greeting. If pressing 1 does nothing,
   `payload.digits` is not the field; if the voice is refused (item 9), `LINE.inbound.voice` is wrong.
7. **Voicemail (items 10, 11).** Leave a message of about 30 seconds and hang up: it should arrive within a minute as an unread message from
   Phone with the number and length, and an email without sound. Play it in meet (item 12), seek in it, delete it, and check Telnyx's
   recordings no longer list it. Hang up during the greeting: a missed-call line, no email.
8. **The cap.** Lower `LINE.monthlyMinutes` below this month's use (or use a test month) and call: meet rings, the cell does not, the
   voicemail still works.
9. **A dispatcher's callback (item 17).** Only with Telnyx's say-so, never to a live service: have the callback arrive as a call to the number
   (Telnyx's test line, if it has one) and check that it rings.
10. **Many at once (item 15).** Call twice at once, and ring with two people's phones: see whether Telnyx refuses a leg for the 3-call limit.
11. **A year on (item 13).** Put a reminder to see whether a year-old voicemail still plays, if copies are not kept.
