# Installing the space for a company

From nothing to a company's own space at its own address. The space runs as one Cloudflare Worker in the company's own Cloudflare account, deployed from the company's own repository with [zbc](https://github.com/Zabaca/zbc). Nothing is hosted for you, and nothing of your install is ever in this folder.

The starting files give the smallest install: Today, Meet's chat and channels, Forms and signed documents, People, Clients and Knowledge, for the people you list, behind one sign-in. Mail, calls, the phone line, a calendar and the assistant are switched on afterwards, each by what the declaration says ("Turning a part on" below).

## What you need first

- A Cloudflare account on the Workers Paid plan, with the company's domain as a zone in it. The space takes one hostname of that zone (`space.` by default).
- A Zero Trust organisation in that account (the free plan is enough) with the one-time PIN sign-in offered. People sign in to the space through it; guests of a channel and signers of a document do not sign in.
- A repository with zbc in it (`bunx @zabaca/zbc init`), `sops` and an age key for its secrets, and `bun`.
- Sending from the company's domain turned on in Cloudflare (Email Sending), for the addresses Forms and Meet send from.

## 1. Pull the space

```sh
bunx @zabaca/zbc add space --env production
```

On a clean git tree this pulls the space into `vendor/space/` as one squashed commit, adds its folders to the root workspace, installs the zbc modules its deploy uses, and writes, only where absent:

| File | What it is |
|---|---|
| `packages/infra/environments/production/workspace.json` | The declaration: the company, its people, its businesses, what is switched on |
| `packages/infra/environments/production/workspace-install.json` | The install file: the account, and what each thing is called in it |
| `packages/infra/environments/production/workspace-content.json` | The assistants' personas and spam questions; empty to start |
| `packages/infra/space/modules.ts`, `packages/infra/space/production.ts` | The glue: your zbc modules handed to the space's kit, and the install it makes |
| `packages/infra/environments/production/*.ts` | One line per instance zbc applies: Forms' bucket and database, four Access applications, the Worker |

Read what it left in the working tree and commit it. `.zbc-vendor.json` records which version you pulled.

## 2. Say who the company is

Edit `workspace.json`. Every `yourcompany` and `.example` value is a placeholder:

- `company`: an id (lower case, no spaces; it is never shown), the name people see, the legal name documents carry, the domain and the time zone.
- `access.teamDomain`: your Zero Trust organisation's team domain.
- `space.host`: the address the space is served at.
- `senders`: the addresses Forms and Meet send from, on a domain with sending turned on.
- `formsService`: the name signers see, who they write to with a question, and the mailing line under a request.
- `people`: everyone who signs in, each with the address they sign in as and `owner` or `member`. The first owner is the one the space names wherever it names one person.
- `businesses`: at least one, the company itself.

Then `workspace-install.json`: the Cloudflare account id, and a name of your own for the Worker, the bucket and the database. **Choose these names once.** The Worker's name and its stores' names are what your records are kept under; renaming one later starts an empty one. The `access` names are the titles of the applications in Zero Trust, and the `secrets` names are the keys of your secrets file.

## 3. Make the secrets

In `packages/infra/environments/production/secrets.yaml` (sops), never in plain text:

- `CLOUDFLARE_API_TOKEN`, a token of the company's account that can do what the apply does. **Account:** Workers Scripts, D1, Workers R2 Storage, Queues, Access: Apps and Policies, and Access: Service Tokens, each Read and Write; Access: Organizations Read; Access: Identity Providers Read. **The company's zone:** Zone Read, Workers Routes Read and Write. It needs no DNS, billing or member permission.
- Forms' keys, made once and never replaced, by a script that writes them straight into the file:

  ```sh
  SPACE_DECLARATION=$PWD/packages/infra/environments/production/workspace.json \
    bun vendor/space/packages/forms/scripts/seal-certs.ts --production
  ```

  It makes the key every signed record is stored under and the company's own seal certificate, named for the company in the declaration. Keep the secrets file backed up: a lost data key is every record lost.
- The notifications key:

  ```sh
  SPACE_DECLARATION=$PWD/packages/infra/environments/production/workspace.json \
    bun vendor/space/packages/inbox/scripts/vapid-key.ts production
  ```

## 4. Look before applying

```sh
bun install
bunx @zabaca/zbc list production
```

Seven instances, the Worker last, each importing what must exist before it. A declaration and an install file that disagree stop here, with every problem named.

## 5. Apply, and look at it

```sh
bunx @zabaca/zbc apply production space
```

The apply makes the four Access applications, the bucket and the database (and runs its migrations), builds the Worker for your declaration, deploys it on your host and pushes its secrets. The first apply is the first thing made in the account, so read its output. Then check the address as `vendor/space/packages/space/README.md` says ("Checking an address after an apply"): no path answers without the sign-in, and signed in as an owner the tabs are the ones your declaration gives.

The space is applied by hand, by a person who then looks at it; it is not a step of CI. A change to the declaration (a person added or removed) reaches the space only when it is applied.

## Turning a part on

Each part is a change to the declaration and, where it needs a store or a secret, to the install file, then an apply. `zbc list` shows the instances the change adds, and each new instance needs its one-line file beside the others (copy one and change the key). The invented company in `vendor/space/packages/workspace/northfield/` has every part on, and its three files are the worked example.

| Part | What it needs |
|---|---|
| A business mailbox | The mailbox in the declaration, a raw-mail bucket and a delivery-report queue in the install file (instances `inbox-raw` and `inbox-delivery`), and a routing rule in your zone that sends the address to the Worker by its name, added after the apply |
| Calls | A Cloudflare Realtime app and a TURN key, their ids in the install file and their secrets in the secrets file (instance `space-guest-calls`) |
| Gmail and Google calendars | A Google app of the company's own; `vendor/space/packages/inbox/docs/runbooks/inbox-google-setup.md` and `vendor/space/packages/calendar/docs/runbooks/calendar-google-setup.md` |
| The assistant | A persona per mailbox in the content file, and a model key in the secrets file |
| The phone line | `vendor/space/packages/meet/README.md` |

## Taking a newer version

```sh
bunx @zabaca/zbc update space
bun install
bunx @zabaca/zbc apply production space
```

The update pulls the newest version over `vendor/space/` and keeps what you changed there; a conflict is an ordinary git merge conflict. It then lists the files that are your own and the files that differ from the version pulled. Your install's files are outside `vendor/space/` and are never touched. Read the stores' counts before and after an apply that brings a new version (`vendor/space/packages/inbox/docs/runbooks/`).

## Working an install from the command line

The scripts that read or change a deployed install are told which one by its declaration's path, and guess nothing:

```sh
SPACE_DECLARATION=$PWD/packages/infra/environments/production/workspace.json bun vendor/space/packages/inbox/scripts/inbox.ts mailbox
```
