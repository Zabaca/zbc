# Runbook: every mailbox has people

Placeholders: `<env>` (the deploy environment), `<owner>` (the install's owner, for example `tessa@northfield.example`). The decisions are `../adr/0004-every-mailbox-has-people-and-a-person-sees-only-theirs.md`. **One migration (19, store version 20), one-way: bookmark before the deploy, and an undo build keeps migrations 12 to 19.**

- **What it is:** a mailbox is one person's (a Gmail account they connected) or a list's (a shared mailbox). The inbox shows a person only the mailboxes they are on and a person sends only from them. For an install that had a single owner before this change the outcome is exactly the same for that owner: their Gmail accounts become theirs, and every shared mailbox (business mailboxes, the mail server's, Telegram) becomes shared with the owner alone.
- **Whose:** nothing new for the owner to do. Adding a person to a business mailbox is a change to the declaration (`people` on the mailbox in `workspace.json`) and a deploy of the space; a declaration that names none leaves each mailbox the owner's alone. No new binding, secret, queue, route or infra instance; the Worker's settings are unchanged (the install kit writes the same two mailbox vars, `people` is not in them).

## What the deploy changes

- **Store:** migration 19 adds the table `mailbox_person` and an index, and fills each Gmail account with the person who connected it (`connected_by`). No other row of any table is rewritten. When the object starts it makes every other mailbox's people agree with the declaration (`settleMailboxPeople`: the declared people, else the owner) before it serves a request, so the first request after the deploy already finds every mailbox on the owner. It writes nothing once settled, and the start line `inbox: N mailbox people set to the declaration` is logged only when it wrote.
- **The inbox's part of the space:** every method that reads or works mail is a person's (admitted when on at least one mailbox, the owner always) and is cut to the mailboxes they are on; what changes the install's setup stays the owner's. For an owner, who is on everything, nothing is cut.
- **Claude's door:** reads with the owner's scope (everything) and sends with it. Nothing changes for the owner.
- **Notifications:** a device is its person's; a notification goes to the devices of people who may see its mail. The owner's devices (added by the owner, or by an actor that is no person of the install) are the owner's.

## Before the apply

1. `bun scripts/inbox.ts bookmark` (the inbox package's script) and write the bookmark down (the restore point under the one-way migration).
2. `scripts/inbox.ts mailbox`, `mailboxes`, `telegram`, `jmap`: write down each mailbox's state and its `messages` and `conversations` (the Gmail accounts, each business mailbox, the mail server's, Telegram). And `scripts/inbox.ts queue`: the filter counts (Inbox, Unread, Drafts, Bulk, Closed).
3. The store's counts as for any apply of the space (before and after, `storeCounts`; the new table is one more row-count to expect).

## Apply

`bunx @zabaca/zbc apply <env> space`, after the merge, on the owner's word. The migration and the settling run when the Durable Object wakes (a few seconds of the owner's mail restarting, as for any deploy of the space). Check the public routes a few minutes after, not at once.

**After this apply, and after any apply that touches the inbox (the one place these steps are written; the reason and the mechanism are the comment on `storeOver`, `../../src/store-access.ts`):**

- Read the Worker's tail for `inbox: the store object started`. A line `inbox: the store object answered "No such method: <m>"...; restarting it` may or may not be there: it means the object was still on the old code and the Worker restarted it itself.
- **Read a call that needs the new method** (this change added `mailScope`): open the Inbox as the owner and read the counts (step 1 of the checks below). If any inbox call still answers 500 "No such method", **restart the object by hand** (`POST /api/inbox/store/restart`, signed in as the owner, in the browser) and read again.

## Checks after the apply (the owner, about ten minutes, and whoever applied)

1. **Nothing is missing.** Repeat step 2 above: every mailbox is there with the same `messages` and `conversations`, and the queue's filter counts are the same.
2. **The owner sees all of it.** In the space, the Inbox shows the same rows as before the apply; the menu lists the same mailboxes and the same Gmail accounts, with the same counts; Drafts, Today, People and a search (a word that is in a business mailbox's mail and one that is in a Gmail account) answer as before.
3. **The owner does what they did.** Open a conversation in a business mailbox and in a Gmail account: it opens and marks read. Send one real reply from a business mailbox (one email sent). A notification still reaches the owner's phone for a new email (send one to a business mailbox and watch).
4. **Claude's script is unchanged.** `scripts/inbox.ts queue`, `drafts`, `mailbox` answer as before, and a conversation by id in a business mailbox answers (not 404). `scripts/inbox.ts mailbox-people` lists every mailbox the install has, each with `people` of exactly the owner's address.
5. **Nobody else can come in.** Nothing to see for a stranger: the space's Access list is unchanged.
6. The Worker's tail shows `inbox: the store object started` and, once, `inbox: N mailbox people set to the declaration` (N is the number of mailboxes the migration did not fill: every shared mailbox, Telegram and the mail server's included; the Gmail accounts were filled by the migration itself).

If a mailbox is missing for the owner, or a count is lower: stop. `scripts/inbox.ts mailbox-people` lists who is on each mailbox (the rows of `mailbox_person`), and the way back is the bookmark of step 1 of "Before the apply" with an undo build that still carries migrations 12 to 19.

## What a build without Cloudflare or Google cannot show

The behaviour is proved over the real store, Mailroom and arrivals with fakes (`test/mailbox-people.test.ts`: a made-up company of three people and four mailboxes through every read and every send; `test/schema-people.test.ts`: the migration over a store with the earlier schema; `test/mail-scope.test.ts`: the rule and its SQL; the space's own screens in `../../../space/test/mailbox-people.test.ts`). The real apply, the real mailboxes and the owner's phone are the checks above.

## When a second person is added to a mailbox

Name the people on the mailbox in the declaration: `"cloudflareMailboxes": [{ "address": "leads@brightwater.example", "name": "Leads", "people": ["priya@brightwater.example", "owner@brightwater.example"] }]` (work addresses of people of the install; a name that is not one is refused when the declaration is read). Apply the space. Each person named is let into the Inbox and shown that mailbox only; the owner is the first owner the declaration lists.
