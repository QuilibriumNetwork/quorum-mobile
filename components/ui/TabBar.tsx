import React from 'react';
import { ScrollView, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme, type AppTheme } from '@/theme';
import { IconSymbol, type IconSymbolName } from './IconSymbol';
import * as Skin from '@/theme/skins/geometry';

type TabBarVariant = 'underline' | 'pill' | 'segmented';

interface Tab {
  /** Unique identifier */
  key: string;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: IconSymbolName;
}

interface TabBarProps {
  /** Array of tabs */
  tabs: Tab[];
  /** Currently active tab key */
  activeTab: string;
  /** Tab change handler */
  onTabChange: (key: string) => void;
  /** Visual variant */
  variant?: TabBarVariant;
  /** Enable horizontal scrolling for many tabs */
  scrollable?: boolean;
  /** Custom style */
  style?: ViewStyle;
  /** Test ID */
  testID?: string;
}

/**
 * Themed tab bar with multiple visual variants.
 *
 * @example
 * ```tsx
 * const tabs = [
 *   { key: 'profile', label: 'Profile' },
 *   { key: 'settings', label: 'Settings', icon: 'gear' },
 * ];
 *
 * <TabBar
 *   tabs={tabs}
 *   activeTab={activeTab}
 *   onTabChange={setActiveTab}
 *   variant="underline"
 * />
 * ```
 */
export function TabBar({
  tabs,
  activeTab,
  onTabChange,
  variant = 'underline',
  scrollable = false,
  style,
  testID,
}: TabBarProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme, variant);

  const renderTab = (tab: Tab) => {
    const isActive = tab.key === activeTab;

    return (
      <TouchableOpacity
        key={tab.key}
        onPress={() => onTabChange(tab.key)}
        style={[
          styles.tab,
          isActive && styles.tabActive,
        ]}
        activeOpacity={0.7}
      >
        {tab.icon && (
          <IconSymbol
            name={tab.icon}
            size={16}
            color={isActive ? styles.tabTextActive.color : styles.tabText.color}
            style={styles.tabIcon}
          />
        )}
        <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
          {tab.label}
        </Text>
      </TouchableOpacity>
    );
  };

  const content = tabs.map(renderTab);

  if (scrollable) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.scrollContainer, style]}
        contentContainerStyle={styles.scrollContent}
        testID={testID}
      >
        {content}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.container, style]} testID={testID}>
      {content}
    </View>
  );
}

const createStyles = (theme: AppTheme, variant: TabBarVariant) => {
  const isUnderline = variant === 'underline';
  const isPill = variant === 'pill';
  const isSegmented = variant === 'segmented';

  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      ...(isUnderline ? {
        borderBottomWidth: Skin.border(1),
        borderBottomColor: theme.colors.border,
      } : {}),
      ...(isSegmented ? {
        backgroundColor: theme.colors.surface2,
        borderRadius: Skin.radius(12),
        padding: Skin.space(4),
      } : {}),
    },
    scrollContainer: {
      flexGrow: 0,
    },
    scrollContent: {
      paddingHorizontal: isPill ? 0 : 0,
      gap: isPill ? 8 : 0,
    },
    tab: {
      flex: isSegmented ? 1 : (isPill ? undefined : 1),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: isPill ? 8 : 12,
      paddingHorizontal: isPill ? 16 : 0,
      ...(isUnderline ? {
        borderBottomWidth: Skin.border(2),
        borderBottomColor: 'transparent',
      } : {}),
      ...(isPill ? {
        backgroundColor: theme.colors.surface2,
        borderRadius: Skin.radius(20),
      } : {}),
      ...(isSegmented ? {
        borderRadius: Skin.radius(8),
      } : {}),
    },
    tabActive: {
      ...(isUnderline ? {
        borderBottomColor: theme.colors.primary,
      } : {}),
      ...(isPill ? {
        backgroundColor: theme.colors.primary,
      } : {}),
      ...(isSegmented ? {
        backgroundColor: theme.colors.background,
      } : {}),
    },
    tabText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textSubtle,
    },
    tabTextActive: {
      color: isPill ? '#ffffff' : theme.colors.primary,
    },
    tabIcon: {
      marginRight: Skin.space(6),
    },
  });
};

export default TabBar;
