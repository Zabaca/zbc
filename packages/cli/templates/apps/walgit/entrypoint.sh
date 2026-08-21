#!/bin/sh
# walgit boot: materialize SSH identity from secrets, then supervise sshd and
# the smart-HTTP server as one unit.
set -eu

REPOS_DIR="${WALGIT_REPOS_DIR:-/srv/walgit/repos}"
mkdir -p "$REPOS_DIR"
chown git:git "$REPOS_DIR"

# The host key comes from a secret because the container filesystem does not
# survive a machine stop. A generated-on-boot key would change on every
# autostart and every client would see the SSH man-in-the-middle warning — on a
# host designed to stop whenever it is idle, that is every day.
if [ -n "${WALGIT_SSH_HOST_KEY:-}" ]; then
  printf '%s\n' "$WALGIT_SSH_HOST_KEY" > /etc/ssh/ssh_host_ed25519_key
  chmod 600 /etc/ssh/ssh_host_ed25519_key
  ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key > /etc/ssh/ssh_host_ed25519_key.pub
else
  echo "walgit: WALGIT_SSH_HOST_KEY is unset — generating an EPHEMERAL host key." >&2
  echo "walgit: clients will see a changed host key after every machine stop." >&2
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
fi

# Every authorized key is pinned to the forced command. The client's own command
# line is then never executed — it arrives as SSH_ORIGINAL_COMMAND and is parsed
# by src/repo.ts, which allows exactly two git verbs and one repository name.
AUTH_KEYS=/srv/walgit/.ssh/authorized_keys
: > "$AUTH_KEYS"
if [ -n "${WALGIT_SSH_AUTHORIZED_KEYS:-}" ]; then
  printf '%s\n' "$WALGIT_SSH_AUTHORIZED_KEYS" | while IFS= read -r key; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    printf 'command="bun /app/src/ssh-shell.ts",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' "$key" >> "$AUTH_KEYS"
  done
fi
chown git:git "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
if [ ! -s "$AUTH_KEYS" ]; then
  echo "walgit: no authorized keys — SSH will refuse every client (set WALGIT_SSH_AUTHORIZED_KEYS)." >&2
fi

# Two processes, one machine lifetime: if either half dies the machine should
# stop rather than keep serving half a git host, so each kills the other.
/usr/sbin/sshd -D -e &
SSHD=$!
bun /app/src/server.ts &
HTTP=$!

term() { kill "$SSHD" "$HTTP" 2>/dev/null || true; }
trap term TERM INT

# Polled rather than `wait -n`, which busybox ash does not reliably provide.
while kill -0 "$SSHD" 2>/dev/null && kill -0 "$HTTP" 2>/dev/null; do
  sleep 5
done
echo "walgit: a server process exited — stopping the machine." >&2
term
exit 1
