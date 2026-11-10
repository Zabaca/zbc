# Calls are cards in their conversation, and the phone is meet's screen, held by the shell

Status: accepted. **Amended by [0014](0014-conversations-is-split-back-into-inbox-and-meet-and-the-old-addresses-redirect.md): the Calls filter is Meet's (`/meet?view=calls`), and a card stays in the conversation it was made in, so an email conversation in the Inbox keeps the call card of a call link or meeting made from it (the Inbox still asks meet for the cards of its person's addresses, and for nothing else of chat); a huddle's card is in its direct message or channel in Meet.** Meet's side is [packages/meet ADR 0006](../../../meet/docs/adr/0006-calls-in-the-space-a-call-is-a-room-with-a-record-of-what-it-is-for-and-every-link-is-meets-own.md); the contract is `packages/workspace/src/meet-for-space.ts`. Builds on [0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md), [0004](0004-a-conversation-is-one-history-per-person-and-every-send-carries-a-key-made-once.md) and [0006](0006-today-is-seven-reads-cut-on-the-companys-day-each-row-opens-where-the-work-is.md).

## What the space does about calls

Nothing it decides. Every question is one call to `SpaceMeet` with the assertion this request arrived with, and meet decides who may start a huddle, who sees a call and when the meter refuses. The space shows the answer, and says each way a call can end (`ViewAnswer`: ok, refused in meet's words, failed, unreachable, outcome unknown).

| What the person sees | Where it comes from |
|---|---|
| A **huddle** card in a direct message or channel, standing where the message that announced it is | `history` (the message carries `huddle`, the call's name) and `cards` (the call's state) |
| A **call link** or a **meeting** card in an email conversation | `cards` asked by the row's key and every address it holds |
| **Start huddle** by the reply box where the reply goes by chat, **Add call link** where it goes by email, **Schedule** in both | `meet/huddle`, `meet/call`, `meet/meeting` |
| **New call**: a row of its own, opening its card, link and saved chat | `conversations` (`calls`), `meet/call` |
| The **Calls** filter: past calls newest first, each with its saved chat | `meet/calls`, paged by meet's own cursor; `meet/call` |
| The **Phone** row: voicemails and missed calls with Call back, and the dial pad | `conversations` (`phone`), `meet/phone`, and `/api/phone/*` |
| **Later today** and **Tomorrow** on Today, with Join and Copy link | `meetings`, cut on the company's day (ADR 0006) |
| The month's usage, the phone's line settings and each person's 911 address, in Settings | `meet/usage` (the owner's), meet's phone screen |

## Decisions

**A card is its call's state, read again while a call is on.** The conversation carries `calls`; while any has people in it the page reads the conversation again every 8 seconds, so "2 people are in it now" becomes "Call ended, 12 min". A huddle's card stands in place of the message that announced it (a huddle with no card in the answer is the message as it was, with its link); the others stand at the time they were made. A part that did not answer is said as the Chat part, as for history.

**NO LINK IS MADE IN THE SPACE.** Copy link copies `call.link` exactly, Join opens it in a tab of its own with the person's name added (`?as=`, which only fills the lobby's name box), and a test proves no card carries an address of the space's. `Today`'s "Happening now" row is still made from the origin of the declared meet address, as ADR 0006 has it.

**An invitation is text, and nothing here can send it.** Add call link and Schedule put the link or the invitation (what, when on the company's clock with its zone named, the link) into the reply box under what is written; the email goes only when the sender presses Send, by the inbox's send, with its compose key. The booking form is **not a form**: it is drawn inside the reply box's own form, and a submit from a nested form bubbled to the reply's and sent the email being written (found in a screenshot before anything was deployed); Book is a button, and a test pins that the composer holds exactly one form. The time typed is read on the company's clock (`parseLocal`, which treats the hour the clocks skip and repeat), not the browser's.

**Every write carries a key made once and is never retried.** A key meet already used answers the call the first use made, so pressing twice is one call; the meter's refusal frees the key; a lost answer is "outcome unknown" and offers no second try. The page makes one key per press.

**The phone is meet's own screen, imported, and held by the shell.** The space imports meet's `PhonePanel`, `PhoneSetup`, `PhoneLineSettings` and `usePhone` by path (`@space/meet/src/web/phone/...`, as it imports forms' screens), over an adapter (`client/phone/api.ts`) that asks this Worker at `/api/phone`, which hands each request to `SpaceMeet.fetch` at meet's phone path, with the assertion and without the cookie (`src/phone.ts`). The hook lives in `PhoneHost` at the top of the shell, so a call goes on while the person reads a conversation and a call to the number rings (banner, ring tone, flashing title) wherever they are in the space. It asks once whether the person has a phone and draws nothing if not. Meet's phone CSS moved to `meet/src/web/phone/phone.css` and travels with the component; inside `.meet-screen` the space maps meet's tokens and shared classes (`calls.css`). The page's content security policy names `wss://rtc.telnyx.com`, **which this record did not see work against a live account**: with no Telnyx account opened, the phone shows "not set up" and no dial pad (meet's README covers the phone's hand test).

**The Phone, New calls and past calls are not conversations of the inbox's and meet's kind.** Their rows are `phone` and `call:<name>` in the list (`CallRow`, `PhoneRow` of the contract; `ListedConversation` is the person's or channel's alone), open their own screens (`PhonePane`, `CallPane`), and are in the main list only. The Calls filter is a view of the list (`?view=calls`) that draws meet's list of calls in place of rows.

**The switch.** meet's `/start` redirect is meet's (ADR 0006 there); the space has nothing to do for it but be at the address it names.

**Today.** Meetings are an eighth read (`meetings` from now to the end of tomorrow on the company's clock), a call with people in it says why it is shown, and the Phone's unread voicemails and missed calls are one row of Waiting on you, taken from the overview meet already answers (so only a person on the phone list has one).

**The inbox is not changed.** A change to the inbox's draft or send path for an emailed invitation was expected, and is not needed: the invitation is text in the reply box, sent by the inbox's existing send when a person presses Send, so no inbox change or inbox deploy goes with it. Making the invitation a stored draft in the inbox would be a later change to the inbox's draft path.

## Not here

Cancelling or moving a meeting; other people's meetings in a person's Today beyond those they are invited to; chat's notifications and @mentions; the phone's account.
