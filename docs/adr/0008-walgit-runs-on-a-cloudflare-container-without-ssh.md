# walgit runs on a Cloudflare Container, and drops SSH

**Status:** accepted (2026-08-28). Supersedes [ADR-0006](./0006-fly-returns-as-a-deploy-module.md) **for walgit only** — the `fly` module itself stands, for the next payload that needs raw inbound TCP. Amends the transport consequences of [ADR-0007](./0007-walgit-object-storage-holds-the-log.md); its core sentence is untouched.

walgit serves **git smart-HTTP from a Cloudflare Container behind a thin Worker**, and the SSH transport is deleted rather than kept on a second host.

ADR-0006 put walgit on Fly with a dedicated IPv4 for one reason: SSH needs raw inbound TCP, and no Cloudflare product delivers it. That reason is removed here rather than worked around — with SSH gone, nothing about walgit needs anything but HTTP, so the Fly machine, the dedicated IP, `fly.toml`, sshd, the forced command and the host key all go with it.

## Why the option ADR-0006 rejected is now the right one

ADR-0006 considered "stay on Cloudflare, drop SSH, serve smart-HTTP only" and rejected it: "SSH is core enough to git's identity for our users that dropping it changes what the product is." That argument was about human users. walgit's users are **agents** (see the walgit goal): an agent has a bearer token before it has anything else, and cannot manage an SSH key at all without a human first putting one somewhere. For that audience smart-HTTP is not the lesser transport, it is the only one, and SSH is a second front door serving nobody while owning the entire hosting decision.

## What the spike settled, so it is not re-derived

Measured on Cloudflare Containers, 2026-08-28:

- No response-size or duration ceiling found: a 4 GiB response held open 1301 s arrived whole, and a request doing 293 s of container work returned 200. A clone is a long response and a push is a long request, so this was the gating question.
- R2 over the S3 API works with the credential shape `store-env.ts` already reads, and `If-None-Match: *` returns 412 — the compare-and-swap `index.json` depends on.
- The disk is 10.67 GiB ext4 and is **wiped completely on restart**, which is not a hazard but exactly the assumption ADR-0007 was written against.
- `/dev/shm` is listed as 64 MiB and is unusable; `git repack -adf` on a 250 MiB repository still succeeded in 27.7 s, so git does not need it.
- Cold start is one regime: median 1.77 s, spread 0.93–6.45 s, and a ten-minute idle measures the same. It replaces Fly's ~1.35 s machine wake in ADR-0007's "restore latency is two numbers, not one" — the shape of that decision is unchanged, only the number.

## Consequences

- **The container runs one process.** The image used to supervise sshd and the HTTP server as a mutually-killing pair; with one transport there is nothing to supervise, so `CMD` is the server.
- **One trust boundary, one credential kind.** Authorization is `WALGIT_HTTP_TOKENS` and nothing else — the SSH key list it used to sit beside is gone, along with per-key revocation, which no longer has a client that wanted it.
- **Secrets reach the container only through the Worker.** The container runs outside the Worker's binding graph, so `worker/index.ts` forwards an explicit list of `WALGIT_*` variables into it. A secret absent from that list reaches the Worker and stops there, and the push path then refuses every push — correctly, but three processes away from the cause.
- **Production goes red until git.zabaca.com is torn down.** Deleting `fly.toml` breaks the `fly:walgit` instance, and `zbc apply` is fail-fast by design: the run aborts there and `cloudflare-email:email`, the only instance ordered after it, never applies. This is accepted, not a regression, and the fix is the teardown, **not** error handling in the apply loop — an instance that cannot converge should stop the run rather than let later ones build on a state that does not exist.
- **`wrangler delete` does not delete a container application.** Removing the Worker leaves its container instances live; that needs a separate `wrangler containers delete`.
