# walgit

A git host where **object storage holds the write-ahead log and is the source of
truth, and the bare repo on local disk is a disposable cache** that can be
deleted at any time and rebuilt from the log. See
`docs/adr/0007-walgit-object-storage-holds-the-log.md` in the zbc repository.

## What works today

The **front door** and the **storage layer**, not yet joined to each other:

| | |
| --- | --- |
| `src/store.ts`, `src/wal-index.ts` | the object-store adapter and the `index.json` compare-and-swap |
| `src/repo.ts` | repo addressing — the one place a client-supplied name becomes a path |
| `src/ssh-shell.ts` | the SSH forced command: one git verb, one repository |
| `src/http.ts`, `src/git-backend.ts`, `src/server.ts` | smart-HTTP, with `git http-backend` as a CGI child |

A push currently lands on the machine's filesystem and nowhere else. Wiring the
push path to the WAL is the next milestone; until then a destroyed machine loses
whatever was pushed to it.

## How a client reaches it

```bash
# SSH — the repository is named in the command, because SSH has no SNI
git clone git@<ip>:myrepo.git

# smart-HTTP — the token is sent as the Basic-auth password
git clone https://walgit:$WALGIT_TOKEN@<app>.fly.dev/myrepo.git
```

A repository is created on first contact: pushing to a name nobody has used
creates it, with `receive.unpackLimit=0` so even a tiny push is retained as a
packfile (what the WAL will upload).

## Deployment

Through the `fly` module, never by hand — `zbc apply <env>`. The instance must
set `ipv4: "dedicated"`: shared IPv4 covers ports 80/443 only, so SSH on :22
would be unreachable and `fly deploy` would still report success.

Secrets the app needs (in the environment's `secrets.yaml`):

- `WALGIT_SSH_HOST_KEY` — an ed25519 **private** key
  (`ssh-keygen -t ed25519 -f walgit_host -N ''`). It is a secret rather than a
  generated-at-boot file because the container filesystem does not survive a
  machine stop, and this machine stops whenever it is idle — a regenerated host
  key would trip every client's man-in-the-middle warning.
- `WALGIT_SSH_AUTHORIZED_KEYS` — newline-separated **public** keys. Each is
  written into `authorized_keys` pinned to the forced command.
- `WALGIT_HTTP_TOKENS` — comma-separated bearer tokens (comma-separated so a
  credential can be rotated without a window where neither works).

The machine runs `min_machines_running = 0` and stops when idle; the next
connection autostarts it, measured at ~1.35 s in the milestone-0 spike
(`docs/research/walgit-m0-spike/`). There is **no Fly Volume** on purpose.

## Authorization, today

One trust boundary: any authorized SSH key or HTTP token can read and write any
repository. Per-repo authorization and an SSH CA are deferred until the repo
namespace exists in the WAL — the forced command and the `tokens` list are the
seams they plug into.

## Tests

```bash
bun test src
```

Includes end-to-end clone/push/fetch over both transports against a real `git`
client — smart-HTTP through a real server, SSH through the real forced command
with a stand-in for `ssh` itself.
