/**
 * The shared mention parser.
 *
 * Messages carry mentions in wire format (`@<QmAbc…>`), and before this existed
 * the notification panel rendered that verbatim — a mention-only message showed
 * as a bare 46-character hash and told the reader nothing. The chat view had
 * always resolved them, but inside a component, where no other surface could
 * reach it.
 *
 * The address in the fixtures below is the one observed on device.
 */

import {
  findMentionTokens,
  mentionedAddresses,
  renderMentionsAsPlainText,
} from '../utils/mentionTokens';

const ADDR = 'QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1';
const OTHER = 'QmZzZzZzEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imAAA1';

describe('findMentionTokens', () => {
  it('finds a bracketed address and reports where it sits', () => {
    const [token] = findMentionTokens(`hey @<${ADDR}> look`);
    expect(token).toMatchObject({ kind: 'address', key: ADDR, raw: `@<${ADDR}>` });
    expect(`hey @<${ADDR}> look`.slice(token.start, token.end)).toBe(token.raw);
  });

  it('classifies @everyone separately from a name', () => {
    expect(findMentionTokens('@everyone ping').map((t) => t.kind)).toEqual(['everyone']);
    expect(findMentionTokens('@design ping').map((t) => t.kind)).toEqual(['bare']);
  });

  it('finds several mentions in one message', () => {
    const kinds = findMentionTokens(`@<${ADDR}> and @<${OTHER}> and @everyone`);
    expect(kinds.map((t) => t.kind)).toEqual(['address', 'address', 'everyone']);
  });

  it('is not left stateful between scans', () => {
    // The regex is module-level and /g. A leftover lastIndex silently skips the
    // start of the next string, so the SECOND call is the one that matters.
    const text = `@<${ADDR}>`;
    expect(findMentionTokens(text)).toHaveLength(1);
    expect(findMentionTokens(text)).toHaveLength(1);
  });

  it('finds nothing in text with no mentions', () => {
    expect(findMentionTokens('just a message')).toEqual([]);
    expect(findMentionTokens('')).toEqual([]);
  });
});

describe('renderMentionsAsPlainText', () => {
  const resolve = (a: string) => (a === ADDR ? 'Brave Light' : undefined);

  it('replaces a resolved address with the name', () => {
    expect(renderMentionsAsPlainText(`@<${ADDR}> take a look`, resolve)).toBe(
      '@Brave Light take a look',
    );
  });

  it('truncates an address it cannot resolve instead of printing the hash', () => {
    // The observed bug: the whole row was this hash and the message was pushed
    // off the end. Truncated is not great; a 46-char hash is useless.
    const out = renderMentionsAsPlainText(`@<${OTHER}> hello`, resolve);
    expect(out).not.toContain(OTHER);
    expect(out.length).toBeLessThan(30);
    expect(out).toContain('hello');
  });

  it('truncates with no resolver at all — the read-time backstop', () => {
    // This is the path old stored rows take: nothing to resolve against, but
    // the row must still be readable.
    const out = renderMentionsAsPlainText(`@<${ADDR}> hi`);
    expect(out).not.toContain(ADDR);
    expect(out).toContain('hi');
  });

  it('leaves @everyone alone', () => {
    expect(renderMentionsAsPlainText('@everyone standup', resolve)).toBe('@everyone standup');
  });

  it('leaves a role tag alone', () => {
    // A role tag is already what the sender typed and what the reader expects.
    expect(renderMentionsAsPlainText('@design please review', resolve)).toBe(
      '@design please review',
    );
  });

  it('truncates a long bare address written without brackets', () => {
    const out = renderMentionsAsPlainText(`@${ADDR} hi`, () => undefined);
    expect(out).not.toContain(ADDR);
  });

  it('resolves every mention in a message with several', () => {
    const out = renderMentionsAsPlainText(
      `@<${ADDR}> and @<${ADDR}> both`,
      resolve,
    );
    expect(out).toBe('@Brave Light and @Brave Light both');
  });

  it('keeps the surrounding text exactly, including the tail', () => {
    expect(renderMentionsAsPlainText(`start @<${ADDR}> end`, resolve)).toBe(
      'start @Brave Light end',
    );
  });

  it('returns text with no mentions completely unchanged', () => {
    // The control arm: the overwhelmingly common case must not be touched.
    const plain = 'no mentions here, just an email a@b.com and a price of 5';
    expect(renderMentionsAsPlainText(plain, resolve)).toBe(plain);
  });

  it('ignores a resolver that returns only whitespace', () => {
    const out = renderMentionsAsPlainText(`@<${ADDR}> hi`, () => '   ');
    expect(out).not.toContain('@  ');
    expect(out).not.toContain(ADDR);
  });
});

describe('mentionedAddresses', () => {
  it('lists the addresses that need resolving, deduped', () => {
    expect(mentionedAddresses(`@<${ADDR}> @<${OTHER}> @<${ADDR}> @everyone @design`)).toEqual([
      ADDR,
      OTHER,
    ]);
  });

  it('returns nothing for text with no addresses to resolve', () => {
    expect(mentionedAddresses('@everyone @design hello')).toEqual([]);
  });
});
