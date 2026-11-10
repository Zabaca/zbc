# People is three reads merged by address, and the profile is the inbox's contact with three fields

Status: accepted. People adds link to a Client, merge duplicates and documents. Completes the
tab [0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md) left as an honest empty state, and takes the Conversations tree's Contacts item from [0005](0005-the-inbox-s-other-views-come-in-the-sender-serves-both-kinds-of-device-and-the-old-address-moves-people-only-when-told.md)
off the inbox's own page.

## What People is

- **The directory** is the front door's merge of three reads, as Conversations' list is of two ([0003](0003-conversations-is-a-merge-of-two-reads-one-row-per-person-joined-by-address.md)): the inbox's
  contacts, meet's people and the company layer's team, one entry per person joined by lowercase address (a teammate on both of their addresses). Grouped **Clients** (a contact linked to a Client the site
  lists), **Outside** (every other contact the inbox judges a person, and channel guests) and **Team**. No channels: a channel is a conversation, not a person. Nothing is stored in the space.
- **An automated sender is not a person** (a newsletter, a receipt, a no-reply address: the inbox's own `judgeSender`). The inbox counts them and the directory leaves them out of its lists; the page says so in a line with **Show automated (N)**, which lists
  them under their own heading. A person's page, and the fields beside their conversation, find them either way, so a real person the inbox misjudged keeps their business, role and notes. Without leaving
  them out the directory would be hundreds of senders, and the Clients and Outside would be the smaller part of it.
- **The profile is the inbox's contact** (name, every address and number, Client) **plus three fields People adds: business, role and notes**, kept on the contact because a contact is the person (an identity is
  one way to reach them), in four columns of one migration (the inbox's migration 12; `profile_rev` is the revision). A teammate's profile is the company layer's person and has no boxes: what the team knows of
  each other is not the owner's notes. The same three boxes are drawn beside a person's conversation (`ProfileFields`), read by the conversation's own key, which the Worker finds the person by.
- **Open email** goes to `/inbox/<key>` and **Open chat** to `/meet/<key>` (they were one "Open conversation" to `/conversations/<key>` before [0014](0014-conversations-is-split-back-into-inbox-and-meet-and-the-old-addresses-redirect.md)), each where something has been said on that side (a contact with a conversation; a direct message with a message in it). The entry carries
  `conversationKey`, made by the rule Conversations' list makes its row key by, and a test pins the two equal for every row of the list. For someone nothing has been said with there is no row, and the page says so
  instead of offering a button that would end in "no such conversation".

## What a write is

- **A save names the revision the person was shown** and the inbox refuses it (`conflict`, nothing changed) when they have moved on, so two windows or Claude's script cannot write over each other. The page keeps
  what was typed in the boxes, shows the newer details under it and offers them instead; it does not read the newer details over the top while there is something typed. A merge names both revisions, for the same reason.
- **A merge is undoable, whole.** The inbox's merge already moved the addresses and deleted the other contact, and its old undo was to split an address back off (a new contact named by the address, with
  nothing of the old one). The merge's audit entry now keeps both contacts as they were (fields included, and when the absorbed one was made), and `undoContactMerge` puts the other contact back under its own id
  with its name, Client, fields and the addresses that are still on the survivor. The survivor's Client and fields go back only if nobody changed them since. A merge made before the migration has no fields in its entry and
  cannot be undone this way. The space offers Undo in the line that follows the merge, and the merge's number is what it names.
- **A merge fills the survivor's blanks** from the other contact (business, role, note), as it already did for the Client, and never overwrites a field the survivor has. The other's note is never lost: it is in
  the audit entry and comes back with an undo.
- **Linking a Client is the inbox's existing `linkClient`** (a Client the site does not list is refused; the Client list is the site's and is asked afresh). It sets a value, so twice is once and it has no revision.
- **Never retried:** every write is one call through `/api/inbox/<name>`, with the views' answer shape and their rule that a write the space loses track of is "it may have been done: look".

## What never appears

A message, a subject, a snippet or a draft (the profile is who someone is, not what was said); an automated sender; on a document anything but its title, state and counts (never the names of those who have not
signed, an address, a link or an answer: `PersonDocument` has no field for them, and a test looks for the names). A note belongs to its contact alone.

## Why not the alternatives

- **The profile in the space's own store:** the space stores nothing (0001). The fields are about a contact, which the inbox keeps, so they live in its store and a merge carries them with the contact.
- **A separate table for the fields:** one more table to merge, split and restore beside the contact for four short values. Columns with defaults are the smallest change a migration can be, and nothing is rewritten.
- **Undo by splitting addresses back off:** what the inbox had. It loses the other contact's name, Client and fields, and turns one person into as many new contacts as they had addresses.
- **Listing every contact:** the inbox keeps hundreds of automated senders; People is for people.
