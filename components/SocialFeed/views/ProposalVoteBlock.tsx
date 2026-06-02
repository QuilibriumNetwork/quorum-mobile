/**
 * ProposalVoteBlock — the reputation-weighted FOR/AGAINST tally + voting UI
 * rendered beneath a /hegemony proposal cast in the feed. Voting posts a
 * `FOR` / `AGAINST` reply cast (optionally `FOR: <reason>`) via the normal
 * Farcaster reply path; the weighted tally updates on the next refresh.
 */

import React from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { postFarcasterCast } from '@/services/farcasterClient';

function fmtPoints(n: number): string {
  return Math.floor(n).toLocaleString();
}

export function ProposalVoteBlock({
  hash,
  votesFor,
  votesAgainst,
  token,
  theme,
  onVoted,
}: {
  hash: string;
  votesFor: number;
  votesAgainst: number;
  token?: string;
  theme: AppTheme;
  onVoted?: () => void;
}) {
  const [dir, setDir] = React.useState<'for' | 'against' | null>(null);
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const total = votesFor + votesAgainst;
  const forPct = total > 0 ? (votesFor / total) * 100 : 50;

  const start = (d: 'for' | 'against') => {
    if (!token) {
      Alert.alert('Sign in', 'Connect Farcaster to vote.');
      return;
    }
    setReason('');
    setDir(d);
  };

  const submit = async () => {
    if (!dir || !token || submitting) return;
    const base = dir === 'for' ? 'FOR' : 'AGAINST';
    const trimmed = reason.trim();
    const text = trimmed ? `${base}: ${trimmed}` : base;
    setSubmitting(true);
    try {
      await postFarcasterCast({ token, text, parentHash: hash });
      setDir(null);
      setReason('');
      onVoted?.();
    } catch (e) {
      Alert.alert('Vote failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.wrap, { borderColor: theme.colors.surface3 }]}>
      <View style={styles.bar}>
        <View style={{ flex: forPct, backgroundColor: theme.colors.accent }} />
        <View style={{ flex: 100 - forPct, backgroundColor: theme.colors.warning }} />
      </View>
      <View style={styles.row}>
        <Text style={{ color: theme.colors.accent, fontSize: Skin.font(12) }}>
          FOR {fmtPoints(votesFor)} ({total > 0 ? forPct.toFixed(1) : '0.0'}%)
        </Text>
        <Text style={{ color: theme.colors.warning, fontSize: Skin.font(12) }}>
          AGAINST {fmtPoints(votesAgainst)} ({total > 0 ? (100 - forPct).toFixed(1) : '0.0'}%)
        </Text>
      </View>

      {dir ? (
        <View style={{ marginTop: Skin.space(8), gap: Skin.space(8) }}>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={`Voting ${dir === 'for' ? 'FOR' : 'AGAINST'} — add a reason (optional)`}
            placeholderTextColor={theme.colors.textMuted}
            style={[styles.input, { color: theme.colors.textMain, backgroundColor: theme.colors.surface3 }]}
            multiline
            maxLength={280}
          />
          <View style={{ flexDirection: 'row', gap: Skin.space(8) }}>
            <Pressable onPress={submit} disabled={submitting} style={[styles.btn, { backgroundColor: theme.colors.accent, opacity: submitting ? 0.6 : 1 }]}>
              {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>Post vote</Text>}
            </Pressable>
            <Pressable onPress={() => setDir(null)} style={[styles.btn, { backgroundColor: theme.colors.surface3 }]}>
              <Text style={[styles.btnText, { color: theme.colors.textMain }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: Skin.space(8), marginTop: Skin.space(8) }}>
          <Pressable onPress={() => start('for')} style={[styles.btn, { backgroundColor: theme.colors.accent }]}>
            <Text style={styles.btnText}>Vote FOR</Text>
          </Pressable>
          <Pressable onPress={() => start('against')} style={[styles.btn, { backgroundColor: theme.colors.warning }]}>
            <Text style={styles.btnText}>Vote AGAINST</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Skin.space(14),
    paddingTop: Skin.space(10),
    paddingBottom: Skin.space(14),
    marginBottom: Skin.space(6),
  },
  bar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: Skin.radius(4),
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Skin.space(4),
  },
  input: {
    minHeight: 40,
    maxHeight: 100,
    borderRadius: Skin.radius(10),
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(8),
    fontSize: Skin.font(14),
  },
  btn: {
    paddingHorizontal: Skin.space(14),
    paddingVertical: Skin.space(8),
    borderRadius: Skin.radius(20),
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: Skin.font(13),
  },
});

export default ProposalVoteBlock;
