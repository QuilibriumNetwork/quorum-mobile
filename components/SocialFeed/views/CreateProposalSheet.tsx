import type { AppTheme } from '@/theme';
import { BaseModal } from '@/components/shared';
import type {
  ClientArea,
  CreateProposalInput,
  ProtocolCategory,
  ProposalScope,
} from '@/hooks/useGovernance';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
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
        <View style={styles.segmentedControl}>
          {(['protocol', 'client'] as const).map((s) => (
            <TouchableOpacity
              key={s}
              style={[
                styles.segment,
                { backgroundColor: scope === s ? theme.colors.accent : theme.colors.surface3 },
              ]}
              onPress={() => setScope(s)}
            >
              <Text style={[
                styles.segmentText,
                { color: scope === s ? theme.colors.surface0 : theme.colors.textMuted },
              ]}>
                {s === 'protocol' ? 'Protocol' : 'Client'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Scope-specific fields */}
        {scope === 'protocol' ? (
          <>
            <Text style={[styles.label, { color: theme.colors.textMuted }]}>Category</Text>
            <View style={styles.pillRow}>
              {PROTOCOL_CATEGORIES.map((c) => (
                <TouchableOpacity
                  key={c.value}
                  style={[
                    styles.pill,
                    { backgroundColor: category === c.value ? theme.colors.accent : theme.colors.surface3 },
                  ]}
                  onPress={() => setCategory(c.value)}
                >
                  <Text style={[
                    styles.pillText,
                    { color: category === c.value ? theme.colors.surface0 : theme.colors.textMuted },
                  ]}>
                    {c.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

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
            <View style={styles.pillRow}>
              {CLIENT_AREAS.map((a) => (
                <TouchableOpacity
                  key={a.value}
                  style={[
                    styles.pill,
                    { backgroundColor: clientArea === a.value ? theme.colors.accent : theme.colors.surface3 },
                  ]}
                  onPress={() => setClientArea(a.value)}
                >
                  <Text style={[
                    styles.pillText,
                    { color: clientArea === a.value ? theme.colors.surface0 : theme.colors.textMuted },
                  ]}>
                    {a.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

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
    flexDirection: 'row',
    gap: Skin.space(8),
    marginBottom: Skin.space(20),
  },
  segment: {
    flex: 1,
    paddingVertical: Skin.space(8),
    borderRadius: Skin.radius(10),
    alignItems: 'center',
  },
  segmentText: {
    fontSize: Skin.font(14),
    fontWeight: '600',
  },
  label: {
    fontSize: Skin.font(13),
    fontWeight: '500',
    marginBottom: Skin.space(6),
    marginTop: Skin.space(12),
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Skin.space(8),
  },
  pill: {
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(6),
    borderRadius: Skin.radius(14),
  },
  pillText: {
    fontSize: Skin.font(13),
    fontWeight: '500',
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
