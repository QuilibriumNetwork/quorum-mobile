import { BaseModal } from '@/components/shared';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth, useWebSocket } from '@/context';
import { useFarcasterProfile } from '@/hooks/useFarcasterProfile';
import { updateFarcasterProfile } from '@/services/farcaster/updateProfile';
import { getAllSpaces } from '@/services/config/spaceStorage';
import { maybeSendUpdateProfileMessage } from '@/services/space/spaceMessageService';
import { compressAvatarImage } from '@/services/media/imageAttachment';
import { useTheme, type AppTheme } from '@/theme';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

export type EditScope = 'quorum' | 'farcaster' | 'both';

interface UnifiedProfileEditModalProps {
  visible: boolean;
  scope: EditScope;
  onClose: () => void;
}

export default function UnifiedProfileEditModal({
  visible,
  scope,
  onClose,
}: UnifiedProfileEditModalProps) {
  const { theme } = useTheme();
  const { user, farcasterAuthToken, updateProfile } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the live Farcaster profile so farcaster-scoped edits seed from
  // the Farcaster-side fields rather than the Quorum-side fields.
  const { author: farcasterAuthor } = useFarcasterProfile({
    fid: user?.farcaster?.fid ?? 0,
    token: farcasterAuthToken ?? undefined,
    enabled: Boolean(visible && user?.farcaster?.fid && scope !== 'quorum'),
  });

  // Seed state from the appropriate source for the chosen scope.
  useEffect(() => {
    if (!visible || !user) return;
    if (scope === 'farcaster') {
      setDisplayName(farcasterAuthor?.displayName ?? user.farcaster?.username ?? '');
      setBio(farcasterAuthor?.profile?.bio?.text ?? '');
      setAvatar(farcasterAuthor?.pfp?.url ?? user.farcaster?.pfpUrl ?? null);
    } else {
      setDisplayName(user.displayName ?? '');
      setBio(user.bio ?? '');
      setAvatar(user.profileImage ?? user.farcaster?.pfpUrl ?? null);
    }
  }, [visible, user, scope, farcasterAuthor]);

  if (!user) return null;

  const title =
    scope === 'quorum'
      ? 'Edit Quorum profile'
      : scope === 'farcaster'
        ? 'Edit Farcaster profile'
        : 'Edit profile';

  const subtitle =
    scope === 'both'
      ? 'Changes apply to both Quorum and Farcaster.'
      : scope === 'farcaster'
        ? 'Changes apply to Farcaster only.'
        : 'Changes apply to Quorum only.';

  const handlePickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
      // base64 deferred to compressAvatarImage which enforces a
      // hard size cap. Avatars stored as raw camera output were
      // bloating the public-profile JSON to 60MB+, OOM'ing okhttp
      // on the fetching side.
      base64: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const compressed = await compressAvatarImage(
      asset.uri,
      asset.width ?? 512,
      asset.height ?? 512,
    );
    if (!compressed) return;
    setAvatar(compressed.dataUri);
  };

  const saveQuorum = async () => {
    const name = displayName.trim();
    const b = bio.trim();

    updateProfile({
      displayName: name || undefined,
      bio: b || undefined,
      profileImage: avatar ?? undefined,
    });

    // Broadcast to all spaces
    const spaces = getAllSpaces();
    if (spaces.length > 0) {
      enqueueOutbound(async () => {
        const envelopes: string[] = [];
        for (const space of spaces) {
          try {
            // Only include fields that have a real value — empty
            // strings would clobber recipients' stored values for
            // those fields under the receiver's "treat present as
            // assigned" rule.
            const res = await maybeSendUpdateProfileMessage({
              spaceId: space.spaceId,
              channelId: space.defaultChannelId,
              senderAddress: user.address,
              displayName: name || undefined,
              userIcon: avatar || undefined,
              bio: user.isProfilePublic ? b : undefined,
            });
            if (res) {
              envelopes.push(res.wsEnvelope);
            }
          } catch {
            // Skip failed space broadcasts
          }
        }
        return envelopes;
      });
    }
  };

  const saveFarcaster = async (): Promise<string[]> => {
    if (!farcasterAuthToken) {
      return ['Farcaster not connected'];
    }
    const name = displayName.trim();
    const b = bio.trim();

    const fields: { displayName?: string; bio?: string; pfp?: string } = {
      displayName: name,
      bio: b,
    };
    // Only send a new pfp when the avatar differs from what we already had
    // (heuristic: data URI or local file URI indicates user picked a new image)
    if (avatar && (avatar.startsWith('data:') || avatar.startsWith('file:'))) {
      fields.pfp = avatar;
    }

    const res = await updateFarcasterProfile(farcasterAuthToken, fields);
    if (!res.ok) return [res.error ?? 'Unknown error'];
    return [];
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const quorumTargeted = scope === 'quorum' || scope === 'both';
      const farcasterTargeted = scope === 'farcaster' || scope === 'both';

      if (quorumTargeted) {
        await saveQuorum();
      }
      if (farcasterTargeted) {
        const fcErrors = await saveFarcaster();
        if (fcErrors.length > 0) {
          Alert.alert(
            'Farcaster update failed',
            fcErrors.join('\n\n'),
          );
          setSaving(false);
          return;
        }
      }
      onClose();
    } catch (e) {
      Alert.alert('Failed to save', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} avoidKeyboard>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>

        <TouchableOpacity style={styles.avatarWrap} onPress={handlePickImage} activeOpacity={0.8}>
          <CachedAvatar
            source={avatar ? { uri: avatar } : null}
            style={styles.avatar}
          />
          <View style={styles.avatarBadge}>
            <IconSymbol name="camera.fill" size={14} color="#fff" />
          </View>
        </TouchableOpacity>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Display Name</Text>
          <TextInput
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            autoCapitalize="words"
            maxLength={60}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Bio</Text>
          <TextInput
            value={bio}
            onChangeText={setBio}
            placeholder="Tell people about yourself..."
            placeholderTextColor={theme.colors.textMuted}
            style={[styles.input, { height: 100, textAlignVertical: 'top' }]}
            multiline
            maxLength={256}
          />
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.button, styles.buttonSecondary]}
            onPress={onClose}
            disabled={saving}
          >
            <Text style={[styles.buttonLabel, { color: theme.colors.textMain }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.buttonPrimary]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.buttonLabel, { color: '#fff' }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(40),
      gap: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(20),
      fontWeight: '700',
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: Skin.space(-8),
    },
    avatarWrap: {
      alignSelf: 'center',
      marginVertical: Skin.space(12),
    },
    avatar: {
      width: 96,
      height: 96,
      borderRadius: Skin.radius(48),
      backgroundColor: theme.colors.surface2,
    },
    avatarBadge: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 30,
      height: 30,
      borderRadius: Skin.radius(15),
      backgroundColor: theme.colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
    field: {
      gap: Skin.space(6),
    },
    fieldLabel: {
      fontSize: Skin.font(13),
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    input: {
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface1,
    },
    actions: {
      flexDirection: 'row',
      gap: Skin.space(10),
      marginTop: Skin.space(12),
    },
    button: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonPrimary: {
      backgroundColor: theme.colors.accent,
    },
    buttonSecondary: {
      backgroundColor: theme.colors.surface2,
    },
    buttonLabel: {
      fontSize: Skin.font(15),
      fontWeight: '600',
    },
  });
}
