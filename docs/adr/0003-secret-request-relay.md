# Secret requests go through a per-project relay worker with end-to-end encryption

Agents driving zbc cannot prompt interactively in a terminal, so `zbc secret request`
opens a browser page for the human to paste secret values, which the CLI writes
straight into the target environment's SOPS-encrypted `secrets.yaml`. The secret
never enters the agent's context — the CLI reports only that it arrived.

We route the exchange through a **relay**: a tiny permanent Cloudflare Worker each
project deploys itself (`zbc add secret-relay`, an app template — single-tenant, no
Zabaca-hosted service, per CONTEXT.md principles). The CLI opens an outbound
connection with a one-time channel id; the browser page (served by the relay) posts
the value; the relay forwards; the CLI decrypts and runs `sops set`.

## Considered options

- **Localhost server + `open`** (the gcloud/gh pattern): zero infra, but only works
  when the CLI and browser share a machine — no story for SSH, devcontainers, CI, or
  Claude Code web. Rejected as the primary path; a localhost fast-path could return later.
- **SSH port-forward with printed URL**: no infra but a manual `ssh -L` per use. Rejected.
- **On-demand tunnel (`cloudflared`)**: third-party dependency in the path per request. Rejected.

## Security model

A capability-URL design, deliberately not just "unguessable link":

- **E2E encryption** — the CLI generates an ephemeral keypair; the public key travels
  in the URL *fragment* (never sent to the server); the page encrypts with WebCrypto.
  The relay carries ciphertext only, so a compromised relay reads nothing.
- **Single-use + TTL** — a channel accepts one submission and expires with the CLI's
  timeout (default 5 min); a leaked URL is worthless after use.
- **Pairing code** — CLI and page both display a short code the human matches before
  pasting, closing the wrong-channel/phishing direction.
- Cloudflare Access gating was considered and deferred: it only defends against a
  live attacker who already holds the URL and wants denial-of-service (a garbage
  submission fails decryption), which didn't justify per-use login friction.

## Consequences

- The relay is project infrastructure, deployed once (in production, non-ephemeral);
  preview-env secret requests use the same relay. `zbc secret request` resolves its
  URL from the relay instance's apply outputs — no URL field in `zbc.config.ts`.
- "The agent never sees the secret" holds against context leakage (transcripts, logs,
  summaries), not against a hostile agent running in the user's sandbox with sops keys.
