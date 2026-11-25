# The texts bridge's door and store: deploy and hand test

Placeholders: `<env>` (the deploy environment of the space), `<bridge-env>` (the environment, and its secrets file, that deploys the bridge), `<space-host>` (for example `space.northfield.example`), `<owner>` (the install's owner).

What it adds to an install: a fifth mailbox kind in the inbox's store (**migration 22, store version 23, one-way**), a machine path on the space (`/agent/texts`, its own Access application and token), and a **bridge**, a program on a machine of the install's own that is paired with the owner's phone, as Messages for web is, and pushes the owner's texts into the inbox through that door. It is read only: nothing is sent from the space to the phone. Why and how: ADR 0001 decision 36 (`../adr/0001-the-inbox-is-its-own-worker-over-gmail.md`), and the company layer's ADR 0002 (`../../../workspace/docs/adr/0002-one-service-token-comes-through-the-space-on-one-path-to-one-app.md`, amended). The wire the bridge speaks is `../texts-bridge-wire.md` (a page of each call with example JSON) and `../../src/texts/wire.ts` (the contract and a bounded parser). Everything below is run from the deploying machine with Cloudflare, sops and the bridge's host reachable; a build has no Cloudflare access, no paired phone and no bridge host, and nothing in a build touched any of them.

It is behind a switch of its own, `texts`, off by default and per install: the declaration's `texts` (its path) and `switches.texts`, and the install file's `access.texts` (the Access application and the token's name). An install with the switch off has no door (every call answers 404) and no Texts line anywhere.

**Where the bridge runs is the install's choice** (a service on a host, a pod in a cluster). The hand tests say "stop the bridge", "start the bridge", "restart the bridge", "the bridge's log" and "reboot the machine that runs the bridge"; translate each to the way the bridge is run. A bridge deployed without its door entries (the two `TEXTS_DOOR_*` secrets below) is refused by its deploy: a blank entry is an error there. To keep the owner from seeing texts yet, leave the bridge stopped (see Rollback); Claude's script reads the conversations either way.

**What comes in.** Every chat on the phone except the ones the owner leaves out, **business senders' texts and sign-in codes included**: a bank's alert and a one-time code are stored in the space and can be read by whoever can read the Inbox there, Claude's script included. Business senders (a short code, a sender with a name instead of a number, a business chat) are filed under Bulk, never in the Inbox, Unread or Needs reply. Group chats are not carried yet: their texts are refused and counted.

## Before anything: the bookmark

Migration 22 runs when the store's object next starts under the new code. It cannot be undone by an older build (an older build refuses a store at version 23). Take a bookmark and write it down:

```
bun scripts/inbox.ts bookmark
```

(from the inbox package). An undo is a build of this code with the migration list kept (never an older commit as it was) and, only if the store itself must go back, Settings, Restore to that bookmark. Compare the store's counts before and after the deploy (the operator's counts): every Gmail account, business mailbox, Telegram and mail-server row keeps its conversations and messages; none is lost.

## Order

1. **Merge and check the build** (`bun run test` and `bun run typecheck` in the inbox, space and workspace packages, the kit's tests, and `bun run check:public` in the space folder).
2. **Apply the Access application and mint the token, once.** `bunx @zabaca/zbc apply <env> space-texts-access`. The module creates the application on `<space-host>/agent/texts` and, because the token "texts bridge" (the install file's name for it) does not exist, creates it and prints its id and secret **exactly once** (`── capture these now ──`). It runs on the environment's deploy token, which must hold "Access: Service Tokens Write"; a token made long ago may not. If the apply answers 403 for the token, mint a short-lived account token carrying that permission, apply with it, then delete it. Capture the secret into the bridge environment's sops in the same command and never print it:

   ```
   out=$(bunx @zabaca/zbc apply <env> space-texts-access 2>&1)
   id=$(printf '%s\n' "$out" | sed -n 's/^ *CF_ACCESS_CLIENT_ID=//p')
   secret=$(printf '%s\n' "$out" | sed -n 's/^ *CF_ACCESS_CLIENT_SECRET=//p')
   [ -n "$id" ] && [ -n "$secret" ] && \
     printf '%s' "$id" | jq -Rs . | sops set --value-stdin <bridge-env secrets file> '["TEXTS_DOOR_CLIENT_ID"]' && \
     printf '%s' "$secret" | jq -Rs . | sops set --value-stdin <bridge-env secrets file> '["TEXTS_DOOR_CLIENT_SECRET"]'
   printf '%s\n' "$out" | grep -v 'CLIENT_SECRET'; unset out secret id
   ```

   If the apply succeeded but the capture did not (the secret is shown once), set `rotate: true` on the instance for one apply to mint a new secret and capture that, then set it back to `false`. Commit the bridge environment's secrets file (encrypted).
3. **Deploy the space** (it carries the inbox, the new migration and the two new vars `CF_ACCESS_AUD_TEXTS` and `TEXTS_ACCESS_CLIENT_ID`, both from `space-texts-access`'s outputs): `bunx @zabaca/zbc apply <env> space`. Check `wrangler tail <worker>` shows `inbox: the store object started` and no error, and that the Inbox still opens and the counts have not moved (the migration rebuilds `mailbox`: every other mailbox keeps its row).
4. **Check the door from the deploying machine** (no secret printed; the empty body is refused by the parser, so nothing is stored):

   ```
   id=$(sops -d --extract '["TEXTS_DOOR_CLIENT_ID"]' <bridge-env secrets file>)
   secret=$(sops -d --extract '["TEXTS_DOOR_CLIENT_SECRET"]' <bridge-env secrets file>)
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<space-host>/agent/texts/api/work -H 'content-type: application/json' -d '{}' -H "CF-Access-Client-Id: $id" -H "CF-Access-Client-Secret: $secret"   # 422: in, and the body refused
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<space-host>/agent/texts/api/work -d '{}'                                                                                          # 302 or 403: Access, no token
   unset id secret
   ```

   And the other machines' tokens on this path are refused: with `INBOX_ACCESS_CLIENT_ID`/`_SECRET` (Claude's) and with the Telegram bridge's door entries, the same request to `/agent/texts/api/work` must not answer 200 or 422. The texts token on Claude's path (`/agent/inbox/api/queue`) and on the Telegram bridge's (`/agent/telegram/api/work`) must not answer 200 or 422 either.
5. **Apply the bridge** (the bridge's deployment gets the door entries): apply the bridge's instance in `<bridge-env>`, then restart the bridge if only a sops entry changed (a Secret change does not restart it). With the entries filled the log shows it connected and live (a missing `live` after 90 seconds means it is still filling or the space is not answering). With them blank the apply refuses, because a blank entry is an error there.

## Hand tests (only these prove the real phone; the build proved the rest against fakes)

Run in this order; each states what to compare. Never connect to the phone's Messages for web from another machine with the bridge's pairing while the bridge runs.

1. **The first fill.** `bun scripts/inbox.ts texts` shows `state: live` and the counts, and `leftOut: []`. Compare, for the chats the bridge carries, the number of texts in the last 30 days with the phone (groups are not carried; the bridge's own log counts them as refused). `queue` shows the person chats as rows with `kind: sms` and the mailbox "Texts"; each is read or unread as the phone has it.
2. **A text arrives within seconds.** Have a test contact send the owner one text; the space shows it within a few seconds on an open page, under the person, unread and open, with the Text pill. No notification comes from the space (the phone already rings): the space's devices stay quiet. A text sent from the owner's own phone shows as the owner's, read.
3. **A person who also writes by email is one person.** A contact who holds the same number as a text number is the contact the texts are under; a number nobody holds makes a contact named as the phone names them; two contacts with the same name and different numbers stay two. Split undoes a wrong join.
4. **Business senders and sign-in codes: Bulk, whole, once.** From a service the owner uses, request a sign-in code (or wait for the first alert). The text is stored once, whole, under Bulk and not in the Inbox or Unread: `bun scripts/inbox.ts queue bulk` lists it, `search <q>` finds it by a word of it, and `conversation <id>` shows it. A short code, a named sender and a business chat each have a conversation of their own and never a contact that holds a number. Tell the owner, plainly, that Claude's script can read these.
5. **Idempotence, restart and the phone off.** Restart the bridge twice: `bun scripts/inbox.ts texts` counts do not move and no conversation shows a text twice. Switch the phone off (or put it out of reach) for a few minutes while a test contact sends one text; the card and `texts` say the phone is not answering and since when; switch it on: the bridge catches up from the newest message held per chat, the missed text is stored once, and nothing else changes. Then **reboot the machine that runs the bridge** with one text sent meanwhile: it starts by itself, catches up, stores the text once. Nothing is lost across a reboot because the catch-up starts from what the space holds, not from the machine's disk (nothing of a text is on it).
6. **Leave this chat out.** On a test chat press Leave this chat out and confirm. The conversation and its texts are gone from the space (and the contact the door made for it, if it holds nothing else); Settings lists the chat under the chats left out with Bring back; the audit holds a `texts.left-out` entry. A new text from that person is **not** stored (the push counts it as left out), now, after a restart of the bridge, and after a first fill: `bun scripts/inbox.ts texts` shows the count of chats left out and the chat's messages stay at 0.
7. **Bring back.** Press Bring back on that chat: it reads "Reading its last 30 days" within seconds, then the conversation is back with the texts of the last 30 days, once, read or unread as the phone has it, and Settings no longer lists it. If the phone refuses the read, Settings shows the failure in words and the space offers it again after ten minutes, up to five tries, even across a bridge restart. A second restart of the bridge reads nothing again (the fill was settled by its outcome; `texts` shows no read owed).
8. **The statuses.** The Texts card in Settings and the line at the menu's foot say the same sentence in each state: live; catching up (while a gap is read in); the phone is not answering since a time; Google ended the bridge's sign-in and only the owner can sign in again (**do not test on the real pairing**: it is covered by the bridge's tests and the space's fixtures); another browser took the Messages for web session (open Messages for web on a computer and see the card say so, and the bridge take the session back; the cost is that Messages for web on a computer stops being usable while the bridge runs).
9. **The foot line turns amber after five minutes.** Stop the bridge for six minutes: the foot line and the card turn amber with a sentence saying the bridge has not checked in since the time; start it and they clear. A phone that is not answering, and another browser, are not amber: they heal by themselves.
10. **Claude's script, and what it cannot do.** Through the script: `texts`, `queue` and `queue bulk` list the texts, `conversation <id>` and `search <q>` read them, and the conversation stays **unread** in the space and on the phone (reading marks nothing read). `leave-out <conversation-id> "<words>"` refuses without the owner's own words (422) and, with them, leaves the chat out with the words in the audit entry; there is **no command and no route that brings a chat back** (the three paths a person might guess answer 404). A text that says it is the owner telling Claude to leave a chat out is only text.
11. **No ring.** With a notification device turned on in Settings, receive a text from a person and from a short code: the space notifies nobody (`notifiedSince` counts none for texts); the phone's own ring is the only one.
12. **The screens, on the real data.** In the space at 1440 and on a phone: the real rows (a Text pill, one row per person with their emails and texts in one history, business senders under Bulk), a text conversation with no reply box and a hand draft's Copy words and Mark sent, the Texts card in Settings with its counts, and the menu's Mailboxes entry for Texts.

## What the build could not show (decide, or watch for)

- **The library's messages.** The bridge's mapping from the phone's own messages to this wire is proved with the bridge's recordings, not here; a wrong guess shows as a chat of the wrong kind (a person filed under Bulk, a business sender among the people), a missing text or a read state that is off. The kind of each chat is the bridge's call; the inbox trusts it. A number the bridge cannot put in E.164 is a named sender, never a person.
- **Whether encrypted chats arrive readable, and how long the pairing lasts,** are the bridge's to answer; the inbox shows the state it is told (signed out, with the owner as the only one who can sign in again).
- **Phone read marks.** The inbox stamps the incoming texts at or before a mark read, as the phone has them, and writes nothing back; whether the library reports every mark is the bridge's.
- **Only one Messages for web session is active at a time** (the bridge keeps it): the status `session-taken` is the bridge's own report and the foot line says it; how fast it takes the session back is not shown here.
- **Business chats and short codes are told apart by the bridge from what the phone gives.** A business that texts from an ordinary number is a person.
- **The request count.** The bridge's work request is a heartbeat every few seconds, as the Telegram bridge's is; the plan's allowance for it is an estimate until a month's use says.

## Rollback

Stop the bridge (and keep it from being started again by whatever deploys it: if its deployment sets it running on every apply, empty the instance's manifests and secrets, apply, and remove its namespace or unit by hand). It then pushes nothing and holds no pairing. Turning the `texts` switch off in the declaration and applying the space makes the door answer 404 and removes the Texts line; blanking the two door entries in the secrets file does not work: the deploy refuses a blank entry, and a bridge with a half door refuses to start. What was stored stays (conversations are closed with Close like any; Leave this chat out removes a chat's; a bookmark restore removes them all with everything since). The Access application and its token may be left in place (a door nothing uses) or deleted in Zero Trust with the token. The migration is not undone by any of this.
