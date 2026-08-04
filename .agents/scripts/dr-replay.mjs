// Offline replay of a REAL failed DM decrypt, against the real crypto core.
//
// Feed it a desktop console log containing [XPDUMP] lines (emitted on every
// DM decrypt failure by the debug/dm-cross-platform-trace branch). Each dump
// carries the exact ratchet state row AND the exact sealed frame, so the
// failing decrypt can be reproduced here as many times as you like with ZERO
// device time - then bisected, mutated, and understood.
//
// Run:  node .agents/scripts/dr-replay.mjs $QM_CAPTURE_DIR/localhost-XXXX.log
//
// ⚠️ XPDUMP lines contain REAL KEY MATERIAL. Debug branch + throwaway test
// accounts only. Delete the logs when the investigation is done.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const SDK_DIR =
  process.env.SDK_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../quilibrium-js-sdk-channels');
const glue = pathToFileURL(resolve(SDK_DIR, 'src/channel/channelwasm.js')).href;
const ch = await import(glue);
ch.initSync(readFileSync(resolve(SDK_DIR, 'src/wasm/channelwasm_bg.wasm')));

const logPath = process.argv[2];
if (!logPath) {
  console.error('usage: node dr-replay.mjs <desktop-console-log>');
  process.exit(1);
}

// ---- extract + reassemble the dumps ------------------------------------
// Desktop emits each dump as `[XPDUMP] <dump>/<idx>/<total> <chunk>` because
// DevTools truncates any single logged string at ~5k chars on export.
const parts = new Map(); // dumpNo -> { total, chunks: Map(idx -> text) }
for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
  const m = line.match(/\[XPDUMP\]\s+(\d+)\/(\d+)\/(\d+)\s(.*)$/);
  if (!m) continue;
  const [, no, idx, total, text] = m;
  if (!parts.has(no)) parts.set(no, { total: +total, chunks: new Map() });
  parts.get(no).chunks.set(+idx, text);
}
const dumps = [];
for (const [no, { total, chunks }] of parts) {
  if (chunks.size !== total) {
    console.log(`dump #${no}: INCOMPLETE (${chunks.size}/${total} chunks) - skipping`);
    continue;
  }
  const joined = Array.from({ length: total }, (_, i) => chunks.get(i + 1)).join('');
  try {
    dumps.push(JSON.parse(joined));
  } catch (e) {
    console.log(`dump #${no}: reassembled but did not parse - ${String(e).slice(0, 90)}`);
  }
}
console.log(`found ${dumps.length} XPDUMP record(s) in ${logPath}\n`);
if (!dumps.length) {
  console.log('None. Either no decrypt failed, or the log predates the XPDUMP build.');
  process.exit(0);
}

const fp = (v) => {
  const s = String(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
};

// Desktop's decrypt is DoubleRatchetInboxDecrypt(stateRow, sealedMessage).
// Reproduce it here in two stages so we can see WHICH stage fails:
//   1. unseal  (js_decrypt_inbox_message, needs receiving_inbox private key)
//   2. ratchet (js_double_ratchet_decrypt)
for (const d of dumps) {
  console.log(`--- dump #${d.n}  frame=${new Date(d.ts).toLocaleTimeString()} envFp=${d.envFp} stFp=${d.stFp} ---`);
  let row;
  try {
    row = JSON.parse(d.state);
  } catch (e) {
    console.log('  state did not parse (log line probably truncated):', String(e).slice(0, 80));
    continue;
  }
  const rs = JSON.parse(row.ratchet_state);
  console.log(`  state: root=${fp(rs.root_key)} sLen=${rs.current_sending_chain_length} pS=${rs.previous_sending_chain_length} rLen=${rs.current_receiving_chain_length} pR=${rs.previous_receiving_chain_length} skipped=${Object.keys(rs.skipped_keys_map || {}).length}`);
  console.log(`  dhs=${fp(rs.sending_ephemeral_private_key)} dhr=${fp(rs.receiving_ephemeral_key)}`);

  // `frame` is the whole SealedMessage: the sender's ephemeral public key sits
  // alongside the envelope, and the unseal needs both.
  let sealed;
  try {
    sealed = JSON.parse(d.frame);
  } catch (e) {
    console.log('  frame did not parse:', String(e).slice(0, 80));
    continue;
  }
  console.log(`  frame: inbox=${String(sealed.inbox_address).slice(0, 12)} signed=${sealed.inbox_public_key ? 'yes' : 'no'}`);

  // stage 1: unseal
  let unsealed;
  try {
    const bytes = JSON.parse(
      ch.js_decrypt_inbox_message(
        JSON.stringify({
          inbox_private_key: row.receiving_inbox.inbox_encryption_key.private_key,
          ephemeral_public_key: [
            ...new Uint8Array(Buffer.from(sealed.ephemeral_public_key, 'hex')),
          ],
          ciphertext: JSON.parse(sealed.envelope),
        })
      )
    );
    unsealed = Buffer.from(new Uint8Array(bytes)).toString('utf-8');
    console.log('  [1] unseal: OK');
  } catch (e) {
    console.log('  [1] unseal: FAILED ->', String(e).slice(0, 140));
    console.log('      (the sealed layer is what broke, NOT the ratchet)');
    continue;
  }

  // stage 2: ratchet decrypt
  let envelope = unsealed;
  try {
    const maybeInit = JSON.parse(unsealed);
    if (maybeInit.user_address) {
      console.log('  [i] frame is an INIT envelope (carries user_address)');
      envelope = maybeInit.message;
    }
  } catch { /* plain DR envelope */ }

  try {
    const out = JSON.parse(
      ch.js_double_ratchet_decrypt(
        JSON.stringify({ ratchet_state: row.ratchet_state, envelope })
      )
    );
    const msg = Buffer.from(new Uint8Array(out.message)).toString('utf-8');
    if (msg.startsWith('Decryption failed') || msg.includes('aead')) {
      console.log('  [2] ratchet: FAILED ->', msg.slice(0, 100));
      const after = JSON.parse(out.ratchet_state);
      console.log(`      state unchanged? rLen ${rs.current_receiving_chain_length} -> ${after.current_receiving_chain_length}`);
    } else {
      console.log(`  [2] ratchet: OK  -> ${msg.slice(0, 90)}`);
      console.log('      ⚠️ It decrypts HERE but failed live. The inputs are fine;');
      console.log('         the live failure came from something around the call.');
    }
  } catch (e) {
    console.log('  [2] ratchet: THREW ->', String(e).slice(0, 140));
  }
  console.log();
}
