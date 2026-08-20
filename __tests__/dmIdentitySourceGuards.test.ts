/**
 * An address prefix is not a name. Stamping `senderAddress.substring(0, 8)`
 * into the row's displayName poisons the ladder's locallyKnownNames tier
 * (identity/identityFromMaps.ts reads conversation rows as a NAME source),
 * which then blocks the honest truncated-address fallback AND wins over a
 * real name arriving later only in surfaces that read the row raw.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'context', 'WebSocketContext.tsx'),
  'utf8',
);

it('no DM row write uses an address slice as a display name', () => {
  expect(src).not.toMatch(/senderAddress\.substring\(0,\s*8\)/);
  expect(src).not.toMatch(/resolvedSenderAddress\.substring\(0,\s*8\)/);
});

it('every init envelope that attaches a name also attaches the icon (or neither)', () => {
  const files = [
    'hooks/chat/useSendDirectMessage.ts',
    'hooks/chat/useSendDirectEmbedMessage.ts',
  ].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  for (const src of files) {
    const envelopes = src.split('initEnvelope: InitializationEnvelope').slice(1);
    for (const chunk of envelopes) {
      const head = chunk.slice(0, 600);
      if (/display_name/.test(head)) {
        expect(head).toMatch(/user_icon/);
      }
    }
  }
});

/**
 * An address stored in a NAME or ICON slot poisons identityFromMaps.ts's
 * locallyKnownNames tier exactly like the substring(0, 8) case above (see
 * the header comment): it enters as if it were real data, which then blocks
 * both the honest truncated-address fallback and any real name arriving
 * later. All six init-envelope sites below used to write
 * `display_name: displayName || userAddress`; they were changed to the
 * conditional spread `...(displayName ? { display_name: displayName } : {})`
 * seen throughout this file today, which omits the field entirely rather
 * than ever writing an address into it.
 *
 * The regex keys on "display_name/user_icon immediately followed by a `||`
 * fallback whose right-hand side contains the word address" - not on a
 * specific variable name and not on the conditional-spread syntax itself -
 * so a harmless rename (e.g. `displayName` -> `senderDisplayName`) does not
 * trip it, but reintroducing an `||` fallback to any *Address-named variable
 * does, regardless of exactly how it's spelled.
 */
it('no init envelope falls back to the address for display_name or user_icon', () => {
  const files = [
    'hooks/chat/useSendDirectMessage.ts',
    'hooks/chat/useSendDirectEmbedMessage.ts',
  ].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  const addressFallbackPattern = /(display_name|user_icon)\s*:\s*[^,\n]*\|\|\s*[^,\n]*[Aa]ddress/;
  for (const src of files) {
    const envelopes = src.split('initEnvelope: InitializationEnvelope').slice(1);
    // A renamed/removed field or a collapsed envelope count would make this
    // loop find zero chunks and pass vacuously - assert it still found the
    // six sites it exists to guard (same shape as the sibling test above).
    expect(envelopes.length).toBeGreaterThan(0);
    for (const chunk of envelopes) {
      const head = chunk.slice(0, 600);
      expect(head).not.toMatch(addressFallbackPattern);
    }
  }
});

/**
 * Task 8's audit found sendEncryptedMessageToAllDevices callers that fire
 * without a fresh, ledger-gated deliberate act by the local user:
 *  - WebSocketContext's DM receipt ack — a debounced ReceiptService flush.
 *  - useDeleteConversationSignal — reachable on a conversation that holds
 *    only INBOUND messages (a stranger who messaged us, never replied to),
 *    so it can be the very first frame we ever send them, before any
 *    onDeliberateDmSend reveal.
 * Attaching identity on either of these re-opens the harvest-by-messaging
 * hole: a spammer messages us, our client acts on its own (acks, or we
 * delete the conversation to get rid of it), and that automatic frame
 * carries our name and avatar to someone who never earned them. Pinned here
 * so a future edit cannot silently reattach displayName/userIcon to one of
 * these call sites.
 *
 * CallContext.tsx is NOT in this list — see the dedicated call-signal test
 * below. Its sendEncryptedMessageToAllDevices call legitimately references
 * `displayName` in source (as `identity?.displayName`) because two of its
 * eight callers now opt in deliberately; a plain "never contains the
 * substring displayName" check would either false-positive on that or (if
 * loosened) go blind to a regression. The call-signal test checks the
 * CALLERS of sendSignal instead, which is where deliberate-vs-automatic is
 * actually decided.
 */
it('automatic DM control frames never pass a displayName to sendEncryptedMessageToAllDevices', () => {
  const files = [
    'context/WebSocketContext.tsx',
    'hooks/chat/useDeleteConversationSignal.ts',
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const calls = [...text.matchAll(/sendEncryptedMessageToAllDevices\(([\s\S]*?)\);/g)];
    // A renamed/removed call would make this loop a silent no-op — assert it
    // still found the call site(s) it exists to guard.
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) {
      expect(args).not.toMatch(/displayName/);
    }
  }
});

/**
 * The product model: a call offer is the analogue of a first DM (the
 * sender's identity rides it), and answering is the analogue of replying
 * (the answer reveals identity back). Every OTHER call-signal frame — ICE
 * candidates, hangup, the call-event log, circuit-rotation renegotiation —
 * fires on paths that can run with no fresh human act behind them (WebRTC's
 * own schedule, a dropped connection, a periodic rotation timer) and must
 * stay silent, exactly like the automatic DM frames pinned above.
 *
 * `sendSignal` is one shared transport for all eight call sites, so the
 * invariant that actually matters lives at the CALL sites, not inside the
 * transport: exactly two calls to `sendSignal(...)` (the offer, the answer)
 * may pass a 4th `identity` argument; the other five `sendSignal(...)`
 * calls, plus the one indirect call through `sendSignalRef.current`
 * (circuit rotation), must not.
 */
it('call-signal sites: only the offer and the answer opt in to identity', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'context', 'CallContext.tsx'), 'utf8');

  // `sendSignal(` never matches inside `sendSignalRef...` (the very next
  // character there is `R`, not `(`) or inside the `sendSignalRef.current =
  // sendSignal;` assignment (next character is `;`) — so this pattern finds
  // exactly the direct calls, no lookbehind needed.
  const directCalls = [...text.matchAll(/sendSignal\(([\s\S]*?)\);/g)].map((m) => m[1]);
  const refCalls = [...text.matchAll(/sendSignalRef\.current\?\.\(([\s\S]*?)\);/g)].map((m) => m[1]);

  // A renamed function, or every call site collapsing into one, would make
  // every assertion below vacuous — pin the shape this test assumes.
  expect(directCalls.length).toBe(7);
  expect(refCalls.length).toBe(1);

  const withIdentity = directCalls.filter((args) => /displayName/.test(args));
  const withoutIdentity = directCalls.filter((args) => !/displayName/.test(args));
  expect(withIdentity.length).toBe(2); // offer, answer
  expect(withoutIdentity.length).toBe(5); // 2x ICE candidate, hangup, event, renegotiate-answer

  for (const args of refCalls) {
    expect(args).not.toMatch(/displayName/);
  }
});
