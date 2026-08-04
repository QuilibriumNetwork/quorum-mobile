// LOCAL-ONLY candidate FIX patch: widen the send-retry window in the RN
// websocket client, inside node_modules, so it can be tested on a device
// without publishing quorum-shared to npm.
//
// WHY
// ---
// Rounds Q and R measured the loss mechanism exactly:
//   - the relay kills a connection that answers its ping >1s late
//   - it does so with no close frame, so the client keeps writing into a dead
//     socket for ~3.5s before it notices
//   - frames written 1.4-3.5s before that detection are accepted by ws.send(),
//     dropped from the queue as "sent", and never delivered or retried => LOST
//   - frames written <1s before detection are caught mid-batch by the EXISTING
//     pendingEnvelopes requeue and flushed on reconnect => they survive
//
// So the rescue path already exists and works. Its window is just ~1s wide
// while the lethal window is ~3.5s. This patch widens it: every frame handed to
// ws.send is retained for RETAIN_MS, and anything still inside that window when
// the socket reopens is replayed.
//
// SAFETY
// ------
// Replay can re-send a frame that actually landed (the client knows when it
// NOTICED the death, not when the relay caused it). That case is already
// routine and harmless: the relay redelivers frames constantly today, a
// duplicate's message key was already consumed so it fails AEAD, is logged and
// deleted, and no message is lost. It also cannot feed crate bug 2a — skipped
// keys are filed when a frame arrives AHEAD of the ratchet position, and a
// replay sits behind it. Cost is log noise, not damage.
//
// Idempotent. Re-run after any yarn install or quorum-shared rebuild, then
// RESTART METRO WITH -ResetCache. Verify with:
//   [WS-retain] armed          on client creation
//   [WS-retain] replaying N    on each reconnect that has retained frames
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// How far back to replay, measured from send to REPLAY (i.e. to the reconnect),
// so the budget must cover the blind window AND the reconnect gap. Round T lost
// T5 with 6000: blind window >5.0s plus a 4.42s reconnect gap made it 9.43s old
// at replay, past the cutoff. Worst observed total is ~10s, so 12s adds margin
const RETAIN_MS = 12000;
const RETAIN_CAP = 200; // frames; ~33 messages of 6-target fan-out

const PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/@quilibrium/quorum-shared/dist'
);
const TARGETS = ['index.native.js', 'index.js', 'index.mjs'];

for (const name of TARGETS) patchFile(resolve(PKG, name), name);

// Remove any earlier insertion by this script. Needed because v1 anchored its
// blocks INSIDE the text patch-rn-ws-diag.mjs uses for its own "already
// patched" check, which broke that script's idempotency: `git debug` then died
// with "pattern not found: batch send". Every anchor below now sits strictly
// AFTER the diag patch's own inserted lines, so the two compose.
function stripPrevious(t) {
  return t
    .replace(/\n\s*if \(!this\.__retain\) this\.__retain = \[\];\n\s*this\.__retain\.push\(\{ m, t: Date\.now\(\) \}\);\n\s*if \(this\.__retain\.length > \d+\) this\.__retain\.splice\(0, this\.__retain\.length - \d+\);/g, '')
    .replace(/\n *try \{\n *const now = Date\.now\(\);\n *const all = this\.__retain \|\| \[\];[\s\S]*?\n *\} catch \(e\) \{\n *console\.warn\("\[WS-retain\] replay failed: " \+ \(e && e\.message\)\);\n *\}/g, '')
    .replace(/\n *console\.warn\("\[WS-retain\] armed[^\n]*\);/g, '');
}

function patchFile(FILE, label) {
  const src = readFileSync(FILE, 'utf-8');

  // Only the RN client. BrowserWebSocketClient has byte-identical code earlier
  // in the bundle, and patching it here would be wrong (desktop does not even
  // use it — it has its own provider).
  const marker = '// src/transport/rn-websocket.ts';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('rn-websocket marker not found in ' + label);
  const head = src.slice(0, at);
  let tail = stripPrevious(src.slice(at));
  let applied = 0;

  // The diag patch must have run first: every anchor below is a line it adds.
  if (!tail.includes('[WS-frame] sent len=')) {
    throw new Error(
      'diag patch not present in ' + label + ' — run `git debug` (or '
      + 'node .agents/scripts/patch-rn-ws-diag.mjs) FIRST, then this script.'
    );
  }

  function replaceOnce(hay, from, to, what) {
    if (hay.includes(to)) { console.log('  already patched: ' + what); return hay; }
    const i = hay.indexOf(from);
    if (i < 0) throw new Error('pattern not found: ' + what + ' (' + label + ')');
    if (hay.indexOf(from, i + 1) >= 0) throw new Error('pattern not unique: ' + what);
    applied++;
    return hay.slice(0, i) + to + hay.slice(i + from.length);
  }

  // 1. Retain every frame we hand to the socket. This sits immediately after
  //    the existing [WS-frame] sent probe so it only fires on a send that did
  //    not throw. Uses plain assignment rather than ||= for Hermes safety.
  // Anchored AFTER the whole try/catch. patch-rn-ws-diag.mjs's "already
  // patched" string for its batch-send step spans from `for (const m of
  // messages) {` all the way to `} catch (error) {`, so ANY insertion inside
  // that region breaks its idempotency check — which is what killed `git debug`
  // on the first attempt. Outside the block, the two patches compose.
  //
  // This retains a frame even when ws.send threw. That case already pushes the
  // frame to pendingEnvelopes, so the replay step below filters against it to
  // avoid queueing the same frame twice.
  const CATCH_BLOCK = `            } catch (error) {
              console.error("Error sending outbound envelope:", error);
              this.pendingEnvelopes.push(m);
            }`;
  tail = replaceOnce(
    tail,
    CATCH_BLOCK,
    CATCH_BLOCK + `
            if (!this.__retain) this.__retain = [];
            this.__retain.push({ m, t: Date.now() });
            if (this.__retain.length > ${RETAIN_CAP}) this.__retain.splice(0, this.__retain.length - ${RETAIN_CAP});`,
    'retain on send'
  );

  // 2. On reconnect, replay whatever is still inside the window. It goes to the
  //    FRONT of pendingEnvelopes: those hold frames caught mid-batch at the
  //    moment of failure, which are chronologically NEWER than anything
  //    retained, and the recipient must see frames in ratchet order.
  tail = replaceOnce(
    tail,
    `          console.warn("[WS-life] OPEN t=" + Date.now() + " attempts=" + this.reconnectAttempts);
          this.reconnectAttempts = 0;`,
    `          console.warn("[WS-life] OPEN t=" + Date.now() + " attempts=" + this.reconnectAttempts);
          this.reconnectAttempts = 0;
          try {
            const now = Date.now();
            const all = this.__retain || [];
            const keep = all.filter((e) => now - e.t <= ${RETAIN_MS} && this.pendingEnvelopes.indexOf(e.m) === -1);
            this.__retain = [];
            if (keep.length > 0) {
              console.warn("[WS-retain] replaying " + keep.length + " frame(s) retained within ${RETAIN_MS}ms (dropped " + (all.length - keep.length) + " older)");
              this.pendingEnvelopes.unshift.apply(this.pendingEnvelopes, keep.map((e) => e.m));
            }
          } catch (e) {
            console.warn("[WS-retain] replay failed: " + (e && e.message));
          }`,
    'replay on reconnect'
  );

  // 3. Armed marker, so a capture proves this patch is in the running build —
  //    the same reason the diag patch carries one. Round 25 was thrown away for
  //    want of exactly this.
  // Anchored AFTER the factory function closes, at module scope. Sitting
  // between diag's marker and its `return` broke diag's own "already patched"
  // string, which requires those two lines to be adjacent. At module scope this
  // also fires earlier — on bundle load rather than on first client creation —
  // which is a slightly stronger proof that the patched module is running.
  const DIAG_FACTORY = `function createRNWebSocketClient(options) {
  console.warn("[WS-diag] transport patch armed");
  return new RNWebSocketClient(options);
}`;
  tail = replaceOnce(
    tail,
    DIAG_FACTORY,
    DIAG_FACTORY + `
  console.warn("[WS-retain] armed window=${RETAIN_MS}ms cap=${RETAIN_CAP}");`,
    'armed marker'
  );

  writeFileSync(FILE, head + tail);
  console.log(label + ': ' + (applied > 0 ? `patched OK (${applied} step(s))` : 'fully patched already'));
}
