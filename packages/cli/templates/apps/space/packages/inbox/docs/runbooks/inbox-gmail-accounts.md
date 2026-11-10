# Runbook: several Gmail accounts in the inbox

Placeholders: `<project-id>` (the install's Google Cloud project), `<space-host>` (for example `space.northfield.example`), `<env>` (the deploy environment), `<owner>` (the install's owner, for example `tessa@northfield.example`). The decisions behind this are `../adr/0003-the-inbox-takes-several-gmail-accounts.md`. **One migration (14, store version 15), one-way: bookmark before the deploy, and an undo build keeps migrations 12 to 14.**

- **What it is:** the inbox takes any number of Gmail accounts, all the owner's, each with its own grant, history cursor and watch. Mail from each is filed into the one inbox with a pill naming the account, a reply goes out from the account the conversation came through, and a new email goes out from the one the owner chooses (or the default). A grant Google ends is shown as lapsed, by name, with Connect again.
- **Whose:** only the owner connects or disconnects an account (the space's gate and the Mailroom's own check). Claude's script reads all the accounts and can ask for a sync of all of them; it cannot connect or disconnect an account. It may choose which account (or business mailbox) a NEW email is drafted from, by `from` on `draft` (ADR 0001 decision 26); the choice is on the draft, which `drafts` prints as `sendsFrom`, and a disconnected or lapsed account is refused.

## Google's side (the owner, separately; recorded here so the deploy is checked against it)

The code does not depend on these being done first, but no account outside the install's own Workspace organization can connect until they are.

1. The OAuth client of `inbox-google-setup.md` (project `<project-id>`) is switched to **External, in testing**, with each account to connect listed as a **test user**. (`inbox-google-setup.md` step 4 says Internal; this supersedes it for as long as the app is External. An install whose accounts all belong to its organization can stay Internal.)
2. The app is marked **Trusted** in the Workspace admin console (API controls), so the organization's own accounts are not blocked by the consent screen.
3. The return address `https://<space-host>/api/inbox/gmail/callback` is registered on the client.

**What testing mode costs:** a grant for an account outside the app's own organization ends **7 days** after it is given. That is the lapse the inbox says out loud. Expect each outside account to lapse weekly until the app is published or verified. Whether an organization account's grant lapses too (marking the app Trusted may exempt it) is Google's to say and unverified: the first week shows it. Nothing breaks: mail stays in Gmail, and a reconnect catches up from the kept cursor.

## What the deploy changes

- **Store:** migration 14 (store version 15): `mailbox.grant_lapsed_at` (NULL) and a label for the existing Gmail row (in its `display_name`, which was empty for a Gmail row). Nothing is dropped or rewritten. **One-way:** a build from before it refuses a store at version 15 (`migrate`), so never redeploy an older commit as it was.
- **The Mailroom** works every connected account, isolated from each other; a push is routed by the address in its body; the daily pass renews each account's watch.
- **The space:** Settings, Mailboxes shows a card per account with Connect Gmail (adds one), Connect again (that account, Google hinted to offer it first), Sync now and Disconnect; the menu's foot has a line per account; the New email From box lists each working account.
- **The contract** (`../../../workspace`): `InboxMailboxes.gmail` and `InboxNav.gmail` became `gmailAccounts` lists; `InboxGmail` gained `id`, `name`, `lapsedAt` and the state `lapsed`; `changeGmail` and `gmailSignIn` take the account's id; `InboxFrom` for Gmail may name an account. The inbox and the space are one Worker, so they deploy together.
- **Claude's script:** `mailbox` answers `{ accounts: [...] }` (it answered `{ mailbox: ... }`). Nothing else changed.
- No new binding, secret, route, queue or infra instance. Gmail's push, the Google client and the topic are as they were.

## Before the apply

1. `bun scripts/inbox.ts bookmark` (the inbox package's script) and write the bookmark down (the restore point under the one-way migration).
2. `bun scripts/inbox.ts mailbox` and `mailboxes`: write down each account's state, `messages` and `conversations`, and the numbers of each business mailbox.
3. The store's counts, as for any apply of the space.

## Apply

`bunx @zabaca/zbc apply <env> space`. (The inbox is a library in the space's Worker; there is no `inbox` instance to apply.) The migration runs when the Durable Object wakes.

## Checks after the apply

1. `scripts/inbox.ts mailbox` answers `{ "accounts": [ ... ] }` with the one account that was connected, `state: "live"`, a `name` (the label), and the same `messages` and `conversations` as before.
2. The business mailboxes' numbers are the same. A new email to the connected address shows within a minute (the push route still works for the one account).
3. The space's Inbox shows each Gmail conversation with the account's pill beside the business ones.

## What the owner does to connect each account

For each further account, after the apply (the account already connected needs nothing):

1. Open the space, **Settings, Mailboxes**, and press **Connect Gmail** in the "Gmail accounts" block.
2. At Google, choose the account (or sign in to it). Because the app is in testing, Google may say it has not verified the app: press **Advanced**, then **Go to ... (unsafe)**. Allow every permission it lists, including "Manage your mail".
3. You land on Settings, Mailboxes with a new card. It shows "Reading in the last 30 days" and then "Live". The fill reads thirty days of Inbox and Sent mail in chunks, so a busy account takes some minutes.
4. Check the card's "In Gmail's Inbox" count against that account's own Gmail unread count (the numbers agree to within what arrived meanwhile).

**When an account's sign-in lapses** (about weekly, for the outside accounts): the menu's foot shows an amber line "<account name> Gmail: connect it again" and the card in Settings opens with the sentence naming the account. Press **Connect again** on that card, pick the same account, allow, and you are back on Settings with the card live. Mail that arrived meanwhile is caught up; nothing is lost or filled twice. You can also press Disconnect, which withdraws the permission at Google, and Connect Gmail again later.

## The hand test (what a build without Google cannot show)

These are for a deployed install, with real accounts:

1. **Connect one outside account.** Its card goes Live, a message sent to it from elsewhere arrives in the space within a minute with its pill, and `scripts/inbox.ts mailbox` lists two accounts. The new account's watch shows an end date about a week away.
2. **Push routing:** send to the new account only; the first account's "Last push" does not move, the new one's does.
3. **A reply** to that message goes out from the new account's address (check the From at the recipient and the thread in that account's Gmail Sent). **A new email** with From set to another connected account goes out from it.
4. **The lapse:** the first one is Google's to cause, a week on. To see it sooner, revoke the inbox in that account's Google "Third-party access" page; within a push or a sync (press Sync now) the card reads "Sign-in ended" and the foot goes amber, the other accounts keep syncing, and Connect again restores it. (The assumption nothing without Google could test is that Google answers a revoked or expired grant with `invalid_grant` at the token endpoint, which is the case the inbox treats as a lapse.)
5. **The daily pass** (next morning): every account's watch end date moved a week on.

## Rollback

A fix forward is right: the migration cannot be undone, and an older build refuses the store. If the space must go back, deploy a build of the old code that **still carries migrations 12 to 14** (a revert of the source change, not of the migration list); the second and later accounts then sit unread (their rows stay, their mail stays) and the first account works as before, since the old code reads the first Gmail row. The bookmark from "Before the apply" is the restore point under that (`scripts/inbox.ts` and the space's Restore; a restore of a store to the bookmark is migrated again by the new build, so it does not undo the version). Nothing at Google needs undoing: Disconnect on each extra account withdraws its permission.

## Not done here (the install's to decide)

- The draft chat (the assistant) works on the conversations of an account only where the install's content gives that account a persona; the other accounts have none, and it says so in words.
- No per-account menu view (a list of one account's mail); the pill and the search are how to tell them apart.
- No notification when a grant lapses; the menu foot and Settings say it.
