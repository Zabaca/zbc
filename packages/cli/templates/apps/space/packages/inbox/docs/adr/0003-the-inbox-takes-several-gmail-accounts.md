# The inbox takes several Gmail accounts, all the owner's

Status: accepted. The owner works through several Gmail accounts (for example `tessa@northfield.example` and a personal one) and wants them in the one inbox.

**Superseded in part by [0004](0004-every-mailbox-has-people-and-a-person-sees-only-theirs.md):** a Gmail account is no longer "all the owner's": it is its connector's mailbox, and a person sees only the mailboxes they are on. Connecting stays the owner's until each person connects their own (deferred to a later step). The rest stands.

## What this supersedes, and what it leaves

- **Supersedes** the rule the code held and `CONTEXT.md` ("Mailbox") described, that the owner's Gmail is the only Gmail mailbox and a sign-in as any other account is refused and revoked: any
  address may be connected now, by the owner only. ADR 0001 never stated that rule, so it is not superseded there; what it does say, that "the mailbox" means the Gmail one (and so, in
  practice, the first Gmail row), is superseded in part, and ADR 0001 says so beside that paragraph.
- **Leaves decision 15 and the whole send rule as they were.** Claude's send is the same path as the owner's press, behind the same switch (off by default, the owner's alone to flip) and the
  same instruction, for every account. Nothing about who may send, what is recorded or what a failure means changes; the only new fact is WHICH account a send goes from, decided
  below and recorded the way a Cloudflare mailbox's already was.

## Decisions

1. **One row per account, the table it always was.** `mailbox` is unique on (kind, address) and already held the cursor, watch, job, push counters and error per row, with every
   conversation and message pointing at its row. Several Gmail accounts needed no new table: they needed the code to stop meaning "the first Gmail row" by "the mailbox". Every
   Mailroom and store method that did now takes the row it is about. Migration 14 adds two things only: `grant_lapsed_at`, and a label for the account that already exists
   (below). It is one-way in the way every migration here is (a build from before it refuses a store at version 15), so the deploy takes a bookmark first and an undo build keeps the
   migration (`docs/runbooks/inbox-gmail-accounts.md`).
2. **Only the owner connects; the address is the owner's choice at Google.** The check that refused anything but the owner's own address is replaced by "the actor is the owner", made before the
   code is spent, by the Mailroom as well as by the space's gate. A sign-in as an address already held replaces that account's grant and ends its lapse; it never adds a second row. A
   grant that is not `gmail.modify` is still revoked at Google and nothing is kept.
3. **A push names its account, and only that account is owed a sync.** Pub/Sub's body carries `emailAddress`; the inbox finds the row by it. A push for an address the inbox does not
   hold, or for an account with no working grant, is acknowledged and dropped (a refusal only makes Pub/Sub send it again). A push whose body cannot be read is a hint for every
   account. The history id in a push is still never used as a cursor.
4. **One alarm serves every account, and one account's trouble is never another's.** A run works each account that is owed something, a failure is recorded on its row, and the
   next run is asked for straight away if any other account has more to do, else after the shortest backoff among the failed. The daily pass renews each account's watch and runs one
   sync for each.
5. **A lapsed grant is a state, not an error.** Google's testing mode ends a grant after seven days, so for accounts outside the organization it will happen every week. The first call that
   finds the grant gone (`GmailAuthError`: `invalid_grant`, or a refused sign-in) stamps `grant_lapsed_at` and audits it. A lapsed account is not synced, renewed or sent from (so
   Google is not hammered, and a send is refused in words before anything is claimed), its status is `lapsed`, and its one amber sentence names the account and says to connect it again,
   on Settings, Mailboxes and on the menu's foot. Connecting it again (a click, with Google hinted to offer that account first) replaces the grant on the same row, keeps its cursor and
   catches up; a stale cursor takes the resync that already existed. Disconnect also clears it. Nothing notifies the owner that a grant lapsed: the menu foot is where it shows.
6. **A conversation carries the account it came through, as the business mailboxes' do.** The mark on a conversation (`mailbox`) is now set for a Gmail conversation too, with the
   account's short label as its name (for example "northfield"; the address itself when two accounts would wear the same label), and `mailboxKind` says which kind it is.
   What only a Cloudflare mailbox has (files, the spam check's lines, the assistant) still keys on the kind, not on the mark.
7. **A reply goes from the account its conversation came through; a new email from the one chosen.** A reply's account is its conversation's mailbox, as a Cloudflare reply's already
   was. A new email records its account on the draft when it is made (the message's `mailbox_id`, the column a Cloudflare draft already used): the one the person chose (the owner at the space's compose box; Claude through `from` on the draft route, [ADR 0001](0001-the-inbox-is-its-own-worker-over-gmail.md) decision 26, which refuses a disconnected or lapsed account), else the
   one the contact last wrote to, else the default account (the owner's own address while it is connected, else the oldest connected). A draft that records none, made before this,
   goes from the default account, which is the one account it always went from.
8. **What stays one-account.** The assistant's personas are keyed by mailbox address, and only the owner's main address has one where the install's content gives it one: the draft chat on another
   account's conversation is refused in words, as it was for any address without a persona. Writing one for another account is a decision about who it sounds like, the owner's.
   Gmail accounts send no files (decision 24's reason is unchanged). Claude's script reads all the accounts (`mailbox`) and syncs all (`sync`).

## Consequences

- A fourth account costs one row, one watch (Gmail allows one watch per account, all to the same topic) and its mail in the one store; the fill is thirty days, read in chunks under
  the Worker's subrequest limit, as it always was.
- The same message delivered to two of the owner's accounts is two messages in two conversations (a conversation is unique per account and thread), as it would be in two mail apps.
- `ownAddresses` is the connected accounts' addresses plus the owner's: a draft to another of the owner's connected accounts is refused as "your own address", as one to themselves always was.
- The grant's seven days are Google's testing mode, not the inbox's. When the app is published, or the accounts move into the organization, the lapse stops happening and the state
  is never seen; nothing here needs to change then.
