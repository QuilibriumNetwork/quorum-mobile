// DIAG-ONLY transport patch: per-frame send logging inside the RN websocket
// client's drain loop (node_modules/@quilibrium/quorum-shared/dist/index.js).
//
// The [DM-send wire] line in mobile code logs at prepare-end, BEFORE the
// per-frame ws.send loop — it proves the drain ran, not that each frame was
// handed to the native socket. This patch logs each frame AT the ws.send
// call, with length + target inbox + bufferedAmount, closing that gap for
// the write-layer investigation.
//
// node_modules is not tracked, so this must be RE-RUN after any yarn
// install (patch-package cannot diff this package on this machine — its
// temp re-install step fails). The capture protocol checks the marker:
//   [WS-diag] transport patch armed
// No marker in the logcat => the patch is not in the running build.
//
// Idempotent: each step is skipped if its text is already present.
// Targets ONLY the RNWebSocketClient copy (after the rn-websocket.ts
// marker); BrowserWebSocketClient has byte-identical code earlier.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Metro resolves the package.json "react-native" field FIRST, which points at
// dist/index.native.js — NOT dist/index.js ("main"). Round 25 ran without the
// patch because only index.js was patched. Patch every bundle that carries the
// RN client so the entry-point resolution can never silently bypass it again.
const PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/@quilibrium/quorum-shared/dist'
);
const TARGETS = ['index.native.js', 'index.js', 'index.mjs'];

for (const name of TARGETS) {
  patchFile(resolve(PKG, name), name);
}

function patchFile(FILE, label) {
const src = readFileSync(FILE, 'utf-8');

const marker = '// src/transport/rn-websocket.ts';
const at = src.indexOf(marker);
if (at < 0) throw new Error('rn-websocket marker not found');
const head = src.slice(0, at);
let tail = src.slice(at);
let applied = 0;

const IB = `((/"inbox_address"\\s*:\\s*"([^"]+)"/.exec(m) || [])[1] || "?").slice(0, 12)`;
const SIG = `(/"inbox_signature"\\s*:\\s*"[^"]/.test(m) ? 1 : 0)`;

function replaceOnce(haystack, from, to, label) {
  if (haystack.includes(to)) {
    console.log('already patched: ' + label);
    return haystack;
  }
  const i = haystack.indexOf(from);
  if (i < 0) throw new Error('pattern not found: ' + label);
  if (haystack.indexOf(from, i + 1) >= 0) throw new Error('pattern not unique in tail: ' + label);
  applied++;
  return haystack.slice(0, i) + to + haystack.slice(i + from.length);
}

// 1. pendingEnvelopes flush
tail = replaceOnce(
  tail,
  `          try {
            this.ws.send(m);
            this.pendingEnvelopes.shift();`,
  `          try {
            this.ws.send(m);
            console.warn("[WS-frame] flushed-pending len=" + m.length + " ib=" + ${IB});
            this.pendingEnvelopes.shift();`,
  'pending flush'
);

// 2a. upgrade a v1-patched bundle (no sig= field) in place — MUST run before
// step 2 so its already-patched check sees the current (v2) line.
{
  const v1 = `console.warn("[WS-frame] sent len=" + m.length + " ib=" + ${IB} + " ba=" + (this.ws.bufferedAmount ?? "?"));`;
  const v2 = `console.warn("[WS-frame] sent len=" + m.length + " ib=" + ${IB} + " sig=" + ${SIG} + " ba=" + (this.ws.bufferedAmount ?? "?"));`;
  if (tail.includes(v1)) {
    tail = tail.split(v1).join(v2);
    applied++;
    console.log('upgraded v1 sent-line to v2 (sig field)');
  }
}

// 2. per-frame batch send + mid-batch socket loss
tail = replaceOnce(
  tail,
  `          for (const m of messages) {
            if (this.ws?.readyState !== WebSocket.OPEN) {
              this.pendingEnvelopes.push(m);
              continue;
            }
            try {
              this.ws.send(m);
            } catch (error) {`,
  `          for (const m of messages) {
            if (this.ws?.readyState !== WebSocket.OPEN) {
              console.warn("[WS-frame] socket lost mid-batch, requeued len=" + m.length + " ib=" + ${IB});
              this.pendingEnvelopes.push(m);
              continue;
            }
            try {
              this.ws.send(m);
              console.warn("[WS-frame] sent len=" + m.length + " ib=" + ${IB} + " sig=" + ${SIG} + " ba=" + (this.ws.bufferedAmount ?? "?"));
            } catch (error) {`,
  'batch send'
);


// 2b. SOCKET LIFECYCLE (added 2026-07-30 for the dying-socket investigation).
// The mid-batch probe above only notices a dead socket when it is about to
// write, so a drop between batches leaves no trace at all. These three log the
// transitions themselves, which is what distinguishes "the socket died and we
// wrote into it" from "the write itself failed". The close line also reports how
// many envelopes were still queued at that instant — frames written moments
// before are NOT in those queues, which is precisely the loss window.
tail = replaceOnce(
  tail,
  `        this.ws.onopen = () => {
          this.reconnectAttempts = 0;`,
  `        this.ws.onopen = () => {
          console.warn("[WS-life] OPEN t=" + Date.now() + " attempts=" + this.reconnectAttempts);
          this.reconnectAttempts = 0;`,
  'lifecycle open'
);

tail = replaceOnce(
  tail,
  `        this.ws.onclose = () => {
          this.setState("disconnected");`,
  `        this.ws.onclose = (ev) => {
          console.warn("[WS-life] CLOSE t=" + Date.now() + " code=" + (ev?.code ?? "?") + " reason=" + (ev?.reason || "-") + " clean=" + (ev?.wasClean ?? "?") + " pending=" + (this.pendingEnvelopes?.length ?? "?") + " outbound=" + (this.outboundQueue?.length ?? "?"));
          this.setState("disconnected");`,
  'lifecycle close'
);

tail = replaceOnce(
  tail,
  `        this.ws.onerror = () => {
          const error = new Error("WebSocket error");`,
  `        this.ws.onerror = (ev) => {
          console.warn("[WS-life] ERROR t=" + Date.now() + " msg=" + (ev?.message || "-"));
          const error = new Error("WebSocket error");`,
  'lifecycle error'
);

// 3. armed marker on client creation
tail = replaceOnce(
  tail,
  `function createRNWebSocketClient(options) {
  return new RNWebSocketClient(options);
}`,
  `function createRNWebSocketClient(options) {
  console.warn("[WS-diag] transport patch armed");
  return new RNWebSocketClient(options);
}`,
  'armed marker'
);

writeFileSync(FILE, head + tail);
console.log(label + ': ' + (applied > 0 ? `patched OK (${applied} step(s) applied)` : 'fully patched already'));
}
