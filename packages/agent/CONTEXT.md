# Agent

Runs Claude Agent SDK agents with a known token cost and a known blast radius.
The base configuration decides what an agent *sends*; a Profile decides what it
*is*; a Workspace decides where it can act.

## Language

**Profile**:
A named preset that decides what an agent is — its instructions, tools, and model
tier — applied through the base configuration so it cannot weaken a token or
privacy lever.
_Avoid_: preset (the SDK uses that word for its own system prompt), persona, mode

**Workspace**:
A disposable clone of a target repository, created under a temp root so the
agent's reads can be confined by denying the real one. Connected to its origin
only in that the host can fetch from it; the agent itself cannot reach back.
_Avoid_: worktree (implies a git-linked checkout, which this cannot be — a linked
worktree's `.git` points into the denied path), sandbox (that is the enforcement,
not the place)

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
