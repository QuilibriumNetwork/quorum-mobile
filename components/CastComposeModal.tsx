import { BaseModal } from '@/components/shared';
import {
  MentionAutocomplete,
  getMentionInfo,
  replaceMention,
} from '@/components/SocialFeed/MentionAutocomplete';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useFarcasterSubmitCast } from '@/hooks/useFarcasterSubmitCast';
import { uploadImageForCast } from '@/services/farcasterClient';
import { pickMedia, type ProcessedAttachment } from '@/services/media/imageAttachment';
import { uploadVideoForCast } from '@/services/farcaster/videoUpload';
import { useTheme, type AppTheme } from '@/theme';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface CastComposeModalProps {
  visible: boolean;
  onClose: () => void;
  /** Required token. The modal is gated on a valid Farcaster session. */
  token?: string;
  /** Optional channel target. When set, the modal posts the cast there. */
  channelKey?: string;
  /** Called once the cast has been posted (parent can refetch). */
  onPosted?: () => void;
}

const MAX_LENGTH = 320;

export default function CastComposeModal({
  visible,
  onClose,
  token,
  channelKey,
  onPosted,
}: CastComposeModalProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { submitCast } = useFarcasterSubmitCast({ token });

  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState<ProcessedAttachment[]>([]);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mentionInfo = useMemo(() => getMentionInfo(text, cursor), [text, cursor]);

  // Reset state on close
  useEffect(() => {
    if (!visible) {
      setText('');
      setAttachments([]);
      setPosting(false);
      setError(null);
    }
  }, [visible]);

  const canPost =
    !posting && Boolean(token) && (text.trim().length > 0 || attachments.length > 0);

  const handlePickMedia = async () => {
    if (attachments.length >= 2) return;
    const result = await pickMedia('library');
    if (result.success && result.attachment) {
      setAttachments((prev) => [...prev, result.attachment!]);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePost = async () => {
    if (!canPost || !token) return;
    setPosting(true);
    setError(null);
    try {
      const embeds: string[] = [];
      for (const a of attachments) {
        if (a.kind === 'video') {
          const v = await uploadVideoForCast(token, a.localUri);
          embeds.push(v.url);
        } else {
          const uploaded = await uploadImageForCast(token, a.localUri, a.mimeType);
          embeds.push(uploaded.url);
        }
      }
      await submitCast({
        text: text.trim(),
        embedUrls: embeds,
        channelKey,
      });
      onPosted?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to post cast');
    } finally {
      setPosting(false);
    }
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} avoidKeyboard>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} disabled={posting}>
            <Text style={[styles.cancelText, posting && styles.disabled]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{channelKey ? `Cast in /${channelKey}` : 'New cast'}</Text>
          <TouchableOpacity
            onPress={handlePost}
            disabled={!canPost}
            style={[styles.postButton, !canPost && styles.postButtonDisabled]}
          >
            {posting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.postText}>Post</Text>
            )}
          </TouchableOpacity>
        </View>

        <TextInput
          autoFocus
          multiline
          maxLength={MAX_LENGTH}
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)}
          placeholder={channelKey ? `What's on your mind in /${channelKey}?` : "What's happening?"}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.input}
          editable={!posting}
        />

        {mentionInfo && (
          <MentionAutocomplete
            mentionInfo={mentionInfo}
            token={token}
            theme={theme}
            onSelectUser={(u) => {
              const next = replaceMention(text, mentionInfo, u.username);
              setText(next);
              setCursor(mentionInfo.replaceStart + u.username.length + 1);
            }}
            onSelectChannel={(c) => {
              const next = replaceMention(text, mentionInfo, c.key);
              setText(next);
              setCursor(mentionInfo.replaceStart + c.key.length + 1);
            }}
          />
        )}

        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.imageRow} contentContainerStyle={{ gap: Skin.space(8) }}>
            {attachments.map((a, index) => (
              <View key={index} style={styles.imageWrap}>
                <Image source={{ uri: a.thumbnailLocalUri ?? a.localUri }} style={styles.image} />
                {a.kind === 'video' && (
                  <View style={styles.videoBadge}>
                    <IconSymbol name="play.fill" size={12} color="#fff" />
                  </View>
                )}
                <TouchableOpacity onPress={() => handleRemoveAttachment(index)} style={styles.removeImage}>
                  <IconSymbol name="xmark.circle.fill" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={styles.footer}>
          <TouchableOpacity onPress={handlePickMedia} style={styles.iconButton} disabled={posting || attachments.length >= 2}>
            <IconSymbol name="photo.fill" size={20} color={attachments.length >= 2 ? theme.colors.textMuted : theme.colors.accent} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <Text style={styles.charCount}>
            {text.length}/{MAX_LENGTH}
          </Text>
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}
      </ScrollView>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(40),
      gap: Skin.space(12),
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(6),
    },
    title: {
      fontSize: Skin.font(15),
      fontWeight: '600',
      color: theme.colors.textStrong,
      flex: 1,
      textAlign: 'center',
      marginHorizontal: Skin.space(12),
    },
    cancelText: {
      color: theme.colors.textSubtle,
      fontSize: Skin.font(15),
    },
    disabled: {
      opacity: 0.5,
    },
    postButton: {
      backgroundColor: theme.colors.accent,
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(14),
      minWidth: 56,
      alignItems: 'center',
    },
    postButtonDisabled: {
      opacity: 0.4,
    },
    postText: {
      color: '#fff',
      fontWeight: '600',
      fontSize: Skin.font(14),
    },
    input: {
      minHeight: 100,
      maxHeight: 240,
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      textAlignVertical: 'top',
      padding: 0,
    },
    imageRow: {
      maxHeight: 110,
    },
    imageWrap: {
      position: 'relative',
    },
    image: {
      width: 100,
      height: 100,
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
    },
    videoBadge: {
      position: 'absolute',
      bottom: 4,
      left: 4,
      backgroundColor: 'rgba(0,0,0,0.6)',
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(4),
      paddingVertical: Skin.space(2),
    },
    removeImage: {
      position: 'absolute',
      top: 4,
      right: 4,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
      paddingTop: Skin.space(4),
    },
    iconButton: {
      padding: Skin.space(4),
    },
    charCount: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
    },
    errorText: {
      color: theme.colors.danger,
      fontSize: Skin.font(12),
      marginTop: Skin.space(4),
    },
  });
}
