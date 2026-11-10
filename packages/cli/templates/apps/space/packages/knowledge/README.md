# knowledge

The one knowledge base of an install: what the assistants of each of its businesses may tell people,
written once, marked with the businesses each entry is for, and read by each business's assistant only for its own. Terms are in [`CONTEXT.md`](CONTEXT.md); why it was built this way is
[ADR 0001](docs/adr/0001-the-knowledge-base-is-an-app-of-its-own-with-no-address.md); how to work in it is [`CLAUDE.md`](CLAUDE.md).

**This package is a library, with no Worker of its own.** The store is the SPACE Worker's: the Knowledge tab and the inbox's assistants call this
package's code in the space's Worker. An earlier shape had a `knowledge` Worker of its own that the store was moved out of and that was then deleted; the old `SpaceKnowledge` and `InboxKnowledgeAccess`
entrypoints went with it. See "Reading an older note" in the space's [ADR 0015](../space/docs/adr/0015-forms-and-the-knowledge-app-run-in-the-spaces-worker-and-the-knowledge-store-is-handed-to-it.md) before trusting a line in an older note that names either.

## What it is

- **One Durable Object, `KnowledgeDO` (`src/durable.ts`), with its own SQLite**, one object named `knowledge`, owned by the space's Worker. Migrations are in code (`src/schema.ts`,
  applied by the constructor, refusing a store a newer build migrated). Nothing in this package touches the Workers runtime but that file.
- **Two faces, both called in-process in the space's Worker** (the contract is the workspace package's `src/knowledge.ts`):
  - `createSpaceKnowledge` (`src/space.ts`), for the space's Knowledge tab: `knowledge(asker, business?)`, `changeKnowledge(asker, change)` and the operator's three. It takes the person the space's one sign-in check named
    and admits the install's owner and nobody else (no teammate), stamping the owner's address. The assertion check is the space's
    ([workspace ADR 0003](../workspace/docs/adr/0003-the-space-checks-the-sign-in-once-and-the-parts-in-its-worker-are-handed-the-person.md)).
  - `createInboxKnowledge` (`src/inbox.ts`), for the inbox: `activeFor(business)` (the words of a business's active entries, for the draft chat),
    `readBase(business?)` and `propose(by, proposal)` (for Claude's script, which the inbox hands on). No assertion, because it has no route; it can read and propose and nothing else, and a proposal must name an agent (`agent:...`).
- **The rules** are the inbox's knowledge store's, keyed by business: every version kept (a change of businesses is a version),
  the version check, the owner alone changing entries, Claude proposing, the assistants only reading, at least one declared
  business per entry, an entry the same as an active one refused, at most fifty proposals waiting across the base, and a proposed change refused at
  approval once its entry has moved past the version it was written against.

## Checks (in a worktree)

From the knowledge package, after `bun install` at the root: `bun test`, `bun run typecheck`. From the workspace and
infra packages: the same. Nothing here talks to a live service: the rules run over a real SQLite with the real migration, the
sign-in over a stand-in Zero Trust team, the object over a stand-in for `cloudflare:workers`. The space package's own tests pin that its Worker exports the class and binds it.

## Deploying

Nothing is deployed from here: the space's apply (`bunx @zabaca/zbc apply <env> space`) deploys the class with the rest.
