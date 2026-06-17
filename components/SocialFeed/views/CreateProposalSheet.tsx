import type { AppTheme } from '@/theme';
import { BaseModal } from '@/components/shared';
import type {
  ClientArea,
  CreateProposalInput,
  ProtocolCategory,
  ProposalScope,
} from '@/hooks/useGovernance';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface CreateProposalSheetProps {
  visible: boolean;
  theme: AppTheme;
  userAddress?: string;
  userName?: string;
  onClose: () => void;
  onSubmit: (data: CreateProposalInput) => void;
}

const PROTOCOL_CATEGORIES: { value: ProtocolCategory; label: string }[] = [
  { value: 'protocol-change', label: 'Protocol Change' },
  { value: 'new-feature', label: 'New Feature' },
  { value: 'deprecation', label: 'Deprecation' },
];

const CLIENT_AREAS: { value: ClientArea; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'miniapps', label: 'MiniApps' },
  { value: 'feed', label: 'Feed' },
  { value: 'profile', label: 'Profile' },
  { value: 'other', label: 'Other' },
];

export default function CreateProposalSheet({
  visible,
  theme,
  userAddress,
  userName,
  onClose,
  onSubmit,
}: CreateProposalSheetProps) {
  const [scope, setScope] = useState<ProposalScope>('protocol');
  const [title, setTitle] = useState('');

  // Protocol fields
  const [category, setCategory] = useState<ProtocolCategory>('protocol-change');
  const [abstract, setAbstract] = useState('');
  const [problemStatement, setProblemStatement] = useState('');
  const [proposedSolution, setProposedSolution] = useState('');

  // Client fields
  const [clientArea, setClientArea] = useState<ClientArea>('chat');
  const [description, setDescription] = useState('');
  const [rationale, setRationale] = useState('');

  const canSubmit = title.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit || !userAddress) return;

    if (scope === 'protocol') {
      onSubmit({
        scope: 'protocol',
        title: title.trim(),
        authorAddress: userAddress,
        authorName: userName,
        category,
        abstract: abstract.trim(),
        problemStatement: problemStatement.trim(),
        proposedSolution: proposedSolution.trim(),
      });
    } else {
      onSubmit({
        scope: 'client',
        title: title.trim(),
        authorAddress: userAddress,
        authorName: userName,
        clientArea,
        description: description.trim(),
        rationale: rationale.trim(),
      });
    }

    // Reset form
    setTitle('');
    setAbstract('');
    setProblemStatement('');
    setProposedSolution('');
    setDescription('');
    setRationale('');
  };

  const inputStyle = [styles.textInput, {
    backgroundColor: theme.colors.surface3,
    color: theme.colors.textMain,
    borderColor: theme.colors.surface5 ?? theme.colors.surface3,
  }];

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} avoidKeyboard>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.sheetTitle, { color: theme.colors.textMain }]}>
          New Proposal
        </Text>

        {/* Scope toggle */}
        <SegmentedPills
          style={styles.segmentedControl}
          variant="solid"
          pillShape="rect"
          scrollable={false}
          items={[
            { key: 'protocol', label: 'Protocol' },
            { key: 'client', label: 'Client' },
          ]}
          activeKey={scope}
          onChange={(key) => setScope(key as ProposalScope)}
        />

        {/* Scope-specific fields */}
        {scope === 'protocol' ? (
          <>
            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Category</Text>
            <SegmentedPills
              style={styles.pillRow}
              variant="solid"
              wrap
              itemRole="button"
              items={PROTOCOL_CATEGORIES.map<SegmentedPillItem>((c) => ({ key: c.value, label: c.label }))}
              activeKey={category}
              onChange={(key) => setCategory(key as ProtocolCategory)}
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Title</Text>
            <TextInput
              style={inputStyle}
              value={title}
              onChangeText={setTitle}
              placeholder="Proposal title"
              placeholderTextColor={theme.colors.textMuted}
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Abstract</Text>
            <TextInput
              style={[inputStyle, { height: 72 }]}
              value={abstract}
              onChangeText={setAbstract}
              placeholder="Brief summary of the proposal"
              placeholderTextColor={theme.colors.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Problem Statement</Text>
            <TextInput
              style={[inputStyle, { height: 110 }]}
              value={problemStatement}
              onChangeText={setProblemStatement}
              placeholder="What problem does this solve?"
              placeholderTextColor={theme.colors.textMuted}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Proposed Solution</Text>
            <TextInput
              style={[inputStyle, { height: 110 }]}
              value={proposedSolution}
              onChangeText={setProposedSolution}
              placeholder="How would you solve it?"
              placeholderTextColor={theme.colors.textMuted}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
            />
          </>
        ) : (
          <>
            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Client Area</Text>
            <SegmentedPills
              style={styles.pillRow}
              variant="solid"
              wrap
              itemRole="button"
              items={CLIENT_AREAS.map<SegmentedPillItem>((a) => ({ key: a.value, label: a.label }))}
              activeKey={clientArea}
              onChange={(key) => setClientArea(key as ClientArea)}
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Title</Text>
            <TextInput
              style={inputStyle}
              value={title}
              onChangeText={setTitle}
              placeholder="Proposal title"
              placeholderTextColor={theme.colors.textMuted}
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Description</Text>
            <TextInput
              style={[inputStyle, { height: 96 }]}
              value={description}
              onChangeText={setDescription}
              placeholder="Describe the proposed change"
              placeholderTextColor={theme.colors.textMuted}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />

            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Rationale</Text>
            <TextInput
              style={[inputStyle, { height: 96 }]}
              value={rationale}
              onChangeText={setRationale}
              placeholder="Why is this change needed?"
              placeholderTextColor={theme.colors.textMuted}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </>
        )}

        {/* Submit button */}
        <TouchableOpacity
          style={[
            styles.submitButton,
            { backgroundColor: canSubmit ? theme.colors.accent : theme.colors.surface3 },
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          <Text style={[
            styles.submitText,
            { color: canSubmit ? theme.colors.surface0 : theme.colors.textMuted },
          ]}>
            Submit Proposal
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </BaseModal>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Skin.space(20),
    paddingBottom: Skin.space(40),
  },
  sheetTitle: {
    fontSize: Skin.font(20),
    fontWeight: '700',
    marginBottom: Skin.space(16),
  },
  segmentedControl: {
    marginBottom: Skin.space(20),
  },
  label: {
    fontSize: Skin.font(13),
    fontWeight: '500',
    marginBottom: Skin.space(6),
    marginTop: Skin.space(12),
  },
  pillRow: {
    marginBottom: Skin.space(4),
  },
  textInput: {
    borderRadius: Skin.radius(10),
    padding: Skin.space(12),
    fontSize: Skin.font(14),
    borderWidth: Skin.border(1),
  },
  submitButton: {
    marginTop: Skin.space(24),
    paddingVertical: Skin.space(14),
    borderRadius: Skin.radius(12),
    alignItems: 'center',
  },
  submitText: {
    fontSize: Skin.font(16),
    fontWeight: '600',
  },
}));
