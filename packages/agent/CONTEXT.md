# Agent

Runs Claude Agent SDK agents with a known token cost and a known blast radius.
The base configuration decides what an agent _sends_; a Profile decides what it
_is_; a Trait layers on what it is told; a Workspace decides where it can act; a
Tier decides where that Workspace lives.

## Language

**Profile**:
A named preset that decides what an agent is — its instructions, tools, and model
tier — applied through the base configuration so it cannot weaken a token or
privacy lever.
_Avoid_: preset (the SDK uses that word for its own system prompt), persona, mode

**Workspace**:
A disposable clone of a target repository, created under a temp root so the
agent's reads can be confined by denying everywhere else. Connected to its origin
only in that the host can fetch from it; the agent itself cannot reach back.
_Avoid_: worktree (implies a git-linked checkout, which this cannot be — a linked
worktree's `.git` points into the denied path), sandbox (that is the enforcement,
not the place)

**Sandbox**:
The kernel-level restrictions the CLI process runs under, expressed as
sandbox-runtime settings generated per Workspace. Wraps the whole process tree,
which is what distinguishes it from the SDK's `sandbox` option — that one
restricts shelled-out commands only, so it never reached `Read`, `Grep` or
`Glob`. See ADR 0002.
_Avoid_: seatbelt (the macOS backend, not the concept — sandbox-runtime also has
bubblewrap and WFP backends), permissions (those are the SDK's prompt layer,
which we bypass precisely because the kernel is enforcing instead)

**Trait**:
An instruction layer that composes onto any Profile. Carries a system prompt and
nothing else, so no combination of Traits can widen what an agent is able to do —
only what it is told. That is what makes them safe to stack, and why the
containment tests hold per Profile rather than per combination.
_Avoid_: mixin (implies behaviour, not text), modifier, flag

**Tier**:
Where a run executes, and therefore what confines it. `local` is a clone under a
temp root with sandbox-runtime around the CLI; `cloudflare` is a container that
is itself the boundary. A Profile, its Traits and the option composition are
identical on both — only the placement and the containment differ. Not a
capability an agent can ask for: "containment off" is true of a tier, never of a
caller. See ADR 0003.
_Avoid_: environment (already means an infra environment in this repo), backend,
target

**Collect**:
The host-side step that fetches an agent's branch out of a Workspace into the
real repository. The only moment an agent's work crosses the containment
boundary, and always host-initiated — an agent can neither push nor trigger it.
_Avoid_: sync, push, merge (Collect stops short of merging; the merge is a human's)

**Custom Tool**:
A tool supplied to an agent as an in-process SDK MCP tool rather than a built-in.
Runs in the host process, so it is outside the sandbox by construction — the
sanctioned way to grant one narrow capability without widening a policy that
applies to everything else the agent does.
_Avoid_: MCP server (a Custom Tool may be one, but the term is about where the
code runs and what that implies, not the transport)
