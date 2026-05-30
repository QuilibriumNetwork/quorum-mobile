/**
 * useTokenInfo — resolve a (chain, contractAddress) token reference to
 * display-ready info: name, symbol, USD price, 24h % change, icon, and a
 * thin 24h price-series for a sparkline.
 *
 * Data sources:
 *   - DexScreener  (name + symbol + price + 24h change + icon)        — free, no key
 *   - CoinGecko    (24h price series via the wallet's proxy)          — already wired
 *
 * Both calls run in parallel and degrade independently: a token without
 * a CoinGecko listing still renders price + change, just without the
 * sparkline; a token DexScreener doesn't know about renders nothing.
 *
 * Used by `FarcasterTokenEmbed` to render `farcaster.xyz/~/c/<chain>:<addr>`
 * URLs as inline token cards.
 */

import { useQuery } from '@tanstack/react-query';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens';
const PRICE_CHART_BASE = 'https://rpc-proxy.quorummessenger.com/api/price/chart';

// chain slug (from the farcaster URL) → CoinGecko platform slug. The wallet
// keeps its own map; duplicated here intentionally — feed shouldn't reach
// into wallet service internals.
const CHAIN_TO_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  polygon: 'polygon-pos',
  bsc: 'binance-smart-chain',
  zksync: 'zksync',
  linea: 'linea',
  scroll: 'scroll',
  blast: 'blast',
  avalanche: 'avalanche',
  gnosis: 'xdai',
  celo: 'celo',
  zora: 'zora',
  mantle: 'mantle',
  solana: 'solana',
};

export interface TokenInfo {
  chain: string;
  contractAddress: string;
  name: string;
  symbol: string;
  priceUsd: number | null;
  change24hPct: number | null;
  iconUrl?: string;
  liquidityUsd?: number;
  /** Last 24h of (ms, price) samples, normalized to ascending timestamp. */
  sparkline: { t: number; p: number }[];
}

async function fetchDexScreener(contractAddress: string, chain: string) {
  const res = await fetch(`${DEXSCREENER_BASE}/${contractAddress}`);
  if (!res.ok) return null;
  const json = await res.json();
  const pairs: any[] = json.pairs ?? [];
  if (pairs.length === 0) return null;
  // Prefer pairs on the requested chain when the address has cross-chain
  // listings; fall back to the first.
  const onChain = pairs.find((p) => p.chainId === chain) ?? pairs[0];
  const base = onChain.baseToken ?? {};
  const priceStr = onChain.priceUsd;
  const change = onChain.priceChange?.h24;
  return {
    name: typeof base.name === 'string' ? base.name : '',
    symbol: typeof base.symbol === 'string' ? base.symbol : '',
    priceUsd: priceStr != null ? Number(priceStr) : null,
    change24hPct: typeof change === 'number' ? change : null,
    iconUrl: onChain.info?.imageUrl as string | undefined,
    liquidityUsd: typeof onChain.liquidity?.usd === 'number' ? onChain.liquidity.usd : undefined,
  };
}

async function fetchCoinGecko24hChart(
  contractAddress: string,
  chain: string,
): Promise<{ t: number; p: number }[]> {
  const platform = CHAIN_TO_PLATFORM[chain];
  if (!platform) return [];
  // Solana addresses are case-sensitive base58; EVM hex is lowercase.
  const addr = platform === 'solana' ? contractAddress : contractAddress.toLowerCase();
  const url = `${PRICE_CHART_BASE}/${platform}/contract/${addr}?vs_currency=usd&days=1`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const prices: [number, number][] = json.prices ?? [];
  // Downsample to ~30 points so the sparkline draws quickly without
  // murdering each row in a list.
  if (prices.length <= 30) return prices.map(([t, p]) => ({ t, p }));
  const step = Math.ceil(prices.length / 30);
  return prices.filter((_, i) => i % step === 0).map(([t, p]) => ({ t, p }));
}

export async function fetchTokenInfo(
  chain: string,
  contractAddress: string,
): Promise<TokenInfo | null> {
  const [dex, chart] = await Promise.all([
    fetchDexScreener(contractAddress, chain),
    fetchCoinGecko24hChart(contractAddress, chain),
  ]);
  if (!dex) return null;
  return {
    chain,
    contractAddress,
    name: dex.name,
    symbol: dex.symbol,
    priceUsd: dex.priceUsd,
    change24hPct: dex.change24hPct,
    iconUrl: dex.iconUrl,
    liquidityUsd: dex.liquidityUsd,
    sparkline: chart,
  };
}

export function useTokenInfo(
  chain: string | undefined,
  contractAddress: string | undefined,
) {
  return useQuery({
    queryKey: ['token-info', { chain, contractAddress }] as const,
    queryFn: () => fetchTokenInfo(chain as string, contractAddress as string),
    enabled: Boolean(chain) && Boolean(contractAddress),
    // Token prices move; 60s is short enough to feel live, long enough to
    // dedupe duplicate renders of the same token across cells.
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });
}
