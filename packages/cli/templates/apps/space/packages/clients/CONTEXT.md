# clients: Context

The one list of Clients of an install. The company layer's terms (install, declaration, switch, owner, assertion) are in [`packages/workspace/CONTEXT.md`](../workspace/CONTEXT.md).

## Glossary

- **Client**: a business the company serves and groups people, mail and documents under. One thing: the space's, not an outside site's and not Forms'. It has a **number**, a **name**, a **legal name**, a **revision**, and, if a source brought it in, a **source part**.
- **Number**: the Client's id in the space, a whole number from 1, what every link and address names. The row's own id: never reused, never changed. A Client made in the space is numbered from `CLIENT_LOCAL_NUMBER_FROM` while the install has a source, from 1 with none; a Client a source brought in keeps the number the source asked for when it was free.
- **Name, legal name**: the name is required and on one line; the legal name is optional (the limits are `CLIENT_NAME_MAX` and `CLIENT_LEGAL_NAME_MAX`, Forms' own, so a Client always fits Forms). Edited by the owner, or followed from the source until then.
- **Revision**: how many times the Client's own fields have changed. An edit names the one the owner was shown, and is a `conflict` over a Client that has moved.
- **Archived**: out of the lists and pickers, kept with its people linked. The owner's alone: a source never archives, and nothing deletes.
- **Source**: an outside system that keeps Clients of its own and PUSHES them in (a company's own website, for example Northfield's at `northfield.example`). The install declares at most one, as its `clientsDoor` (name, path, token). The space never asks a source and depends on none; an install with no source makes its Clients in the space.
- **Source part**: what the part keeps of a Client a source brought in, as generic fields: the source's name, its **external id** for the Client, an **address** of the Client in its admin, what it last **said** of the name and legal name (whole), its **extra** fields (text under keys the sender names; the part shows them and never reads them), and since when it is **gone**.
- **Said**: what the source last said of the name and legal name. A Client's name follows it only while the name still equals it (cut to the longest name): once the owner edits the name, the owner's stands and the source's is shown beside it.
- **Gone**: the source says the Client no longer exists. The Client is marked with the time and kept as it is, never archived or deleted; sending it again clears the mark.
- **Preferred number**: the number a source asks a Client to keep (a source's own Clients keep their numbers, so every link already made still points at them). Honoured when free, otherwise the Client takes the lowest free local number.
- **Full send** (`sync`): the source's whole set at once. Every Client in it is made or brought up to date, every Client of the source not in it is marked gone, and the result says whether the space now holds exactly what was sent. All or nothing.
- **Clients door**: the path of the space where the source's service token is let in (the space package's `src/clients-door.ts`), the third machine path after Claude's and the Telegram bridge's. It hands the source's face to the part.
- **Space face** (`createSpaceClients`): Settings' way in, called in the space's Worker with the person its one sign-in check named. Admits the owner only.
- **Inbox face** (`createInboxClients`): the inbox's way in, in-process, with no assertion. Reads the list and one Client; cannot write.
- **Source face** (`createSourceClients`): the Clients door's way in, made for the one declared source, with no assertion. Writes that source's Clients and nothing else.
- **The operator's three**: bookmark (Cloudflare's marker of the store's history now), restart (the object is reset under the call) and counts (how many Clients, of which kinds, and when the source was last heard from). The owner's, by POST, for the sitting of an apply and the comparison with the source's own list.
