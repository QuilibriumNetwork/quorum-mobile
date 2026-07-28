// SLICE 1 SPIKE — offline, no relay, no account.
//
// Proves the single most uncertain thing about running mobile's client code
// headlessly: that the Rust channel crate's WASM binding loads and produces real
// keys inside THIS repo's toolchain. Everything else in the harness is ordinary
// wiring; if this fails, the approach needs a different runner and the whole
// slice plan changes.
//
// Deliberately offline so it is safe to run anywhere, any time, with no keys and
// no network. Run: yarn harness:smoke
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { channel_raw } from '@quilibrium/quilibrium-js-sdk-channels';

const WASM = resolve(
  __dirname,
  '../../../quorum-desktop/node_modules/@quilibrium/quilibrium-js-sdk-channels/src/wasm/channelwasm_bg.wasm'
);

describe('harness smoke (offline)', () => {
  it('loads the channel WASM and generates real ed448 + x448 keypairs', () => {
    // channel_raw and the high-level `channel` API share one wasm var, so this
    // initialises both.
    channel_raw.initSync(readFileSync(WASM));

    const ed = JSON.parse(channel_raw.js_generate_ed448());
    const x = JSON.parse(channel_raw.js_generate_x448());

    // Assert real key sizes rather than "is an array" — a stub returning []
    // would pass the loose version.
    //
    // Lengths MEASURED against the running crate, not taken from the curve
    // specs — note x448 is asymmetric here (57-byte public, 56-byte private),
    // which is not what the raw spec would suggest. Two earlier drafts of this
    // test guessed and failed. If these ever change, measure again rather than
    // reasoning about what they ought to be.
    expect(ed.public_key).toHaveLength(57);
    expect(ed.private_key).toHaveLength(57);
    expect(x.public_key).toHaveLength(57);
    expect(x.private_key).toHaveLength(56);

    // Two calls must not return the same key — catches a wasm that loaded but
    // is returning a constant.
    const ed2 = JSON.parse(channel_raw.js_generate_ed448());
    expect(ed2.public_key).not.toEqual(ed.public_key);
  });

  it('signs and verifies with the generated key (the crate is really executing)', () => {
    const ed = JSON.parse(channel_raw.js_generate_ed448());
    const priv = Buffer.from(new Uint8Array(ed.private_key)).toString('base64');
    const pub = Buffer.from(new Uint8Array(ed.public_key)).toString('base64');
    const msg = Buffer.from('harness slice 1').toString('base64');

    const sig = JSON.parse(channel_raw.js_sign_ed448(priv, msg)) as string;
    expect(channel_raw.js_verify_ed448(pub, msg, sig)).toBe('true');

    // A tampered message must fail — proves verification is real, not a stub
    // returning 'true' unconditionally.
    const other = Buffer.from('harness slice 1!').toString('base64');
    expect(channel_raw.js_verify_ed448(pub, other, sig)).not.toBe('true');
  });
});
