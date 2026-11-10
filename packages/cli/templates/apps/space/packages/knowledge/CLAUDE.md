# knowledge

The one knowledge base of an install, marked by business, run by the space's Worker and read by the inbox's assistants. A library with no Worker of its own: the Durable Object that holds it belongs to the SPACE's Worker, and the inbox and the Knowledge tab call this package's code in that Worker. What it is: `README.md`. Terms: `CONTEXT.md`. The decision: `docs/adr/0001`.

## Working here

- **The schema runner is copied from the inbox's** (the inbox package's `src/store/schema.ts`). The layers are the inbox's: `store.ts` (rules, ports, no runtime), `space.ts` and `inbox.ts` (what each face does, with its externals passed
  in), `durable.ts` (the only file that touches `cloudflare:workers`; `store-access.ts` has the object's name and the typed way to reach it, with no runtime import, so the space and the tests load it).
- **The contract is in the workspace package's `src/knowledge.ts`**, not here. A method added to a face is added there first; `test/inbox.test.ts` pins the inbox face to the contract's method list, and `test/durable.test.ts` pins that the
  object has `call` and the operator's three and nothing else public (the runtime exposes every method of a Durable Object class over RPC, `private` or not).
- **The businesses are the install's company declaration's** (its `workspace.json`, bundled into the
  space's Worker): a new business is a line there and an apply of the space, and starts with no entries.
- **Secrets and vars:** none. The sign-in check is the space's (`createSpaceKnowledge` is handed the person it named, `SignedIn`).

## Checks

In a worktree, after `bun install` at the root, from the knowledge package: `bun test`, `bun run typecheck`. From
the workspace, space and infra packages: `bun test` and `bun run typecheck`. A worktree has no Cloudflare access.

## Where it breaks

- **Its identity is (the SPACE Worker, class `KnowledgeDO`) and the object's name** (`KNOWLEDGE_NAME` in
  `src/store-access.ts`). Changing any of them is a new, empty knowledge base beside the stored one.
- **Keep `src/durable.ts` free of anything the space's environment would not have** (it reads one binding, the optional `LIVE`, which it tells after a change is stored: `CHANGING_METHODS` in `src/store.ts`): the object runs with the space Worker's environment.
- **Migrations are appended, never edited or reordered** (`src/schema.ts`; `test/schema.test.ts` pins the count). A store a newer
  build migrated refuses an older one, so undoing a deploy that migrated is a forward fix, not a redeploy.
- **The inbox's face takes no assertion** and its only write is a proposal; do not add a method that edits, removes or
  approves to it. The space's face (`createSpaceKnowledge`) admits the owner only.
- **Entry text is read by an assistant on every email:** a longer title or body than the contract's caps is a cost on every reply.
- **Deploying:** nothing deploys from here. The knowledge class goes out with the space's own apply. If the base does not answer, the inbox refuses the draft-chat turn rather than draft as if the business had no entries.
