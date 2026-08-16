/**
 * QnsExplainPanel — paste an address, find out why it does or does not show a `.q`.
 *
 * ## Why a panel and not more reading
 *
 * "No `.q`" has at least four causes that look identical on screen: nobody
 * claimed a name, a claim was refused, the overlay declined to fake one, or
 * nothing ever fetched the profile that would carry it. Two sessions have gone
 * into arguing about which was happening from screenshots. This answers it.
 *
 * ## The one thing only a panel can see
 *
 * Whether the APP fetched the profile. `explainQnsClaim` distinguishes
 * `undefined` (never fetched) from `null` (fetched, none exists), and that
 * distinction is the difference between "our surface forgot to `enrich`" and
 * "they genuinely have nothing". It is read from the React Query cache rather
 * than by fetching, because fetching would destroy the very state being
 * measured — so "Read cache" and "Fetch now" are deliberately separate buttons.
 *
 * Dev builds only, same gate as the sibling panels.
 */

import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { DevButton, DevButtonRow, DevPanel, DevReadout, DevRow } from '@/components/dev/DevPanel';
import { publicProfileQueryKey, type PublicProfile } from '@/hooks/useUserPublicProfile';
import { getQuorumClient } from '@/services/api/quorumClient';
import { resolveBatch } from '@/services/api/qnsClient';
import { claimedNameBelongsTo } from '@/utils/verifyQnsClaim';
import { deriveAddress } from '@/utils/deriveAddress';
import { getAllSpaces } from '@/services/config/spaceStorage';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { deriveFakeQName, getFakeQnsState } from '@/services/dev/fakeQns';
import { explainQnsClaim, type QnsExplanation } from '@/services/dev/explainQnsName';

/**
 * What the overlay WOULD synthesize for this address, mirroring `applyFakeQns`'
 * own precedence. Read rather than inferred, so a synthesized name is never
 * mistaken for a real one.
 */
function overlayNameFor(address: string): string | undefined {
  const state = getFakeQnsState();
  if (!state.enabled || state.allProfilesPrivate) return undefined;
  const entry = state.entries[address.toLowerCase()];
  if (entry?.private) return undefined;
  if (entry?.primaryUsername) return entry.primaryUsername;
  if (entry) return undefined;
  return state.giveEveryoneAName ? deriveFakeQName(address) : undefined;
}

/**
 * The broadcast claim this address carries, on any roster row OR on the DM
 * conversation row.
 *
 * `undefined` when nothing carried the field at all — distinct from `''`,
 * which is an un-election. A present-and-empty claim anywhere wins, matching
 * how the app settles a member whose sources disagree.
 *
 * **The conversation row is not optional here.** The same broadcast lands in
 * two different places: a space member row for a space, the conversation row
 * for a DM (`WebSocketContext`'s `dm-update-profile` handler). A panel that
 * scanned only rosters would report "no claim" for every DM-only partner —
 * i.e. it would say the feature is broken precisely in the case it was built
 * for, which is worse than having no panel. Mirrors `broadcastClaimsFor`'s
 * scan order: spaces first, then the conversation.
 */
async function broadcastClaimFor(address: string): Promise<string | undefined> {
  let found: string | undefined;
  for (const space of getAllSpaces()) {
    let members: { address?: string; claimed_primary_username?: string | null }[] = [];
    try {
      members = (await getMMKVAdapter().getSpaceMembers(space.spaceId)) as typeof members;
    } catch {
      continue; // a roster we cannot read tells us nothing; it is not an answer
    }
    const row = members.find((m) => m?.address === address);
    const raw = row?.claimed_primary_username;
    if (raw === undefined || raw === null) continue;
    const trimmed = raw.trim();
    if (!trimmed) return ''; // un-election ends the scan
    if (found === undefined) found = trimmed;
  }

  try {
    const { conversations } = await getMMKVAdapter().getConversations({ type: 'direct' });
    const row = (
      conversations as unknown as { address?: string; claimed_primary_username?: string | null }[]
    ).find((c) => c?.address === address);
    const raw = row?.claimed_primary_username;
    if (raw !== undefined && raw !== null) {
      const trimmed = raw.trim();
      if (!trimmed) return '';
      if (found === undefined) found = trimmed;
    }
  } catch {
    // Same rule as an unreadable roster: it tells us nothing, it is not an answer.
  }

  return found;
}

export function QnsExplainPanel() {
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QnsExplanation | null>(null);
  const [crossCheck, setCrossCheck] = useState<string>('');

  const run = useCallback(
    async (fetchProfile: boolean) => {
      const addr = address.trim();
      if (!addr) return;
      setBusy(true);
      setResult(null);
      setCrossCheck('');
      try {
        // `undefined` from the cache is the load-bearing case — it means the app
        // never asked. Only overwrite it when explicitly told to fetch.
        let profile = queryClient.getQueryData<PublicProfile | null>(
          publicProfileQueryKey(addr),
        );
        if (fetchProfile) {
          profile = await getQuorumClient().getPublicProfile(addr);
        }

        const broadcastClaim = await broadcastClaimFor(addr);
        const overlaySynthesizes = overlayNameFor(addr);

        const claim =
          broadcastClaim !== undefined
            ? broadcastClaim.trim()
            : (profile?.primary_username ?? '').trim();

        let record: { resolveKey?: string | null } | null | undefined;
        let derived: string | null = null;
        // Skip the lookup for a name the overlay invented: it is registered
        // nowhere, so the request is a guaranteed miss and its "not found"
        // would read as a finding rather than as the tautology it is.
        if (claim && claim !== overlaySynthesizes) {
          try {
            record = (await resolveBatch([claim]))[0] ?? null;
          } catch {
            record = null;
          }
          const key = record?.resolveKey;
          if (key) {
            try {
              derived = deriveAddress(key);
            } catch {
              derived = null;
            }
          }
          // The control arm: the REAL predicate, beside this module's
          // independent reasoning. They should agree; if they ever do not,
          // that disagreement outranks either answer on its own.
          setCrossCheck(
            `claimedNameBelongsTo → ${claimedNameBelongsTo(
              record as Parameters<typeof claimedNameBelongsTo>[0],
              addr,
            )}`,
          );
        }

        setResult(
          explainQnsClaim({
            address: addr,
            profile,
            broadcastClaim,
            record,
            derivedAddress: derived,
            overlaySynthesizes,
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [address, queryClient],
  );

  const styles = StyleSheet.create({
    input: {
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(8),
      fontSize: Skin.font(12),
    },
    verdict: {
      color: theme.colors.textMain,
      fontSize: Skin.font(14),
      fontWeight: '700',
      marginBottom: Skin.space(4),
    },
    fact: { color: theme.colors.textSubtle, fontSize: Skin.font(11), lineHeight: Skin.font(15) },
    summary: { marginBottom: Skin.space(8) },
  });

  return (
    // No "(dev builds only)" in the title — `DevPanel` appends it itself (see
    // its `title` prop docstring). Passing it here rendered the suffix twice.
    <DevPanel title="Why no .q?">
      <DevRow
        label="Explain an address"
        hint="Paste a full Qm… address (copy it from a profile). Read cache answers what the APP currently knows — including whether it ever fetched at all, which Fetch now would destroy."
      />
      <TextInput
        value={address}
        onChangeText={setAddress}
        placeholder="Qm…"
        placeholderTextColor={theme.colors.textSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <DevButtonRow>
        <DevButton label={busy ? '…' : 'Read cache'} onPress={() => void run(false)} disabled={busy} />
        <DevButton label={busy ? '…' : 'Fetch now'} onPress={() => void run(true)} disabled={busy} />
      </DevButtonRow>

      {result && (
        <DevReadout>
          <View>
            <Text style={styles.verdict}>{result.verdict.toUpperCase()}</Text>
            <Text style={[styles.fact, styles.summary]}>{result.summary}</Text>
            {result.facts.map((f) => (
              <Text key={f.label} style={styles.fact}>
                {f.label}: {f.value}
              </Text>
            ))}
            {!!crossCheck && <Text style={styles.fact}>{crossCheck}</Text>}
          </View>
        </DevReadout>
      )}
    </DevPanel>
  );
}
