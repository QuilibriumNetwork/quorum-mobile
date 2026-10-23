import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { FarcasterLogoIcon } from '@/components/ui/FarcasterLogoIcon';
import { SegmentedPills } from '@/components/ui/SegmentedPills';
import { useAuth } from '@/context';
import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { getAddedMiniapps, type AddedMiniapp } from '@/services/miniapp/addedMiniapps';
import { getRecentMiniapps, recordMiniappUse, type RecentMiniapp } from '@/services/miniapp/recentMiniapps';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Dimensions, FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { SizedImage } from '@/components/ui/SizedImage';
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

// Launcher tabs: All (discovery), Saved (favorites + locally added),
// Recently used (device-local usage history).
type LauncherTab = 'all' | 'saved' | 'recent';

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

const { width: SCREEN_WIDTH } = Dimensions.get('window');
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

/**
 * The discover list ("All"), cached so coming back to this screen doesn't
 * fetch it again. It changes slowly, and the screen remounts every time the
 * Wallet tab switches to Mini Apps, which refetched it each time.
 */
export const TOP_MINIAPPS_QUERY_KEY = ['miniapps', 'top-frameapps'] as const;
const TOP_MINIAPPS_STALE_MS = 60 * 60 * 1000;
const TOP_MINIAPPS_GC_MS = 6 * 60 * 60 * 1000;

async function fetchTopFrames(): Promise<ApiFrame[]> {
  const response = await fetch(`${FARCASTER_API_BASE}/v1/top-frameapps?limit=50`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  const data: TopFramesResponse = await response.json();
  // Filter out apps that require Base chain, or are authored by excluded creators
  return data.result.frames.filter(
    frame => !requiresBase(frame) && !isExcludedAuthor(frame),
  );
}

// Convert a locally-stored added/recent entry into the display MiniApp shape.
const localToMiniApp = (e: {
  domain: string;
  url: string;
  name?: string;
  iconUrl?: string;
}): MiniApp => ({
  id: e.domain,
  name: e.name ?? e.domain,
  // Use the domain as a subtitle only when there's a distinct display name;
  // otherwise it duplicates the name line (domain shown twice). Discovery
  // enrichment fills a real description when the app is known.
  description: e.name && e.name !== e.domain ? e.domain : '',
  category: 'social',
  url: e.url,
  icon: e.iconUrl ? { uri: e.iconUrl } : null,
  featured: false,
  requiresFarcaster: false,
  isQNative: false,
});

// Tolerantly pull frame objects out of the favorite-frames response, whose
// exact shape isn't contractually documented. Accepts result.frames /
// favoriteFrames / apps, and entries that are either a frame or {frame}.
function extractFavoriteFrames(data: unknown): ApiFrame[] {
  const result =
    (data as { result?: Record<string, unknown> })?.result ??
    (data as Record<string, unknown>) ??
    {};
  const arr =
    (result as { frames?: unknown }).frames ??
    (result as { favoriteFrames?: unknown }).favoriteFrames ??
    (result as { apps?: unknown }).apps ??
    [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) =>
      it && typeof it === 'object' && 'frame' in it
        ? (it as { frame: ApiFrame }).frame
        : (it as ApiFrame),
    )
    .filter((f): f is ApiFrame => Boolean(f && (f.homeUrl || f.domain)));
}

export default function MiniAppsModal({ visible, onClose, onOpenMiniApp, isRouteMode = false, noTopInset = false }: MiniAppsModalProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { farcasterAuthToken } = useAuth();
  const [activeTab, setActiveTab] = useState<LauncherTab>('all');
  const floatingTabBarPadding = useFloatingTabBarPadding();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MiniApp[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // "Saved" tab: farcaster.xyz favorites (best-effort) merged with the
  // locally-added apps. "Recently used": device-local usage history.
  const [favoriteApps, setFavoriteApps] = useState<MiniApp[]>([]);
  const [isFavLoading, setIsFavLoading] = useState(false);
  const [localAdded, setLocalAdded] = useState<AddedMiniapp[]>([]);
  const [recentList, setRecentList] = useState<RecentMiniapp[]>([]);
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

  // Top frames from the Farcaster API
  const topFrames = useQuery({
    queryKey: TOP_MINIAPPS_QUERY_KEY,
    queryFn: fetchTopFrames,
    enabled: visible,
    staleTime: TOP_MINIAPPS_STALE_MS,
    gcTime: TOP_MINIAPPS_GC_MS,
    retry: 1,
  });
  const miniApps = useMemo(
    () => (topFrames.data ?? []).map((frame, index) => frameToMiniApp(frame, index, true)),
    [topFrames.data, frameToMiniApp],
  );
  const isLoading = topFrames.isLoading;
  // A failed refresh keeps showing the list it already has.
  const error =
    topFrames.error && !topFrames.data ? topFrames.error.message || 'Failed to fetch apps' : null;

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

  // Load device-local stores when shown / when switching tabs so freshly
  // added or used apps appear without a remount.
  useEffect(() => {
    if (!visible) return;
    setLocalAdded(getAddedMiniapps());
    setRecentList(getRecentMiniapps());
  }, [visible, activeTab]);

  // Fetch the user's farcaster.xyz favorites for the "Saved" tab. Best-effort
  // and auth-gated — failures fall back to the locally-added apps, so this
  // never blocks the tab from rendering.
  useEffect(() => {
    if (!visible) return;
    if (!farcasterAuthToken) {
      setFavoriteApps([]);
      return;
    }
    let cancelled = false;
    const fetchFavorites = async () => {
      setIsFavLoading(true);
      try {
        const response = await fetch(
          'https://farcaster.xyz/~api/v1/favorite-frames?limit=50',
          { headers: { Authorization: `Bearer ${farcasterAuthToken}` } },
        );
        if (!response.ok) throw new Error(`favorites ${response.status}`);
        const data = await response.json();
        const frames = extractFavoriteFrames(data).filter((f) => !isExcludedAuthor(f));
        if (!cancelled) setFavoriteApps(frames.map((f, i) => frameToMiniApp(f, i, false)));
      } catch {
        if (!cancelled) setFavoriteApps([]);
      } finally {
        if (!cancelled) setIsFavLoading(false);
      }
    };
    void fetchFavorites();
    return () => {
      cancelled = true;
    };
  }, [visible, farcasterAuthToken, frameToMiniApp]);

  // Discovery apps (top-frames + featured) carry full metadata: real name,
  // icon, and requiresFarcaster. Locally-added / recent / sparse-favorite
  // entries often only have a domain, so enrich them from discovery when the
  // domain (id) matches — backfilling name, icon, and the Farcaster flag the
  // saved/recent rows would otherwise be missing.
  const discoveryById = useMemo(() => {
    const map = new Map<string, MiniApp>();
    for (const a of miniApps) map.set(a.id, a);
    return map;
  }, [miniApps]);

  const enrichFromDiscovery = useCallback((app: MiniApp): MiniApp => {
    const rich = discoveryById.get(app.id);
    if (!rich) return app;
    return {
      ...app,
      // Prefer the entry's own real name; fall back to discovery when the entry
      // only had its domain (name === domain) or nothing.
      name: app.name && app.name !== app.id ? app.name : rich.name,
      icon: app.icon ?? rich.icon,
      requiresFarcaster: app.requiresFarcaster || rich.requiresFarcaster,
      isQNative: app.isQNative || rich.isQNative,
      description: app.description && app.description !== app.id ? app.description : rich.description,
    };
  }, [discoveryById]);

  // Saved = favorites first (richer metadata), then locally-added apps not
  // already represented, deduped by domain (id). All enriched from discovery.
  const savedApps = useMemo(() => {
    const byId = new Map<string, MiniApp>();
    for (const a of favoriteApps) byId.set(a.id, a);
    for (const a of localAdded.map(localToMiniApp)) if (!byId.has(a.id)) byId.set(a.id, a);
    return Array.from(byId.values()).map(enrichFromDiscovery);
  }, [favoriteApps, localAdded, enrichFromDiscovery]);

  const recentApps = useMemo(
    () => recentList.map(localToMiniApp).map(enrichFromDiscovery),
    [recentList, enrichFromDiscovery],
  );

  // Use search results if searching, otherwise show all apps
  const isSearchMode = debouncedQuery.length > 0;

  const filteredApps = isSearchMode ? searchResults : miniApps;

  const featuredApps = miniApps.filter(app => app.featured).slice(0, 5);

  const handleAppPress = (app: MiniApp) => {
    // Record rich metadata so the Recently-used tab shows a real name/icon
    // (opening via the overlay only carries the URL).
    recordMiniappUse({ url: app.url, name: app.name, iconUrl: app.icon?.uri });
    // In route mode, don't close - just open the mini app
    // In modal mode, close the modal first
    if (!isRouteMode) {
      onClose();
    }
    onOpenMiniApp?.(app.url, app.isQNative);
  };

  // A single app card in the grid — shared by All / Saved / Recently used.
  const renderAppCard = (app: MiniApp) => (
    <TouchableOpacity
      key={app.id}
      style={styles.appCard}
      onPress={() => handleAppPress(app)}
    >
      {(app.requiresFarcaster || app.isQNative) && (
        <View style={styles.appCardBadge}>
          {app.requiresFarcaster ? (
            <FarcasterLogoIcon size={14} color={theme.colors.textMuted} />
          ) : (
            <IconSymbol name="lock.fill" size={13} color={theme.colors.textMuted} />
          )}
        </View>
      )}
      <View style={styles.appIconContainer}>
        {app.icon ? (
          <SizedImage uri={app.icon.uri} displayWidth={APP_ICON_SIZE} style={styles.appIcon} />
        ) : (
          <View style={styles.appIconPlaceholder}>
            <Text style={styles.iconPlaceholderText}>{app.name.charAt(0)}</Text>
          </View>
        )}
      </View>
      <Text style={styles.appName} numberOfLines={2}>{app.name}</Text>
      {app.description ? (
        <Text style={styles.appDescription} numberOfLines={2}>{app.description}</Text>
      ) : null}
    </TouchableOpacity>
  );

  // The two-column grid of app cards. A list, so only the rows on screen and
  // a couple of screens either side are mounted: 50 cards and their icons
  // used to load at once.
  const renderAppsGrid = (
    apps: MiniApp[],
    header: React.ReactElement | null,
    empty: React.ReactElement,
  ) => (
    <FlatList
      data={apps}
      keyExtractor={(app) => app.id}
      renderItem={({ item }) => renderAppCard(item)}
      numColumns={2}
      columnWrapperStyle={styles.appsGridRow}
      ItemSeparatorComponent={AppsGridRowGap}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={<View style={styles.appsGridFooter} />}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={5}
      showsVerticalScrollIndicator={false}
      style={styles.scrollContent}
      contentContainerStyle={isRouteMode ? { paddingBottom: floatingTabBarPadding } : undefined}
    />
  );

  // Grid body for the local tabs (Saved / Recently used), with loading +
  // empty states.
  const renderLocalTab = (
    apps: MiniApp[],
    loading: boolean,
    emptyTitle: string,
    emptyText: string,
  ) =>
    renderAppsGrid(
      apps,
      null,
      loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <View style={styles.emptyState}>
          <IconSymbol name="square.grid.2x2" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyStateTitle}>{emptyTitle}</Text>
          <Text style={styles.emptyStateText}>{emptyText}</Text>
        </View>
      ),
    );

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

      {/* All | Saved | Recently used */}
      <View style={styles.tabSwitcher}>
        <SegmentedPills
          variant="segmented"
          scrollable={false}
          items={[
            { key: 'all', label: 'All' },
            { key: 'saved', label: 'Saved' },
            { key: 'recent', label: 'Recent', accessibilityLabel: 'Recently used' },
          ]}
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as LauncherTab)}
        />
      </View>

      {activeTab === 'all' && (
        <>
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
              void topFrames.refetch();
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {!isLoading && !error && renderAppsGrid(
        filteredApps,
        <>
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
                    onPress={() => handleAppPress(app)}
                    activeOpacity={0.9}
                  >
                    {app.bannerImage ? (
                      <SizedImage
                        uri={app.bannerImage.uri}
                        displayWidth={FEATURED_CARD_WIDTH}
                        style={styles.featuredBannerImage}
                        contentFit="cover"
                      />
                    ) : app.icon ? (
                      <View style={styles.featuredIconBackground}>
                        <SizedImage uri={app.icon.uri} displayWidth={80} style={styles.featuredIconLarge} />
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
                                <FarcasterLogoIcon size={8} color="#fff" />
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
        </>,
        <View style={styles.emptyState}>
          <IconSymbol name="magnifyingglass" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyStateTitle}>No apps found</Text>
          <Text style={styles.emptyStateText}>
            Try adjusting your search or filters
          </Text>
        </View>,
      )}
        </>
      )}

      {activeTab === 'saved' &&
        renderLocalTab(
          savedApps,
          isFavLoading,
          'No saved apps',
          'Apps you favorite or add here will show up.',
        )}

      {activeTab === 'recent' &&
        renderLocalTab(
          recentApps,
          false,
          'Nothing recent',
          'Mini apps you open will appear here.',
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

const APP_ICON_SIZE = 56;
const FEATURED_CARD_WIDTH = SCREEN_WIDTH - 52;
const appCardSize = () => (SCREEN_WIDTH - 2 * Skin.space(20) - Skin.space(12)) / 2;

/** Space between grid rows. */
function AppsGridRowGap() {
  return <View style={{ height: Skin.space(12) }} />;
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
    tabSwitcher: {
      marginHorizontal: Skin.space(20),
      marginBottom: Skin.space(16),
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
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
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
      width: FEATURED_CARD_WIDTH,
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
    appsGridRow: {
      gap: Skin.space(12),
    },
    appsGridFooter: {
      height: Skin.space(20),
    },
    appCard: {
      // Two to a row: the screen less the list's side padding and the gap.
      width: appCardSize(),
      height: appCardSize(),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    },
    // Farcaster / lock badge pinned to the top-right of the whole app card.
    // Bare Farcaster/lock glyph (theme-muted) pinned to the card's bottom-right.
    // No circle background — a repeated row of purple circles read too heavy.
    appCardBadge: {
      position: 'absolute',
      bottom: Skin.space(8),
      right: Skin.space(8),
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1,
    },
    appIconContainer: {
      width: APP_ICON_SIZE,
      height: APP_ICON_SIZE,
      marginBottom: Skin.space(10),
      position: 'relative',
    },
    appIcon: {
      width: APP_ICON_SIZE,
      height: APP_ICON_SIZE,
      borderRadius: Skin.radius(14),
    },
    appIconPlaceholder: {
      width: APP_ICON_SIZE,
      height: APP_ICON_SIZE,
      borderRadius: Skin.radius(14),
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
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(8),
      textAlign: 'center',
      lineHeight: Skin.font(17),
    },
    appIconBadgeQNative: {
      backgroundColor: theme.colors.info,
    },
    appStats: {
      flexDirection: 'row',
      gap: Skin.space(8),
      marginBottom: Skin.space(6),
    },
    smallStatText: {
      fontSize: Skin.font(10),
      color: theme.colors.textSubtle,
    },
    authBadge: {
      width: 18,
      height: 18,
      borderRadius: Skin.circleOrSquare(9),
      backgroundColor: '#855DCD',
      alignItems: 'center',
      justifyContent: 'center',
    },
    authBadgeQNative: {
      backgroundColor: theme.colors.info,
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
      color: theme.colors.textSubtle,
      textAlign: 'center',
    },
  });
