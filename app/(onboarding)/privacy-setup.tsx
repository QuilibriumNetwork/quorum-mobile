/**
 * Privacy Setup - Step 4 of Onboarding
 *
 * User must select a privacy level:
 * - Maximum: Full Q-routing, no external connections
 * - Enhanced: Q-routing with link resolution
 * - Standard: Direct connections with optional private mode
 */

import { OnboardingLayout, StepNavigation } from '@/components/onboarding';
import { Card } from '@/components/ui/Card';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useOnboarding } from '@/context';
import type { PrivacyLevel } from '@/context/OnboardingContext';
import { useTheme, type AppTheme } from '@/theme';
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface PrivacyOption {
  level: PrivacyLevel;
  title: string;
  description: string;
  icon: IconSymbolName;
  features: string[];
  recommended?: boolean;
}

const PRIVACY_OPTIONS: PrivacyOption[] = [
  {
    level: 'enhanced',
    title: 'Enhanced Privacy',
    description: 'Privacy protection with convenience features.',
    icon: 'shield.checkered',
    features: [
      'Traffic routed through Q network',
      'Link previews enabled',
      'External images loaded',
      'Good balance of privacy and usability',
    ],
    recommended: true,
  },
  {
    level: 'maximum',
    title: 'Maximum Privacy',
    description: 'Full anonymity with Q-routing. No external connections.',
    icon: 'lock.shield.fill',
    features: [
      'All traffic routed through Q network',
      'No link previews or external fetches',
      'IP address never exposed',
      'Strongest metadata protection',
    ],
  },
  {
    level: 'standard',
    title: 'Standard',
    description: 'Direct connections with optional private mode.',
    icon: 'globe',
    features: [
      'Direct connections to services',
      'Full link and media previews',
      'Private mode toggle available',
      'Best performance',
    ],
  },
];

export default function PrivacySetupScreen() {
  const { theme } = useTheme();
  const { state, goBack, goToStep } = useOnboarding();
  const [selectedLevel, setSelectedLevel] = useState<PrivacyLevel>(state.privacyLevel ?? 'enhanced');
  const styles = createStyles(theme);

  const handleSelect = (level: PrivacyLevel) => {
    setSelectedLevel(level);
  };

  const handleContinue = useCallback(() => {
    // Set privacy level and navigate to complete screen in a single state update
    // This prevents the save effect from firing with stale currentStep
    goToStep('complete', { privacyLevel: selectedLevel });
  }, [selectedLevel, goToStep]);

  return (
    <OnboardingLayout currentStep="privacy-setup">
      <View style={styles.header}>
        <View style={styles.iconContainer}>
          <IconSymbol name="hand.raised.fill" size={32} color={theme.colors.primary} />
        </View>
        <Text style={styles.title}>Privacy Preferences</Text>
        <Text style={styles.subtitle}>
          Choose how Quorum handles your connections and data. You can change this later in settings.
        </Text>
      </View>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.options}>
          {PRIVACY_OPTIONS.map((option) => {
            const isSelected = selectedLevel === option.level;

            return (
              <TouchableOpacity
                key={option.level}
                onPress={() => handleSelect(option.level)}
                activeOpacity={0.7}
              >
                <Card
                  variant="bordered"
                  style={[
                    styles.optionCard,
                    isSelected ? styles.optionCardSelected : undefined,
                  ]}
                >
                  <View style={styles.optionHeader}>
                    <View style={[
                      styles.optionIconContainer,
                      isSelected ? styles.optionIconContainerSelected : undefined,
                    ]}>
                      <IconSymbol
                        name={option.icon}
                        size={24}
                        color={isSelected ? theme.colors.primary : theme.colors.textMuted}
                      />
                    </View>

                    <View style={styles.optionTitleColumn}>
                      <Text style={[
                        styles.optionTitle,
                        isSelected ? styles.optionTitleSelected : undefined,
                      ]}>
                        {option.title}
                      </Text>
                      {option.recommended && (
                        <View style={styles.recommendedBadge}>
                          <Text style={styles.recommendedText}>Recommended</Text>
                        </View>
                      )}
                    </View>

                    <View style={[
                      styles.radioOuter,
                      isSelected ? styles.radioOuterSelected : undefined,
                    ]}>
                      {isSelected && <View style={styles.radioInner} />}
                    </View>
                  </View>

                  <Text style={styles.optionDescription}>{option.description}</Text>

                  <View style={styles.featureList}>
                    {option.features.map((feature, idx) => (
                      <View key={idx} style={styles.featureItem}>
                        <IconSymbol
                          name="checkmark"
                          size={12}
                          color={isSelected ? theme.colors.primary : theme.colors.textMuted}
                        />
                        <Text style={[
                          styles.featureText,
                          isSelected ? styles.featureTextSelected : undefined,
                        ]}>
                          {feature}
                        </Text>
                      </View>
                    ))}
                  </View>
                </Card>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      <StepNavigation
        onBack={goBack}
        onNext={handleContinue}
        nextLabel="Continue"
        nextDisabled={!selectedLevel}
      />
    </OnboardingLayout>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    header: {
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(32),
      backgroundColor: theme.colors.primary + '20',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(24),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textAlign: 'center',
      marginBottom: Skin.space(8),
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(20),
      paddingHorizontal: Skin.space(16),
    },
    scrollView: {
      flex: 1,
    },
    options: {
      gap: Skin.space(12),
      paddingBottom: Skin.space(16),
    },
    optionCard: {
      padding: Skin.space(16),
      borderWidth: Skin.border(2),
      borderColor: 'transparent',
    },
    optionCardSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primary + '08',
    },
    optionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(12),
    },
    optionIconContainer: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: Skin.space(12),
    },
    optionIconContainerSelected: {
      backgroundColor: theme.colors.primary + '20',
    },
    optionTitleColumn: {
      flex: 1,
      flexDirection: 'column',
      justifyContent: 'center',
      gap: Skin.space(4),
    },
    optionTitle: {
      fontSize: Skin.font(16),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    optionTitleSelected: {
      color: theme.colors.primary,
    },
    recommendedBadge: {
      alignSelf: 'flex-start',
      backgroundColor: theme.colors.primary + '20',
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(4),
    },
    recommendedText: {
      fontSize: Skin.font(10),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      textTransform: 'uppercase',
    },
    radioOuter: {
      width: 22,
      height: 22,
      borderRadius: Skin.radius(11),
      borderWidth: Skin.border(2),
      borderColor: theme.colors.textMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOuterSelected: {
      borderColor: theme.colors.primary,
    },
    radioInner: {
      width: 12,
      height: 12,
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.primary,
    },
    optionDescription: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      marginBottom: Skin.space(12),
      lineHeight: Skin.font(20),
    },
    featureList: {
      gap: Skin.space(6),
    },
    featureItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    featureText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    featureTextSelected: {
      color: theme.colors.textSubtle,
    },
  });
