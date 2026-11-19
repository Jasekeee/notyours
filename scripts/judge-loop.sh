#!/usr/bin/env bash
# The notyours loop without Claude Code, as a quick end-to-end check (AUD-15): a fixed boundary is locked, a regression comes back,
# the replay catches it (exit 1, LEAK), the fix goes back in, the replay is GREEN (exit 0).
#
#   From a clone:  npm ci && npm run build && bash scripts/judge-loop.sh            (work folder ./notyours-loop)
#   Other CLI:     NY="npx github:Jasekeee/notyours" bash scripts/judge-loop.sh
#
# First run only (setup): the quick demo (~4 min, ~50–60 credits) and proving the fixed B1 (2 authoring runs,
# ~2–3 min, ~30–40 credits). After that the loop itself takes about 2 minutes and a few credits (replays only).
# Needs Node 22+, Chrome, kane-cli 0.10.0 logged in, and port 3077 free. Measured numbers: docs/STATUS.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NY="${NY:-node $HERE/../dist/cli/index.js}"
DIR="${1:-./notyours-loop}"
B=b1-notes-cross-user
PORT=3077

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ny() { $NY "$@"; }

if [ -z "${NY_SKIP_PORT_CHECK:-}" ] && lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Port $PORT is in use; the demo app needs it. Find it: lsof -i :$PORT" >&2
  exit 2
fi

# --- setup (first run only) -------------------------------------------------------------------------------------
if [ ! -f "$DIR/.notyours/secrets.json" ]; then
  say "Setup 1/2: the quick demo (B1 leaks: Bob opens Alice's note)"
  ny demo --quick --dir "$DIR" --no-open
fi
DIR="$(cd "$DIR" && pwd)"
cd "$DIR"

[ -f .loop/notes.seeded.js ] || { mkdir -p .loop; cp routes/notes.js .loop/notes.seeded.js; }
if [ ! -f .loop/notes.fixed.js ]; then
  # The fix an agent would make for SEEDED BUG #1 and #2: load the note only if it belongs to the caller.
  node - <<'EOF'
const fs = require('fs');
const s = fs.readFileSync('.loop/notes.seeded.js', 'utf8');
const from = 'WHERE n.id = ?`, [id])';
if (s.split(from).length - 1 !== 2) { console.error('routes/notes.js is not the seeded demo route; not patching it.'); process.exit(1); }
fs.writeFileSync('.loop/notes.fixed.js', s.split(from).join('WHERE n.id = ? AND n.owner_id = ?`, [id, req.user.id])'));
EOF
fi

APP_PID=""
start_app() {
  stop_app
  PORT=$PORT node server.js >> .loop/app.log 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/login" && return 0; sleep 0.5; done
  echo "The demo app did not start; see $DIR/.loop/app.log" >&2
  exit 2
}
stop_app() { if [ -n "$APP_PID" ]; then kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true; APP_PID=""; fi; }
trap stop_app EXIT

if ! grep -q '^locked: true' .notyours/boundaries/b1-cross-user.yaml 2>/dev/null; then
  say "Setup 2/2: fix the route, prove B1 holds, lock it (2 authoring runs)"
  cp .loop/notes.fixed.js routes/notes.js
  start_app
  ny run "$B"
  ny lock "$B"
fi

# --- the loop (about 2 minutes) ---------------------------------------------------------------------------------
t0=$(date +%s)
say "1/2 A regression: the old route without the owner check is back (simulated: the seeded file is restored)"
cp .loop/notes.seeded.js routes/notes.js
start_app
set +e; ny replay "$B"; red=$?; set -e
echo "replay exit code: $red (expected 1: LEAK)"

say "2/2 The fix goes back in"
cp .loop/notes.fixed.js routes/notes.js
start_app
set +e; ny replay "$B"; green=$?; set -e
echo "replay exit code: $green (expected 0: GREEN)"
stop_app

say "Loop done in $(( $(date +%s) - t0 )) s"
if [ "$red" -eq 1 ] && [ "$green" -eq 0 ]; then
  echo "As expected: the regression was caught (exit 1, LEAK), and the fixed code replayed GREEN (exit 0)."
else
  echo "Unexpected exit codes (regression: $red, fix: $green). The report under $DIR/.notyours/runs/ says why." >&2
  exit 1
fi
