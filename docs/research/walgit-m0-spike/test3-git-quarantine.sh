#!/bin/bash
# M0 test 3: receive.unpackLimit=0 retention + quarantine dir layout + hook ordering
set -u
ROOT="$(dirname "$0")/run3"; rm -rf "$ROOT"; mkdir -p "$ROOT"; cd "$ROOT" || exit 1
ROOT="$PWD"
LOG="$ROOT/hooks.log"; : > "$LOG"

git init --bare -q server.git
git -C server.git config receive.unpackLimit 0

# pre-receive: record quarantine dir + what's in it
cat > server.git/hooks/pre-receive <<'HOOK'
#!/bin/bash
L="$GIT_DIR/../hooks.log"
echo "== pre-receive ==" >> "$L"
echo "GIT_QUARANTINE_PATH=${GIT_QUARANTINE_PATH:-<unset>}" >> "$L"
echo "GIT_OBJECT_DIRECTORY=${GIT_OBJECT_DIRECTORY:-<unset>}" >> "$L"
while read -r old new ref; do echo "stdin: $old $new $ref" >> "$L"; done
if [ -n "${GIT_QUARANTINE_PATH:-}" ]; then
  echo "-- quarantine tree --" >> "$L"
  (cd "$GIT_QUARANTINE_PATH" && find . -type f | sed 's/^/  /') >> "$L"
fi
exit 0
HOOK

# reference-transaction: record every phase
cat > server.git/hooks/reference-transaction <<'HOOK'
#!/bin/bash
L="$GIT_DIR/../hooks.log"
echo "== reference-transaction phase=$1 ==" >> "$L"
while read -r old new ref; do echo "stdin: $old $new $ref" >> "$L"; done
if [ -f "$GIT_DIR/../ABORT" ] && [ "$1" = "prepared" ]; then
  echo "  -> refusing (simulated CAS failure)" >> "$L"
  exit 1
fi
exit 0
HOOK
chmod +x server.git/hooks/pre-receive server.git/hooks/reference-transaction

git init -q -b main client && cd client
git config user.email s@p.ke; git config user.name spike
echo one > a.txt; git add a.txt; git commit -qm "one object push"
git remote add origin "$ROOT/server.git"

echo "### PUSH 1 (should succeed) ###"
git push origin main 2>&1 | sed 's/^/  /'
cd "$ROOT"
echo
echo "### server object store after push 1 ###"
echo "packs:"; ls server.git/objects/pack/ 2>/dev/null | sed 's/^/  /' || echo "  (none)"
echo "loose object dirs:"; find server.git/objects -maxdepth 1 -type d -name '??' | sed 's/^/  /' || true
LOOSE=$(find server.git/objects -type f -path '*/??/*' 2>/dev/null | wc -l | tr -d ' ')
PACKS=$(ls server.git/objects/pack/*.pack 2>/dev/null | wc -l | tr -d ' ')
echo "  => loose=$LOOSE packs=$PACKS"
echo
echo "### PUSH 2 (reference-transaction prepared exits 1) ###"
touch "$ROOT/ABORT"
cd client; echo two > b.txt; git add b.txt; git commit -qm "second push"
git push origin main 2>&1 | sed 's/^/  /'
echo "  client exit code: $?"
cd "$ROOT"; rm -f ABORT
echo
echo "### server refs after rejected push ###"
git -C server.git for-each-ref | sed 's/^/  /'
echo "packs now: $(ls server.git/objects/pack/*.pack 2>/dev/null | wc -l | tr -d ' ')"
echo
echo "########## HOOK LOG ##########"
cat "$LOG"
