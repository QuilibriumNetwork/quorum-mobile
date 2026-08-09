#!/usr/bin/env bash
# qlog — grab React Native JS logs off the connected phone, fast and safely.
#
# WHY THIS EXISTS
#
# Metro's terminal output is far too busy to watch by eye, and this app fills
# the Android log ring buffer in roughly FORTY SECONDS (measured 2026-08-09:
# 1302 ReactNativeJS lines in a 40s window). So "run it and look for line X"
# does not work for a human, and "read the buffer afterwards" does not work for
# an agent — by the time anyone looks, the evidence has rolled off.
#
# The fix is to start a FILTERED capture BEFORE the action, and let it run.
#
# SAFETY — read before changing the output path
#
# Device logs contain real account addresses, space IDs and inbox addresses.
# Those must never enter the repository: this repo is public-facing and the
# operator is anonymous in it. So output goes to a machine-local directory
# OUTSIDE the repo, and this script must never be changed to write inside it.
# The script itself holds no data and is safe to commit.
#
# USAGE
#
#   .agents/scripts/qlog.sh start '[ProfileSync]|[DMProfileSync]'   # begin capture
#   .agents/scripts/qlog.sh read                                    # show what landed
#   .agents/scripts/qlog.sh stop                                    # end capture
#   .agents/scripts/qlog.sh once '[ProfileSync]' 20                 # capture 20s, then print
#
# The pattern is an extended regex (grep -E). Omit it to capture everything,
# which fills fast — prefer a pattern.

set -uo pipefail

OUT_DIR="${LOCALAPPDATA:-$HOME}/quorum-qlog"
OUT="$OUT_DIR/capture.log"
PID_FILE="$OUT_DIR/capture.pid"

mkdir -p "$OUT_DIR"

die() { echo "qlog: $*" >&2; exit 1; }

require_device() {
  local n
  n=$(adb devices 2>/dev/null | grep -cE "\sdevice$")
  [ "$n" -ge 1 ] || die "no device attached (check 'adb devices'; for Wi-Fi try 'adb connect <ip>:5555')"
}

stop_capture() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # Belt and braces: adb logcat can outlive the wrapper shell.
  pkill -f "adb logcat -s ReactNativeJS" 2>/dev/null || true
}

case "${1:-}" in
  start)
    require_device
    stop_capture
    pattern="${2:-.}"
    : > "$OUT"
    # Clear the ring buffer so the capture starts from a known-empty state and
    # nothing from a previous run is mistaken for this one.
    adb logcat -c 2>/dev/null || true
    # Fully detached, or the caller's shell blocks waiting on the pipeline and
    # `start` never returns — which makes the tool useless to an agent driving
    # it from a command runner. nohup + closed stdio + disown is what actually
    # lets it survive independently here.
    nohup bash -c "adb logcat -s ReactNativeJS 2>/dev/null \
        | grep --line-buffered -aE '$pattern' >> '$OUT'" >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
    disown 2>/dev/null || true
    echo "qlog: capturing /$pattern/ -> $OUT"
    echo "qlog: do the action on the phone now, then: qlog.sh read"
    ;;

  read)
    [ -f "$OUT" ] || die "no capture file — run 'qlog.sh start' first"
    n=$(wc -l < "$OUT" | tr -d ' ')
    echo "qlog: $n matching line(s)"
    cat "$OUT"
    ;;

  stop)
    stop_capture
    echo "qlog: stopped"
    ;;

  once)
    require_device
    stop_capture
    pattern="${2:-.}"
    secs="${3:-20}"
    : > "$OUT"
    adb logcat -c 2>/dev/null || true
    ( adb logcat -s ReactNativeJS 2>/dev/null \
        | grep --line-buffered -aE "$pattern" >> "$OUT" ) &
    cap_pid=$!
    echo "qlog: capturing /$pattern/ for ${secs}s — act now"
    sleep "$secs"
    kill "$cap_pid" 2>/dev/null || true
    pkill -f "adb logcat -s ReactNativeJS" 2>/dev/null || true
    echo "qlog: $(wc -l < "$OUT" | tr -d ' ') matching line(s)"
    cat "$OUT"
    ;;

  *)
    sed -n '2,32p' "$0"
    exit 1
    ;;
esac
