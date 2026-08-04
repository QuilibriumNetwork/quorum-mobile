// Ground-truth harness driving the REAL Quilibrium channel crypto core (the SDK's
// wasm build of the Rust `channel` crate — the same crate mobile loads via UniFFI).
// Lets you answer protocol questions in seconds with NO devices and no rebuild.
//
// Run:  node .agents/scripts/dr-core-harness.mjs
// Needs the SDK repo checked out as a sibling of this one (../quilibrium-js-sdk-channels),
// override with:  SDK_DIR=/path/to/quilibrium-js-sdk-channels node .agents/scripts/dr-core-harness.mjs
//
// Currently answers (see the bug file §10):
//   Q1. What does a DR envelope string actually look like? (backslashes?)
//   Q2. Does mobile's blanket unescape corrupt a real envelope?  (§9 wrapper hazard)
//   Q3. Does the core recover out-of-order frames across a DH ratchet epoch boundary? (§8)
//
// Key gotchas if you extend this: device identity/pre/ephemeral keys are all x448
// (ed448 is only for inbox SIGNING keys), keygen returns number[] not base64, and
// the X3DH result IS base64.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const SDK_DIR =
  process.env.SDK_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../quilibrium-js-sdk-channels');

const glue = pathToFileURL(resolve(SDK_DIR, 'src/channel/channelwasm.js')).href;
const { initSync } = await import(glue);
const ch = await import(glue);

initSync(readFileSync(resolve(SDK_DIR, 'src/wasm/channelwasm_bg.wasm')));

const b64 = (s) => Buffer.from(s, 'base64');
const bytes = (b) => [...new Uint8Array(b)];

// ---------- build an X3DH-established DR pair, exactly as the SDK does ----------
const aIdent = JSON.parse(ch.js_generate_x448());
const aPre = JSON.parse(ch.js_generate_x448());
const aEph = JSON.parse(ch.js_generate_x448());
const bIdent = JSON.parse(ch.js_generate_x448());
const bPre = JSON.parse(ch.js_generate_x448());

const senderSK = JSON.parse(
  ch.js_sender_x3dh(
    JSON.stringify({
      sending_identity_private_key: aIdent.private_key,
      sending_ephemeral_private_key: aEph.private_key,
      receiving_identity_key: bIdent.public_key,
      receiving_signed_pre_key: bPre.public_key,
      session_key_length: 96,
    })
  )
);
const recvSK = JSON.parse(
  ch.js_receiver_x3dh(
    JSON.stringify({
      sending_identity_private_key: bIdent.private_key,
      sending_signed_private_key: bPre.private_key,
      receiving_identity_key: aIdent.public_key,
      receiving_ephemeral_key: aEph.public_key,
      session_key_length: 96,
    })
  )
);
const sk = (v) => (typeof v === 'string' ? bytes(b64(v)) : v);
const A = sk(senderSK), B = sk(recvSK);
console.log('X3DH session keys match:', Buffer.from(A).equals(Buffer.from(B)));

let alice = ch.js_new_double_ratchet(
  JSON.stringify({
    session_key: A.slice(0, 32),
    sending_header_key: A.slice(32, 64),
    next_receiving_header_key: A.slice(64, 96),
    is_sender: true,
    sending_ephemeral_private_key: aEph.private_key,
    receiving_ephemeral_key: bPre.public_key,
  })
);
let bob = ch.js_new_double_ratchet(
  JSON.stringify({
    session_key: B.slice(0, 32),
    sending_header_key: B.slice(32, 64),
    next_receiving_header_key: B.slice(64, 96),
    is_sender: false,
    sending_ephemeral_private_key: bPre.private_key,
    receiving_ephemeral_key: aEph.public_key,
  })
);
JSON.parse(alice); JSON.parse(bob);

const enc = (state, text) => {
  const r = JSON.parse(
    ch.js_double_ratchet_encrypt(
      JSON.stringify({ ratchet_state: state, message: bytes(Buffer.from(text, 'utf-8')) })
    )
  );
  return [r.ratchet_state, r.envelope];
};
const dec = (state, envelope) => {
  const r = JSON.parse(
    ch.js_double_ratchet_decrypt(JSON.stringify({ ratchet_state: state, envelope }))
  );
  const msg = Buffer.from(new Uint8Array(r.message)).toString('utf-8');
  if (msg.startsWith('Decryption failed') || msg.includes('aead')) throw new Error(msg);
  return [r.ratchet_state, msg];
};

// ================= Q1: real envelope shape =================
let env1;
[alice, env1] = enc(alice, 'hello from alice');
console.log('\n=== Q1: REAL DR ENVELOPE ===');
console.log('len:', env1.length);
console.log('sample:', env1.slice(0, 220));
console.log("contains backslash:", env1.includes('\\'));
console.log('contains \\":', env1.includes('\\"'));
const parsedEnv = JSON.parse(env1);
console.log('top-level keys:', Object.keys(parsedEnv));
for (const [k, v] of Object.entries(parsedEnv)) {
  console.log(`  ${k}:`, typeof v, Array.isArray(v) ? `array[${v.length}]`
    : typeof v === 'object' && v ? `keys=${Object.keys(v)}` : String(v).slice(0, 40));
}

// ================= Q2: does mobile's blanket unescape corrupt it? =================
// Mobile receive sites do:  if (s.includes('\\')) s = s.replace(/\\"/g,'"').replace(/\\\\/g,'\\')
const mobileUnescape = (s) =>
  s.includes('\\') ? s.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s;

console.log('\n=== Q2: MOBILE BLANKET UNESCAPE ===');
// (a) confirmed-session path: envelope is the sealed plaintext verbatim
console.log('(a) direct envelope  -> unescape is a no-op:', mobileUnescape(env1) === env1);
// (b) init path: SDK embeds envelope inside InitializationEnvelope via JSON.stringify,
//     mobile recovers it via JSON.parse. Does the extra unescape then corrupt it?
const initWire = JSON.stringify({ type: 'direct', message: env1, tag: 'QmX' });
const recovered = JSON.parse(initWire).message;
console.log('(b) JSON round-trip exact:', recovered === env1);
console.log('(b) after unescape exact :', mobileUnescape(recovered) === env1);
// (c) would the corrupted form actually fail decrypt? only meaningful if (a)/(b) differ
let bobAfter, out1;
try {
  [bobAfter, out1] = dec(bob, mobileUnescape(env1));
  console.log('(c) decrypt of unescaped envelope: OK ->', JSON.stringify(out1));
  bob = bobAfter;
} catch (e) {
  console.log('(c) decrypt of unescaped envelope: FAILED ->', e.message.slice(0, 120));
}

// ================= Q3: epoch-boundary / out-of-order recovery =================
console.log('\n=== Q3: DH-RATCHET EPOCH BOUNDARY (the §8 hypothesis) ===');
const st = (s) => {
  const p = JSON.parse(s);
  return `sLen=${p.current_sending_chain_length} pS=${p.previous_sending_chain_length} rLen=${p.current_receiving_chain_length} pR=${p.previous_receiving_chain_length} skipped=${Object.keys(p.skipped_keys_map || {}).length}`;
};
console.log('alice:', st(alice));
console.log('bob  :', st(bob));

// Alice sends 3 more on the SAME chain, Bob receives them out of order (2,0,1)
const chain = [];
for (let i = 0; i < 3; i++) {
  let e;
  [alice, e] = enc(alice, `same-chain #${i}`);
  chain.push(e);
}
console.log('\n-- same-chain out-of-order (2,0,1) --');
for (const i of [2, 0, 1]) {
  try {
    let m;
    [bob, m] = dec(bob, chain[i]);
    console.log(`  frame ${i}: OK "${m}"  bob ${st(bob)}`);
  } catch (e) {
    console.log(`  frame ${i}: FAIL ${e.message.slice(0, 90)}`);
  }
}

// Now force a DH ratchet: Bob replies (new sending chain), Alice receives it.
// Meanwhile Alice had already queued frames on her OLD chain that are still in flight.
console.log('\n-- cross-epoch: frames from the PREVIOUS sending chain arrive LATE --');
const inFlight = [];
for (let i = 0; i < 2; i++) {
  let e;
  [alice, e] = enc(alice, `pre-ratchet #${i}`);
  inFlight.push(e);
}
let bobEnv;
[bob, bobEnv] = enc(bob, 'bob reply -> triggers DH ratchet');
let aliceMsg;
[alice, aliceMsg] = dec(alice, bobEnv);
console.log('  alice received bob reply:', JSON.stringify(aliceMsg));
console.log('  alice after DH ratchet:', st(alice));
// Alice now sends on her NEW chain; Bob receives THAT first, then the stragglers.
let newEnv;
[alice, newEnv] = enc(alice, 'post-ratchet #0');
try {
  let m;
  [bob, m] = dec(bob, newEnv);
  console.log(`  bob got post-ratchet frame FIRST: OK "${m}"  bob ${st(bob)}`);
} catch (e) {
  console.log('  bob post-ratchet frame FAIL:', e.message.slice(0, 90));
}
for (let i = 0; i < inFlight.length; i++) {
  try {
    let m;
    [bob, m] = dec(bob, inFlight[i]);
    console.log(`  straggler pre-ratchet #${i}: OK "${m}"  bob ${st(bob)}`);
  } catch (e) {
    console.log(`  straggler pre-ratchet #${i}: FAIL ${e.message.slice(0, 90)}`);
  }
}

// ================= Q4: sustained alternating ratchets (the observed traffic) =================
// Real DM traffic ping-pongs constantly: every post drags a read-ack and a
// delivery-ack, so BOTH sides DH-ratchet every few seconds. Round-5 capture
// showed desktop's receiving chain freezing and never following mobile's
// ratchet. Does the CRATE break under that interleaving, or is the driver?
console.log('\n=== Q4: SUSTAINED ALTERNATING RATCHETS (10 rounds, acks included) ===');
let ok = 0, fail = 0;
for (let round = 1; round <= 10; round++) {
  // mobile-ish side sends a post + two acks on its current chain
  const burst = [];
  for (const kind of ['post', 'read-ack', 'delivery-ack']) {
    let e; [alice, e] = enc(alice, `r${round}-${kind}`);
    burst.push([kind, e]);
  }
  for (const [kind, e] of burst) {
    try { let m; [bob, m] = dec(bob, e); ok++; }
    catch (err) { fail++; console.log(`  round ${round} ${kind}: FAIL ${err.message.slice(0, 70)}`); }
  }
  // peer replies -> forces the other side to DH-ratchet
  let rep; [bob, rep] = enc(bob, `r${round}-reply`);
  try { let m; [alice, m] = dec(alice, rep); ok++; }
  catch (err) { fail++; console.log(`  round ${round} reply: FAIL ${err.message.slice(0, 70)}`); }
  const a = JSON.parse(alice), b = JSON.parse(bob);
  console.log(`  round ${round}: aliceRoot=${String(a.root_key).slice(0,8)} bobRoot=${String(b.root_key).slice(0,8)} ok=${ok} fail=${fail}`);
}
console.log(`\n  RESULT: ${ok} decrypted, ${fail} failed over 10 alternating-ratchet rounds`);
