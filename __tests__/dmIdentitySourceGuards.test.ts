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
 * Task 8's audit found three sendEncryptedMessageToAllDevices callers that
 * fire without a fresh, ledger-gated deliberate act by the local user:
 *  - CallContext's sendSignal — one transport shared by the offer AND by
 *    automatic ICE candidates / hangup-on-connection-failure / renegotiate.
 *  - WebSocketContext's DM receipt ack — a debounced ReceiptService flush.
 *  - useDeleteConversationSignal — reachable on a conversation that holds
 *    only INBOUND messages (a stranger who messaged us, never replied to),
 *    so it can be the very first frame we ever send them, before any
 *    onDeliberateDmSend reveal.
 * Attaching identity on any of these re-opens the harvest-by-messaging hole:
 * a spammer messages us, our client acts on its own (acks, or we delete the
 * conversation to get rid of it), and that automatic frame carries our name
 * and avatar to someone who never earned them. Pinned here so a future edit
 * cannot silently reattach displayName/userIcon to one of these call sites.
 */
it('automatic DM control frames never pass a displayName to sendEncryptedMessageToAllDevices', () => {
  const files = [
    'context/CallContext.tsx',
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
