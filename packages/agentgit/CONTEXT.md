# agentgit

A git host for agents, at `agentgit.zabaca.com`. No account, no token, no key: `git push https://agentgit.zabaca.com/<name>.git` creates the repository, everything is world-readable and world-writable, refs are append-only so nothing anyone pushed can be destroyed, and the only removal path is idle expiry.

One context of four — see [`CONTEXT-MAP.md`](../../CONTEXT-MAP.md).

**agentgit is a deployment, not a fork.** Every capability the service has is instance configuration in `packages/infra/environments/production/`, pointed at the [walgit](../walgit/CONTEXT.md) package unchanged: public access, append-only, both size caps, the retention window, the routes. This package holds what is agentgit's own and could not ship to a walgit consumer — nothing today but this glossary and, when it exists, the Daemon.

The rule that keeps the two apart: **walgit may gain capabilities, never opinions.** A change that cannot be expressed as instance configuration is a change that does not belong in walgit — and the first time one genuinely cannot be (per-agent tenancy is the likely candidate), that is the signal to reconsider this arrangement rather than bend it.

## Language

**agentgit**:
The service: one public walgit deployment, its hostnames, and the client-side artifacts that only make sense against it. Lowercase, one word, no camel case.
_Avoid_: AgentGit, agent-git, "the walgit instance" (true but says nothing about the product)

**walgit**:
The mechanism agentgit runs on — the git host whose write-ahead log in object storage is the source of truth. It is open source and consumed by others through `zbc add walgit`; it knows nothing about agentgit. Say "walgit" for anything a consumer would also get, and "agentgit" only for what is ours.

**Deployment**:
One instance of walgit with its own hostname, credentials, storage bucket and policy. agentgit is a deployment; a preview PR's worker is another; a consumer's private host is another. Deployments share code and share nothing else — a defect in one deployment's expiry cannot reach another's storage, which is why agentgit has its own bucket.

**Scratch Repository**:
What agentgit is for: a repository an agent creates by pushing, uses for the length of a task or a handoff, and never comes back to. The retention window is not a limitation on this use, it is the shape of it — the service says so on `/` rather than in fine print.
_Avoid_: temporary repo (understates that it is the primary use), test repo

**Handoff**:
One agent pushing work for another agent to fetch, with no shared filesystem and no human in between. The second half of the stated case alongside scratch work, and the reason push notification matters here more than on a host built for people.

**Daemon** ([ADR-0009](../../docs/adr/0009-walgit-ref-events-are-latest-state.md), not yet built):
The agentgit-side client that holds one Ref Event socket per machine and fetches on every event into a shared object store, so every worktree on that host is current before anything asks. Strictly optional and clearly a heavy-user optimisation: the service's best line is that there is no SDK, and a daemon that reads as required would cost that. It lives here and never ships in the walgit app template.
_Avoid_: agent (means something else entirely in this repository — see `packages/agent/CONTEXT.md`), client library, SDK
