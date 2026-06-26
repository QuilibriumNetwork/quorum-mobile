import React from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BaseModal } from '@/components/shared/BaseModal';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSpaceMembers } from '@/hooks/chat/useSpaces';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import type { Space } from '@quilibrium/quorum-shared';

interface SpaceDescriptionSheetProps {
  visible: boolean;
  onClose: () => void;
  space: Space;
}

function formatMemberCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${Math.floor(n / 1000)},${String(n % 1000).padStart(3, '0')}`;
  return `${Math.round(n / 1000)}k`;
}

export function SpaceDescriptionSheet({
  visible,
  onClose,
  space,
}: SpaceDescriptionSheetProps) {
  const { theme } = useTheme();
  const { data: members = [] } = useSpaceMembers(space.spaceId, { enabled: visible });

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.5} showHandle>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Row 1: icon */}
        {space.iconUrl ? (
          <Image
            source={{ uri: space.iconUrl }}
            style={[styles.icon, { borderRadius: Skin.radius(10) }]}
            resizeMode="cover"
          />
        ) : (
          <View
            style={[
              styles.icon,
              styles.iconFallback,
              { backgroundColor: theme.colors.surface3, borderRadius: Skin.radius(10) },
            ]}
          >
            <IconSymbol name="person.3" size={22} color={theme.colors.textMuted} />
          </View>
        )}

        {/* Row 2: space name */}
        <Text style={[styles.name, { color: theme.colors.textMain }]} numberOfLines={2}>
          {space.spaceName}
        </Text>

        {/* Row 3: member count */}
        <View style={styles.memberRow}>
          <IconSymbol name="person.2" size={14} color={theme.colors.textMuted} />
          <Text style={[styles.memberCount, { color: theme.colors.textSubtle }]}>
            {formatMemberCount(members.length)} {members.length === 1 ? 'member' : 'members'}
          </Text>
        </View>

        {/* Row 4: description */}
        {!!space.description && (
          <Text style={[styles.description, { color: theme.colors.textSubtle }]}>
            {space.description}
          </Text>
        )}
      </ScrollView>
    </BaseModal>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    paddingHorizontal: Skin.space(24),
    paddingBottom: Skin.space(32),
    paddingTop: Skin.space(12),
  },
  icon: {
    width: 56,
    height: 56,
    flexShrink: 0,
    marginBottom: Skin.space(12),
  },
  iconFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    flexShrink: 1,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Skin.space(5),
    marginBottom: Skin.space(16),
  },
  memberCount: {
    fontSize: 13,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
});
