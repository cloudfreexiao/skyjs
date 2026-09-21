#!/bin/zsh
# usage: rss_trim.sh <case> — dedicated-node RSS peak for one bench case
# (bootstrap runs test/service/bench_trim_main.js with the case as snjs_param)
cd "$(dirname "$0")/.."
CASE=$1
LOG=build/trim_log_$CASE.txt
cat > build/config_trim.json <<EOF
{ "thread": 4, "cpath": "./cservice/?.so;./test/cservice/?.so",
  "bootstrap": "snjs test/service/bench_trim_main.js $CASE",
  "logservice": "logger", "profile": true }
EOF
./skyjs build/config_trim.json > "$LOG" 2>&1 &
PID=$!
PEAK=0
N=0
while kill -0 "$PID" 2>/dev/null; do
  R=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
  if [[ -n "$R" ]] && (( R > PEAK )); then PEAK=$R; fi
  N=$((N+1))
  if grep -q BENCH_TRIM_DONE "$LOG" 2>/dev/null && (( N > 100 )); then break; fi
  (( N > 3000 )) && break
  sleep 0.02
done
kill "$PID" 2>/dev/null
echo "TRIM case=$CASE peak_kb=$PEAK js_mem=$(grep -o 'js_mem=[0-9]*' "$LOG" | tail -1)"
