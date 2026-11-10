# The space

One web address where a small company works: its mail, its calls and chat, its calendar, forms and documents sent for signature, its clients and what it knows, behind one sign-in. It runs as one Cloudflare Worker in the company's own Cloudflare account, and every company that runs it has its own.

This folder is a copy the company owns. It is pulled into a project as `vendor/space` and may be changed there; an update merges a newer copy over it and keeps the project's changes.

## What is here

| Folder | What it is |
|---|---|
| `packages/space` | The Worker and the page: the one door, the tabs, and the paths open to a call's guests, a channel's guests and a document's signers |
| `packages/inbox` | Mail (Gmail accounts, business mailboxes, a mail server over JMAP, Telegram), drafts, the assistant and notifications |
| `packages/meet` | Calls, channels and direct messages, and the phone line |
| `packages/forms` | Forms, and documents sent for signature and sealed |
| `packages/calendar` | Google calendars, read into a store of their own |
| `packages/clients` | The company's list of Clients |
| `packages/knowledge` | What the assistants may draw on, per business |
| `packages/workspace` | The company layer: an install's declaration, its people, its switches and the sign-in check. It also holds the invented company the tests run on (`northfield/`) and the public check |
| `kit` | The deploy kit: from an install's files to what zbc applies and the Worker's settings |
| `starter` | The files a new install starts from, which `zbc add space` writes into a project (listed in `zbc-app.json`) |
| `docs/install.md` | From nothing to a company's own space: what to have first, what to fill in, the first apply |

Each package says how to work in it in its own `README.md` or `CLAUDE.md`, names its terms in `CONTEXT.md`, and keeps its decisions in `docs/adr/`.

## An install

A company's install is three files, kept outside this folder and never published:

- `workspace.json`, the declaration: who the company is, its people, its businesses and mailboxes, and which features are switched on.
- `workspace-install.json`, the install file: what each part is called in the company's Cloudflare account, and the names (never the values) of its secrets.
- `workspace-content.json`, the content: each mailbox's assistant persona and spam questions.

`packages/workspace/northfield/` is such a set for an invented company with every feature on. Tests and `bun run dev` run on it.

A build is for one company and says which: `SPACE_DECLARATION=<path to workspace.json> bun run build` in `packages/space`. A build that names none stops. The scripts that work a deployed install are told the same way (`packages/workspace/scripts/project-env.ts`).

A project deploys with zbc. Its instance files are one line each: they call the kit (`kit/instances.ts`) with the project's own zbc modules, its declaration and its install file, and export what the kit returns. `zbc add space` writes a first set, and [`docs/install.md`](docs/install.md) goes from there to a first apply.

## Working on it

```sh
bun install
bun run test
bun run typecheck
bun run check:public
```

## What may be written here

Everything in this folder is public, comments and tests included. It names no real person, company, address, host, phone number or account id, and cites no private record. Invented people and companies use the reserved example domains and numbers. `bun run check:public` reads the whole folder and fails on anything else; it is also one of the tests.

## Licence

MIT, in `LICENSE`. Built by Zabaca.
