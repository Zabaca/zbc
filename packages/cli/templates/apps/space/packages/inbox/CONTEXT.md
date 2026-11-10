# Inbox: Context

Normative glossary for the inbox: where the owner and the install's other people (in the space) and Claude (through its script) work the correspondence. The inbox has no page and no address for people. **Client** is the space's word (the Clients part, `packages/clients/CONTEXT.md`; the space's ADR 0021); the inbox reads Clients from that part and owns none. **Subscription** is a source's word, kept and shown as the source said it. The decisions that shape the code are in [`docs/adr/`](docs/adr/); the runbooks for the steps an apply cannot do
are in [`docs/runbooks/`](docs/runbooks/).

## Language

The inbox (`packages/inbox`) is where the owner and Claude work the correspondence. It
groups people by **Client** and keeps no list of businesses of its own: a business becomes
something to group under by being added as a Client in the admin. Do not call a Client a "company"
or an "organization" here, and never call a contact a **Customer**.

**Contact**:
One person the owner corresponds with, with any number of Identities. Never a Customer, which a Client's own customers are called. A prospect's, a vendor's or an accountant's contact belongs
to no Client. A contact is under at most one Client, and only because a person or Claude put it there:
nothing is assigned by matching an address (see **Suggestion**).
_Avoid_: customer, lead, account

**Identity**:
One of a contact's addresses on one channel: an email address, a phone number, or a handle. Unique
per channel and address, and belongs to exactly one contact. Merging two contacts moves identities
from one to the other, which is why a merge can be undone (see **Merge**).
_Avoid_: alias, handle (for the general case)

**Profile**:
What the owner knows about a contact that no address says: the **business** they are with, their **role** there and a **note**, kept as three columns of the contact (migration 12) and shown and
edited in the space's People tab, not in this app's own page. A contact's profile is read with its **revision**.
_Avoid_: card, details

**Revision**:
A number on every contact (`profile_rev`) that goes up by one when its profile is saved, when it is renamed, when an address is split off it and when a merge or the undo of one changes it, and never down. A write over a profile, a rename, a split or a merge
names the revision the person was shown and is refused (409, nothing changed) when the contact has moved on, so a screen read before someone else's change cannot write over it.
Linking a Client is not guarded by it: it sets a value, so twice is once.

**Merge**:
Two contacts who are the same person become one: every identity of the absorbed contact moves to the survivor, which keeps its own name and Client and takes a business, role or note
it left blank. The absorbed contact is deleted, and the audit entry keeps both contacts whole (name, identities, Client, profile, when it was made). It is undone by `undoMerge` (the
space's Undo), which makes the absorbed contact again under its own id with its name, Client, profile and the identities still on the survivor, and puts the survivor's Client and profile
back only where nobody changed them since; it is refused when it was undone already, when the same contact was merged again since, when the survivor is gone, or when none of the
identities is on the survivor any more. A merge made before migration 12 has no profile in its entry and is undone, as it always was, by splitting an address off (`splitIdentity`),
which makes a new contact named by the address and nothing more.
_Avoid_: combine, dedupe

**Client directory** (the word the inbox's code and screens still use for the answer to "who are the Clients"):
the Clients part's list, asked in-process in the space's Worker through its inbox face (the list and one Client, and nothing that writes). Each Client has its number, name, legal name,
whether it is archived and, for one a source brought in, the source's address of it and its extra fields (the part's generic source fields; the inbox reads only the one key the company declaration names to suggest by, `clientsDoor.suggestByAddressKey`). The part is the only owner and writer
of Clients: the owner makes, edits and archives them in Settings, and a source such as a company's website pushes its own in. The inbox asks whenever a request needs Clients and keeps none of it, so a Client made or
renamed in Settings shows on the next page load. It depends on no site: a Client a source stopped listing is still held, and linking a person never waits on any source. When the part does not answer,
Clients show as "Client 7" and assigning a contact is refused until it does. An archived Client is left out of the menu, the pickers and Suggestions, a link to it is refused with a sentence, and its people
stay linked.
_Avoid_: cache (the inbox keeps nothing of it)

**Suggestion**:
A Client the inbox offers for a contact that has none, because one of the contact's addresses is
the address the Client's source gave under the key the company declaration names for suggesting (`clientsDoor.suggestByAddressKey`; a sign-in address, say), or is on a domain (not free-mail) that people already assigned to
that one Client write from. Computed when asked and never stored, and it takes effect only when
a person or Claude links it, which is an ordinary assignment, audited with who linked it. Not to be confused with the
"Suggested reply from Claude" heading over a draft: that is a draft, not a Client.
_Avoid_: auto-assign, match, guess

**Link**:
The word for putting a contact under a Client (the assignment), and the button that does it: Link on
a Suggestion, Link after choosing another Client, and Unlink to take the contact out. Linking is the only
way a contact comes to count under a Client: a Client's view and its count in the menu are of linked people
only, and the inbox's Suggestions are shown beside them as Link buttons, never counted. Audited as whoever
pressed it. Not a Signing Link.
_Avoid_: accept (for a Suggestion), attach, tag

**Mailbox**:
One account on one channel. It has four kinds. A **Gmail mailbox** (a Gmail account the owner connected; the inbox takes several, each connected by the owner, any address) is where Gmail keeps the mail and the inbox keeps a working copy; each has its own grant, history cursor and watch, and its conversations carry its short label as a pill (for example `northfield`).
A Gmail account whose grant Google no longer accepts (a Google app in testing mode ends a grant after 7 days) is **lapsed**: it is said so by name, nothing syncs or sends for it, and connecting it again ends the lapse. A
**Cloudflare mailbox**, a **Telegram mailbox** and a **JMAP mailbox** are the other kinds, below. Slack is a later channel. A
conversation with no mailbox is a manual one.
_Also called_: Gmail account, which is the word for a Gmail mailbox in the space.
_Avoid_: account for any other kind, inbox (the inbox is the app)

**People of a mailbox**:
Who is on a mailbox: one person (a Gmail account they connected, which only they see) or a list (a shared mailbox), kept in the store as the rows of `mailbox_person` (migration 19, store version 20) and read nowhere else. What fills them is a source the store is
given: a Gmail account is its connector's; a declared business mailbox (Cloudflare's or the mail server's) is the declaration's `people`, left out meaning the install's owner alone; the Telegram mailbox is the owner's; and a mailbox nobody is on is the owner's, so no mail is ever left that
nobody can see. They are made agree with the declaration when the object starts (`settleMailboxPeople`), so adding someone to a mailbox is a deploy; when people are kept by the space the source changes and the reads do not. The decision is [ADR 0004](docs/adr/0004-every-mailbox-has-people-and-a-person-sees-only-theirs.md).
_Avoid_: owner of a mailbox, member (the install's `member` is a role of a person, not of a mailbox)

**Scope**:
What a person may see of the store's mail: the mailboxes they are on, and, for the install's owner only, what belongs to no mailbox (a text or a note, a draft not made from any mailbox, a contact with no mail at all). The one rule is `canSee` in `src/queue.ts` (a pure function: a table test), its translation to SQL is
`scopeWhere` (`src/store/scope.ts`, held equal to it by test), and every read that answers a person is cut to it before anything is counted or cut to a screen. An id the person may not see answers exactly as one that does not exist. Claude acts for the owner and reads with the owner's scope. A scope of everything (`ALL_MAIL`) is for the store's own work, never for a read that answers a person.
_Avoid_: permission, role, access (the install's roles are `owner` and `member`; a scope is mail)

**Cloudflare mailbox**:
One address on a domain whose mail Cloudflare Email Routing hands to the inbox's Worker, such as `support@northfield.example`. Unlike a Gmail mailbox, the inbox, not Gmail, is where the mail lives:
there is no other copy to refill from, so the exact message as it arrived (its **raw copy**, in a bucket) and the
store are the whole record, and neither is ever pruned. It is declared in the deploy config (an address and the
name its conversations are marked with), one per domain, and the first mail for it makes its row; mail for a
domain nobody declared is refused outright. Mail to any address on the domain lands in it. Its read and closed
state are the inbox's own stamps (as a manual conversation's are), not labels: a message arrives unread and open,
the owner opening it marks it read, Close closes it, and a new message reopens it unread. Its conversations carry its
name as a mark on the row and on the conversation, which a Gmail account's own mail never does. A reply on its conversation
goes out from its own address through Cloudflare's sending, never through Gmail as the owner, and a Gmail account's own never goes out as
it; a new email to a contact goes from the mailbox the drafter chose, else the mailbox that contact last wrote to when the draft was made (its **transport**).
_Also called_: business mailbox, which is what the space's pages say (the code and docs of this package say Cloudflare mailbox, which says what is different about it).
_Avoid_: team inbox (that is the people of a mailbox, above), account

**Telegram mailbox**:
The third kind: one row for the owner's one Telegram account (its address is their Telegram user id, its pill is "Telegram"), filled by the **bridge** and by nothing else (ADR 0001 decision 27). Like a Cloudflare mailbox the inbox's stamps are the whole read and closed state (a message from the person arrives unread and open and reopens a closed conversation; the owner's own message sent from their phone is filed read and closed), and Telegram's own folders and read marks are never written to. A conversation is one chat (with one person, or a group, or a channel: see below), found by the chat's id; a message is found by the chat and Telegram's message id, so a push repeated after a timeout stores one. A person (or bot) is an identity of kind `telegram` whose address is the Telegram user id; it joins the contact that already has the same phone number as a text identity when exactly one does, and Split undoes it. A bot's chat is Bulk. Telegram's own service chat (where login codes arrive) and Saved Messages are never stored. Its row holds **Telegram's position** (what a reconnect catches up from, stored with the batch it follows) and what the bridge last said of itself (live, catching up, signed out; not checked in after five minutes).
_Also called_: Telegram (the pill, the card and the script's `telegram` command).
_Avoid_: Telegram account (the mailbox is the inbox's row; the account is the owner's on Telegram)

**JMAP mailbox**:
The fourth kind: a mailbox on the install's own mail server, read and written over JMAP, declared in the space's deploy config with the name of the secret that holds its own JMAP-only key (ADR 0001 decision 33). Shaped like Gmail: the server is the mailbox of record and the inbox a working copy, so read and closed are the server's state (unread when not marked seen; open when in the Inbox, closed in Archive or any other folder), changed on the server first and then here; a message is found by the server's id and a conversation is the server's thread. Like a Cloudflare mailbox, the mailbox's address and every address on its domain are the install's. Its row holds the server's state strings as its cursor, whether the server's push subscription is live, and whether the server refused the key. Mail the server files as junk stays there and Drafts are not brought in. A reply goes out from it through the server's own submission, so it is in the mailbox's Sent in a mail app.
_Also called_: the mailbox on the mail server (the space's words).
_Avoid_: IMAP mailbox (nothing here speaks IMAP), the mail server's product name (the code says what it speaks, not whose server it is)

**Refused key**:
A JMAP mailbox's state when the server (or the door in front of it) turned the space's credential away. Nothing syncs or sends for it and nothing retries, because the server bans an address after 100 failed sign-ins; a deploy that changes the key or the door's token ends it.

**Telegram group**, **Telegram channel**:
A group is ONE conversation under ONE contact that stands for it (named by its title, the conversation's only participant, so its row never moves between members); every member who writes in it is a person (a contact with a `telegram` identity, the same one as their one-to-one chat), and each message is filed under its sender and not under the group. A member's own history holds what passed between the two of them and never a group message; the groups they write in are listed beside it (`groups`). A group rings, needs a reply and reopens only for a message addressed to the owner (it mentions them, or replies to one of their own messages: `telegram_to_me`). A channel is the same with no sender: its contact is judged an automated sender, which is what files it in Bulk, and it has no reply box. People leaves a group's and a channel's own contacts out. A supergroup and a channel have a position of their own (ADR 0001 decision 29; migration 17).
_Avoid_: channel for a Meet channel (Meet's channels are its own; a Telegram channel is one the owner follows and cannot post in), member (a member who has not written is nobody here: there is no roster)

**Bridge**:
The small program (kept outside this folder, by the project that runs one) that holds the owner's Telegram connection and pushes what Telegram says to the inbox through its door of its own (`/agent/telegram`, the token "telegram bridge"). It runs on a machine of the owner's choosing, not in the space. It fills the last 30 days once, catches up after a gap from the stored position (reading the chats instead when Telegram says the gap is too long), and pushes live updates in the order they came. The inbox never calls it; it asks the inbox for work every few seconds, which is also its heartbeat.
_Avoid_: bot (Telegram's word for a program people chat with; the bridge is not one), sync (the Gmail Mailroom's word)

**Transport**:
How a message leaves a mailbox: Gmail's API for the Gmail mailbox, Cloudflare's sending for a Cloudflare mailbox. A draft
goes out by the transport of the mailbox it is FROM, which is decided when the draft is made and shown on it: a reply, the
mailbox its conversation is in; a new email, the mailbox chosen for it (the person at the space's compose box, or Claude through `from` on a draft, one of the Gmail accounts or a business mailbox; Claude's is refused for a disconnected or lapsed account and on a reply), else the mailbox the contact last wrote to at that moment, else the default Gmail account (the owner's own address while it is connected). The two never cross, and
no later arrival changes whom a draft in the queue goes out as.
_Avoid_: channel (that is email, text or DM), route

**Raw copy**:
A message that came through Cloudflare, exactly as it arrived (every byte, attachments included), written to the
raw-mail bucket before the inbox parses it or the store hears of it, under the SHA-256 of its bytes so a delivery
that happens twice writes it once. It is the only exact record: if filing the message fails, the copy is kept and the
message is owed a filing, which the Durable Object's alarm retries from the copy until it works. The conversation shows
the text the inbox read out of it; the copy's key is on the message (`rawKey`).
_Avoid_: archive, backup, attachment

**Spam check**:
The one judgment in a Cloudflare mailbox's Inbox and Bulk, and the only one a model makes on arrival. Its questions are written per mailbox (what a business's customers write, what is a pitch, how hard to lean to keeping a real person's message): a mailbox with none is never put to the classifier and its switch will not turn on, until its own are
written. When a message comes
through a Cloudflare mailbox it is kept (its raw copy), filed, and then put to the **classifier**, Cloudflare's decision model on
Workers AI, which answers how likely the message is to be unsolicited (0 to 1) and which of a short list of kinds it is
(for example: a customer, business already under way, selling something, a scam, a test; each mailbox's questions name the kinds that fit it). Those three facts (the score, the kind, the
model) are stored on the message; NULL means nothing judged it, which is not a low score. **0.80 or more is spam**: the
conversation is Bulk, marked Spam, kept and never deleted. Under 0.80, or not judged, it is Inbox. It is asked only of what
no rule has settled: not of a message with a List-Unsubscribe header or an automated sender (those are Bulk without it), not
of a conversation with a **Client's** contact on it (a Client is never judged spam), not of one a person has called, not of
the mailbox's own mail, and not while the owner's switch for it is off. Nothing it does can fail the filing: it is cut off
after a few seconds, and a judgment that does not come leaves the message in the Inbox, notified. It never retries.
The owner or Claude may move a conversation to Bulk or back (a **spam call**, on a Gmail conversation too), which decides over every rule but a Client's
people and stays when the same person writes again in that conversation. ADR 0001 decision 22 is the record.
_Avoid_: sort, label (which in the inbox already means Gmail's), category, tag, filter

**Assistant**:
The model that writes a reply when the owner asks for one in the draft chat, on any email conversation (a business mailbox's and a Gmail account's,
decision 23), and revises it as they chat. It does nothing on arrival: it does not sort mail, does not decide Inbox or
Bulk, and writes no draft until asked (decision 22). It never sends, and it is not Claude, which in this repo means
Claude in a session, working through the script: a draft it wrote says so (`createdBy: assistant`, or the owner's name with the
assistant's edit when it filled the empty draft they asked for), as Claude's says Claude. It signs as the persona the install's content gives the mailbox and reads that mailbox's business's knowledge base; a persona may also carry rules of its own (for instance that it gives general information and never legal advice), and a mailbox with no persona gets no assistant. A business's entries are marked for it in the knowledge base, so
it states no price, hour or policy it has not been given (while a business has none, its prompt says the knowledge base is empty). It runs on a key of its own, which only the draft chat uses; without the key the chat is
refused and nothing else changes.
_Avoid_: bot, agent, AI

**Knowledge base**:
What each business's assistant may tell people (prices, hours, policies). **It is not the inbox's:** it is the knowledge app's (`packages/knowledge`), one base for the
organisation, each entry marked with the **businesses** it is for, every version kept and who wrote each. The assistant asks the app for the ACTIVE entries marked for the
business of the conversation's mailbox on every chat turn, so a price in one is a price it quotes to that business's customers; if the app does not answer in four seconds the
turn is refused with a sentence and nothing is saved, never drafted as if the business had none. The owner adds, edits, removes and puts back entries in the space's
Knowledge tab, and nowhere else; Claude reads the base and **proposes** an entry (naming its businesses) or a change to one through the script, which hands it on to the app
and which nothing reads until the owner approves it. The assistant writes none. The inbox's own old per-mailbox tables are left as they were, read by nothing. See `docs/adr/0002`.

**Business**:
One of the company's businesses in the company declaration (`businesses`): an id, a name and the mailbox addresses that draft for it. A company with one brand has one; Northfield Works might name Northfield Works (`tessa@northfield.example`, the owner's Gmail) and a second business with its own business mailbox. A mailbox is in exactly one; the business of a conversation's mailbox decides which
knowledge its assistant reads. The inbox never keeps a list of its own.
_Avoid_: FAQ, wiki, docs

**Draft chat**:
The owner's conversation with the assistant about one draft ("shorter", "mention the $40 tune-up"), or on a conversation with none,
their ask for one ("write a reply"): the only way the assistant writes a reply. It is on every email conversation, a business mailbox's and a
Gmail account's alike (decision 23), with or without a draft, and does not depend on the spam check's switch. A text or a DM has none.
Kept beside the draft turn by turn: the owner's words, the
assistant's note, and whether the draft changed and from which revision. A turn that changes the draft makes the next revision (so a send naming the one before is refused), after saving
anything the owner had typed as their own edit; one on a conversation with no draft makes an empty draft in the owner's name for the
assistant to fill. On a Gmail conversation that draft is a normal Gmail-path draft, sent through Gmail as the owner. The reply is to whoever the
conversation's reply plan addresses (the newest message that came in: its Reply-To, else its From, never us; when nothing has come in and the owner
wrote last, the first address the newest message was written to), and the model is shown only what was exchanged with that person (and, when
there is no draft yet, the message being answered), with quoted history cut where it can be proved to be a quote, never the rest of a thread of several people. It is the owner's alone (Claude has no chat), and nothing typed there sends anything, "send it" included.
A message that arrives over a draft changes nothing about it.
_Avoid_: thread, message (a chat turn is not a Message)

**Conversation**:
Everything said between the owner and one or more contacts on one channel, as the mailbox threads it.
For Gmail that is a thread. For a manual channel (a text, a DM) it is one per contact per channel.
The unit of work: it is assigned, read and closed as a whole.
_Avoid_: thread (Gmail's word for one kind), chat

**Message**:
One email, text or note in a conversation, with a direction and a status.
_Avoid_: email, mail (a message may be neither)

**Attachment**:
A file that came with a message, kept as its name, its size and the type the sender's client declared, and never
as its bytes in the store. For Gmail, Gmail is the only copy: a picture (PNG, JPEG, GIF or WebP, by its own first bytes, at most 5 MB) shows
under its message as a thumbnail fetched from Gmail when it is about to be seen; every other one is a chip that opens the
message in Gmail. On a message that came through a **Cloudflare mailbox** its bytes are in the message's **raw copy** and the inbox gives
them back to its owner, and to nobody else (Claude's token is refused): a picture as a thumbnail, any other file as a download, read out of the raw
copy when asked for, one at a time, and not from a message over 10 MB (named only, "too large to open"). A reply from a Cloudflare mailbox
may carry files (ten, 15 MB together), each kept beside the **sent copy**; a Gmail account sends none. Named by its message and its place in that message's list, never by Gmail's id for it.
_Avoid_: file (too broad), image (only some attachments are pictures), download (only for a Cloudflare mailbox's files; Gmail's other files open in Gmail)

**Calendar summary**:
What an email's first calendar part (text/calendar or application/ics, inline or a file, or a name ending in .ics) says, read once when the mail arrives and kept on the message as a short piece of JSON (`message.calendar`, migration 20): what the part is (an
**invitation**, an **update**, a **cancellation**, a guest's **answer** (accepted, declined, tentative or a counter proposal), or a plain **event**), the first event's title, time, place, organizer and guests (ten, then a count) and how many more events the part holds. Times are read to
moments (UTC, an IANA zone, a Windows zone name through a fixed table, or the part's own zone block) or kept as written and said so; text is cut and stripped, and no link is kept. NULL on a message not looked at, the text `none` on one looked at that has no summary. A conversation shows
a card from it in place of the empty bubble, a list row whose newest email has no words is listed under its one line, and Claude's script prints that line. Made for every email, a person's included, because it closes nothing (the **event key** is a different thing: it keys only mail Google Calendar sent, to close older updates).
_Avoid_: invite, ics (the file), event (Google Calendar's word, and the event key's)

**Delivery report**:
What Cloudflare's Email Sending publishes, to a queue the inbox consumes, about one recipient of one message the inbox sent as a **Cloudflare mailbox**: delivered, deferred, bounced, failed, rejected or complained, with the receiving
server's reason in its words. Kept one row each in `delivery_event` (never changed, once however often it is delivered), believed only when its sender is a declared mailbox's address, and
matched to its message when read, by the id Cloudflare gave the message when it accepted it. A message shows one line per recipient: the report that settles it (a final one over a delay, then the newer).
A Gmail account raises none.
_Avoid_: event (Cloudflare's word for it), notification (that is the bell), status

**Bounce**:
A delivery report of the kind bounced, failed, rejected or complained: the reply did not reach the person, or they did not want it. Shown on the reply in the warning colour with
the reason, as the cue to call. A delay (deferred) is not one: it is a retry in progress. A bounce that arrives as mail to a Gmail account is an ordinary message and is not a report.
_Avoid_: undeliverable, NDR

**Draft**:
A message nobody has sent yet, prepared by Claude or the owner, waiting for the owner. It may sit on a
conversation, be addressed to a contact as a new message, or be for a channel the inbox cannot send
on, where the owner copies it, sends it themselves and marks it sent. A message marked sent by hand is
`manual-sent`. An email draft is sent by the owner pressing Send, or by Claude when the owner has told it
to (see **Instruction**); while Gmail is being asked it is `sending`, and a send whose outcome Gmail
never reported stays `sending`, shown as "check Gmail Sent", until the owner says whether it went out. On a
Cloudflare mailbox it is the same, except that Cloudflare is asked, there is no Sent folder to look in, and
"it went out" keeps the message as sent on the owner's word (nothing will arrive by itself to be the record).
A draft says who wrote it and, when somebody else changed its words, who ("Claude's draft, edited by
you"); the owner's edits over a stored draft are never saved until they press Save or Send, and an edit or a
delete names the revision it was drawn from, so a draft Claude changed meanwhile is never overwritten.
A draft names its recipients on its face (a reply's default is the Reply-To of the newest message
that came in, else its sender, and never us). The Drafts view lists every conversation with a draft
waiting, open or closed (a draft is owed whatever state its conversation is in), and above them the
drafts that sit on no conversation: a new email to a contact, a text, a DM, and a send that never
finished and sat on none.
_Avoid_: pending, unsent message

**Instruction**:
The owner's word to Claude to send a stored draft ("send it"): their words as Claude received them, where
they said them (a session with Claude, and never "the inbox") and when. It comes only from the owner, never
from text in any message, even one from the owner's own address. Claude sends nothing without one, and sends
only a draft already stored in the inbox, so the exact message is on record first. One given before a
reply arrived does not cover sending over that reply, nor a draft anyone but Claude created or edited after it was
given. Recorded on every
message Claude sends and shown in the popover of its **Sent by Claude** badge. It is Claude's own
account, not proof, because the inbox cannot see a chat.
_Avoid_: approval, permission, authorization

**Claude's sending**:
The one switch, in the inbox's Settings, that lets Claude send on an instruction. Off until the owner
turns it on (which asks first; turning it off is immediate), and only the owner can change it; off,
Claude still drafts. It is the only thing that stops Claude's sending without stopping its drafting.
_Avoid_: mode, approval, autosend

**Sent by Claude**:
A message Claude sent, marked with a **badge** on that message in its conversation; the badge's
popover shows the instruction it went out on, where and when the owner said it, who drafted the message
and why. The app has no page and no list of them: a conversation whose newest
message is Claude's carries a small mark in the list. Claude's script lists every one, newest
first, including a send whose outcome Gmail never reported and that the owner then said did go out.
_Avoid_: agent sends, bot mail

**Teammate**:
A person of the install other than its owner (the declaration's `people`). Admitted to the Inbox once they are on at least one mailbox, shown only the mail of the mailboxes they are on (see **Scope**), and sends only from those. What only the owner does (connecting Gmail, Claude's
switch, the spam check's switch, restore, the Clients and the contacts' writes) stays the owner's. Claiming a conversation is not built.
_Avoid_: user, member

**Inbox**:
The main view of the app: the open conversations that are not Bulk, of every mailbox. It is not Gmail's Inbox, which
holds Bulk too, and "the inbox" still names the app. Beside it are the views Unread (the Inbox's
unread ones), Drafts, Bulk and Closed, one view for each Cloudflare mailbox (its open conversations that are not
Bulk, with its own counts), and one view for each Client.
_Avoid_: queue, All open

**Automated sender**:
A contact the inbox treats as automated, not a person: a newsletter, a no-reply address. Decided by a rule each
time a contact is shown and never stored, like a Suggestion, with its reason as a sentence on the contact's page
and in the details column. In order: a contact under a Client is always a person; otherwise it is automated when
its name is a machine-made address (an unsubscribe or bounce address, or one with a token for a name), when every
address it has is a no-reply kind of mailbox (noreply, donotreply, notifications, mailer-daemon, postmaster), or
when it has conversations and every one is Bulk, unless one of its addresses is a free-mail address
(gmail.com, yahoo.com, outlook.com and the like), since a person's only conversation can land in Bulk; that exemption
sets aside the Bulk reason only, and the name and no-reply reasons still apply. The length of an address is never a reason, and neither is
hello@, help@, support@, leads@ or billing@, because people answer from them. For a conversation in either kind of mailbox the
name and no-reply reasons also decide Bulk, as the newest sender's (the history reason needs conversations to count and is
not asked there). Contacts lists automated senders
last, folded behind one line, and their avatar is a dashed square. Nothing marks a contact by hand: a misfire is
fixed by changing the rule. The page offers two hand fixes only: Rename, for a name the rule read as an address,
and Link, when the inbox suggests the contact's Client (a contact under a Client is a person).
_Avoid_: bot, robot, machine (in the app's words)

**Search**:
The box above the list: it finds conversations, open or closed, that have every word typed somewhere on them (the
name or address of a person on it, a subject, or the text of any message, a waiting draft included), newest first,
at most one screen. It reads only what the inbox holds, the last 30 days of mail and everything since, never
Gmail; older mail is Gmail's to search. It is a read: it writes nothing and never marks a conversation read (only
opening one does). Claude's script has the same search (`search <words...>`). A plain scan, with no index. Letters
are matched without regard to case for ASCII only (SQLite's `LIKE`), so "é" does not find "É". Enter in the box opens
the first result and keeps the results; Escape empties the box.
_Avoid_: filter (the views are the inbox's filters), find

**Bulk**:
Newsletters, receipts and notifications, and spam. ONE rule for both kinds of mailbox (`src/queue.ts`, decision 23), in order: a
conversation with a contact assigned to a Client on it is never Bulk; a person's call (a **spam call**, on a Gmail or a Cloudflare
conversation) decides; then the newest inbound message: a List-Unsubscribe header, and for Gmail a category tab (Promotions,
Social, Updates, Forums), and for both an **automated sender** (no-reply kinds, machine-made names), and for a Cloudflare mailbox
last the classifier's score at 0.80 or more. Gmail's is decided from the mail's own envelope and the sender's name and addresses and never from
its content; a Cloudflare mailbox has no category tabs and adds the one judgment of the **Spam check**. Shown under its own view and not in the
Inbox, unless one participant is a contact assigned to a Client. It is the inbox's view and never a change in Gmail: Gmail's labels
are untouched, nothing is deleted, and changing a conversation's place notifies nobody. A row in a Cloudflare mailbox says Spam
when the classifier or a person called it spam, and an open conversation of either kind lists why it is where it is (its header, its category
tab, its automated sender, a call, and for a Cloudflare mailbox the classifier's score).
_Avoid_: spam (as a general word for Bulk: Gmail's own spam never comes in at all, and a conversation is spam only when the classifier or a person said so), junk

**Closed**:
A conversation taken out of the Inbox; it is open until then, and for Gmail open means any of its
messages is in Gmail's Inbox (a message in the trash, in spam or an unfinished draft does not count).
Nothing is deleted, one click reopens it, and a new reply reopens it by itself. The button that closes
one is called Close (key c), and Reopen brings it back; closing or reopening one here archives or
unarchives it in Gmail first. Close only covers what the person has been shown: if an inbound message
in the Inbox arrived after they last looked, the inbox refuses and shows it. (Reopen has no such
check, since it hides nothing.) Closing moves on to the next conversation in the list, with a
"Closed." notice and an Undo, which is Reopen. Mail the owner sent by hand is filed closed, as Gmail files
a conversation of nothing but sent mail. The inbox also closes by itself in one case: when Google Calendar
sends a newer update (or the cancellation) of the same calendar event into the same mailbox, the older
open conversations of that event, which hold nothing but calendar mail and nothing of the owner's, are closed
the same way (Gmail first), stamped `closedBy: calendar` and audited as `conversation.replaced`; one that a
person reopens afterwards is never closed that way again.
_Avoid_: done, resolved, archived (that is what Closed does in Gmail, not what it is here)

**Read**:
A conversation is read when none of its messages is unread; a message in the trash, in spam or an
unfinished draft does not count. For Gmail that is Gmail's own unread mark, so reading on the phone
changes it here, and the owner opening a conversation in the inbox changes it there. The inbox also
records who made each change (a person, Claude, or Gmail). Like Close, opening only marks read what the
page showed: an unread message that arrived after the page was loaded makes the inbox refuse, and show
it. Claude's reading never marks anything read, so unread keeps meaning that nobody has looked.
_Avoid_: seen, opened

**Fill**:
The first reading of a mailbox when it is connected: the last 30 days of Inbox and Sent mail, each
message with the labels Gmail has on it. Carried out in short runs, so it takes a few minutes for a large
mailbox, during which the mailbox is shown as filling and not as live.
_Avoid_: import, backfill, sync (a sync is the catch-up that follows)

**Push**:
Gmail telling the inbox, through Google Pub/Sub, that the mailbox changed. It is a hint and carries
nothing the inbox believes: the inbox asks Gmail what changed since its cursor. Arrives on the one
public hostname, and only with a Google-signed token.
_Avoid_: webhook, notification (that is what the inbox shows on a person's devices: see **Notification**)

**Notification**:
What a person's phone or Mac shows when mail from a person lands in the Inbox: the sender's name over the
subject, on the lock screen too, and nothing more of the message. "From a person" is the inbox's own
rules: not Bulk, not an automated sender, a Client's people always; never the owner's own mail or Claude's
sends, mail already read, mail found more than an hour after Gmail received it, or the 30 days read in
when Gmail is connected. For a Cloudflare mailbox's mail it is the same shape, asked once per message after the spam check has answered
(or failed, or was not asked): Inbox mail notifies, Bulk and spam never, and a message nothing judged notifies. One per email on each device (more than three at once arrive as one, "5 new messages", whose tap opens the Inbox), encrypted to the device on its way through
Google's push service, quiet on a device where that conversation is open on screen, and a tap opens that
conversation. Gmail's own notifications on a phone are separate and stay on.
It goes to every **Device** of a person who may see that mail, one payload for each: the sender over the subject, the sender's address and a conversation id; a tap opens THAT PERSON'S conversation in the space (`/inbox/<address>`), or the Inbox list for a summary and the test.
_Avoid_: push (that is Gmail telling the inbox), alert

**Device**:
One browser, or installed app, on one phone or computer, where a person turned notifications on in Settings. Listed there with when it last got one and any problem, and removable from any device of theirs. A device is its person's (whoever turned it on; one from before devices had people is the owner's), listed, tested and removable by that person alone, and a notification goes only to the devices of people who may see its mail. Claude cannot turn one on or off. Every device is the space's (the inbox's own installed app is gone; an old `device-origin:<id>` setting row is read by nothing).
_Avoid_: subscription (a Subscription in this repo is Stripe's, and Pub/Sub has one too), endpoint

**Watch**:
Gmail's standing instruction to publish a mailbox's changes. It lapses after seven days, so the
daily pass renews it. A mailbox with no watch, or one about to lapse, is shown amber.
_Avoid_: subscription (that is the Pub/Sub side of the same path)

**Resync**:
Reading a window of a mailbox again because Gmail no longer has the history since the inbox's
cursor (an outage, a long gap): the mail from a day before the newest message held, and the labels
of the open conversations, so a read or an archive made meanwhile is caught. Stamped on the mailbox
with the time it finished.
_Avoid_: rebuild, reindex
