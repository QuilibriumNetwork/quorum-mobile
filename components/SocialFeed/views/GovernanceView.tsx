import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import {
  useGovernance,
  type ClientProposal,
  type CreateProposalInput,
  type Proposal,
  type ProtocolCategory,
  type ProtocolProposal,
  type ProposalScope,
  type VoteDirection,
  type VoteMap,
} from '@/hooks/useGovernance';
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import CreateProposalSheet from './CreateProposalSheet';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface GovernanceViewProps {
  theme: AppTheme;
  onOpenProposal?: (id: string) => void;
}

const CATEGORY_LABELS: Record<ProtocolCategory, string> = {
  'protocol-change': 'Protocol Change',
  'new-feature': 'New Feature',
  'deprecation': 'Deprecation',
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function ProposalCard({
  proposal,
  votes,
  onVote,
  onPress,
  theme,
}: {
  proposal: Proposal;
  votes: VoteMap;
  onVote: (id: string, dir: VoteDirection) => void;
  onPress?: () => void;
  theme: AppTheme;
}) {
  const userVote = votes[proposal.id];

  const badge = proposal.scope === 'protocol'
    ? CATEGORY_LABELS[(proposal as ProtocolProposal).category]
    : (proposal as ClientProposal).clientArea.charAt(0).toUpperCase() + (proposal as ClientProposal).clientArea.slice(1);

  const bodyText = proposal.scope === 'protocol'
    ? (proposal as ProtocolProposal).abstract
    : (proposal as ClientProposal).description;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      disabled={!onPress}
      style={[styles.card, { backgroundColor: theme.colors.surface3 }]}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.badge, { backgroundColor: theme.colors.accent + '22' }]}>
          <Text style={[styles.badgeText, { color: theme.colors.accent }]}>{badge}</Text>
        </View>
        <Text style={[styles.timeText, { color: theme.colors.textSubtle }]}>
          {formatTimeAgo(proposal.createdAt)}
        </Text>
      </View>

      <Text style={[styles.cardTitle, { color: theme.colors.textMain }]} numberOfLines={2}>
        {proposal.title}
      </Text>

      {bodyText ? (
        <Text style={[styles.cardBody, { color: theme.colors.textSubtle }]} numberOfLines={2}>
          {bodyText}
        </Text>
      ) : null}

      <View style={styles.cardFooter}>
        <View style={styles.voteRow}>
          <TouchableOpacity
            style={styles.voteButton}
            onPress={() => onVote(proposal.id, 'up')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconSymbol
              name="hand.thumbsup.fill"
              size={16}
              color={userVote === 'up' ? theme.colors.accent : theme.colors.textMuted}
            />
            <Text style={[styles.voteCount, { color: userVote === 'up' ? theme.colors.accent : theme.colors.textMuted }]}>
              {proposal.upvotes}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.voteButton}
            onPress={() => onVote(proposal.id, 'down')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconSymbol
              name="hand.thumbsdown.fill"
              size={16}
              color={userVote === 'down' ? theme.colors.danger : theme.colors.textMuted}
            />
            <Text style={[styles.voteCount, { color: userVote === 'down' ? theme.colors.danger : theme.colors.textMuted }]}>
              {proposal.downvotes}
            </Text>
          </TouchableOpacity>
        </View>

        {proposal.authorName ? (
          <Text style={[styles.authorText, { color: theme.colors.textSubtle }]}>
            by {proposal.authorName}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

export default function GovernanceView({ theme, onOpenProposal }: GovernanceViewProps) {
  const { user } = useAuth();
  const userAddress = user?.address;
  const { protocolProposals, clientProposals, votes, createProposal, vote } = useGovernance(userAddress);

  const [activeTab, setActiveTab] = useState<ProposalScope>('protocol');
  const [showCreate, setShowCreate] = useState(false);

  const displayedProposals = activeTab === 'protocol' ? protocolProposals : clientProposals;

  const handleVote = useCallback((id: string, dir: VoteDirection) => {
    vote(id, dir);
  }, [vote]);

  const handleCreateProposal = useCallback((data: CreateProposalInput) => {
    createProposal(data);
    setShowCreate(false);
  }, [createProposal]);

  return (
    <View style={styles.container}>
      {/* Sub-tabs + Create button */}
      <View style={styles.tabRow}>
        <View style={styles.tabs}>
          {(['protocol', 'client'] as const).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={styles.tab}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[
                styles.tabText,
                { color: activeTab === tab ? theme.colors.accent : theme.colors.textSubtle },
              ]}>
                {tab === 'protocol' ? 'Protocol' : 'Client'}
              </Text>
              {activeTab === tab && (
                <View style={[styles.tabUnderline, { backgroundColor: theme.colors.accent }]} />
              )}
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[styles.createButton, { backgroundColor: theme.colors.accent }]}
          onPress={() => setShowCreate(true)}
        >
          <IconSymbol name="plus" size={16} color={theme.colors.surface0} />
          <Text style={[styles.createButtonText, { color: theme.colors.surface0 }]}>New</Text>
        </TouchableOpacity>
      </View>

      {/* Proposals list */}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {displayedProposals.length === 0 ? (
          <View style={styles.emptyState}>
            <IconSymbol name="checkmark.seal.fill" size={40} color={theme.colors.textMuted} />
            <Text style={[styles.emptyText, { color: theme.colors.textSubtle }]}>
              No {activeTab} proposals yet.
            </Text>
          </View>
        ) : (
          displayedProposals.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              votes={votes}
              onVote={handleVote}
              onPress={onOpenProposal ? () => onOpenProposal(p.id) : undefined}
              theme={theme}
            />
          ))
        )}
      </ScrollView>

      {/* Create proposal sheet */}
      <CreateProposalSheet
        visible={showCreate}
        theme={theme}
        userAddress={userAddress}
        userName={user?.farcaster?.username}
        onClose={() => setShowCreate(false)}
        onSubmit={handleCreateProposal}
      />
    </View>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    flex: 1,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Skin.space(16),
    paddingTop: Skin.space(12),
    paddingBottom: Skin.space(4),
  },
  tabs: {
    flexDirection: 'row',
    flex: 1,
    gap: Skin.space(20),
  },
  tab: {
    paddingVertical: Skin.space(8),
    alignItems: 'center',
  },
  tabText: {
    fontSize: Skin.font(15),
    fontWeight: '600',
  },
  tabUnderline: {
    height: 2,
    width: '100%',
    borderRadius: Skin.radius(1),
    marginTop: Skin.space(4),
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(6),
    borderRadius: Skin.radius(16),
    gap: Skin.space(4),
  },
  createButtonText: {
    fontSize: Skin.font(13),
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: Skin.space(16),
    gap: Skin.space(12),
  },
  card: {
    borderRadius: Skin.radius(12),
    padding: Skin.space(14),
    gap: Skin.space(8),
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: Skin.space(8),
    paddingVertical: Skin.space(3),
    borderRadius: Skin.radius(8),
  },
  badgeText: {
    fontSize: Skin.font(11),
    fontWeight: '600',
  },
  timeText: {
    fontSize: Skin.font(12),
  },
  cardTitle: {
    fontSize: Skin.font(15),
    fontWeight: '600',
    lineHeight: Skin.font(20),
  },
  cardBody: {
    fontSize: Skin.font(13),
    lineHeight: Skin.font(18),
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Skin.space(4),
  },
  voteRow: {
    flexDirection: 'row',
    gap: Skin.space(16),
  },
  voteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(4),
  },
  voteCount: {
    fontSize: Skin.font(13),
    fontWeight: '500',
  },
  authorText: {
    fontSize: Skin.font(12),
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Skin.space(60),
    gap: Skin.space(12),
  },
  emptyText: {
    fontSize: Skin.font(15),
  },
}));
