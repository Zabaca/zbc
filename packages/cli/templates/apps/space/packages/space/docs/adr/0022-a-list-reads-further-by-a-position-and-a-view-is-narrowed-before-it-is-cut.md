# A list reads further by a position, and a view is narrowed before it is cut

Status: accepted. Builds on
[0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md) (the Inbox's list is a merge of the inbox's conversations, one row per person) and on
[0005](0005-the-inbox-s-other-views-come-in-the-sender-serves-both-kinds-of-device-and-the-old-address-moves-people-only-when-told.md) (a view lists what its count counts).

Every list of the Inbox (Inbox, Unread, Sent, Drafts, Bulk, Closed, a mailbox, a Client) was the newest `QUEUE_PAGE` (200) conversations of its view, with a line saying so, and the only way to
older mail was the search box. Two things were wrong with that.

## A view is narrowed in the inbox, before the cut

A mailbox's list was asked of the inbox as the main list, so the inbox kept the newest 200 open conversations of EVERY mailbox and the space then dropped the ones outside the mailbox. With
more than 200 open conversations, a mailbox whose mail is all older had a count in the menu and an empty list. A Client's list and Unread had the same shape: the page narrowed what the inbox
had already cut.

The contract's `InboxScope` now carries the narrowing: `mailbox`, `client`, `unread`, each applied to the conversations BEFORE the cut to a screen, as `addresses` and `contactIds` always were.
The space asks for a view by name (`?view=unread`, `?view=mailbox&mailbox=<id>`, `?view=client&client=<id>`) and `inboxScopeFor` turns it into that scope. The page still keeps the rows
its view is about (a Client's people, the people with something unread), which is now only a safety, not the cut.

One consequence is visible: a row in Unread is as new as the person's newest UNREAD conversation (it used to be their newest conversation, read or not), because the read ones are no longer in the
answer. A row in a mailbox or a Client's list has always been drawn from that view's conversations only.

## Load older reads down to a position

A list that has more shows a "Load older" control at its foot (the same one on a phone and a computer; the line that said the list was only the newest is now the line above it). The inbox answers
each list with `more` and `floor`: the position of the oldest conversation it holds, which is the conversation's last activity (the owner's newest send, for Sent) and its row number (the tie-break the SQL
orders by), as text. The page hands it back as `through`, with `older` for one more screen below it.

**A position, not an offset.** A count of rows shifts when mail arrives (the newest arrival pushes every row down one), so a page asked for by count would repeat a row or skip one. A position is
a place in the order, so mail that arrives is above every position, and mail that is closed or read moves nothing below it.

**Each answer is the whole list down to the position, never a page to add to what is held.** The page keeps one number, the position it has read down to, and every read of the list after Load older (a
live message, the minute's read, a send, the page shown again) asks for the list down to the same position and replaces what it holds. So loaded rows do not vanish on a refresh and a refresh cannot double
one; what arrived since is on top. The cost is that a list loaded to 600 conversations is read as 600 on each refresh, which the inbox does in one pass over facts it already reads for the menu. A person
who has not pressed Load older reads the newest screen as before. Another list starts again from its own newest screen.

**Who may see what is unchanged.** The position is read after the person's mailboxes have cut the facts (`canSee`), so a position handed to someone else's read shows them only their own mail.
The menu's counts are unchanged: they were never cut.

**Nothing here acts on rows.** The list has no "mark all read" or "Done all"; what acts on a person's conversation (read, Done, close) acts on that conversation, which the page opens whole by its own
read (`everything`), not on the rows the list drew. So no action covers a row that was not shown, and loaded rows add none.
