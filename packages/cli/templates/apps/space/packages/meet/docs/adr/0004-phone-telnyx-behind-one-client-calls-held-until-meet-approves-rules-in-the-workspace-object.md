# The phone: Telnyx behind one client, every call held until meet approves it, the rules in the Workspace object, a dial pad only for people named on a list

Status: accepted, for calls out only. The product choices: Telnyx with its own browser calling; one US number with a caller name; 1,000 minutes a month in meet, and at Telnyx $5 a day, US only, at most $0.05 a minute and 3 calls at once; 911 on, with each person's address registered and an email to the owner whenever anyone dials it. Taking calls and voicemail were built afterwards: [ADR 0005](0005-phone-calls-in-call-control-commands-ring-every-phone-then-the-cell-then-voicemail-in-the-phone-conversation.md), which says where it changes what is written here (marked "Superseded" below). Phones in meet calls (a bridge) are not built. The choices below are the ones that shape the code.

The code was first written against a fake Telnyx in the tests and a stand-in on a localhost run, and every Telnyx request was written from Telnyx's own documentation, none of it run until the account existed. The hand test at the end says what to look at first on a new account.

## 1. Three doors by path; the phone is a teammates' route and nothing else

| Path | Who | Credential, checked by the Worker |
|---|---|---|
| `/start/api/w/phone/*` | the install's people | The teammates' door of ADR 0003 (Access, then the teammate list), then **the phone list** in the phone core |
| `/api/phone/webhook` | Telnyx | No sign-in, but only a request signed by Telnyx is read at all: Ed25519 over the timestamp and the body joined by a bar, the timestamp within 5 minutes |
| `/api/phone/dev/*` | a localhost run | The development bypass AND the stand-in Telnyx; 404 anywhere else |

**There is no phone route on the guests' door.** The phone group is mounted under the teammates' Hono app (`mountPhoneTeammates`,
called from `workspace-routes.ts`), so a guest's cookie reaches no phone route, and a test drives every phone route with a guest
cookie, with no assertion, and as a teammate who is not on the phone list.

**The phone list** is the install's declaration, `phone.people` (it was once a constant, `PHONE_PEOPLE` in `src/phone-line.ts`). It names who has the dial pad, one line each, as the teammate list does: an
address must be on the teammate list AND on this one. The value on each line is the number that person's
911 calls leave from (section 5), so adding a person is a line and an apply, and they need a number of their own.

## 2. Every call is held until meet decides; the page's approval is a single-use ticket

The Telnyx connection has **Park Outbound Calls** on: a call from a browser waits at Telnyx while Telnyx asks meet's webhook. meet
answers with a Dial command (from the line's number, with the configured caller name, linked to the parked leg and bridged when it answers, a 4 hour
limit, no recording) or hangs the parked leg up. Never Telnyx's transfer command, which costs $0.10 a time.

The rules run twice, so a page that was tampered with, or a stolen login token, places nothing:

1. **The page asks first** (`POST .../phone/call`): every rule runs (the person, the number, the setup, the cap), and an allowed
   call gets a **ticket**: random, kept hashed, good for 60 seconds, tied to that one number, spent by one call. A refusal comes back
   with its reason in words, so the person is never left guessing why nothing rang.
2. **The webhook asks again** when the parked call arrives. It needs the ticket (the page sends it two ways, as a custom SIP header
   and as the call's client state, and the webhook reads either), spends it, checks it was for this number and runs the rules a
   second time (the month may have run out, or the person may have left the list, in between). No ticket, a wrong number, an
   expired or already spent ticket: the parked leg is hung up and nothing is dialed.

**What is trusted about an event.** Every event is signed by Telnyx, but its client state is the browser's to set, so it never
decides alone which call an event is about. The leg meet dials is known by the leg id meet stored for it; before that is stored
(a moment after the dial request), by client state of the form `meet:<call id>:<nonce>` whose 64-bit random nonce is kept with
the call, and by a dial to the same number still in flight. A leg that claims a call whose stored leg is another one is not that
call's, so a thief with a login token cannot reach another call's log or meter by guessing a sequential id. A parked browser call
is a `call.initiated` on meet's own connection that is not meet's own leg and is either in Telnyx's `parked` state or outgoing
(neither alone is relied on). **An incoming call is never one**, whatever its state. (Superseded by ADR 0005, section 3: a call to the line's number, or a 911
dispatcher's callback, was left alone here because inbound was not built yet; it now rings, and is decided before these rules. A call to a
number that is not meet's is still left alone.) Meet's own 911 leg cannot start
another handling even if its client state is missing: an event with no browser client state (no `who`, no approval) for a number
meet is dialing this moment is that leg's. A browser's own call, which always carries `who`, is never swallowed by that rule, so
two people dialing 911 at once are both dialed and both emailed. A browser that hangs up while the dial request is still out is
recorded as abandoned: the router hangs the leg that comes up at once (and, if Telnyx does not take the hang-up, the cron tries
again for an hour), and the leg counts nothing unless it was answered, in which case its minutes are counted like any call's.

A login token alone therefore lets a thief register a phone and nothing more: it carries no ticket, and a ticket needs a signed-in
person at the teammates' door. This is also why Telnyx's token lifetime (24 hours, section 6) is acceptable.

**911 is the one call with no ticket.** Nothing may stand between a person and 911, so a parked call to 911 or 933 (Telnyx's test
line) is dialed whatever else is true: no setup, no cap, no ticket. The page identifies the person with an opaque id on the call so
the right number is used (section 5); an id that matches nobody is dialed from the line's number. The page also reports 911 to meet
the moment it dials, on a separate request that nothing waits for, so the owner's email does not depend on Telnyx's webhook arriving.

**Cost.** A parked call needs meet's Worker to answer. If it is down, every call from meet fails, 911 included. The notice a person
acknowledges already says a cell phone is the better phone for an emergency; no further mitigation is built.

## 3. The rules live in a core over the Workspace object's SQL; the router does everything external

`PhoneCore` (`src/phone.ts`) is the phone's counterpart to `RoomCore` and `WorkspaceCore` (ADR 0001, section 2; ADR 0003, section
1): it runs inside the Workspace Durable Object over the same synchronous SQLite, never calls the network, takes the verified
address the router hands it and the time, and returns decisions as data (`PhoneAction`: dial, hang up, tell the owner of 911, tell
the owner of the cap). The router (`src/phone-routes.ts`) does the Telnyx calls and the email. The Workspace object gains one method,
`invokePhone`, the same shape as `invoke`.

The phone's tables are **PhoneCore's own** (`PHONE_TABLES`, made on every boot by its constructor, the one owner; a column added
later goes in `PHONE_ADDITIONS`, as the Workspace's `WS_ADDITIONS` work), in the same storage beside the Workspace's, whose frozen
schema and empty `WS_ADDED_TABLES` are untouched. No new Durable Object class, so no migration entry.
They hold each person's profile (the opaque id, the acknowledgement time, the 911 address and whether Telnyx holds it, their
Telnyx credential's id), the tickets, the call log (one row per call, the browser's leg and the leg meet dialed together), the
month's minutes, the alerts already sent, the events already acted on, and the 911 notices already sent.

**Webhooks arrive twice and out of order.** Each event's id is recorded and an event seen before is ignored; a call's minutes are
counted once (`counted`), when it has ended and its answer is known, in whichever order those two events arrive; a hang-up of the
browser's leg takes down the leg meet dialed.

## 4. Spend controls: four layers, three of them in this package's code or script

1. **A prepaid balance at Telnyx with automatic top-up off** is by hand (the script prints it as a step). meet reads the balance once
   a day in the existing cron and emails the owner when it is under $5.
2. **Telnyx's own limits on the line**, set by the setup script and enforced even if meet has a bug: an outbound voice profile
   with US destinations only, at most $0.05 a minute, a $5 daily spend limit and 3 calls at once.
3. **meet's monthly meter**: 1,000 minutes (`LINE.monthlyMinutes`), each call rounded up to the minute, counted once when it ends
   (answered time only). New calls are refused past it, with a reason. The owner is emailed at 80% and 100%, once each. 911 is never
   counted and never refused.
4. **meet's destination rules**, before Telnyx sees a number: US numbers only (Canada, the Caribbean countries that share +1 and
   the US territories are refused as their own reason, because they look like US numbers and bill at other rates), no premium or
   special lines (900, 976, 700, 500 and the 5xx personal-number codes; ADR 0005 adds the 976 and N11 exchanges inside any area code), nothing abroad.

## 5. 911: the fallback is what is built, because a browser call cannot carry a per-call address

The first choice was Telnyx's Dynamic E911, which would let each call carry its own registered address on one shared
number. Telnyx documents it as two ids in the SIP INVITE of the emergency call: a `Geolocation` header and the `From` or
`P-Asserted-Identity`. The browser SDK sends only custom headers whose names start with `X-`, and the call that reaches the
emergency service is the one meet dials after parking, not the browser's own. Nothing found lets a browser call set those two
headers, so **the fallback was built**: each 911 call leaves from a number whose own registered address is the person's.

- **Who uses which number** is the phone list's value: `'line'` (the line's own number, which holds one address, so one person only) or
  a number of their own. A 911 call is dialed from that number (`from`), so Telnyx sends the address registered on it.
- **The address** is collected in the page before a person's first call (street, apartment, city, state, ZIP), with the notice
  of when 911 from meet may not work and an "I understand" whose time is kept. It is registered at Telnyx (an address, then
  emergency service enabled on the number) at once; a call out waits until Telnyx holds the current address, and a failed
  registration says so and can be tried again. The person can change it from the phone panel at any time.
- **Another state**: when Cloudflare puts a request in a US state other than the address's, the panel asks the person to check
  the address, without blocking anything, and does not ask again for that state once they say it is right.
- **The owner is emailed** the moment 911 is dialed, with who and the address, whichever of the page's report and Telnyx's webhook
  arrives first (one email per person per two minutes). The call is dialed before the email is sent, and a failed email changes
  nothing. (ADR 0005, section 5, also posts it in the Phone conversation.)
- **933**, Telnyx's test line, is dialed with no email, for the first live test.

**Not verified**: that 911 dialed as the digits `911` is accepted by the Dial command (Telnyx's page does not say), that a number
with an enabled emergency address sends it when the call leaves from it, and what Telnyx does for an account with no balance.

## 6. Telnyx behind one client; the secrets, the deploy guard and the setup script

`src/telnyx.ts` is the only file that says "Telnyx" on the Worker's side: a typed `Telnyx` (arriving in `Deps` as the SFU client
does, with a fake in the tests and `src/dev-telnyx.ts` on a localhost run), the signature check and the reading of an event. The
page's phone is behind `PhoneSdk` (`src/web/phone/sdk.ts`): Telnyx's SDK (`@telnyx/webrtc`, MIT, loaded as its own chunk and only
on /start for a person with the phone) or the stand-in. Swapping to Twilio replaces those two files and the setup script.

**The API key never reaches a browser.** A phone's login is a token Telnyx's API makes from a credential meet keeps per person;
only the token goes to the page. Telnyx's API-made tokens last 24 hours (a shorter one would need meet to sign them itself, in a
format Telnyx does not document); the page logs in again with a fresh one after 20 hours, and the ticket (section 2) is what makes
a longer life harmless.

**Four Worker secrets, all or none** (`PHONE_SECRETS`): `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` (the webhook's public key, from the
portal), `TELNYX_CONNECTION_ID` and `TELNYX_NUMBER` (E.164). The outbound voice profile's id is not among them: only the setup
script uses it, to attach it to the connection. The Worker shows **no dial pad and no webhook** unless all four are set and the
number and key have the right shape. The deploy instance pushes them only when
the install's secrets file holds all four, and **fails to load when it holds some**, so a half-set account stops `zbc apply` before anything is
deployed (the cloudflare module checks a missing secret only after `wrangler deploy`, which would ship a half-configured Worker).
With none in the secrets file the deploy goes on without the phone.

**The setup script** (`scripts/telnyx-setup.ts`, `src/telnyx-setup.ts`) applies the Telnyx side: the outbound voice profile with
the limits above, the credential connection (calls parked, the webhook address, the profile attached), the number with the
caller name, and a person's 911 address. It reads the account first, prints every step, is idempotent, is a dry run unless given
`--apply`, and buys a number only with `--apply --buy`. It does not run in CI. What it cannot do (the account, business
verification, the prepaid balance with automatic top-up off, the webhook public key, the Free Caller Registry) it prints as steps.

## Choices that might surprise

- **The page asks for a ticket before it dials.** Checking at the webhook alone would have been simpler. The webhook cannot be told which
  person a parked call is from (Telnyx's event may not carry the credential), and the page needs the reason in words; the
  ticket gives both, and the webhook still decides.
- **A refused call at the webhook is hung up, not spoken to.** A parked call must be
  answered before it can be spoken to, and the page already shows the reason from its first step.
- **No pause switch and no settable cap.** Neither has a page to be set from. The cap is `LINE.monthlyMinutes`, one line and an apply; Telnyx's own daily limit
  and the prepaid balance are the brakes in between.
- **The call log has no Phone conversation and no 911 post.** (Superseded: ADR 0005 built the conversation and posts the 911 notice.)
  The owner is emailed.
- **The outbound voice profile id is not a Worker secret** (section 6). **`TELNYX_NUMBER` and the webhook public key are**:
  neither is known until the account exists, so a placeholder in a file would be wrong.
- **Minutes are counted per call, not per leg.** In this version a call has one
  billed leg that matters, the one meet dials, counted from its answer to its end and rounded up. The browser's leg is not
  counted, and the 1,000 minute cap is sized for the per-call rate. Forwarded legs
  count each leg (ADR 0005, section 4).
- **The balance check and the 80% and 100% emails are built**; the check of the address when meet sees a
  sign-in from another state is a notice on the phone panel, not on sign-in.
- **An incoming call is declined by the page.** (Superseded by ADR 0005, section 7: the page now rings, with Answer and Decline.)

**A rerun never buys a second number.** Before buying, the script looks at the account's number orders: one still pending, or
finished in the last day for a number in the wanted area code that the account does not list yet, stops the buy (the order takes a while to land, and a
second buy is a second monthly charge). Buying anyway takes `--apply --buy --buy-another`.

**The balance check** (daily, in the cron) is marked done only once Telnyx has answered and, when the balance is low, the owner has been
emailed, so a failed read or a failed send is tried again at the next run.

## Hand test, once the account exists

From the operator's checkout with the Worker's `.dev.vars` and the install's secrets file: run `bun scripts/telnyx-setup.ts` (the dry
run), then `--apply`, then `--apply --buy`; put the four secrets in the secrets file and apply meet. Then, in this order:

1. Open /start and the Phone: it should say Ready. If it does not, the SDK's login is the first suspect.
2. Give an address; call **933** (Telnyx's test line): it should connect and no email should arrive. If it does not, the
   Dial command's `to` for emergency numbers is the second suspect.
3. Call the owner's cell from meet: the cell shows the line's number and, where phones show names, the caller name. In Telnyx's dashboard
   the parked call's event should show the page's ticket as a custom header or as client state. **Which of the two arrives is
   the thing to look at**: the webhook reads either, but if neither arrives every non-911 call is refused.
4. A refused number (a Canadian one) shows its reason and nothing appears in Telnyx's call log.
5. After a call, `GET /start/api/w/phone` shows the minutes; the Telnyx side shows the leg's billed minutes to compare.
6. Not settled by Telnyx's docs, so look: how an incoming call arrives (its `direction`, and whether it carries `state: parked`),
   and what a 911 dispatcher's callback to the line's number looks like. (Taken over by ADR 0005's hand test, steps 2 and 9: meet now
   rings for both.)
7. 911 only with Telnyx's say-so on the test line, never to a live service.
