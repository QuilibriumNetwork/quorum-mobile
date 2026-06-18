import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Dimensions, Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface MiniAppsModalProps {
  visible: boolean;
  onClose: () => void;
  onOpenMiniApp?: (url: string, isQNative: boolean) => void;
  isRouteMode?: boolean;
  /** Skip the route-mode top safe-area inset when nested under a host
   *  that already accounts for the status bar (e.g. the Wallet/Mini
   *  Apps segmented switcher). Without this the inset would double up. */
  noTopInset?: boolean;
}

// Farcaster API response types
interface ApiFrame {
  domain: string;
  name: string;
  iconUrl?: string;
  homeUrl: string;
  imageUrl?: string;
  splashImageUrl?: string;
  splashBackgroundColor?: string;
  author?: {
    fid: number;
    username?: string;
    displayName?: string;
  };
  requiredChains?: string[];  // e.g. ["eip155:8453"] for Base
}

interface TopFramesResponse {
  result: {
    frames: ApiFrame[];
  };
  next?: {
    cursor?: string;
  };
}

interface SearchMiniAppsResponse {
  result: {
    apps: ApiFrame[];
  };
  next?: {
    cursor?: string;
  };
}

// Internal app type for display
interface MiniApp {
  id: string;
  name: string;
  description: string;
  category: string;
  url: string;
  icon: { uri: string } | null;
  bannerImage?: { uri: string };
  users?: string;
  rating?: number;
  featured: boolean;
  requiresFarcaster: boolean;
  isQNative: boolean;
  author?: string;
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const FARCASTER_API_BASE = 'https://client.warpcast.com';
const BASE_CHAIN_ID = 'eip155:8453';

// Check if an app requires Base chain
const requiresBase = (frame: ApiFrame): boolean => {
  return frame.requiredChains?.some(chain => chain === BASE_CHAIN_ID) ?? false;
};

// Creators excluded from the discover list
const EXCLUDED_AUTHORS = new Set<string>(['hypercat']);

const isExcludedAuthor = (frame: ApiFrame): boolean => {
  const username = frame.author?.username?.toLowerCase();
  return Boolean(username && EXCLUDED_AUTHORS.has(username));
};

export default function MiniAppsModal({ visible, onClose, onOpenMiniApp, isRouteMode = false, noTopInset = false }: MiniAppsModalProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { farcasterAuthToken } = useAuth();
  const floatingTabBarPadding = useFloatingTabBarPadding();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [miniApps, setMiniApps] = useState<MiniApp[]>([]);
  const [searchResults, setSearchResults] = useState<MiniApp[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const styles = createStyles(theme, isDark, insets);

  // Debounce search query
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (searchQuery.trim().length === 0) {
      setDebouncedQuery('');
      setSearchResults([]);
      return;
    }

    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim());
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);


  // Convert API frame to MiniApp format
  const frameToMiniApp = useCallback((frame: ApiFrame, index: number, isFeatured: boolean = false): MiniApp => ({
    id: frame.domain,
    name: frame.name,
    description: frame.author?.displayName
      ? `by ${frame.author.displayName}`
      : frame.domain,
    category: 'social', // Default category
    url: frame.homeUrl,
    icon: frame.iconUrl ? { uri: frame.iconUrl } : null,
    bannerImage: frame.splashImageUrl ? { uri: frame.splashImageUrl } : undefined,
    featured: isFeatured && index < 5, // First 5 are featured
    requiresFarcaster: true, // Farcaster frames require Farcaster
    isQNative: false,
    author: frame.author?.username,
  }), []);

  // Fetch top frames from Farcaster API
  useEffect(() => {
    if (!visible) return;

    const fetchTopFrames = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `${FARCASTER_API_BASE}/v1/top-frameapps?limit=50`
        );

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data: TopFramesResponse = await response.json();

        // Filter out apps that require Base chain, or are authored by excluded creators
        const filteredFrames = data.result.frames.filter(
          frame => !requiresBase(frame) && !isExcludedAuthor(frame),
        );

        const apps = filteredFrames.map((frame, index) => frameToMiniApp(frame, index, true));
        setMiniApps(apps);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch apps');
      } finally {
        setIsLoading(false);
      }
    };

    fetchTopFrames();
  }, [visible, frameToMiniApp]);

  // Search mini apps via API
  useEffect(() => {
    if (!debouncedQuery) {
      setSearchResults([]);
      return;
    }

    if (!farcasterAuthToken) {
      setSearchResults([]);
      return;
    }

    const searchMiniApps = async () => {
      setIsSearching(true);

      try {
        const response = await fetch(
          `https://farcaster.xyz/~api/v1/search-miniapps?limit=20&query=${encodeURIComponent(debouncedQuery)}`,
          {
            headers: {
              'Authorization': `Bearer ${farcasterAuthToken}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Search API error: ${response.status}`);
        }

        const data: SearchMiniAppsResponse = await response.json();

        // Filter out apps that require Base chain
        const filteredApps = (data.result.apps || []).filter(
          frame => !requiresBase(frame) && !isExcludedAuthor(frame),
        );

        const apps = filteredApps.map((frame, index) => frameToMiniApp(frame, index, false));
        setSearchResults(apps);
      } catch (err) {
        // Don't set error for search, just show empty results
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    };

    searchMiniApps();
  }, [debouncedQuery, frameToMiniApp, farcasterAuthToken]);

  // Use search results if searching, otherwise show all apps
  const isSearchMode = debouncedQuery.length > 0;

  const filteredApps = isSearchMode ? searchResults : miniApps;

  const featuredApps = miniApps.filter(app => app.featured).slice(0, 5);

  const handleAppPress = (url: string, isQNative: boolean) => {
    // In route mode, don't close - just open the mini app
    // In modal mode, close the modal first
    if (!isRouteMode) {
      onClose();
    }
    onOpenMiniApp?.(url, isQNative);
  };

  const miniAppsContent = (
    <>
      {/* Title is owned by the parent tab header now (wallet/index.tsx).
          Modal-mode callers still need a visible title since they don't
          carry their own header — show it only when not in route mode. */}
      {!isRouteMode && (
        <View style={styles.header}>
          <Text style={styles.title}>Mini Apps</Text>
        </View>
      )}

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <IconSymbol name="magnifyingglass" size={16} color={theme.colors.textMuted} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search mini apps..."
          placeholderTextColor={theme.colors.textMuted}
          style={styles.searchInput}
        />
        {isSearching && (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        )}
        {searchQuery.length > 0 && !isSearching && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <IconSymbol name="xmark.circle.fill" size={16} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>


      {/* Loading State */}
      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Loading apps...</Text>
        </View>
      )}

      {/* Error State */}
      {error && !isLoading && (
        <View style={styles.errorContainer}>
          <IconSymbol name="exclamationmark.triangle" size={48} color={theme.colors.warning} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              // Trigger re-fetch by toggling visibility effect
              setError(null);
              setIsLoading(true);
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {!isLoading && !error && (
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={styles.scrollContent}
          contentContainerStyle={isRouteMode ? { paddingBottom: floatingTabBarPadding } : undefined}
        >
          {/* Featured Section - hide during search */}
          {!isSearchMode && featuredApps.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Featured</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.featuredContainer}
              >
                {featuredApps.map(app => (
                  <TouchableOpacity
                    key={app.id}
                    style={styles.featuredCard}
                    onPress={() => handleAppPress(app.url, app.isQNative)}
                    activeOpacity={0.9}
                  >
                    {app.bannerImage ? (
                      <Image source={app.bannerImage} style={styles.featuredBannerImage} />
                    ) : app.icon ? (
                      <View style={styles.featuredIconBackground}>
                        <Image source={app.icon} style={styles.featuredIconLarge} />
                      </View>
                    ) : null}
                    <LinearGradient
                      colors={['transparent', 'rgba(0, 0, 0, 0.8)']}
                      style={styles.featuredOverlay}
                    />
                    <View style={styles.featuredContent}>
                      <View style={styles.featuredTextContainer}>
                        <Text style={styles.featuredName} numberOfLines={1}>{app.name}</Text>
                        <Text style={styles.featuredDescription} numberOfLines={2}>
                          {app.description}
                        </Text>
                      </View>
                      <View style={styles.featuredBottomRow}>
                        <View style={styles.featuredStats}>
                          {app.author && (
                            <Text style={styles.featuredStatText}>@{app.author}</Text>
                          )}
                        </View>
                        {(app.requiresFarcaster || app.isQNative) && (
                          <View style={styles.featuredAuthBadge}>
                            <View style={[styles.authBadge, app.isQNative && styles.authBadgeQNative]}>
                              {app.requiresFarcaster ? (
                                <Image
                                  source={require('../assets/images/farcaster.png')}
                                  style={styles.authBadgeIcon}
                                />
                              ) : (
                                <IconSymbol
                                  name="lock.fill"
                                  size={8}
                                  color="#ffffff"
                                />
                              )}
                            </View>
                          </View>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}

          {/* Apps Grid */}
          <Text style={styles.sectionTitle}>
            {isSearchMode
              ? `Search Results${searchResults.length > 0 ? ` (${searchResults.length})` : ''}`
              : 'All Apps'}
          </Text>
          <View style={styles.appsGrid}>
            {filteredApps.map(app => (
              <TouchableOpacity
                key={app.id}
                style={styles.appCard}
                onPress={() => handleAppPress(app.url, app.isQNative)}
              >
                <View style={styles.appIconContainer}>
                  {app.icon ? (
                    <Image source={app.icon} style={styles.appIcon} />
                  ) : (
                    <View style={styles.appIconPlaceholder}>
                      <Text style={styles.iconPlaceholderText}>{app.name.charAt(0)}</Text>
                    </View>
                  )}
                  {(app.requiresFarcaster || app.isQNative) && (
                    <View style={[styles.appIconBadge, app.isQNative && styles.appIconBadgeQNative]}>
                      {app.requiresFarcaster ? (
                        <Image
                          source={require('../assets/images/farcaster.png')}
                          style={styles.appIconBadgeIcon}
                        />
                      ) : (
                        <IconSymbol
                          name="lock.fill"
                          size={8}
                          color="#ffffff"
                        />
                      )}
                    </View>
                  )}
                </View>
                <Text style={styles.appName} numberOfLines={2}>{app.name}</Text>
                <Text style={styles.appDescription} numberOfLines={2}>
                  {app.description}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {filteredApps.length === 0 && (
            <View style={styles.emptyState}>
              <IconSymbol name="magnifyingglass" size={48} color={theme.colors.textMuted} />
              <Text style={styles.emptyStateTitle}>No apps found</Text>
              <Text style={styles.emptyStateText}>
                Try adjusting your search or filters
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </>
  );

  // In route mode, render directly without modal wrapper. Suppress the
  // top safe-area inset when the host has its own header above (e.g.
  // the Wallet/Mini Apps segmented switcher) so the inset isn't doubled.
  if (isRouteMode) {
    return (
      <View style={[styles.routeContainer, { paddingTop: noTopInset ? 0 : insets.top, backgroundColor: theme.colors.surface1 }]}>
        {miniAppsContent}
      </View>
    );
  }

  // In modal mode, wrap with BaseModal
  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height={0.9}
    >
      {miniAppsContent}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    routeContainer: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(24),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      marginHorizontal: Skin.space(20),
      marginBottom: Skin.space(16),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(8),
      gap: Skin.space(8),
    },
    searchInput: {
      flex: 1,
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    scrollContent: {
      paddingHorizontal: Skin.space(20),
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: Skin.space(48),
    },
    loadingText: {
      marginTop: Skin.space(16),
      fontSize: Skin.font(16),
      color: theme.colors.textMuted,
    },
    errorContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: Skin.space(48),
      paddingHorizontal: Skin.space(20),
    },
    errorText: {
      marginTop: Skin.space(16),
      fontSize: Skin.font(16),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    retryButton: {
      marginTop: Skin.space(16),
      paddingHorizontal: Skin.space(24),
      paddingVertical: Skin.space(12),
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(8),
    },
    retryButtonText: {
      color: '#ffffff',
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    sectionTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(12),
      marginTop: Skin.space(8),
    },
    featuredContainer: {
      marginBottom: Skin.space(24),
    },
    featuredCard: {
      width: Dimensions.get('window').width - 52,
      height: 180,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(16),
      marginRight: Skin.space(12),
      overflow: 'hidden',
      position: 'relative',
    },
    featuredBannerImage: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
      resizeMode: 'cover',
    },
    featuredIconBackground: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
    },
    featuredIconLarge: {
      width: 80,
      height: 80,
      borderRadius: Skin.radius(20),
    },
    featuredOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    featuredContent: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      padding: Skin.space(16),
      justifyContent: 'flex-end',
    },
    featuredTextContainer: {
      marginBottom: Skin.space(8),
    },
    featuredBottomRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    featuredAuthBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
    },
    featuredName: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#ffffff',
      marginBottom: Skin.space(4),
    },
    featuredDescription: {
      fontSize: Skin.font(14),
      color: '#ffffffcc',
      lineHeight: Skin.font(18),
    },
    featuredStats: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    featuredStatText: {
      fontSize: Skin.font(12),
      color: '#ffffff99',
    },
    statItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
    },
    appsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(12),
      marginBottom: Skin.space(20),
    },
    appCard: {
      width: (Dimensions.get('window').width - 52) / 2,
      height: (Dimensions.get('window').width - 52) / 2,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      alignItems: 'center',
      justifyContent: 'center',
    },
    appIconContainer: {
      width: 48,
      height: 48,
      marginBottom: Skin.space(10),
      position: 'relative',
    },
    appIcon: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(12),
    },
    appIconPlaceholder: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(12),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconPlaceholderText: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    appName: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(4),
      textAlign: 'center',
      lineHeight: Skin.font(20),
    },
    appDescription: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      textAlign: 'center',
      lineHeight: Skin.font(17),
    },
    appIconBadge: {
      position: 'absolute',
      top: -2,
      right: -2,
      width: 16,
      height: 16,
      borderRadius: Skin.radius(8),
      backgroundColor: '#8B5CF6',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(1),
      borderColor: theme.colors.background,
    },
    appIconBadgeQNative: {
      backgroundColor: theme.colors.info,
    },
    appIconBadgeIcon: {
      width: 10,
      height: 10,
      padding: Skin.space(1),
      resizeMode: 'contain',
    },
    appStats: {
      flexDirection: 'row',
      gap: Skin.space(8),
      marginBottom: Skin.space(6),
    },
    smallStatText: {
      fontSize: Skin.font(10),
      color: theme.colors.textMuted,
    },
    authBadge: {
      width: 14,
      height: 14,
      borderRadius: Skin.radius(7),
      backgroundColor: '#8B5CF6',
      alignItems: 'center',
      justifyContent: 'center',
    },
    authBadgeQNative: {
      backgroundColor: theme.colors.info,
    },
    authBadgeIcon: {
      width: 10,
      height: 10,
      padding: Skin.space(1),
      resizeMode: 'contain',
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: Skin.space(48),
    },
    emptyStateTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginTop: Skin.space(16),
      marginBottom: Skin.space(8),
    },
    emptyStateText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
  });
