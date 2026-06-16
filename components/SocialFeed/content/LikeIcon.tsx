/**
 * LikeIcon - Dynamic like icon based on cast content
 *
 * Renders different icons based on trigger keywords in the cast text.
 */

import { IconSymbol } from '@/components/ui/IconSymbol';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { QuilibriumLogoIcon } from './QuilibriumLogoIcon';
import { QuorumLogoIcon } from './QuorumLogoIcon';

export enum LikeIconType {
  Standard = 'standard',
  GM = 'gm',
  GA = 'ga',
  GN = 'gn',
  QM = 'qm',
  QA = 'qa',
  QN = 'qn',
  RM = 'rm',
  FM = 'fm',
  NounGlasses = 'nouns',
  WOWOW = 'wowow',
  Degen = 'degen',
  RainbowWallet = 'rainbow',
  W = 'w',
  Quilibrium = 'quilibrium',
  Quorum = 'quorum',
}

interface TriggerRule {
  type: LikeIconType;
  test: (text: string) => boolean;
}

/**
 * Trigger rules for determining like icon type.
 * Rules are evaluated in order - first match wins.
 */
const TRIGGER_RULES: TriggerRule[] = [
  // Highest priority - Quilibrium and Quorum
  { type: LikeIconType.Quilibrium, test: (t) => /quilibrium/i.test(t) },
  { type: LikeIconType.Quorum, test: (t) => /quorum/i.test(t) },

  // Greeting triggers - match as standalone word anywhere in text
  { type: LikeIconType.GM, test: (t) => /\bgm\b/i.test(t) },
  { type: LikeIconType.GA, test: (t) => /\bga\b/i.test(t) },
  { type: LikeIconType.GN, test: (t) => /\bgn\b/i.test(t) },
  { type: LikeIconType.QM, test: (t) => /\bqm\b/i.test(t) },
  { type: LikeIconType.QA, test: (t) => /\bqa\b/i.test(t) },
  { type: LikeIconType.QN, test: (t) => /\bqn\b/i.test(t) },
  { type: LikeIconType.RM, test: (t) => /\brm\b/i.test(t) },
  { type: LikeIconType.FM, test: (t) => /\bfm\b/i.test(t) },

  // Content triggers
  { type: LikeIconType.NounGlasses, test: (t) => t.includes('⌐◨-◨') },
  { type: LikeIconType.WOWOW, test: (t) => /wowow/i.test(t) },
  { type: LikeIconType.RainbowWallet, test: (t) => /rainbow/i.test(t) || t.includes('🌈') },
  { type: LikeIconType.Degen, test: (t) => /\$degen/i.test(t) },
  { type: LikeIconType.W, test: (t) => /\bwarpcast(?!\.com)\b/i.test(t) },
];

/**
 * Determine the like icon type based on cast text
 */
export function getLikeIconType(text: string): LikeIconType {
  for (const rule of TRIGGER_RULES) {
    if (rule.test(text)) {
      return rule.type;
    }
  }
  return LikeIconType.Standard;
}

interface LikeIconProps {
  type: LikeIconType;
  isLiked: boolean;
  color: string;
  activeColor: string;
  size: number;
}

/**
 * Renders the appropriate like icon based on type
 */
export function LikeIcon({ type, isLiked, color, activeColor, size }: LikeIconProps) {
  const displayColor = isLiked ? activeColor : color;

  switch (type) {
    case LikeIconType.Quilibrium:
      return <QuilibriumLogoIcon size={size} opacity={isLiked ? 1 : 0.6} />;

    case LikeIconType.Quorum:
      return <QuorumLogoIcon size={size} opacity={isLiked ? 1 : 0.6} />;

    case LikeIconType.GM:
      return <BoldText text="GM" color={displayColor} size={size} />;

    case LikeIconType.GA:
      return <BoldText text="GA" color={displayColor} size={size} />;

    case LikeIconType.GN:
      return <BoldText text="GN" color={displayColor} size={size} />;

    case LikeIconType.QM:
      return <BoldText text="QM" color={displayColor} size={size} />;

    case LikeIconType.QA:
      return <BoldText text="QA" color={displayColor} size={size} />;

    case LikeIconType.QN:
      return <BoldText text="QN" color={displayColor} size={size} />;

    case LikeIconType.RM:
      return <BoldText text="RM" color={displayColor} size={size} />;

    case LikeIconType.FM:
      return <BoldText text="FM" color={displayColor} size={size} />;

    case LikeIconType.NounGlasses:
      return <BoldText text="⌐◨-◨" color={displayColor} size={size} letterSpacing={-1} />;

    case LikeIconType.WOWOW:
      return <WowowIcon color={displayColor} size={size} />;

    case LikeIconType.Degen:
      return <TopHatIcon color={displayColor} size={size} />;

    case LikeIconType.RainbowWallet:
      return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: size * 0.8, lineHeight: size }}>🌈</Text>
        </View>
      );

    case LikeIconType.W:
      return <BoldText text="W" color={displayColor} size={size} />;

    case LikeIconType.Standard:
    default:
      return (
        <IconSymbol
          name={isLiked ? 'heart.fill' : 'heart'}
          color={displayColor}
          size={size}
        />
      );
  }
}

/**
 * Bold text icon component. Constrained to a `size × size` box so the
 * rendered text occupies the same visual footprint as the heart
 * SF Symbol — previously `fontSize: size` made glyphs taller/wider
 * than the icon box (a 16pt "GM" reads visibly bigger than a 16pt
 * heart). The 0.62 factor brings cap-height roughly in line with the
 * heart's bounding box across our common sizes.
 */
function BoldText({ text, color, size, letterSpacing }: { text: string; color: string; size: number; letterSpacing?: number }) {
  const fontSize = size * 0.78;
  return (
    // Box height matches `size` so vertical alignment with adjacent
    // icons/counts is consistent. Width is intrinsic to the text so a
    // two-letter glyph isn't ellipsized when fontSize rounding puts
    // it a hair over the heart's bounding box.
    <View
      style={{
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color,
          fontSize,
          fontWeight: '900',
          lineHeight: fontSize * 1.1,
          letterSpacing,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * WOWOW icon - WOW on top, OW underneath centered
 */
function WowowIcon({ color, size }: { color: string; size: number }) {
  const fontSize = size * 0.55;
  return (
    <View style={styles.wowowContainer}>
      <Text style={[styles.wowowText, { color, fontSize, lineHeight: fontSize * 1.1 }]}>
        WOW
      </Text>
      <Text style={[styles.wowowText, { color, fontSize: fontSize * 0.85, lineHeight: fontSize * 0.95 }]}>
        OW
      </Text>
    </View>
  );
}

/**
 * Top hat icon for Degen
 */
function TopHatIcon({ color, size }: { color: string; size: number }) {
  const crownWidth = size * 0.6;
  const crownHeight = size * 0.7;
  const brimWidth = size * 1.1;
  const brimHeight = Math.max(size * 0.12, 2);
  const bandHeight = Math.max(size * 0.1, 1.5);

  return (
    <View style={[styles.topHatContainer, { width: brimWidth, height: size }]}>
      {/* Crown */}
      <View
        style={{
          width: crownWidth,
          height: crownHeight,
          backgroundColor: color,
          borderTopLeftRadius: crownWidth * 0.15,
          borderTopRightRadius: crownWidth * 0.15,
        }}
      />
      {/* Band */}
      <View
        style={{
          width: crownWidth,
          height: bandHeight,
          backgroundColor: color,
          opacity: 0.6,
        }}
      />
      {/* Brim */}
      <View
        style={{
          width: brimWidth,
          height: brimHeight,
          backgroundColor: color,
          borderRadius: brimHeight / 2,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wowowContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  wowowText: {
    fontWeight: '900',
    textAlign: 'center',
  },
  topHatContainer: {
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
});

export default LikeIcon;
