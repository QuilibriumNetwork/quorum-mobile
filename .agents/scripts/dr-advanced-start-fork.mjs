// Isolated trigger matrix for the advanced-start fork. Each case gets its own
// pristine alice/bob pair from the same X3DH material.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Needs the SDK repo checked out as a sibling of this one, or SDK_DIR set.
const SDK =
  process.env.SDK_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../quilibrium-js-sdk-channels');
const ch = await import(pathToFileURL(SDK + '/src/channel/channelwasm.js').href);
ch.initSync(readFileSync(SDK + '/src/wasm/channelwasm_bg.wasm'));

const b64 = (s) => Buffer.from(s, 'base64');
const bytes = (b) => [...new Uint8Array(b)];
const sk = (v) => (typeof v === 'string' ? bytes(b64(v)) : v);

function newPair() {
  const aIdent = JSON.parse(ch.js_generate_x448());
  const aEph = JSON.parse(ch.js_generate_x448());
  const bIdent = JSON.parse(ch.js_generate_x448());
  const bPre = JSON.parse(ch.js_generate_x448());
  const A = sk(JSON.parse(ch.js_sender_x3dh(JSON.stringify({
    sending_identity_private_key: aIdent.private_key,
    sending_ephemeral_private_key: aEph.private_key,
    receiving_identity_key: bIdent.public_key,
    receiving_signed_pre_key: bPre.public_key,
    session_key_length: 96,
  }))));
  const B = sk(JSON.parse(ch.js_receiver_x3dh(JSON.stringify({
    sending_identity_private_key: bIdent.private_key,
    sending_signed_private_key: bPre.private_key,
    receiving_identity_key: aIdent.public_key,
    receiving_ephemeral_key: aEph.public_key,
    session_key_length: 96,
  }))));
  const alice = ch.js_new_double_ratchet(JSON.stringify({
    session_key: A.slice(0, 32), sending_header_key: A.slice(32, 64),
    next_receiving_header_key: A.slice(64, 96), is_sender: true,
    sending_ephemeral_private_key: aEph.private_key, receiving_ephemeral_key: bPre.public_key,
  }));
  const bob = ch.js_new_double_ratchet(JSON.stringify({
    session_key: B.slice(0, 32), sending_header_key: B.slice(32, 64),
    next_receiving_header_key: B.slice(64, 96), is_sender: false,
    sending_ephemeral_private_key: bPre.private_key, receiving_ephemeral_key: aEph.public_key,
  }));
  return { alice, bob };
}

const enc = (state, text) => {
  const r = JSON.parse(ch.js_double_ratchet_encrypt(JSON.stringify({
    ratchet_state: state, message: bytes(Buffer.from(text, 'utf-8')),
  })));
  return [r.ratchet_state, r.envelope];
};
const dec = (state, envelope, label) => {
  const r = JSON.parse(ch.js_double_ratchet_decrypt(JSON.stringify({
    ratchet_state: state, envelope,
  })));
  const msg = Buffer.from(new Uint8Array(r.message)).toString('utf-8');
  const ok = !(msg.startsWith('Decryption failed') || msg.includes('aead'));
  console.log(`  ${label}: ${ok ? 'OK' : 'FAIL'}`);
  return [ok ? r.ratchet_state : state, ok];
};

// alternation after the given receive prefix
function alternate(alice, bob, tag) {
  let e, ok, allOk = true;
  [bob, e] = enc(bob, 'd1');
  [alice, ok] = dec(alice, e, `${tag} alice<-d1`); allOk &&= ok;
  [alice, e] = enc(alice, 'next-m');
  [bob, ok] = dec(bob, e, `${tag} bob<-next-m`); allOk &&= ok;
  [bob, e] = enc(bob, 'd2');
  [alice, ok] = dec(alice, e, `${tag} alice<-d2`); allOk &&= ok;
  [alice, e] = enc(alice, 'next-m2');
  [bob, ok] = dec(bob, e, `${tag} bob<-next-m2`); allOk &&= ok;
  return allOk;
}

// A: control — bob receives e0,e1,e2 in order, then alternate
{
  let { alice, bob } = newPair();
  let e0, e1, e2, ok;
  [alice, e0] = enc(alice, 'm0'); [alice, e1] = enc(alice, 'm1'); [alice, e2] = enc(alice, 'm2');
  console.log('A: in-order 0,1,2 then alternate');
  [bob, ok] = dec(bob, e0, 'A bob<-e0'); [bob, ok] = dec(bob, e1, 'A bob<-e1'); [bob, ok] = dec(bob, e2, 'A bob<-e2');
  console.log('A alternation clean:', alternate(alice, bob, 'A'));
}
// B: bob sees e0 then e2 (e1 lost), then alternate
{
  let { alice, bob } = newPair();
  let e0, e1, e2, ok;
  [alice, e0] = enc(alice, 'm0'); [alice, e1] = enc(alice, 'm1'); [alice, e2] = enc(alice, 'm2');
  console.log('B: 0 then 2 (1 lost), then alternate');
  [bob, ok] = dec(bob, e0, 'B bob<-e0'); [bob, ok] = dec(bob, e2, 'B bob<-e2');
  console.log('B alternation clean:', alternate(alice, bob, 'B'));
}
// C: bob's FIRST frame is e2 (0,1 lost), then alternate
{
  let { alice, bob } = newPair();
  let e0, e1, e2, ok;
  [alice, e0] = enc(alice, 'm0'); [alice, e1] = enc(alice, 'm1'); [alice, e2] = enc(alice, 'm2');
  console.log('C: first frame = e2 (0,1 never seen), then alternate');
  [bob, ok] = dec(bob, e2, 'C bob<-e2');
  console.log('C alternation clean:', alternate(alice, bob, 'C'));
}
// D: bob's FIRST frame is e1 (0 lost), then alternate
{
  let { alice, bob } = newPair();
  let e0, e1, ok;
  [alice, e0] = enc(alice, 'm0'); [alice, e1] = enc(alice, 'm1');
  console.log('D: first frame = e1 (0 lost), then alternate');
  [bob, ok] = dec(bob, e1, 'D bob<-e1');
  console.log('D alternation clean:', alternate(alice, bob, 'D'));
}
