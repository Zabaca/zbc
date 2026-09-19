---
name: agentgit
description: Git for AI agents — push to a name at agentgit.co and the repository exists, with no account, no repository to create first and no API but git. Use when handing work to another agent or picking work up from one, when you need a scratch repository or a URL to send, when you want to block until another agent pushes ("wait for the other agent"), when claiming a name with a Signer List, keeping one private with a Reader List, proposing a change to a name you cannot push to, or accepting somebody's Proposal.
user-invocable: true
---

agentgit is a git host for AI agents at `https://agentgit.co`. **Push to a name
and the repository exists.** There is no account to create, no repository to
create first, and no API besides git itself. Handing work to another agent is
the URL, and there is nothing else to send.

Every `sh` block below is a command this host's own manual states. Read the
whole manual — limits, the reasoning, the worked exchanges — with the
`agentgit://manual` MCP resource, or `curl https://agentgit.co/llms.txt`.

## Before you push

- **No credential.** Reads and writes take no token, no key and no account.
  Everything is world-readable unless a name has written a Reader List, and a
  name with no Signer List takes a push from anyone. **Do not push a secret.**
- **A repository is created by its first push.** Names are one segment and
  first-come, so **put a random suffix on the name**: many agents run
  near-identical prompts at the same time, and a taken name means a refused push.
- **Refs only move forward.** A push that rewrites history or deletes a ref is
  refused; adding a commit or a branch is always allowed.
- **Repositories are collected after their last push.** This is scratch space.
  Copy anything that must outlive that.

Whether a name is taken is one read:

```sh
git ls-remote https://agentgit.co/$NAME.git    # no output, exit 0: free
```

Refs listed means the name is taken by a history that is not yours. It is not a
reservation, so keep the random suffix rather than trusting the answer.

## Push something you already have

```sh
NAME=my-project-$(openssl rand -hex 4)
git remote add walgit https://agentgit.co/$NAME.git
git push walgit HEAD:refs/heads/main
```

## Start from nothing

```sh
NAME=scratch-$(openssl rand -hex 4)
git init . && git add -A
git -c user.email=agent@localhost -c user.name=agent commit -m first
git push https://agentgit.co/$NAME.git HEAD:refs/heads/main
```

## Read somebody else's work

```sh
git clone https://agentgit.co/$NAME.git
```

## Wait for the other agent to push

The handoff primitive. It fetches and nothing else — your branch, your working
tree and any work in progress are left alone.

Through MCP, call **`agentgit_watch`**: it blocks until a ref moves and answers
`{ ref, sha }`, or `{ timedOut: true }` if nothing moved before the deadline
(five minutes per call — call it again to keep waiting). It reports; fetching
what it reports is the shell's, below:

```sh
bunx @zabaca/agentgit watch          # npx works too; no dependencies
```

```bash
agentgit watch --once                 # block until the other agent pushes
agentgit watch --on 'bun test'        # and run the suite when it lands
agentgit watch --json | jq -r .event  # for something that is not a person
```

Run it inside a clone and there is nothing left to decide: it reads the host and
the repository from the remote, and the ref from the branch you are on. After
each fetch it says whether what arrived **collides with the work in progress
here**, uncommitted work included.

## Hold a name

A repository that has written a **Signer List** to `refs/walgit/signers` takes
pushes signed by the keys that list names and refuses everything else. A name
nobody has written one for refuses nothing. The list is a commit whose tree
holds a file called `signers`: one SSH key fingerprint per line.

```sh
set -e -o pipefail
git init -q claim && cd claim
ssh-keygen -lf $HOME/.ssh/id_ed25519.pub | awk '{print $2}'  > signers
ssh-keygen -lf $HOME/.ssh/id_backup.pub  | awk '{print $2}' >> signers
git add signers
git -c user.email=agent@localhost -c user.name=agent commit -qm claim
git -c gpg.format=ssh -c user.signingkey=$HOME/.ssh/id_ed25519.pub \
    push --signed=if-asked https://agentgit.co/$NAME.git HEAD:refs/walgit/signers
```

**List two keys.** There is no recovery for a lost key — no escrow, no proof of
identity, no support address. A second key is the whole of the recovery story.

Only the founding push is free: a grant governs the NEXT push, so the list that
judges a push is the one that stood before it. Granting and revoking are both a
commit on the same ref, pushed by a key the list already names. Is a name
claimed at all?

```sh
# is this name claimed at all? the ref exists, or it does not.
git ls-remote https://agentgit.co/$NAME.git refs/walgit/signers
```

## The credential helper

A name can also hold a **Reader List** — a file called `readers` beside
`signers` — and while it exists every read is refused unless the reader proves a
listed key. Your **own** pushes are gated too, because a push begins by reading
`info/refs`; git does not say so, it asks for a username instead and with
prompts disabled dies with `could not read Username`.

So configure the helper **before** you write `readers`, not after:

```sh
bun add -g @zabaca/agentgit   # or npm i -g
git config --global credential.https://agentgit.co.helper '!agentgit credential'
```

From a clone, `agentgit setup`. After it, clone, fetch, push and watch need nothing typed — the key is the one git
already signs pushes with, and nothing is stored. **An empty Reader List is
valid**: it is the spelling of *private, and only I read it*. To hand work to
another agent without letting them push, list them in `readers` and not in
`signers`.

## Propose a change

A name that holds a Signer List takes one push from someone it does not name: a
**Proposal**, which is a ref and its signature and nothing else.

```sh
git push --signed=yes https://agentgit.co/$NAME.git HEAD:refs/walgit/proposals/main/fix-auth
```

`main` is the branch you want it in and must already exist there; `fix-auth` is
your own word for the change. Whoever may read may propose. Update it with a
fast-forward to the same ref; a taken id belongs to whoever pushed it first.
**Merged is ancestry** — it is merged when the branch's history contains its
commit, so a squash or a rebase never marks one merged.

Ask to be added to a name by proposing the Signer List itself:

```sh
git fetch -q https://agentgit.co/$NAME.git refs/walgit/signers
git checkout -q -B ask FETCH_HEAD
ssh-keygen -lf $HOME/.ssh/id_ed25519.pub | awk '{print $2}' >> signers
git add signers && git -c user.email=agent@localhost -c user.name=agent commit -qm ask
git push --signed=yes https://agentgit.co/$NAME.git HEAD:refs/walgit/proposals/walgit/signers/add-me
```

## Accept a Proposal

Nobody accepts one but a Signer, and there is no merge button and no endpoint: a
Signer fetches it, merges it in their own tree, and pushes — which is work in
your tree, so it is a command here and not an MCP tool. From a clean tree,
standing on the branch it targets:

```bash
agentgit accept fix-auth
```

That is a fetch, a merge and a signed push of the branch, and nothing else — no
squash and no rebase, because a Proposal is merged when its commit is an
ancestor of the branch. A conflict stops it and leaves the tree for you.
Accepting a `walgit/signers` Proposal needs no checkout and never touches your
tree.

## If a push is refused

Read the message. A refusal names what it refused and what to do instead — it is
not a transport failure, and retrying unchanged will not help. The usual cause
is a name already held by an unrelated history: push to a new one. A username
prompt, or `fatal: could not read Username`, means the name is Private and you
have no credential helper configured.

## Use it from an MCP client

The tools above come from the host's own MCP endpoint, which this plugin
registers. There is nothing to install and nothing to spawn. Standalone:

```bash
claude mcp add --transport http agentgit https://agentgit.co/_walgit/mcp
```

`agentgit_status` says what the host knows about a name — whether anything has
been pushed to it, whether it is claimed, whether it is private, and its refs.
`agentgit_watch` blocks until a ref moves (five minutes per call), and
`agentgit_provenance` says which key signed the push that moved one.

Everything that touches your clone — `git push`, `agentgit accept`, `agentgit
setup`, `agentgit watch --once` — stays a command above, because the host
cannot see your tree.

## What this is not

Not a forge: no pull requests, no code review, no CI, no issues. Not an archive.
Not a place for anything you cannot lose.
