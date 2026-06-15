/**
 * HegemonyGovernanceView — renders the /hegemony governance feed: proposals
 * (cast text starting with `PROPOSAL:`) with reputation-weighted FOR/AGAINST
 * tallies and expandable vote threads, plus in-app voting (posts a `FOR` /
 * `AGAINST` reply cast, optionally with a reason).
 *
 * Data comes pre-parsed from the hypersnap portal API (see
 * services/governance/governanceClient.ts). Voting reuses the Farcaster reply
 * path; the weighted tally updates on the backend's next refresh (~60s).
 */

import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { postFarcasterCast } from '@/services/farcasterClient';
import { useHegemonyGovernance } from '@/hooks/useHegemonyGovernance';
import {
  getTier,
  parseVote,
  type ChannelCast,
  type CastReply,
} from '@/services/governance/governanceClient';

function fmtPoints(n: number): string {
  return Math.floor(n).toLocaleString();
}

/** Recursive reply/vote thread. */
function ReplyThread({
  replies,
  theme,
  depth,
}: {
  replies: CastReply[];
  theme: AppTheme;
  depth: number;
}) {
  return (
    <View style={{ paddingLeft: depth > 0 ? Skin.space(12) : 0, gap: Skin.space(6) }}>
      {replies.map((r, i) => {
        const dir = parseVote(r.text);
        const borderColor =
          dir === 'for' ? theme.colors.accent : dir === 'against' ? theme.colors.warning : theme.colors.surface3;
        return (
          <View key={`${r.authorFid}-${i}`}>
            <View
              style={{
                borderLeftWidth: 2,
                borderLeftColor: borderColor,
                paddingLeft: Skin.space(8),
                paddingVertical: Skin.space(4),
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(6), flexWrap: 'wrap' }}>
                {!!r.authorPfpUrl && (
                  <CachedAvatar
                    source={{ uri: r.authorPfpUrl }}
                    style={{ width: 16, height: 16, borderRadius: Skin.radius(8), backgroundColor: theme.colors.surface3 }}
                  />
                )}
                <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(12), fontWeight: '600' }}>
                  {r.authorDisplayName || r.authorUsername}
                </Text>
                {dir === 'for' && (
                  <Text style={[styles.voteBadge, { color: theme.colors.accent, borderColor: theme.colors.accent }]}>
                    FOR — {fmtPoints(r.points)} pts
                  </Text>
                )}
                {dir === 'against' && (
                  <Text style={[styles.voteBadge, { color: theme.colors.warning, borderColor: theme.colors.warning }]}>
                    AGAINST — {fmtPoints(r.points)} pts
                  </Text>
                )}
                {r.points > 0 && (
                  <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(11) }}>{getTier(r.points)}</Text>
                )}
              </View>
              <Text style={{ color: theme.colors.textSubtle, fontSize: Skin.font(12), marginTop: Skin.space(2) }}>
                {r.text}
              </Text>
            </View>
            {r.replies?.length > 0 && <ReplyThread replies={r.replies} theme={theme} depth={depth + 1} />}
          </View>
        );
      })}
    </View>
  );
}

export function HegemonyGovernanceView({ theme, token }: { theme: AppTheme; token?: string }) {
  const { casts, isLoading, error, refetch, isRefetching } = useHegemonyGovernance();
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [voteTarget, setVoteTarget] = React.useState<{ hash: string; dir: 'for' | 'against' } | null>(null);
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const toggleExpanded = (hash: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(hash) ? next.delete(hash) : next.add(hash);
      return next;
    });

  const startVote = (hash: string, dir: 'for' | 'against') => {
    setReason('');
    setVoteTarget({ hash, dir });
  };

  const submitVote = async () => {
    if (!voteTarget || !token || submitting) return;
    const base = voteTarget.dir === 'for' ? 'FOR' : 'AGAINST';
    const trimmed = reason.trim();
    const text = trimmed ? `${base}: ${trimmed}` : base;
    setSubmitting(true);
    try {
      await postFarcasterCast({ token, text, parentHash: voteTarget.hash });
      setVoteTarget(null);
      setReason('');
      Alert.alert('Vote posted', 'Your vote is in. Weighted tallies update on the next refresh.');
      refetch();
    } catch (e) {
      Alert.alert('Vote failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const s = styles;

  if (isLoading) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={s.center}>
        <Text style={{ color: theme.colors.textMuted, textAlign: 'center' }}>Couldn’t load governance.</Text>
        <Pressable onPress={() => refetch()} hitSlop={8} style={{ marginTop: Skin.space(12) }}>
          <Text style={{ color: theme.colors.accent }}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (casts.length === 0) {
    return (
      <View style={s.center}>
        <Text style={{ color: theme.colors.textMuted }}>No proposals yet.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: Skin.space(12), gap: Skin.space(12), paddingBottom: Skin.space(32) }}
      refreshControl={undefined}
    >
      {casts.map((c: ChannelCast) => {
        const total = c.votesFor + c.votesAgainst;
        const forPct = total > 0 ? (c.votesFor / total) * 100 : 50;
        const isOpen = expanded.has(c.hash);
        const display = c.text.startsWith('PROPOSAL:') ? c.text.slice('PROPOSAL:'.length).trim() : c.text;
        return (
          <View
            key={c.hash}
            style={[
              s.card,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: c.isProposal ? theme.colors.accent : theme.colors.surface3,
              },
            ]}
          >
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(8) }}>
              {!!c.authorPfpUrl && (
                <CachedAvatar
                  source={{ uri: c.authorPfpUrl }}
                  style={{ width: 28, height: 28, borderRadius: Skin.radius(14), backgroundColor: theme.colors.surface3 }}
                />
              )}
              <Text style={{ color: theme.colors.textMain, fontWeight: '600', fontSize: Skin.font(13) }}>
                {c.authorDisplayName || c.authorUsername || `fid:${c.authorFid}`}
              </Text>
              {c.isProposal && (
                <Text style={[s.proposalTag, { color: theme.colors.accent, borderColor: theme.colors.accent }]}>
                  PROPOSAL
                </Text>
              )}
            </View>

            {/* Body */}
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(14), marginTop: Skin.space(6) }}>
              {display}
            </Text>

            {c.isProposal && (
              <>
                {/* Weighted bar */}
                <View style={s.bar}>
                  <View style={{ flex: forPct, backgroundColor: theme.colors.accent }} />
                  <View style={{ flex: 100 - forPct, backgroundColor: theme.colors.warning }} />
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: Skin.space(4) }}>
                  <Text style={{ color: theme.colors.accent, fontSize: Skin.font(12) }}>
                    FOR {fmtPoints(c.votesFor)} ({total > 0 ? forPct.toFixed(1) : '0.0'}%)
                  </Text>
                  <Text style={{ color: theme.colors.warning, fontSize: Skin.font(12) }}>
                    AGAINST {fmtPoints(c.votesAgainst)} ({total > 0 ? (100 - forPct).toFixed(1) : '0.0'}%)
                  </Text>
                </View>

                {/* Vote actions */}
                {voteTarget?.hash === c.hash ? (
                  <View style={{ marginTop: Skin.space(10), gap: Skin.space(8) }}>
                    <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(13), fontWeight: '600' }}>
                      Voting {voteTarget.dir === 'for' ? 'FOR' : 'AGAINST'}
                    </Text>
                    <TextInput
                      value={reason}
                      onChangeText={setReason}
                      placeholder="Add a reason (optional)"
                      placeholderTextColor={theme.colors.textMuted}
                      style={[s.reasonInput, { color: theme.colors.textMain, backgroundColor: theme.colors.surface3 }]}
                      multiline
                      maxLength={280}
                    />
                    <View style={{ flexDirection: 'row', gap: Skin.space(8) }}>
                      <Pressable
                        onPress={submitVote}
                        disabled={submitting}
                        style={[s.btn, { backgroundColor: theme.colors.accent, opacity: submitting ? 0.6 : 1 }]}
                      >
                        {submitting ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Text style={s.btnText}>Post vote</Text>
                        )}
                      </Pressable>
                      <Pressable onPress={() => setVoteTarget(null)} style={[s.btn, { backgroundColor: theme.colors.surface3 }]}>
                        <Text style={[s.btnText, { color: theme.colors.textMain }]}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', gap: Skin.space(8), marginTop: Skin.space(10) }}>
                    <Pressable
                      onPress={() => (token ? startVote(c.hash, 'for') : Alert.alert('Sign in', 'Connect Farcaster to vote.'))}
                      style={[s.btn, { backgroundColor: theme.colors.accent }]}
                    >
                      <Text style={s.btnText}>Vote FOR</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => (token ? startVote(c.hash, 'against') : Alert.alert('Sign in', 'Connect Farcaster to vote.'))}
                      style={[s.btn, { backgroundColor: theme.colors.warning }]}
                    >
                      <Text style={s.btnText}>Vote AGAINST</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}

            {/* Replies / votes */}
            {c.directReplies.length > 0 && (
              <Pressable onPress={() => toggleExpanded(c.hash)} hitSlop={6} style={{ marginTop: Skin.space(10) }}>
                <Text style={{ color: theme.colors.accent, fontSize: Skin.font(12) }}>
                  {isOpen ? 'Hide' : 'Show'} {c.directReplies.length} {c.directReplies.length === 1 ? 'reply' : 'replies'}
                </Text>
              </Pressable>
            )}
            {isOpen && (
              <View style={{ marginTop: Skin.space(8) }}>
                <ReplyThread replies={c.directReplies} theme={theme} depth={0} />
              </View>
            )}

            {/* Counts */}
            <View style={{ flexDirection: 'row', gap: Skin.space(14), marginTop: Skin.space(10) }}>
              <Count icon="heart" value={c.likes} theme={theme} />
              <Count icon="arrow.triangle.2.circlepath" value={c.recasts} theme={theme} />
              <Count icon="bubble.left" value={c.replies} theme={theme} />
            </View>
          </View>
        );
      })}
      {isRefetching && (
        <View style={{ paddingVertical: Skin.space(8) }}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      )}
    </ScrollView>
  );
}

function Count({ icon, value, theme }: { icon: IconSymbolName; value: number; theme: AppTheme }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}>
      <IconSymbol name={icon} size={13} color={theme.colors.textMuted} />
      <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12) }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Skin.space(24),
  },
  card: {
    borderWidth: 1,
    borderRadius: Skin.radius(12),
    padding: Skin.space(14),
  },
  proposalTag: {
    fontSize: Skin.font(10),
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: Skin.radius(4),
    paddingHorizontal: Skin.space(5),
    paddingVertical: Skin.space(1),
  },
  bar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: Skin.radius(4),
    overflow: 'hidden',
    marginTop: Skin.space(10),
  },
  voteBadge: {
    fontSize: Skin.font(10),
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: Skin.radius(4),
    paddingHorizontal: Skin.space(4),
    paddingVertical: Skin.space(1),
  },
  reasonInput: {
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

export default HegemonyGovernanceView;
