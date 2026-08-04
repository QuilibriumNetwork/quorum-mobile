/**
 * DR ABLATION — offline causation test, no device time.
 *
 * The live data shows failures correlate with a large accumulated
 * skipped_keys_map (2 -> 20 -> 23 -> 37 across a day, failure rate rising with
 * it). Correlation only: failures also CREATE skipped keys, so cause and effect
 * are circular on captured evidence alone.
 *
 * This separates them. Take a real captured failure, change ONE property of the
 * ratchet state, and re-run the identical decrypt against the real wasm.
 * If a variant decrypts, that property was load-bearing. If none do, the skipped
 * map is a symptom and the cause is elsewhere in the state.
 *
 * usage: node dr-ablate.mjs <log> [...more logs]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Needs the SDK repo checked out as a sibling of this one, or SDK_DIR set.
const SDK_DIR =
  process.env.SDK_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../quilibrium-js-sdk-channels');
const glue = pathToFileURL(resolve(SDK_DIR, 'src/channel/channelwasm.js')).href;
const ch = await import(glue);
ch.initSync(readFileSync(resolve(SDK_DIR, 'src/wasm/channelwasm_bg.wasm')));

function dumpsFrom(logPath) {
  const parts = new Map();
  for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
    const m = line.match(/\[XPDUMP\]\s+(\d+)\/(\d+)\/(\d+)\s(.*)$/);
    if (!m) continue;
    const [, no, idx, total, text] = m;
    if (!parts.has(no)) parts.set(no, { total: +total, chunks: new Map() });
    parts.get(no).chunks.set(+idx, text);
  }
  const out = [];
  for (const [no, { total, chunks }] of parts) {
    if (chunks.size !== total) continue;
    const joined = Array.from({ length: total }, (_, i) => chunks.get(i + 1)).join('');
    try { out.push({ no, ...JSON.parse(joined) }); } catch { /* truncated */ }
  }
  return out;
}

/** Run the real ratchet decrypt. Returns 'OK' | 'AEAD' | 'THREW'. */
function tryDecrypt(ratchetState, envelope) {
  try {
    const out = JSON.parse(
      ch.js_double_ratchet_decrypt(JSON.stringify({ ratchet_state: ratchetState, envelope }))
    );
    const msg = Buffer.from(new Uint8Array(out.message)).toString('utf-8');
    if (msg.startsWith('Decryption failed') || msg.includes('aead')) return 'AEAD';
    return 'OK:' + msg.slice(0, 40).replace(/\s+/g, ' ');
  } catch (e) {
    return 'THREW:' + String(e).slice(0, 60);
  }
}

const VARIANTS = [
  ['baseline (as captured)', (rs) => rs],
  ['skipped_keys_map = {}', (rs) => ({ ...rs, skipped_keys_map: {} })],
  ['skipped: keep only current recv header key', (rs) => {
    const k = rs.current_receiving_header_key;
    const m = rs.skipped_keys_map ?? {};
    return { ...rs, skipped_keys_map: k && m[k] ? { [k]: m[k] } : {} };
  }],
  ['previous_sending_chain_length = 0', (rs) => ({ ...rs, previous_sending_chain_length: 0 })],
  ['current_receiving_chain_length = 0', (rs) => ({ ...rs, current_receiving_chain_length: 0 })],
  ['drop ONLY the current-recv-header bucket', (rs) => {
    const k = rs.current_receiving_header_key;
    const m = { ...(rs.skipped_keys_map ?? {}) };
    delete m[k];
    return { ...rs, skipped_keys_map: m };
  }],
  ['drop ONLY the next-recv-header bucket', (rs) => {
    const k = rs.next_receiving_header_key;
    const m = { ...(rs.skipped_keys_map ?? {}) };
    delete m[k];
    return { ...rs, skipped_keys_map: m };
  }],
  ['swap current<->next receiving header key', (rs) => ({
    ...rs,
    current_receiving_header_key: rs.next_receiving_header_key,
    next_receiving_header_key: rs.current_receiving_header_key,
  })],
];

let n = 0;
for (const logPath of process.argv.slice(2)) {
  for (const d of dumpsFrom(logPath)) {
    let row, sealed;
    try { row = JSON.parse(d.state); sealed = JSON.parse(d.frame); } catch { continue; }
    let rs;
    try { rs = JSON.parse(row.ratchet_state); } catch { continue; }

    // unseal first (same as the live path)
    let envelope;
    try {
      const bytes = JSON.parse(ch.js_decrypt_inbox_message(JSON.stringify({
        inbox_private_key: row.receiving_inbox.inbox_encryption_key.private_key,
        ephemeral_public_key: [...new Uint8Array(Buffer.from(sealed.ephemeral_public_key, 'hex'))],
        ciphertext: JSON.parse(sealed.envelope),
      })));
      envelope = Buffer.from(new Uint8Array(bytes)).toString('utf-8');
      const maybeInit = JSON.parse(envelope);
      if (maybeInit.user_address) envelope = maybeInit.message;
    } catch { continue; }

    n++;
    const skipped = Object.values(rs.skipped_keys_map ?? {})
      .reduce((a, v) => a + Object.keys(v ?? {}).length, 0);
    console.log(`\n=== dump ${d.no}  envFp=${d.envFp}  sLen=${rs.current_sending_chain_length} rLen=${rs.current_receiving_chain_length} pS=${rs.previous_sending_chain_length} skippedKeys=${skipped} ===`);
    for (const [label, mutate] of VARIANTS) {
      let verdict;
      try { verdict = tryDecrypt(JSON.stringify(mutate(rs)), envelope); }
      catch (e) { verdict = 'MUTATE-ERR:' + String(e).slice(0, 40); }
      const mark = verdict.startsWith('OK') ? ' <<<<<< DECRYPTS' : '';
      console.log(`   ${label.padEnd(44)} ${verdict}${mark}`);
    }
  }
}
console.log(`\n${n} captured failures ablated.`);
console.log('Any variant marked DECRYPTS identifies a load-bearing property.');
console.log('All AEAD => the skipped map is a symptom, not the cause.');
