# walgit's front door: sshd on :22 and a Bun smart-HTTP server on :8080, both
# serving bare repos out of /srv/walgit/repos.
#
# The repos directory is ORDINARY CONTAINER FILESYSTEM on purpose — no volume,
# no mount. The bare repo on disk is a disposable cache rebuildable from the
# write-ahead log in object storage (see the walgit ADR, docs/adr/0007 in the
# zbc repository); a volume would pin a repo to a machine, which is the exact
# problem walgit exists to remove.
FROM oven/bun:1.3-alpine

# `git-daemon` is not optional and not about the daemon: on Alpine it is the
# package that carries `git-http-backend`, which the plain `git` package does
# not ship. Without it smart-HTTP fails as `git: 'http-backend' is not a git
# command` — which reaches the client as an empty CGI response, never as that
# message. `su-exec` is how the HTTP server drops to the `git` account.
RUN apk add --no-cache git git-daemon openssh-server su-exec

# `git` is the account every client authenticates as (`git@host:repo.git`).
#
# Its login shell is REAL, not `/sbin/nologin`: sshd runs a forced command
# through the account's shell, so `nologin` refuses the forced command too and
# every push dies at `Permission denied (publickey)` with the reason only in
# the server log. The forced command is what constrains the session, not the
# shell.
#
# `adduser -D` leaves `git:!` in /etc/shadow, which sshd reads as a locked
# account and refuses before it ever looks at a key ("User git not allowed
# because account is locked"). `*` means "no password will ever match", which
# is what is actually wanted — the account is key-only, not disabled.
RUN adduser -D -h /srv/walgit -s /bin/sh git \
    && sed -i 's/^git:!:/git:*:/' /etc/shadow \
    && mkdir -p /srv/walgit/repos /srv/walgit/.ssh \
    && chown -R git:git /srv/walgit \
    && chmod 700 /srv/walgit/.ssh

WORKDIR /app
COPY package.json ./
RUN bun install --production --no-save
COPY src ./src
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
COPY ssh-entry.sh /app/ssh-entry.sh
RUN chmod +x /entrypoint.sh /app/ssh-entry.sh

ENV WALGIT_REPOS_DIR=/srv/walgit/repos \
    PORT=8080

EXPOSE 2222 8080
CMD ["/entrypoint.sh"]
