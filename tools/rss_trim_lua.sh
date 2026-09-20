#!/bin/zsh
# usage: rss_trim_lua.sh <case> — dedicated lua-node RSS peak for one bench case
# (bootstrap runs test/bench_lua/main_trim.lua with the case as snlua param)
cd "$(dirname "$0")/.."
CASE=$1
LOG=build/trim_lua_log_$CASE.txt
cat > build/config_trim_lua <<EOF
thread = 4
harbor = 0
logservice = "logger"
profile = true
bootstrap = "snlua bootstrap"
start = "test/bench_lua/main_trim $CASE"
cpath = "./cservice/?.so;../../test/cservice/?.so"
lua_path = "./lualib/?.lua;./lualib/?/init.lua"
lua_cpath = "./luaclib/?.so"
luaservice = "./?.lua;./service/?.lua;../../?.lua;../../test/bench_lua/?.lua"
EOF
(cd 3rd/skynet && ./skynet ../../build/config_trim_lua) > $LOG 2>&1 &
PID=$!
PEAK=0
N=0
while kill -0 $PID 2>/dev/null; do
  R=$(ps -o rss= -p $PID 2>/dev/null | tr -d ' ')
  if [[ -n "$R" ]] && (( R > PEAK )); then PEAK=$R; fi
  N=$((N+1))
  if grep -q BENCH_TRIM_DONE $LOG 2>/dev/null && (( N > 100 )); then break; fi
  (( N > 3000 )) && break
  sleep 0.02
done
kill $PID 2>/dev/null
echo "TRIM-LUA case=$CASE peak_kb=$PEAK gc_kib=$(grep -o 'gc_kib=[0-9]*' $LOG | tail -1)"
