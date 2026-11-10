# Forms and the knowledge app run in the space's Worker, and the knowledge store is handed to it

Status: accepted: one app at the space's address, each store moved by Cloudflare's transfer. This is the first stage of the move (forms and the knowledge app); [0016](0016-meets-chat-calls-and-phone-run-in-the-spaces-worker-and-its-two-stores-are-handed-to-it.md) and [0017](0017-the-inbox-runs-in-the-spaces-worker-and-its-store-is-handed-to-it.md) are the next two.
**Supersedes [0001](0001-one-front-door-four-tabs-the-apps-keep-their-data-and-outsiders-their-addresses.md)'s "the apps keep their data" for forms and the knowledge app** (and, as each moves in, for meet and the inbox);
amends [0007](0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md) (the space no longer forwards to forms) and [0008](0008-knowledge-is-the-fifth-tab-and-the-only-place-knowledge-changes.md)
(the base is the space's, not another app's). The sign-in rule is the company layer's [ADR 0003](../../../workspace/docs/adr/0003-the-space-checks-the-sign-in-once-and-the-parts-in-its-worker-are-handed-the-person.md).

## What changed

The space's Worker was a front door that stored nothing and asked four apps over service bindings. Two of the four are now its own code:

- **The knowledge app** (`packages/knowledge`) runs in the Worker: `createSpaceKnowledge`, a function over the store, called with the person the one sign-in check named. The store, one SQLite Durable Object
  (`KnowledgeDO`), belongs to the space's Worker. Cloudflare's transfer between Workers handed it over (five deploys in a fixed order, proved first on throwaway Workers); nothing
  was copied, and it is found by the same name (`KNOWLEDGE_NAME`). The class is defined in one file (`packages/knowledge/src/durable.ts`) that both Workers build from, and `src/index.ts` exports it.
- **Forms** runs in the Worker: its operator API is its own Hono app, built once and handed each request with the operator the check named (`src/parts.ts`), and its reads for Today, People and a conversation are
  `createSpaceForms`. Its database and bucket are the account's own, bound by their names (`FORMS_DB`, `FORMS_FILES`) where they have always been. The Worker holds forms' three secrets and its sender (the install's forms address)
  and has the 10-second CPU guard sealing needs. **What did not move at this stage:** forms' signers' pages and API at forms' own host, its hourly sweep and its migrations stayed on forms' own Worker until the guest paths ([0018](0018-guests-and-signers-use-three-open-paths-of-the-spaces-host-with-no-sign-in-and-a-policy-that-keeps-their-pages-to-those-paths.md)), the
  schedules and the cutover moved them.

## What each Worker was at this stage

| Worker | Is | Until |
|---|---|---|
| `space` | the page, the one sign-in check, forms' operator API and reads, the knowledge base and its store, the Inbox and Meet tabs (drawn from the inbox and meet) | it is the whole app (the end state) |
| `forms` | the signers' pages and API, the hourly sweep, the database's migrations | the cutover, when the space is the only Worker |
| `knowledge` | a forwarder: the class kept in its code, bound back to the space's by name, `InboxKnowledgeAccess` for the inbox's assistants | the inbox moves in; deleted at the cutover |
| `inbox` | unchanged: a Worker of its own behind a service binding, verifying the forwarded assertion | the inbox moves in |
| `meet` | the next stage ([ADR 0016](0016-meets-chat-calls-and-phone-run-in-the-spaces-worker-and-its-two-stores-are-handed-to-it.md)): its chat, calls and phone run in `space`, and its stores are handed to it; what is left is the guests' side | the guest paths move in, then the cutover |

The knowledge forwarder is the exception to "no compatibility shims" that the move itself plans (a deployed Worker, not a forwarding module, needed because the inbox still binds it); nothing may be added to it.

## Reading an older note

Until the cleanup that followed the move of this stage, both Workers also kept an old entrypoint for the live space, `SpaceForms` (forms) and `SpaceKnowledge` (the knowledge app), each with a `SPACE_ACCESS_AUD` var, so that the old space kept working, and could be put back, until the new one was deployed. They were then
deleted, with the step files of the transfer (`wrangler.transfer-*.jsonc`, `wrangler.back-*.jsonc`), the `DO_TRANSFER_STEP` variable and `packages/infra/src/transfer.ts`. **A note in a README, ADR, runbook or code comment that says the space binds `FORMS`, `FORMS_READS` or `KNOWLEDGE` to those entrypoints, forwards the
assertion to them, or that either Worker holds `SPACE_ACCESS_AUD`, was true until then and is not now.** Those notes are left as the record of what was built and deployed at the time; this section is the one place that says so.

## Consequences

- **Every change to forms or the knowledge app now reaches the space only when the space is applied** (by hand: the space is not in CI). Forms is still in CI for its own Worker, so a push that changes forms deploys forms and
  leaves the live space on the old copy. The deploy workflow's `space-apply-warning` (its note that the space needs applying) now fires on any change under `packages/forms` (before this stage it fired on twelve named files: [0007](0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md), "What is imported from forms"),
  and `test/forms-imports.test.ts` holds that filter to the whole package.
- **A bad deploy of the space now takes the Knowledge tab and the Forms tab's API down with the page**, as with every change that ships in the one Worker.
- **The way back from a move is zbc applies, never `wrangler rollback`** (Cloudflare says a rollback cannot cross a change to a class's `exports` lifecycle). Before the class changes hands (step 4 of the five) it is a redeploy of the space
  without the `expecting-transfer` entry, which is also the space's default file; after, it is the reverse transfer, rehearsed on throwaway Workers (three applies, then a restart).
- **A plain apply during a move is guarded, and afterwards the defaults are the end state.** Before the move, a plain apply of the space (CI's summary told a reader to apply it) would have declared the class live and made Cloudflare provision a NEW, EMPTY knowledge base beside the stored one; so
  the default files were the safe state before the move and a step's file was deployed only when named, and, because the default `knowledge` file would do the same once the store had moved, a plain apply first read the Worker's live binding and was refused if it contradicted the default (`classHome` in the infra
  module, kept for the next move). The cleanup after the move made the end-state files the defaults and deleted the step files and the step variable.
- **A moved object keeps running its old Worker's code until it restarts,** and the inbox's assistants read the store on every inbound mail, so it will not go idle by itself. The object has an explicit restart (an abort), reachable only by the owner through the space (`POST /api/knowledge/store/restart`), and the
  operator of the move calls it and reads the object's start line in the space's log (`knowledge: the store object started`) before the knowledge base is called checked. It has a bookmark (`.../store/bookmark`) for a pre-move restore point and a restore (`.../store/restore`), the last resort. The three are the owner's, made from a
  signed-in browser; they touch no entry.
- **The knowledge Worker's declaration** (`knowledge/src/workspace.ts`) takes the install from the same alias the space's build sets (`@knowledge/declaration`, as forms' `@forms/declaration`), so the Durable Object class built into a client's space serves that client's businesses and owners. The knowledge
  Worker's own forwarder served one install alone and was built with that install's declaration.
- **A forms migration** is applied by the `forms` instance (CI does it on merge), never by the space's, which names the database and does not migrate it, and it must leave the space's older bundled copy working until forms leaves CI (`packages/forms/README.md`).
