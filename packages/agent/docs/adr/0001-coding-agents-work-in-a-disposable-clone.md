# Coding agents work in a disposable clone

> **Superseded in part by [ADR 0002](./0002-containment-wraps-the-cli-process.md).**
> The workspace, the host-side collect and the clone requirements below all
> stand. The containment does not: the SDK's `sandbox` option restricts only
> shelled-out commands, so `Read`, `Grep` and `Glob` were never confined by it.
> Sections describing that mechanism are kept for the record and marked below.

A coding agent needs `Bash`, and `Bash` on a developer machine reaches
everything that machine can: this one holds a SOPS age private key that decrypts
every `secrets.yaml` in `packages/infra/environments/`, SSH and AWS credentials,
and thirty other repositories. The agent does not have to be malicious for that
to matter — an injected instruction in a file it reads is enough.

We run the agent against a **Workspace** — a plain `git clone` of the target
repository under `/private/tmp` — and confine it with the Claude Agent SDK's own
`sandbox` settings. Work returns to the real repository only when the host
**Collects** it. Every claim below was measured against SDK `0.3.220` on
macOS 26.5.1, not inferred from documentation.

## What this looks like

_(Superseded — see ADR 0002. Recorded as shipped.)_

```
enabled: true, failIfUnavailable: true
autoAllowBashIfSandboxed: true
allowUnsandboxedCommands: false
filesystem: { denyRead: ['$HOME'], allowRead: [<executables only>] }
network:    { allowedDomains: ['api.anthropic.com'], strictAllowlist: true }
env:        GIT_CONFIG_GLOBAL + XDG_CONFIG_HOME → into the Workspace
```

- The agent commits to a branch inside the Workspace. The host then runs
  `git fetch <workspace> <branch>` and decides whether to merge. Nothing
  sandboxed ever initiates contact with the real repository — the Workspace's
  `origin` points into denied territory, so the agent cannot reach it even if
  instructed to.
- Toolchain config is **redirected into the Workspace** rather than allow-listed
  out of `$HOME`. `GIT_CONFIG_GLOBAL` and `XDG_CONFIG_HOME` point at
  Workspace-local files, which collapses `allowRead` down to executables and
  gives the agent its own git identity by construction, so its commits are
  attributable without anyone remembering to configure that.
- `settingSources: ['project']` is safe **only because** the Workspace is outside
  `$HOME`. CLAUDE.md discovery walks up the directory tree: from
  `packages/agent/` it loaded this repo's CLAUDE.md _and_ `/Users/uptown/CLAUDE.md`
  (19,817-byte request vs 1,069 with `settingSources: []`). From `/private/tmp`
  the walk terminates harmlessly — only the clone's own CLAUDE.md loads.

## Considered options

- **`sandbox: { enabled: true }` alone.** Rejected: it restricts almost nothing.
  Measured with no `filesystem` block, the agent read another repository under
  `$HOME`, read `$HOME/.zshrc`, and reached `example.com` (HTTP 200). Only writes
  have a default boundary — writing into another repo under `$HOME` was refused.
  Reads and egress are open unless configured.
- **Leaving `allowUnsandboxedCommands` at its default.** Rejected, and this is
  the single most load-bearing line. With `denyRead` set but the escape hatch
  open, the agent hit `Operation not permitted`, said _"Let me retry with the
  sandbox disabled"_, and read the file — `Bash` accepts a
  `dangerouslyDisableSandbox` parameter. Setting it to `false` made the identical
  prompt fail with no mechanism available.
- **A hand-written `sandbox-exec` (seatbelt) profile.** Rejected. It does deliver
  default-deny reads, which the SDK's API expresses only as a denylist. But
  seatbelt wraps the CLI _and_ `Bash` under one policy, so every hole the CLI
  needs becomes a hole the agent gets; wrapping the SDK broke Keychain access and
  died with `401 OAuth access token has been revoked`. It is also macOS-only and
  cannot express a domain allowlist, since it filters at the socket layer rather
  than by DNS name. Once the Workspace moved to `/private/tmp`, `denyRead` on
  `$HOME` plus `allowRead` carve-outs achieved the same posture natively.
- **A `git worktree` instead of a clone.** Rejected — structurally impossible
  here. A linked worktree's `.git` is a pointer into the origin repository's
  `.git/worktrees/`, so every git command reaches into the denied path:
  `fatal: not a git repository: …/_zbc-src/.git/worktrees/zbc-wt-probe`. For the
  same reason a `--shared` or `--reference` clone is also unusable, since its
  `objects/info/alternates` points at the origin. The Workspace must be a plain
  clone.
- **The agent pushing its branch to `origin`.** Rejected: it needs `github.com`
  in `allowedDomains` and credentials inside the blast radius. Git's transport
  works over local paths, so a host-side fetch needs neither.
- **A container.** Not rejected on merit — it is stronger. Deferred because the
  threat model is a developer machine, and CI (`ubuntu-latest`) is already a
  disposable container where this buys much less.

## Consequences

- **macOS for now.** `sandbox-exec` is present; `bubblewrap` is not installed on
  the `ubuntu-latest` runners, and Ubuntu 24.04's AppArmor restrictions on
  unprivileged user namespaces are an unverified risk for it. The sandbox config
  is kept as its own object so enabling CI is a config change, not a refactor.
  `failIfUnavailable` must never be flipped to `false`: silent degradation means
  an unsandboxed agent with no signal.
- **`allowRead` is not an allowlist on its own.** It re-allows paths _within_
  `denyRead` regions and does nothing without one. `allowManagedReadPathsOnly`
  binds only from managed/policy settings, per its name.
- **Two environment variables must never be set**, both of which fail in ways
  that look like unrelated bugs:
  - `CLAUDE_CONFIG_DIR` — breaks authentication even when set to its own default
    value, apparently by switching the CLI from Keychain to file-based
    credentials that do not exist. _(Superseded: the guess was right, and the
    coupling is gone now that the credential comes from the environment. ADR 0002
    sets it, and must — see there.)_
  - `HOME` — hides the login Keychain, 401s the CLI, and raises a _"Keychain Not
    Found"_ dialog at whoever is sitting at the machine.
- **New tools cost an `allowRead` entry or a redirect.** Prefer the redirect.
  `git` reaches for `~/.config/git/ignore` and warns when denied; pointing
  `XDG_CONFIG_HOME` into the Workspace fixed it without touching `$HOME`.
- **The clone must be `--no-hardlinks`.** A local clone hardlinks its object
  store, and a hardlink is a second name for an inode rather than a path, so the
  sandbox cannot filter it. Writing through one from inside the workspace
  corrupts the _origin_ — verified: `chmod u+w` on a cloned object, one `echo`,
  and `git -C <origin> cat-file` reports `loose object … is corrupt`. That is a
  write path out of a workspace whose whole promise is that it has none, and
  `dispose()` cannot undo it. Costs one object-store copy; asserted by a test.
- **The operator's environment is not inherited.** `denyRead` protects a
  credential _file_; nothing protects a credential _value_ in the environment,
  and an agent with `Bash` only has to run `env`. CI sets `SOPS_AGE_KEY` at the
  step level in `production.yml` and `preview.yml` — the key that decrypts every
  environment — so an agent invoked from those steps would have been handed it,
  and no egress rule helps once the value is in the transcript. Sandboxed
  profiles pass `inheritEnv: false` after their overrides, so it cannot be
  switched back on by accident; anything genuinely needed is named explicitly
  via `env`. The allowlist is `ESSENTIAL_ENV` in `src/index.ts`.
- **`settingSources: ['project']` still loads the target repo's
  `.claude/settings.json`, hooks included.** The workspace solves the CLAUDE.md
  half of this (the discovery walk terminates outside `$HOME`) and nothing about
  the settings half. Accepted because the targets are our own repositories and
  the clone is disposable — point this at a repo you did not write and the
  assumption is gone. Note the asymmetry with `strictMcpConfig`, which exists
  precisely to stop a stray `.mcp.json` from contributing. Whether the SDK runs
  project hooks inside or outside the sandbox is **unverified**.
- **Custom Tools are outside the sandbox** — SDK MCP tools run in the host
  process. That is the intended escape hatch: grant one narrow, audited capability
  rather than widening `allowedDomains` or `allowRead` for everything. It is also
  a real hole, so their arguments are ours to validate.
- **Token cost is the price of the job.** Tool schemas for
  `Read, Write, Edit, Bash, Grep, Glob` are 7,404 input tokens against the base
  package's 124, and `preset: 'claude_code'` adds ~3,148 more. Both sit in the
  cached prefix. `excludeDynamicSections: true` keeps the working directory and
  git status out of the cached system prompt; without it, a Workspace whose git
  state differs from the last session rewrites 1,343 tokens at cache-write
  pricing (measured 3.4× cost on an otherwise identical request). That snapshot is
  taken once per session — commits made _during_ a session invalidate nothing.
