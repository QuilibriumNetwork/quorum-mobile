/**
 * FarcasterTokenEmbed — renders `farcaster.xyz/~/c/<chain>:<address>` token
 * references as an inline card with name, symbol, current USD price, 24h
 * % change, and a thin 24h sparkline. Tap opens the original farcaster.xyz
 * URL so the user can route to their preferred wallet/DEX UI.
 *
 * Data via `useTokenInfo` — DexScreener for the labels + price + change,
 * CoinGecko (via proxy) for the sparkline. Both degrade independently:
 * a missing CoinGecko listing just suppresses the chart, not the card.
 */

import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSwapModal } from '@/context/SwapModalContext';
import { useTokenInfo } from '@/hooks/useTokenInfo';
import type { AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

// chain slug (from the farcaster URL) → EVM chainId expected by SwapModal.
// SwapModal accepts arbitrary chainIds but its viem-client map covers only
// the major EVM chains, so we mirror that set here. An unmapped chain
// falls through to the URL-only fallback (we can't open a swap for it).
const CHAIN_TO_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  bsc: 56,
  zksync: 324,
  linea: 59144,
  scroll: 534352,
  blast: 81457,
  avalanche: 43114,
  gnosis: 100,
  celo: 42220,
  zora: 7777777,
  mantle: 5000,
};

const SPARKLINE_W = 96;
const SPARKLINE_H = 32;

function formatPriceUsd(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return '—';
  if (price >= 1000) return `$${(price / 1000).toFixed(1)}k`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  // Sub-cent: decimal form capped at 6 places. Scientific notation looks
  // broken in a token card; truncating precision on ultra-low prices is
  // the lesser evil.
  return `$${price.toFixed(6)}`;
}

function formatChange(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function buildSparklinePath(points: { t: number; p: number }[]): string | null {
  if (points.length < 2) return null;
  const prices = points.map((pt) => pt.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const stepX = SPARKLINE_W / (points.length - 1);
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const x = i * stepX;
    const y = SPARKLINE_H - ((points[i].p - min) / range) * SPARKLINE_H;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)} `;
  }
  return d.trim();
}

export function FarcasterTokenEmbed({
  chain,
  contractAddress,
  theme,
  onPress,
}: {
  chain: string;
  contractAddress: string;
  theme: AppTheme;
  /** Optional override. Default: navigate to the Wallet tab with the
   *  token preloaded as the swap buy target. */
  onPress?: () => void;
}) {
  const { data, isLoading } = useTokenInfo(chain, contractAddress);
  const { openSwap } = useSwapModal();

  const handlePress = React.useCallback(() => {
    if (onPress) {
      onPress();
      return;
    }
    const chainId = CHAIN_TO_CHAIN_ID[chain];
    if (!chainId) return;
    // JSON shape SwapModal's `initialBuyToken` expects. Stays an overlay
    // — no tab navigation, so the feed scroll/state is preserved.
    openSwap(JSON.stringify({ address: contractAddress, chainId }));
  }, [onPress, openSwap, chain, contractAddress]);

  const containerStyle = {
    backgroundColor: theme.colors.surface2,
    borderRadius: Skin.radius(12),
    padding: Skin.space(12),
    marginHorizontal: Skin.space(12),
    borderWidth: Skin.border(1),
    borderColor: theme.colors.surface3,
  };

  if (isLoading && !data) {
    return (
      <View
        style={{
          ...containerStyle,
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(8),
        }}
      >
        <ActivityIndicator size="small" color={theme.colors.textMuted} />
        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(13) }}>
          Loading token…
        </Text>
      </View>
    );
  }

  // No DexScreener data — fall back to a minimal "open token" link card so
  // the user can still navigate. Hide the embed entirely would hide that
  // the cast referenced a token at all.
  if (!data) {
    return (
      <Pressable
        style={({ pressed }) => [
          containerStyle,
          { opacity: pressed ? 0.8 : 1 },
        ]}
        onPress={handlePress}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(8) }}>
          <IconSymbol name="bitcoinsign.circle" color={theme.colors.accent} size={18} />
          <Text
            style={{ color: theme.colors.textStrong, fontSize: Skin.font(13), flex: 1 }}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            Token on {chain}: {contractAddress}
          </Text>
          <IconSymbol name="chevron.right" color={theme.colors.textMuted} size={14} />
        </View>
      </Pressable>
    );
  }

  const change = data.change24hPct;
  const changeColor =
    change == null
      ? theme.colors.textMuted
      : change >= 0
        ? theme.colors.success
        : theme.colors.danger;
  const sparkPath = buildSparklinePath(data.sparkline);

  return (
    <Pressable
      style={({ pressed }) => [
        containerStyle,
        { opacity: pressed ? 0.8 : 1 },
      ]}
      onPress={handlePress}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(10) }}>
        <CachedAvatar
          source={data.iconUrl ? { uri: data.iconUrl } : null}
          style={{
            width: 32,
            height: 32,
            borderRadius: Skin.radius(16),
            backgroundColor: theme.colors.surface3,
          }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: Skin.space(6) }}>
            <Text
              style={{ color: theme.colors.textStrong, fontWeight: '600', fontSize: Skin.font(14) }}
              numberOfLines={1}
            >
              {data.name || data.symbol || 'Token'}
            </Text>
            {data.symbol && (
              <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12) }} numberOfLines={1}>
                {data.symbol}
              </Text>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: Skin.space(6), marginTop: Skin.space(2) }}>
            <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(13) }}>
              {formatPriceUsd(data.priceUsd)}
            </Text>
            {change != null && (
              <Text style={{ color: changeColor, fontSize: Skin.font(12) }}>
                {formatChange(change)}
              </Text>
            )}
          </View>
        </View>
        {sparkPath && (
          <Svg width={SPARKLINE_W} height={SPARKLINE_H}>
            <Path
              d={sparkPath}
              stroke={changeColor}
              strokeWidth={1.5}
              fill="none"
            />
          </Svg>
        )}
      </View>
    </Pressable>
  );
}
