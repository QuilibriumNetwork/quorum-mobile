/**
 * explainQnsName — why does (or doesn't) this address render a `.q`?
 *
 * ## Why this exists
 *
 * On screen, these three are indistinguishable — all of them are simply "no
 * `.q`" — and they mean opposite things:
 *
 *   1. Nobody claimed a name for this address.
 *   2. A name was claimed and verification REFUSED it (the feature working).
 *   3. A name would have resolved, but nothing ever fetched the profile that
 *      carries it (the feature not reaching this surface).
 *
 * Two separate sessions have been spent arguing about which of those was
 * happening, on the strength of screenshots. That is the gap this closes: it
 * turns the question into a readout.
 *
 * ## It deliberately does NOT reuse the code under test
 *
 * The presence rule below duplicates `claimIn`, and the ownership comparison
 * duplicates `claimedNameBelongsTo`, rather than importing them. That is the
 * point: a diagnostic built out of the thing it is diagnosing cannot falsify
 * it — if `claimIn` picks the wrong field, a diagnostic calling `claimIn` will
 * confidently report the wrong field as correct.
 *
 * The panel shows BOTH this module's independent verdict and the real
 * `claimedNameBelongsTo` answer. Agreement is the expected case; disagreement
 * is itself a finding, and a much louder one than either number alone.
 *
 * Dev-only. Nothing here may be imported from a production path.
 */

export type QnsExplainVerdict =
  /** No public profile has been requested for this address at all. */
  | 'not-fetched'
  /** A profile exists (or a roster row does) and neither carries a claim. */
  | 'no-claim'
  /** The claim is one the dev overlay synthesized — nothing real behind it. */
  | 'synthesized'
  /** The overlay is on and would have synthesized a name, but the profile came
   *  back without one, so `applyFakeQns` bailed for this address. */
  | 'overlay-declined'
  /** A real claim, but the name does not resolve or exposes no `resolveKey`. */
  | 'unresolvable'
  /** A real claim that resolves to a DIFFERENT address. Impersonation, or a
   *  name that has since been transferred away. */
  | 'wrong-owner'
  /** A real claim that resolves back to this address. Renders as `.q`. */
  | 'verified';

export interface QnsExplainInput {
  address: string;
  /**
   * What `getPublicProfile` returned — with the dev overlay already applied,
   * because that is the only form any caller can observe.
   *
   * `undefined` means NO FETCH HAS HAPPENED, which is a different answer from
   * `null` (the server has no profile for them). Collapsing the two is what
   * makes "the surface never asked" look like "they have nothing".
   */
  profile: { primary_username?: string | null } | null | undefined;
  /**
   * `claimed_primary_username` as stored on a roster row, if any space carried
   * the field. `undefined` = absent everywhere; `''` = an un-election arrived.
   */
  broadcastClaim: string | undefined;
  /** The resolver's record for the claimed name. `undefined` = not looked up. */
  record: { resolveKey?: string | null } | null | undefined;
  /** Address derived from `record.resolveKey`, or `null` if that was not possible. */
  derivedAddress: string | null;
  /** What the dev overlay would synthesize for this address, if it is enabled. */
  overlaySynthesizes: string | undefined;
}

export interface QnsExplanation {
  verdict: QnsExplainVerdict;
  /** The claim that was actually judged, for display. */
  claim: string;
  /** One line, written for someone staring at a screen wondering why. */
  summary: string;
  /** Every input that fed the verdict, so the reader can check the reasoning
   *  instead of trusting it. This is the half that makes it an instrument. */
  facts: { label: string; value: string }[];
}

const show = (v: string | null | undefined): string =>
  v === undefined ? '—' : v === null ? 'null' : v === '' ? "'' (empty)" : v;

/**
 * The claim a row is making, by the same PRESENCE rule the app uses.
 *
 * Duplicated from `claimIn` on purpose — see the header. An empty broadcast is
 * an un-election and must beat a profile still carrying the old name, so the
 * test is `!== undefined`, never truthiness.
 */
function claimUnderTest(input: QnsExplainInput): string {
  if (input.broadcastClaim !== undefined) return input.broadcastClaim.trim();
  return (input.profile?.primary_username ?? '').trim();
}

export function explainQnsClaim(input: QnsExplainInput): QnsExplanation {
  const claim = claimUnderTest(input);
  const facts: { label: string; value: string }[] = [
    { label: 'address', value: input.address },
    { label: 'profile fetched', value: input.profile === undefined ? 'NO' : 'yes' },
    { label: 'profile.primary_username', value: show(input.profile?.primary_username) },
    { label: 'roster claimed_primary_username', value: show(input.broadcastClaim) },
    { label: 'claim under test', value: show(claim || undefined) },
    { label: 'overlay would synthesize', value: show(input.overlaySynthesizes) },
    { label: 'resolver record', value: input.record === undefined ? '—' : input.record === null ? 'not found' : 'found' },
    { label: 'record.resolveKey', value: show(input.record?.resolveKey) },
    { label: 'derived address', value: show(input.derivedAddress) },
  ];

  const done = (verdict: QnsExplainVerdict, summary: string): QnsExplanation => ({
    verdict,
    claim,
    summary,
    facts,
  });

  if (!claim) {
    if (input.profile === undefined) {
      return done(
        'not-fetched',
        'Nothing has fetched this address\'s public profile, so no claim could be seen. ' +
          'A surface must opt in with `enrich` (and stay inside MAX_QNS_LOOKUPS) for a `.q` to be possible here.',
      );
    }
    if (input.overlaySynthesizes) {
      return done(
        'overlay-declined',
        `The dev overlay is on and would have synthesized "${input.overlaySynthesizes}", but the profile came back without a claim. ` +
          'applyFakeQns bails when an explicit per-address entry exists with no name on it, or when the profile is forced private. ' +
          'This is an INSTRUMENT state, not a product bug.',
      );
    }
    return done('no-claim', 'Nobody is claiming a QNS name for this address. Correctly renders no `.q`.');
  }

  if (input.overlaySynthesizes && claim === input.overlaySynthesizes) {
    return done(
      'synthesized',
      `"${claim}" was invented by the dev overlay. It is registered nowhere and only renders because the ` +
        'dev exemption lets it bypass the real check. Says nothing about production.',
    );
  }

  if (input.record === undefined) {
    return done(
      'unresolvable',
      `"${claim}" is claimed but has not been looked up yet. Until it resolves it stays unverified, which renders no \`.q\` — that is deliberate.`,
    );
  }
  if (input.record === null || !input.record.resolveKey) {
    return done(
      'unresolvable',
      `"${claim}" does not resolve, or exposes no resolveKey, so ownership cannot be checked at all. Fails closed: no \`.q\`.`,
    );
  }
  if (!input.derivedAddress) {
    return done(
      'unresolvable',
      `"${claim}" has a resolveKey that could not be turned into an address. Fails closed: no \`.q\`.`,
    );
  }
  if (input.derivedAddress !== input.address) {
    return done(
      'wrong-owner',
      `"${claim}" resolves to a DIFFERENT address than the one claiming it. Either an impersonation attempt, ` +
        'or a name that has since been transferred. Refusing it is the whole point of the feature.',
    );
  }

  return done('verified', `"${claim}" resolves back to this exact address. Renders as ${claim}.q.`);
}
