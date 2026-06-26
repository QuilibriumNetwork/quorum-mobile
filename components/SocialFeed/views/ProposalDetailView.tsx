import type { AppTheme } from '@/theme';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context/AuthContext';
import {
  useGovernance,
  type ClientProposal,
  type ProposalComment,
  type ProtocolCategory,
  type ProtocolProposal,
  type VoteDirection,
} from '@/hooks/useGovernance';
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface ProposalDetailViewProps {
  proposalId: string;
  theme: AppTheme;
  onClose: () => void;
  keyboardHeight: number;
  userPanelHeight: number;
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

function CommentRow({ comment, theme }: { comment: ProposalComment; theme: AppTheme }) {
  return (
    <View style={styles.commentRow}>
      <View style={styles.commentHeader}>
        <Text style={[styles.commentAuthor, { color: theme.colors.textMain }]}>
          {comment.authorName ? `@${comment.authorName}` : comment.authorAddress.slice(0, 10) + '...'}
        </Text>
        <Text style={[styles.commentTime, { color: theme.colors.textSubtle }]}>
          {formatTimeAgo(comment.createdAt)}
        </Text>
      </View>
      <Text style={[styles.commentText, { color: theme.colors.textMain }]}>
        {comment.text}
      </Text>
    </View>
  );
}

export function ProposalDetailView({ proposalId, theme, onClose, keyboardHeight, userPanelHeight }: ProposalDetailViewProps) {
  const { user } = useAuth();
  const userAddress = user?.address;
  const { getProposal, getComments, addComment, votes, vote } = useGovernance(userAddress);

  const proposal = getProposal(proposalId);
  const comments = getComments(proposalId);
  const [commentText, setCommentText] = useState('');

  const userVote = votes[proposalId];

  const handleVote = useCallback((dir: VoteDirection) => {
    vote(proposalId, dir);
  }, [vote, proposalId]);

  const handleSubmitComment = useCallback(() => {
    const trimmed = commentText.trim();
    if (!trimmed || !userAddress) return;
    addComment(proposalId, trimmed, userAddress, user?.farcaster?.username);
    setCommentText('');
  }, [commentText, userAddress, proposalId, addComment, user?.farcaster?.username]);

  if (!proposal) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surface0 }]}>
        <View style={[styles.header, { borderBottomColor: theme.colors.surface3 }]}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <IconSymbol name="chevron.left" size={22} color={theme.colors.textMain} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.colors.textMain }]}>Proposal</Text>
          <View style={{ width: 22 }} />
        </View>
        <View style={styles.emptyState}>
          <Text style={[styles.emptyText, { color: theme.colors.textSubtle }]}>Proposal not found.</Text>
        </View>
      </View>
    );
  }

  const badge = proposal.scope === 'protocol'
    ? CATEGORY_LABELS[(proposal as ProtocolProposal).category]
    : (proposal as ClientProposal).clientArea.charAt(0).toUpperCase() + (proposal as ClientProposal).clientArea.slice(1);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface0 }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.surface3 }]}>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <IconSymbol name="chevron.left" size={22} color={theme.colors.textMain} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.textMain }]}>Proposal</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.flex}>
        {/* Scrollable body */}
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Badge + time */}
          <View style={styles.metaRow}>
            <View style={[styles.badge, { backgroundColor: theme.colors.accent + '22' }]}>
              <Text style={[styles.badgeText, { color: theme.colors.accent }]}>{badge}</Text>
            </View>
            <Text style={[styles.timeText, { color: theme.colors.textSubtle }]}>
              {formatTimeAgo(proposal.createdAt)}
            </Text>
          </View>

          {/* Title */}
          <Text style={[styles.title, { color: theme.colors.textMain }]}>{proposal.title}</Text>

          {/* Author */}
          {proposal.authorName ? (
            <Text style={[styles.author, { color: theme.colors.textSubtle }]}>
              by @{proposal.authorName}
            </Text>
          ) : null}

          {/* Proposal content */}
          {proposal.scope === 'protocol' ? (
            <>
              <Text style={[styles.sectionHeading, { color: theme.colors.textMain }]}>Abstract</Text>
              <Text style={[styles.sectionBody, { color: theme.colors.textMain }]}>
                {(proposal as ProtocolProposal).abstract}
              </Text>

              <Text style={[styles.sectionHeading, { color: theme.colors.textMain }]}>Problem Statement</Text>
              <Text style={[styles.sectionBody, { color: theme.colors.textMain }]}>
                {(proposal as ProtocolProposal).problemStatement}
              </Text>

              <Text style={[styles.sectionHeading, { color: theme.colors.textMain }]}>Proposed Solution</Text>
              <Text style={[styles.sectionBody, { color: theme.colors.textMain }]}>
                {(proposal as ProtocolProposal).proposedSolution}
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.sectionHeading, { color: theme.colors.textMain }]}>Description</Text>
              <Text style={[styles.sectionBody, { color: theme.colors.textMain }]}>
                {(proposal as ClientProposal).description}
              </Text>

              <Text style={[styles.sectionHeading, { color: theme.colors.textMain }]}>Rationale</Text>
              <Text style={[styles.sectionBody, { color: theme.colors.textMain }]}>
                {(proposal as ClientProposal).rationale}
              </Text>
            </>
          )}

          {/* Vote row */}
          <View style={styles.voteRow}>
            <TouchableOpacity
              style={styles.voteButton}
              onPress={() => handleVote('up')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <IconSymbol
                name="hand.thumbsup.fill"
                size={18}
                color={userVote === 'up' ? theme.colors.accent : theme.colors.textMuted}
              />
              <Text style={[styles.voteCount, { color: userVote === 'up' ? theme.colors.accent : theme.colors.textMuted }]}>
                {proposal.upvotes}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.voteButton}
              onPress={() => handleVote('down')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <IconSymbol
                name="hand.thumbsdown.fill"
                size={18}
                color={userVote === 'down' ? theme.colors.danger : theme.colors.textMuted}
              />
              <Text style={[styles.voteCount, { color: userVote === 'down' ? theme.colors.danger : theme.colors.textMuted }]}>
                {proposal.downvotes}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Comments divider */}
          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: theme.colors.surface3 }]} />
            <Text style={[styles.dividerText, { color: theme.colors.textSubtle }]}>
              Comments ({comments.length})
            </Text>
            <View style={[styles.dividerLine, { backgroundColor: theme.colors.surface3 }]} />
          </View>

          {/* Comment list */}
          {comments.length === 0 ? (
            <Text style={[styles.noComments, { color: theme.colors.textSubtle }]}>
              No comments yet. Be the first to share your thoughts.
            </Text>
          ) : (
            comments.map((c) => <CommentRow key={c.id} comment={c} theme={theme} />)
          )}
        </ScrollView>

        {/* Comment input bar */}
        <View style={[styles.inputBar, {
          borderTopColor: theme.colors.surface3,
          backgroundColor: theme.colors.surface0,
          marginBottom: keyboardHeight > 0 ? keyboardHeight - userPanelHeight + 2 : 6,
        }]}>
          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.surface3, color: theme.colors.textMain }]}
            placeholder="Type a comment..."
            placeholderTextColor={theme.colors.textMuted}
            value={commentText}
            onChangeText={setCommentText}
            multiline
            maxLength={2000}
          />
          <TouchableOpacity
            style={[styles.sendButton, { opacity: commentText.trim() ? 1 : 0.4 }]}
            onPress={handleSubmitComment}
            disabled={!commentText.trim()}
          >
            <IconSymbol name="paperplane.fill" size={20} color={theme.colors.accent} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Skin.space(16),
    paddingVertical: Skin.space(12),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: Skin.font(17),
    fontWeight: '600',
  },
  scrollContent: {
    padding: Skin.space(16),
    paddingBottom: Skin.space(24),
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Skin.space(12),
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
  title: {
    fontSize: Skin.font(20),
    fontWeight: '700',
    lineHeight: Skin.font(26),
    marginBottom: Skin.space(4),
  },
  author: {
    fontSize: Skin.font(13),
    marginBottom: Skin.space(16),
  },
  sectionHeading: {
    fontSize: Skin.font(15),
    fontWeight: '600',
    marginTop: Skin.space(16),
    marginBottom: Skin.space(6),
  },
  sectionBody: {
    fontSize: Skin.font(14),
    lineHeight: Skin.font(20),
  },
  voteRow: {
    flexDirection: 'row',
    gap: Skin.space(20),
    marginTop: Skin.space(20),
    marginBottom: Skin.space(8),
  },
  voteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  voteCount: {
    fontSize: Skin.font(15),
    fontWeight: '500',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Skin.space(16),
    marginBottom: Skin.space(12),
    gap: Skin.space(10),
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerText: {
    fontSize: Skin.font(13),
    fontWeight: '500',
  },
  noComments: {
    fontSize: Skin.font(13),
    textAlign: 'center',
    paddingVertical: Skin.space(16),
  },
  commentRow: {
    marginBottom: Skin.space(14),
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(8),
    marginBottom: Skin.space(3),
  },
  commentAuthor: {
    fontSize: Skin.font(13),
    fontWeight: '600',
  },
  commentTime: {
    fontSize: Skin.font(11),
  },
  commentText: {
    fontSize: Skin.font(14),
    lineHeight: Skin.font(19),
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(6),
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Skin.space(8),
  },
  input: {
    flex: 1,
    borderRadius: Skin.radius(18),
    paddingHorizontal: Skin.space(14),
    paddingTop: Skin.space(8),
    paddingBottom: Skin.space(8),
    fontSize: Skin.font(14),
    maxHeight: 100,
  },
  sendButton: {
    padding: Skin.space(6),
    marginBottom: Skin.space(2),
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: Skin.font(15),
  },
}));
