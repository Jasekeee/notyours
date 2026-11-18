#!/usr/bin/env bash
# G1 spike: verify kane-cli capabilities notyours depends on.
# Usage: spike/run.sh <T1|T2|chromes-up|T3|T4|T4b|T5|T6|T7|chromes-down>...
# Each kane-cli invocation runs exactly once (credits are limited): no retries, no loops.
# Raw NDJSON goes to spike/logs/ (gitignored); RESULTS.md is written by hand from it.
set -u
cd "$(dirname "$0")"
mkdir -p logs
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ALICE=http://localhost:9301
BOB=http://localhost:9302
# example.com/.org no longer have an <h1>, a link, or visible "Example Domain" (Nov 2026),
# so tests T2-T7 use a local fixture (spike/site via serve.js) instead.
COM=http://127.0.0.1:8787/com.html
ORG=http://127.0.0.1:8787/org.html

# kane <id> <kane-cli args...>  -> logs/<id>.ndjson, logs/<id>.err, logs/<id>.meta
kane() {
  local id=$1; shift
  local t0 t1 rc
  t0=$(date +%s)
  kane-cli "$@" > "logs/$id.ndjson" 2> "logs/$id.err"
  rc=$?
  t1=$(date +%s)
  printf 'exit=%s wall_s=%s\n' "$rc" "$((t1 - t0))" > "logs/$id.meta"
  summary "$id"
}

# Print the run_end event (or last line) of a run, with long opaque values masked.
summary() {
  local id=$1
  echo "== $id $(cat "logs/$id.meta")"
  grep '"run_end"' "logs/$id.ndjson" | tail -1 | jq -c . 2>/dev/null \
    || tail -1 "logs/$id.ndjson"
}

chrome_up() {
  local port=$1 dir=$2
  "$CHROME" --remote-debugging-port="$port" --user-data-dir="$dir" --no-first-run \
    --no-default-browser-check about:blank > "logs/chrome-$port.log" 2>&1 &
  echo $! > "logs/chrome-$port.pid"
  for _ in $(seq 1 30); do
    curl -s "http://localhost:$port/json/version" > /dev/null && { echo "chrome :$port up (pid $(cat "logs/chrome-$port.pid"))"; return 0; }
    sleep 0.5
  done
  echo "chrome :$port FAILED to start"; return 1
}

chrome_down() {
  for port in 9301 9302; do
    [ -f "logs/chrome-$port.pid" ] && kill "$(cat "logs/chrome-$port.pid")" 2>/dev/null && echo "chrome :$port stopped"
    rm -f "logs/chrome-$port.pid"
  done
}

for step in "$@"; do
  case $step in
    T1) kane T1 run "Go to https://example.com, store the main heading text as 'h1', then verify the page shows 'Example Domain'" \
          --agent --headless --timeout 180 ;;
    T2) kane T2 run "Go to $COM, click the only link on the page, store the current page URL as 'url'" \
          --agent --headless --timeout 180 ;;
    serve-up) node serve.js > logs/serve.log 2>&1 & echo $! > logs/serve.pid; sleep 1; curl -s -o /dev/null -w "fixture %{http_code}\n" "$COM" ;;
    serve-down) [ -f logs/serve.pid ] && kill "$(cat logs/serve.pid)" && rm -f logs/serve.pid && echo "fixture stopped" ;;
    chromes-up) chrome_up 9301 /tmp/ny-alice; chrome_up 9302 /tmp/ny-bob ;;
    chromes-down) chrome_down ;;
    T3) # two runs at the same time, one per Chrome
        kane T3a run "Go to $COM and verify the page shows 'Example Domain'" --cdp-endpoint "$ALICE" --agent --timeout 180 &
        kane T3b run "Go to $ORG and verify the page shows 'Example Domain'" --cdp-endpoint "$BOB" --agent --timeout 180 &
        wait ;;
    T4) node dom.js "$BOB" "Example Domain" ;;
    T4b) # dom.js listens to network responses on :9302 while Kane drives it
        node dom.js "$BOB" "Example Domain" --listen 150 > logs/T4b-dom.txt 2>&1 &
        dompid=$!
        sleep 3
        kane T4b run "Go to $COM and verify the page shows 'Example Domain'" --cdp-endpoint "$BOB" --agent --timeout 180
        wait "$dompid"
        echo "== dom.js (network listener) output:"; cat logs/T4b-dom.txt ;;
    T5) kane T5a run --analyzer-only --condition "The page shows 'Example Domain'" --cdp-endpoint "$BOB" --agent
        kane T5b run "" --analyzer-only --condition "The page shows 'Example Domain'" --cdp-endpoint "$BOB" --agent ;;
    T6-author)
        printf '{"site":{"value":"%s"}}\n' "$COM" > v.json
        kane T6-author run "Go to {{site}} and verify the page shows 'Example Domain'" --variables-file v.json --name nyspike --agent --headless --timeout 180
        ls -la .testmuai/tests/ 2>&1
        echo "== nyspike_test.md:"; cat .testmuai/tests/nyspike_test.md ;;
    T6-replay1) kane T6-replay1 testmd run .testmuai/tests/nyspike_test.md --agent --headless ;;
    T6-replay2) kane T6-replay2 testmd run .testmuai/tests/nyspike_test.md --agent --headless ;;
    T6-replay-org) kane T6-replay-org testmd run .testmuai/tests/nyspike_test.md --agent --headless ;;
    T7) kane T7 testmd run .testmuai/tests/nyspike_test.md --cdp-endpoint "$ALICE" --agent ;;
    *) echo "unknown step: $step"; exit 2 ;;
  esac
done
