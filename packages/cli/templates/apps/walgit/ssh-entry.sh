#!/bin/sh
# The forced command every authorized key is pinned to.
#
# It exists because sshd builds a session's environment from scratch: the
# container's WALGIT_* variables belong to PID 1 and reach neither this shell
# nor the git hooks three processes below it. A push would then arrive at a
# `pre-receive` that cannot see the object store and refuse itself, with the
# store configured correctly the whole time — which is the confusing half of
# the failure, since smart-HTTP works (src/git-backend.ts forwards the same
# variables into its CGI child by hand).
#
# The file is written at boot by entrypoint.sh, owned by `git` and mode 600: it
# carries the object store's credentials.
[ -r /srv/walgit/env.sh ] && . /srv/walgit/env.sh
exec bun /app/src/ssh-shell.ts
