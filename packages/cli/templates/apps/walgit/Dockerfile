# walgit's front door: sshd on :22 and a Bun smart-HTTP server on :8080, both
# serving bare repos out of /srv/walgit/repos.
#
# The repos directory is ORDINARY CONTAINER FILESYSTEM on purpose — no volume,
# no mount. The bare repo on disk is a disposable cache rebuildable from the
# write-ahead log in object storage (see the walgit ADR, docs/adr/0007 in the
# zbc repository); a volume would pin a repo to a machine, which is the exact
# problem walgit exists to remove.
FROM oven/bun:1.3-alpine

RUN apk add --no-cache git openssh-server

# `git` is the account every client authenticates as (`git@host:repo.git`). Its
# login shell is never used: each authorized key carries a forced command, so
# the only thing an SSH session can do is one git transport verb.
RUN adduser -D -h /srv/walgit -s /sbin/nologin git \
    && mkdir -p /srv/walgit/repos /srv/walgit/.ssh \
    && chown -R git:git /srv/walgit \
    && chmod 700 /srv/walgit/.ssh

WORKDIR /app
COPY package.json ./
RUN bun install --production --no-save
COPY src ./src
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV WALGIT_REPOS_DIR=/srv/walgit/repos \
    PORT=8080

EXPOSE 22 8080
CMD ["/entrypoint.sh"]
