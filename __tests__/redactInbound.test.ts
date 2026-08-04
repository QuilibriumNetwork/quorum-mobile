/**
 * The inbound-frame redaction that guards the two receive-path logs which
 * print the frame itself. Now that `warn` reaches release builds, "it only
 * runs in dev" is no longer what keeps routing metadata off a device log.
 *
 * The load-bearing property is the default: an UNRECOGNISED field must never
 * print its value. That is what makes the rule safe against a field the
 * server starts sending next year, which nobody will come back to review.
 */
import { summarizeInbound } from '../services/observability/redactInbound';

describe('summarizeInbound', () => {
  it('keeps the rejection reason, which is the whole point of the log', () => {
    const out = summarizeInbound({ error: 'inbox write refused: quota' });
    expect(out).toContain('inbox write refused: quota');
  });

  it('truncates an inbox address to a correlatable prefix', () => {
    const address = '0xabcdef0123456789abcdef0123456789';
    const out = summarizeInbound({ inboxAddress: address });
    expect(out).toContain(address.slice(0, 12));
    expect(out).not.toContain(address);
  });

  it('does not let a STRUCTURED value ride in on an allowlisted key name', () => {
    // The allowlist grants a field NAME, not everything nested beneath it.
    // A server answering `error: {...}` must not serialise the inside.
    const out = summarizeInbound({
      error: { code: 500, inbox: '0xabcdef0123456789abcdef0123456789', detail: 'secret-detail' },
    });
    expect(out).not.toContain('0xabcdef0123456789abcdef0123456789');
    expect(out).not.toContain('secret-detail');
    expect(out).toContain('error');
  });

  it('never prints the value of a field it does not recognise', () => {
    const out = summarizeInbound({
      encryptedContent: 'BASE64CIPHERTEXTTHATMUSTNOTAPPEAR',
      somethingNew: 'a-value-nobody-reviewed',
    });
    expect(out).not.toContain('BASE64CIPHERTEXTTHATMUSTNOTAPPEAR');
    expect(out).not.toContain('a-value-nobody-reviewed');
  });

  it('still reports the shape, so an unknown frame is identifiable', () => {
    const out = summarizeInbound({ ack: 'yes', seq: 7, items: [1, 2, 3] });
    // Key names and types survive; only unreviewed values are withheld.
    expect(out).toContain('ack');
    expect(out).toContain('<string:3>');
    expect(out).toContain('items');
    expect(out).toContain('<array:3>');
    // `seq` is on the verbatim list — a counter carries nothing personal.
    expect(out).toContain('7');
  });

  it('caps total length so one frame cannot flood the log', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`field${i}`] = `value${i}`;
    expect(summarizeInbound(wide).length).toBeLessThanOrEqual(401);
  });

  it('survives a non-object frame without throwing', () => {
    expect(() => summarizeInbound(null)).not.toThrow();
    expect(() => summarizeInbound('plain string')).not.toThrow();
    expect(() => summarizeInbound(undefined)).not.toThrow();
  });
});
