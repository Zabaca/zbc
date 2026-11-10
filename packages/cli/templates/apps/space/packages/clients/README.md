# clients

The one list of Clients of an install: the businesses it serves and groups people, mail and documents under. Made, edited and archived in the space, and, where the install has an outside system that keeps Clients of its own, pushed in by that system. Terms are in [`CONTEXT.md`](CONTEXT.md); why it is built this way is the space's [ADR 0021](../space/docs/adr/0021-clients-are-a-part-of-the-space-with-a-store-of-their-own-and-sources-push-them-in.md); how to work in it is [`CLAUDE.md`](CLAUDE.md).

**This package is a library, with no Worker of its own,** and it is what the inbox and Settings › Clients read: the inbox is handed its inbox face in-process (no service binding to any site), Settings makes, edits, archives and puts back Clients through its space face, and People links to them. A Forms client row is a Client's signing settings, and this part is the one writer of the copy of a Client's names that Forms keeps (the space's ADR 0021, section 6).

## What it is

- **One Durable Object, `ClientsDO` (`src/durable.ts`), with its own SQLite,** one object named `clients`, owned by the space's Worker, declared there as a new class. Migrations are in code (`src/schema.ts`, applied by the constructor, refusing a store a newer build migrated). Nothing in this package touches the Workers runtime but that file. Unlike the calendar's store it is not a copy of anything: a Client made in the space is only here.
- **Three faces, all called in-process in the space's Worker** (the contract is the workspace package's `src/clients.ts`):
  - `createSpaceClients` (`src/space.ts`), for Settings: the list, one Client, make, edit (naming the revision shown), archive, put back, and the operator's three (bookmark, restart, counts). It takes the person the space's one sign-in check named and admits the install's owner and nobody else.
  - `createInboxClients` (`src/inbox.ts`), for the inbox: the list and one Client, nothing else. No assertion, because it has no route; it cannot write.
  - `createSourceClients` (`src/source.ts`), for the Clients door: upsert one Client by the source's id, mark one gone, send the full set (what is missing is marked gone, all or nothing), and list what the space holds so the sender can reconcile. No assertion, because the door (the space package's `src/clients-door.ts`) verified the service token; it is made for the one source the declaration names.
- **The rules** are in `src/store.ts`: a Client is a number (a whole number from 1, never reused), a name, a legal name (none, or one), who made and last changed it, when it was archived, and a revision. Nothing deletes a Client. A Client made in the space is numbered from `CLIENT_LOCAL_NUMBER_FROM` where the install has a source (so the source's own numbers stay free) and from 1 where it has none. **Every limit** (the name's and legal name's lengths, where local numbers start, how much a push may hold) is a constant in the workspace package's `src/clients.ts`; no other doc restates the numbers.

## Sources push; the space asks no one

**The Clients part depends on no source.** A deployment with no source declares no `clientsDoor`, binds nothing, runs no pull, and makes its Clients in its own space; everything here works for it. Where there is an outside system that keeps Clients (a company's own website, for example the one at `northfield.example`), it is a SENDER: it reaches the part through one generic door (`ClientsForSource`: `upsert(id, fields)`, `gone(id)`, `sync(clients)`, `list()`), and the part keeps what it says as generic `source` fields on the Client: the source's name, its id for the Client, an address of the Client in its admin, what it last said of the name and legal name, and a bag of `extra` text fields it names itself (for a site, say, a subscription and a sign-in address). The core Client has no Stripe or site-specific field names, and nothing in `src/` mentions either (the space package's `test/wrangler.test.ts` holds that). The sender is a separate change in its own repo; the only source-specific files here are the declaration's `clientsDoor` entry and the Access application for its token (an infra instance named `space-clients-access`), so a company that has no such service declares neither.

What a source may rely on, all the store's:

- **The source's name wins until it is edited in the space.** A Client's name and legal name follow what the source last said while they still equal it; once the owner edits one, the owner's stands and the source's is shown beside it.
- **A Client the source says is gone is marked, with the time, and kept.** Never archived or deleted by the source; sending it again clears the mark.
- **A Client keeps the number the source asks for** (`preferredNumber`) when it is free, and otherwise takes the lowest free local number. This is what keeps every link already made to a Client of the source pointing at it.
- **The same push twice changes nothing** the second time, and writes nothing to the record.

## Checks (in a worktree)

From the clients package, after `bun install` at the root: `bun test`, `bun run typecheck`. From the workspace, space and infra packages: the same. Nothing here talks to a live service: the rules run over a real SQLite with the real migration, the object over a stand-in for `cloudflare:workers`, the door over the real router with a stand-in Zero Trust team.

## Deploying

Nothing is deployed from here: the space's apply (`bunx @zabaca/zbc apply <env> space`) deploys the class with the rest. The Clients door's Access application mints its service token on its own first apply, so that apply comes first and alone (applying `space` first would mint the token where nobody is capturing the secret).

### The first apply: mint the door's token and store it where the sender keeps its secrets

The secret is the sender's: the sender presents the token's client id and secret as the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`. This is the one place the steps are written.

1. **Mint the token** with an apply of the door's Access application alone, from a checkout that has Cloudflare access and the secrets store's keys (a worktree has neither): `bunx @zabaca/zbc apply <env> space-clients-access --json <temp file>`, with the apply's own output discarded. Do this and the next step with a small script of the install's own, so nothing is typed or shown: check that the sender's secrets store can be decrypted and written before the apply, read the token from the `--json` result, and store it there (values go down a pipe, never onto a command line or a screen). If the deploy token lacks "Access: Service Tokens Write" the apply answers 403: mint a short-lived account token carrying only that permission, run the apply with it in the deploy token's place for that one apply, then delete it.
2. **The keys it writes**, in the sender's secrets file: `SPACE_CLIENTS_CLIENT_ID` and `SPACE_CLIENTS_CLIENT_SECRET`. Declaring them as the sender Worker's secrets, and committing the encrypted file, are the sender's own change.
3. **Then apply the space** (`bunx @zabaca/zbc apply <env> space`; it restarts the running inbox, so do it when the owner says). It reads the door's audience and the token's client id from the instance's outputs.
4. **Check the door**, printing nothing secret: read the pair from the sender's secrets file into shell variables, then `GET https://<space-host>/agent/clients/api/clients` with the two headers answers 200 and a list (empty before the first push); the same request without them is a 302 or 403 from Access.

**If the capture fails** (the script says "no new secret" on a first run, or the apply printed its pair somewhere it was lost): the secret is shown once and cannot be read again. Set `rotate: true` on the instance for one apply, run the script again to mint and store a new secret, then set it back to `false` (an unrotated token is left alone by every later apply). Nothing is using the old secret while the sender does not exist yet; if a sender is already using it, it stops working until it is given the new one.
