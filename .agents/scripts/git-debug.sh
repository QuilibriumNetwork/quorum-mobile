#!/usr/bin/env bash
# `git debug` — put this repo into a valid DM-capture state, then PROVE it.
#
# Mirrors quorum-desktop's `git debug` alias. Run it before every capture
# round; never capture from a build you have not seen this output for.
#
# What it does:
#   1. refuses to run on a dirty tree (a half-applied rebase wastes a round)
#   2. fast-forwards local master from origin
#   3. rebases the diag branch onto local master and checks it out
#   4. re-applies the node_modules transport patch (lost on every yarn install)
#   5. prints BUILD CHECK: the probes AND the shipped fixes that are compiled in
#
# The in-app armed marker only reports the JS probes. It cannot tell you the
# fixes are present, and it cannot tell you the node_modules patch survived —
# that is what this output is for. Round 25 was captured without the transport
# patch and had to be thrown away; that is the failure this prevents.
#
# Edit DIAG_BRANCH below if the rig ever moves to a new branch.

DIAG_BRANCH="diag/dm-frame-trace"
BASE_BRANCH="master"

# --- guard: dirty tree ------------------------------------------------------
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WORKING TREE DIRTY - commit or stash before running git debug"
  git status --short --untracked-files=no
  exit 1
fi

# --- sync base --------------------------------------------------------------
git fetch origin --quiet
git checkout --quiet "$BASE_BRANCH" 2>/dev/null &&
  git merge --ff-only --quiet "origin/$BASE_BRANCH" 2>/dev/null

# --- rebase the rig onto it -------------------------------------------------
if ! git rebase "$BASE_BRANCH" "$DIAG_BRANCH"; then
  echo "REBASE FAILED - resolve before capturing"
  exit 1
fi

# --- re-arm the transport patch (node_modules is not tracked) ---------------
echo ""
echo "--- TRANSPORT PATCH (node_modules, wiped by every yarn install) ---"
# Keep only the per-file summary lines; the per-step "already patched" chatter
# is 12 lines that would push the BUILD CHECK off screen. On failure, dump it all.
if PATCH_OUT="$(node .agents/scripts/patch-rn-ws-diag.mjs 2>&1)"; then
  echo "$PATCH_OUT" | grep -E '^index\.' || echo "$PATCH_OUT"
else
  echo "$PATCH_OUT"
  echo "TRANSPORT PATCH FAILED - [WS-frame] lines will be missing from the capture"
  exit 1
fi

# --- proof ------------------------------------------------------------------
# These are ASSERTIONS, not a report. They used to be printed with "(want 1)"
# next to them and left for a human to read, which is how round 25 was captured
# from an unpatched build, analysed, and thrown away. A rig that is not armed
# must fail the command, not decorate its output.
echo ""
echo "--- BUILD CHECK (marker only reports probes, this reports fixes) ---"
git log --oneline -1
grep -oE "rig: '[^']+'" hooks/chat/useSendDirectMessage.ts | head -1

RIG_FAIL=0
check() { # check <label> <actual> <min>
  if [ "${2:-0}" -ge "$3" ] 2>/dev/null; then
    printf '  ok    %-16s %s (want >=%s)\n' "$1" "${2:-0}" "$3"
  else
    printf '  FAIL  %-16s %s (want >=%s)\n' "$1" "${2:-0}" "$3"
    RIG_FAIL=1
  fi
}

# Count only real call sites: the marker inside a quoted string literal. Plain
# `grep -c '\[DM-recv wire\]'` also matches the comments that mention the probe
# by name, which inflates the count and hides a probe that was actually deleted.
check "send row probe"  "$(grep -c "'\[DM-send row\]'" hooks/chat/useSendDirectMessage.ts)" 1
check "send wire probe" "$(grep -c "'\[DM-send wire\]'" hooks/chat/useSendDirectMessage.ts)" 1
check "recv wire probe" "$(grep -c "'\[DM-recv wire\]'" context/WebSocketContext.tsx)" 2
check "ws transport"    "$(grep -c 'WS-diag' node_modules/@quilibrium/quorum-shared/dist/index.native.js 2>/dev/null || echo 0)" 1

check "sent_accept fix" "$(grep -c sentAccept services/crypto/sessionSendShape.ts)" 1
check "ratchet mutex"   "$(grep -c KeyedMutex services/crypto/ratchet-mutex.ts)" 1
check "send-state pick" "$(grep -c selectSendState hooks/chat/useSendDirectMessage.ts)" 1

echo "local $BASE_BRANCH ahead of origin by $(git rev-list --count "origin/$BASE_BRANCH..$BASE_BRANCH") commits"

if [ "$RIG_FAIL" -ne 0 ]; then
  echo ""
  echo "RIG NOT ARMED - do not capture. Fix the FAIL lines above first."
  echo "  ws transport = 0 is the usual one: a yarn install or a quorum-shared"
  echo "  rebuild wiped the node_modules patch. Re-run this command, then"
  echo "  RESTART Metro with -ResetCache (a warm cache serves the old bundle)."
  exit 1
fi

echo ""
echo "RIG ARMED. After starting the capture and reloading the app, verify the"
echo "log itself before running the round:"
echo "  node ../quorum-desktop/.agents/scripts/validate-capture.mjs <capture.log>"
