/**
 * The QNS explainer's verdicts.
 *
 * Worth testing despite being dev-only for the same reason `fakeQns.test.ts`
 * is: this is an INSTRUMENT, and everything an operator concludes about why a
 * `.q` is missing will be downstream of it. An explainer that quietly says
 * "no claim" when the truth is "never fetched" sends someone hunting a bug in
 * the render path that does not exist — which is exactly the two sessions this
 * module was written to stop repeating.
 *
 * The distinctions it must not blur:
 *
 *   not-fetched      the surface never asked        → OUR gap
 *   no-claim         they claim nothing             → nothing to do
 *   synthesized      the overlay invented it        → says nothing about prod
 *   wrong-owner      claimed, refused               → the feature WORKING
 *
 * On screen all four are identical: no `.q`.
 */

import { explainQnsClaim, type QnsExplainInput } from '../services/dev/explainQnsName';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const OTHER = 'QmThemThemThemThemThemThemThemThemThemThemTh';

const base: QnsExplainInput = {
  address: ADDR,
  profile: null,
  broadcastClaim: undefined,
  record: undefined,
  derivedAddress: null,
  overlaySynthesizes: undefined,
};

const explain = (over: Partial<QnsExplainInput> = {}) =>
  explainQnsClaim({ ...base, ...over });

describe('explainQnsClaim — the four ways to render no .q', () => {
  it('separates "never fetched" from "claims nothing"', () => {
    // `undefined` profile means no fetch happened; `null` means the server has
    // none. Collapsing them is what makes a missing `enrich` look like a user
    // who simply has no name.
    expect(explain({ profile: undefined }).verdict).toBe('not-fetched');
    expect(explain({ profile: null }).verdict).toBe('no-claim');
  });

  it('reports a refused claim as wrong-owner, not as absence', () => {
    const r = explain({
      profile: { primary_username: 'alice' },
      record: { resolveKey: '0xabc' },
      derivedAddress: OTHER,
    });
    expect(r.verdict).toBe('wrong-owner');
    expect(r.claim).toBe('alice');
  });

  it('reports a verified claim', () => {
    expect(
      explain({
        profile: { primary_username: 'alice' },
        record: { resolveKey: '0xabc' },
        derivedAddress: ADDR,
      }).verdict,
    ).toBe('verified');
  });

  it('marks an overlay-invented name as synthesized, never as verified', () => {
    // The trap: the dev exemption makes this render a `.q`, so an explainer
    // that only looked at what rendered would call it verified and imply
    // something about production. Nothing is registered behind it.
    const r = explain({
      profile: { primary_username: 'qapeer' },
      overlaySynthesizes: 'qapeer',
    });
    expect(r.verdict).toBe('synthesized');
  });

  it('flags the overlay declining to fake for one address', () => {
    // The case the operator actually hit: "give everyone a .q" is on, every
    // other member got one, and this one address did not. That is an
    // instrument state, and it must not read as a product bug.
    const r = explain({ profile: null, overlaySynthesizes: 'qapeer' });
    expect(r.verdict).toBe('overlay-declined');
    expect(r.summary).toContain('INSTRUMENT');
  });
});

describe('explainQnsClaim — which claim gets judged', () => {
  it('prefers a present broadcast claim over the profile', () => {
    expect(
      explain({
        profile: { primary_username: 'from-profile' },
        broadcastClaim: 'from-broadcast',
      }).claim,
    ).toBe('from-broadcast');
  });

  it('treats an EMPTY broadcast claim as an un-election that beats the profile', () => {
    // Presence, not truthiness. An empty broadcast is how a user drops their
    // primary name; preferring the profile would keep rendering a name its
    // owner has abandoned.
    const r = explain({
      profile: { primary_username: 'stale' },
      broadcastClaim: '',
    });
    expect(r.claim).toBe('');
    expect(r.verdict).toBe('no-claim');
  });

  it('falls back to the profile when the broadcast field is ABSENT', () => {
    expect(
      explain({ profile: { primary_username: 'from-profile' }, broadcastClaim: undefined }).claim,
    ).toBe('from-profile');
  });
});

describe('explainQnsClaim — fails closed on every unknown', () => {
  it.each([
    ['not looked up yet', { record: undefined }],
    ['name does not resolve', { record: null }],
    ['record carries no resolveKey', { record: {} }],
    ['resolveKey did not derive', { record: { resolveKey: '0xabc' }, derivedAddress: null }],
  ])('%s → unresolvable, never verified', (_label, over) => {
    const r = explain({ profile: { primary_username: 'alice' }, ...(over as Partial<QnsExplainInput>) });
    expect(r.verdict).toBe('unresolvable');
  });
});

describe('explainQnsClaim — the facts list', () => {
  it('always reports every input, so the verdict can be checked rather than trusted', () => {
    const labels = explain().facts.map((f) => f.label);
    expect(labels).toEqual([
      'address',
      'profile fetched',
      'profile.primary_username',
      'roster claimed_primary_username',
      'claim under test',
      'overlay would synthesize',
      'resolver record',
      'record.resolveKey',
      'derived address',
    ]);
  });

  it('distinguishes absent from empty in the readout', () => {
    // `—` vs `'' (empty)` is the whole un-election story; a reader who cannot
    // tell them apart cannot debug it.
    const facts = explain({ broadcastClaim: '' }).facts;
    const row = facts.find((f) => f.label === 'roster claimed_primary_username');
    expect(row?.value).toBe("'' (empty)");
    const absent = explain({ broadcastClaim: undefined }).facts.find(
      (f) => f.label === 'roster claimed_primary_username',
    );
    expect(absent?.value).toBe('—');
  });
});
