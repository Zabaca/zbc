# walgit's front door: one Bun process serving smart-HTTP on :8080 out of
# /srv/walgit/repos, run as a Durable-Object-bound Cloudflare Container behind
# the Worker in worker/index.ts.
#
# ONE process, and no supervisor. The image used to run sshd and the HTTP
# server as a mutually-killing pair because SSH needed raw inbound TCP, which
# is what put walgit on Fly (docs/adr/0006 in the zbc repository). Cloudflare
# delivers HTTP and nothing else, so the SSH transport is gone and with it the
# only reason this container had two processes to supervise.
#
# The repos directory is ORDINARY CONTAINER FILESYSTEM on purpose — no volume,
# no mount. The bare repo on disk is a disposable cache rebuildable from the
# write-ahead log in object storage (see the walgit ADR, docs/adr/0007 in the
# zbc repository). Cloudflare wipes that disk completely on every restart,
# which is not a hazard here but the assumption the design was written against.
FROM oven/bun:1.3-alpine

# `git-daemon` is not optional and not about the daemon: on Alpine it is the
# package that carries `git-http-backend`, which the plain `git` package does
# not ship. Without it smart-HTTP fails as `git: 'http-backend' is not a git
# command` — which reaches the client as an empty CGI response, never as that
# message.
RUN apk add --no-cache git git-daemon

WORKDIR /app
# Only `aws4fetch` — the Worker-side deps (@cloudflare/containers, wrangler) are
# devDependencies precisely so `--production` leaves them out of this image.
COPY package.json ./
RUN bun install --production --no-save
COPY src ./src

ENV WALGIT_REPOS_DIR=/srv/walgit/repos \
    PORT=8080

# The container runs as root and every repo on disk is written by this one
# process, so git never sees a repository owned by somebody else ("detected
# dubious ownership") and there is no account to drop to. The two-user dance
# the old image did existed only because sshd authenticated sessions as `git`.
EXPOSE 8080
CMD ["bun", "/app/src/server.ts"]
