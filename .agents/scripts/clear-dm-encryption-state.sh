#!/usr/bin/env bash
# Clear the DM encryption-session store (MMKV "quorum-encryption") of a
# DEBUG build via adb, then restart the app.
#
# What it deletes: Double-Ratchet session states, conversation-inbox
# keypairs, inbox mappings — the local handshake bookkeeping. Sessions
# re-establish automatically on the next message exchange.
# What it does NOT touch: account keys (SecureStore), message history
# (SQLite), any other app data.
#
# When to use: a test account has accumulated session churn (huge
# quorum-encryption file, thousands of stale session rows, sends slow) and
# you want the clean-user baseline.
#
# LIMITATION: works only on DEBUG builds (adb run-as requires
# android:debuggable). The production/preview app cannot be cleaned this
# way — that would need an in-app dev action.
#
# Usage:
#   ./scripts/clear-dm-encryption-state.sh                # default debug package
#   ./scripts/clear-dm-encryption-state.sh <package.id>   # custom package
#   ADB_SERIAL=<serial> ./scripts/clear-dm-encryption-state.sh   # specific device

set -euo pipefail

PKG="${1:-com.quilibrium.quorummobile.debug}"
ADB=(adb)
if [ -n "${ADB_SERIAL:-}" ]; then ADB=(adb -s "$ADB_SERIAL"); fi

echo "Package: $PKG"
"${ADB[@]}" get-state >/dev/null || { echo "No device connected"; exit 1; }

SIZE=$("${ADB[@]}" shell run-as "$PKG" ls -l files/mmkv/quorum-encryption 2>/dev/null | tr -s ' ' | cut -d' ' -f5 || true)
if [ -z "$SIZE" ]; then
  echo "No quorum-encryption store found (already clean, or not a debug build)."
  exit 0
fi
echo "Current store size: $SIZE bytes"

echo "Stopping app..."
"${ADB[@]}" shell am force-stop "$PKG"

echo "Deleting quorum-encryption MMKV..."
"${ADB[@]}" shell run-as "$PKG" rm -f files/mmkv/quorum-encryption files/mmkv/quorum-encryption.crc

echo "Restarting app..."
"${ADB[@]}" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

echo "Done. Sessions will re-establish on the next message exchange."
