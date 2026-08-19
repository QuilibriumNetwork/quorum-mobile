/**
 * TextSizeModal — the user's own text-size control.
 *
 * The sample at the top is a real chat row built from the same `body` /
 * `headline` / `caption1` tokens the message list uses, so it is a preview in
 * the literal sense: changing the step re-renders the whole app underneath this
 * sheet, and the sample changes with it because it is made of the same parts.
 * A hand-tuned mock would drift from the real thing the first time either was
 * touched.
 *
 * Why the "A" glyphs on the buttons are FIXED sizes and not scaled: they are a
 * legend, not app text. If they grew with the setting the control would resize
 * under the finger as you tapped along it, and the row would reflow — which
 * reads as a bug even though it is "correct". The same reasoning is why the
 * sample sits above the control rather than below it: the control must stay
 * still while the thing it controls moves.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { BaseModal } from '@/components/shared';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useAuth } from '@/context/AuthContext';
import { useResolvedName } from '@/identity';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { DEFAULT_TEXT_SIZE, TEXT_SIZE_STEPS, textSizeLabel } from '@/theme/textSize';

/** Fixed sizes for the legend glyphs, smallest → largest. Not scaled — see the
 *  file header. Length must match TEXT_SIZE_STEPS. */
const GLYPH_SIZES = [13, 15, 17, 20, 24];

export function TextSizeModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { theme, textSize, setTextSize } = useTheme();
  const { user } = useAuth();
  const s = styles(theme);
  // Resolved, not read raw off the profile. The chat labels a message with the
  // resolver's answer (QNS primary name first, then the profile name), so a
  // preview built from `user.displayName` would show a different label than the
  // messages it is previewing. `__tests__/rawNameFieldAudit.test.ts` enforces
  // this; it caught the raw version.
  const resolved = useResolvedName(user?.address ?? '');
  const sampleName = resolved?.trim() || 'You';
  const avatarUri = user?.profileImage?.trim() || undefined;

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.6}>
      <ScrollView contentContainerStyle={{ paddingBottom: Skin.space(32) }}>
        <Text style={s.title}>Text size</Text>
        <Text style={s.subtitle}>
          Changes the size of messages and posts. Names, dates, buttons and the rest of the app
          stay as they are. Your device&apos;s own text size setting still applies on top.
        </Text>

        {/* Live sample — the same tokens, and the same avatar components, the
            message list renders with. Addressed to the reader as themselves:
            showing their own name and face avoids inventing a person, and
            answers the question they actually have, which is what THEIR
            messages will look like. */}
        <View style={s.sampleCard}>
          {avatarUri ? (
            <CachedAvatar
              source={{ uri: avatarUri }}
              style={s.sampleAvatar}
              // Same name the else-branch draws, so a photo that fails to load
              // degrades to the identical initials rather than to something else.
              fallbackName={sampleName}
            />
          ) : (
            <DefaultAvatar resolvedName={sampleName} size={40} style={s.sampleAvatar} />
          )}
          <View style={s.sampleBody}>
            <View style={s.sampleHeader}>
              <Text style={s.sampleName} numberOfLines={1}>
                {sampleName}
              </Text>
              <Text style={s.sampleTime}>12:04</Text>
            </View>
            <Text style={s.sampleText}>
              This is how your messages will look. Pick the size that reads most comfortably.
            </Text>
          </View>
        </View>

        <View style={s.steps}>
          {TEXT_SIZE_STEPS.map((step, i) => {
            const selected = step.key === textSize;
            return (
              <TouchableOpacity
                key={step.key}
                style={[s.step, selected && s.stepSelected]}
                onPress={() => setTextSize(step.key)}
                accessibilityRole="button"
                accessibilityLabel={`Text size: ${step.label}`}
                accessibilityState={{ selected }}
              >
                <Text
                  style={[
                    s.stepGlyph,
                    { fontSize: GLYPH_SIZES[i] },
                    selected && s.stepGlyphSelected,
                  ]}
                >
                  A
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={s.currentLabel}>{textSizeLabel(textSize)}</Text>

        {textSize !== DEFAULT_TEXT_SIZE && (
          <TouchableOpacity
            style={s.reset}
            onPress={() => setTextSize(DEFAULT_TEXT_SIZE)}
            accessibilityRole="button"
            accessibilityLabel="Reset text size to default"
          >
            <Text style={s.resetText}>Reset to default</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </BaseModal>
  );
}

const styles = (theme: AppTheme) =>
  StyleSheet.create({
    title: {
      ...theme.textStyles.title3,
      color: theme.colors.textMain,
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(8),
    },
    subtitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(16),
    },
    sampleCard: {
      flexDirection: 'row',
      marginHorizontal: Skin.space(20),
      padding: Skin.space(14),
      borderRadius: Skin.radius(12),
      backgroundColor: theme.colors.surface3,
    },
    // 40 to match the message list exactly, and NOT scaled by the text size —
    // avatars are chrome, and Telegram's slider leaves them alone too.
    sampleAvatar: {
      width: 40,
      height: 40,
      borderRadius: Skin.circleOrSquare(20),
      marginRight: Skin.space(10),
    },
    sampleBody: {
      flex: 1,
    },
    sampleHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    // The sample MUST use the same tokens the message list uses, or the preview
    // stops previewing — it silently froze once already when message text moved
    // onto `messageBody` and this block was still on `body`.
    sampleName: {
      ...theme.textStyles.messageAuthor,
      color: theme.colors.textStrong,
      flexShrink: 1,
      marginRight: Skin.space(8),
    },
    // Deliberately NOT a message token: the timestamp is chrome, and showing it
    // holding still while the text around it grows is the clearest way to
    // convey what this setting does and does not touch.
    sampleTime: {
      ...theme.textStyles.caption1,
      color: theme.colors.textMuted,
    },
    sampleText: {
      ...theme.textStyles.messageBody,
      color: theme.colors.textMain,
      marginTop: Skin.space(4),
    },
    steps: {
      flexDirection: 'row',
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(24),
    },
    step: {
      flex: 1,
      // Fixed height, deliberately: the glyphs inside are fixed too, so the row
      // must not grow with the setting it sets.
      height: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: Skin.radius(10),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.borderDefault,
      backgroundColor: theme.colors.bgButtonSubtle,
    },
    stepSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accentSoft,
    },
    stepGlyph: {
      ...theme.fonts.semiBold,
      color: theme.colors.textSubtle,
    },
    stepGlyphSelected: {
      color: theme.colors.accent,
    },
    currentLabel: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textMain,
      textAlign: 'center',
      paddingTop: Skin.space(12),
    },
    reset: {
      alignSelf: 'center',
      paddingTop: Skin.space(16),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
    },
    resetText: {
      ...theme.textStyles.footnote,
      color: theme.colors.accent,
    },
  });

export default TextSizeModal;
