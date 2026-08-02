# Containment wraps the CLI process, not each Bash command

ADR 0001 put coding agents in a disposable clone and confined them with the
SDK's `sandbox` option. That option is not a boundary. It restricts commands the
CLI _shells out to_, and the tools an agent actually reads with — `Read`, `Grep`,
`Glob` — never shell out.

Measured against the shipped configuration, `denyRead: [homedir()]` set, same
workspace, same run:

```
Bash  cat ~/.zbc-read-probe/secret.txt  -> Operation not permitted
Read  ~/.zbc-read-probe/secret.txt      -> the file's contents
Grep  ~/.zbc-read-probe                 -> the file's contents
```

Every claim in ADR 0001 about `$HOME` being denied was true of `Bash` and false
of everything else. `~/.ssh`, `~/.aws` and the SOPS age key were reachable by an
agent for as long as that design was shipped.

The SDK's own documentation says as much, once read as a whole: _"Filesystem and
network restrictions are configured via permission rules, not via these sandbox
settings."_ The sandbox is an enforcement mechanism for shelled-out commands;
permission rules are the boundary — and `permissionMode: 'bypassPermissions'`
turns those off.

We now run the CLI itself inside **`@anthropic-ai/sandbox-runtime`** (`srt`), the
same engine, applied to the whole process tree instead of to one tool.

```
pathToClaudeCodeExecutable  ->  <workspace>/home/claude-sandboxed
                                exec bun <srt> -s <settings> -- <claude> "$@"
```

## What the settings say

```
network.allowedDomains   ['api.anthropic.com']
filesystem.denyRead      ['/', <denied binaries>]
filesystem.allowRead     toolchain, workspace, CLI binary
filesystem.allowWrite    workspace, /tmp
```

`denyRead: ['/']` inverts `srt`'s defaults, which allow reads everywhere and deny
a built-in list of credential paths. A denylist protects what someone remembered;
denying the root and allowing back only the toolchain protects what they did not.

## Considered options

- **The SDK's `sandbox` option.** Rejected — the hole above. It also cannot be
  kept alongside this: the kernel refuses `sandbox_apply` inside an existing
  sandbox, so leaving it enabled kills every Bash command with
  `sandbox-exec: sandbox_apply: Operation not permitted` and exit 71.
  `enableWeakerNestedSandbox: true` does not change that. Layering is not
  available; this is a replacement.
- **Permission rules plus a `canUseTool` callback.** Rejected as the primary
  boundary. It would work — `permissionMode: 'dontAsk'` is default-deny — but it
  is a userspace boundary maintained per tool, enforced by a callback that has to
  resolve every path-bearing argument correctly. That is the shape of mistake
  that produced this ADR.
- **A hand-written seatbelt profile.** Built, and it worked: ~200 lines of SBPL,
  deny-default, `Read` blocked, auth intact. Rejected on two counts. Seatbelt
  filters at the socket layer and cannot match a hostname, so it has no way to
  express an egress allowlist — `curl example.com` returned 200 under it and 403
  under `srt`. And it is ours to maintain: three separate breakages during
  authoring (a missing `(import "system.sb")`, which SIGABRTs `/bin/echo` before
  it can print; bun's upward directory walk needing `(literal "/Users/<user>")`;
  the CLI binary living in a denied `node_modules`), each surfacing as an opaque
  failure a long way from its cause.
- **Porting the MITM proxy from another repository.** Considered for egress and
  credential injection. Unnecessary: `srt` ships the proxy, and the parts it does
  not ship reduce to a `network.filterRequest` callback.

## Consequences

- **A credential must be in the environment.** The CLI reads its stored
  credential by spawning `/usr/bin/security`. A sandbox that permits that binary
  is a sandbox where the agent can run `security find-generic-password -w -s …`
  against every item the operator owns, so it is denied — by `denyRead` on the
  binary, since `srt` has no execute allowlist. Verified: `security` becomes
  `command not found`, exit 127, while the rest of `/usr/bin` still runs.
  `requireCredentials()` fails at workspace creation rather than letting this
  surface as `EPERM: posix_spawn 'security'` from inside a minified bundle.
  `CREDENTIAL_ENV` lists what counts; `claude setup-token` mints the first.
- **`CLAUDE_CONFIG_DIR` is now set, having previously been a landmine.** ADR 0001
  recorded that it broke authentication even at its own default value. The cause
  was Keychain coupling — it switched the CLI to file-based credentials that did
  not exist. With the credential in the environment it is inert, and it is
  required: the CLI creates `<config>/session-env/<uuid>` before it will run a
  single Bash command. Left unset that lands in `$HOME/.claude`, which is denied,
  and _every_ Bash call fails with `EPERM: … mkdir` — an error that says nothing
  about Bash. `HOME` is still never set, for the reason ADR 0001 gives.
- **Symlinked system paths need both spellings.** `srt` matches the literal path
  it is given. `/tmp` and `/etc` are symlinks into `/private`, and tools hardcode
  both: the CLI writes to `/tmp/claude-*`, curl reads `/etc/ssl/cert.pem`.
  Granting only the `/private` spelling produced `EPERM: mkdir '/tmp/claude-501'`
  and `error setting certificate verify locations`.
- **The shim's `--` is load-bearing.** `srt` parses options anywhere in its argv,
  and the SDK passes the CLI its own `--settings <json>`. Without the separator
  `srt` consumes it and refuses to start, reporting that a JSON object is not a
  readable settings path.
- **The agent can read the credential it uses.** It is in the process
  environment and `Bash` runs `env`. `srt` supports `network.tlsTerminate` and a
  `network.filterRequest` callback, which is the seam for a sentinel-substitution
  scheme: inject a placeholder, swap it for the real value at the proxy. Until
  that exists, give agents a scoped, rotatable token rather than a personal one.
- **`srt` is a research preview** at `0.0.67`, Apache-2.0. Its settings schema is
  strict — it refused ours for omitting `deniedDomains` and `denyWrite`, and
  refuses to fall back to defaults on an invalid file, which is the behaviour we
  want. Expect churn; `writeSandboxShim` proves the settings load before an agent
  is handed to them.
- **Linux and Windows become configuration, not a rewrite.** `srt` covers
  bubblewrap and WFP. Untested here, but the shape no longer depends on
  `sandbox-exec`.
