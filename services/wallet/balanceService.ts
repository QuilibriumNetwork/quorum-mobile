/**
 * Multi-chain balance fetching service
 *
 * Fetches native and token balances from:
 * - EVM chains via Alchemy API
 * - Bitcoin via Blockstream API
 * - Solana via native RPC
 */

import { formatUnits } from 'viem';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { blake2b } from '@noble/hashes/blake2.js';
import { InteractionManager } from 'react-native';
import { getLocalTokenIconUri } from './tokenIcons';

// In-flight request deduplication to prevent duplicate API calls
const inFlightRequests = new Map<string, Promise<any>>();

function deduplicatedFetch<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fetchFn().finally(() => {
    inFlightRequests.delete(key);
  });

  inFlightRequests.set(key, promise);
  return promise;
}

/**
 * Delay helper for spacing out requests
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute async tasks in concurrent batches to balance speed vs rate limiting.
 * Processes `batchSize` items in parallel, then waits `delayMs` before the next batch.
 * Yields to UI thread between batches.
 */
async function runInBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  batchSize: number = 5,
  delayMs: number = 100
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => fn(item).catch(() => null as any as R))
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }

    // Delay + yield between batches
    if (i + batchSize < items.length) {
      await delay(delayMs);
      await new Promise<void>(resolve => {
        InteractionManager.runAfterInteractions(() => resolve());
      });
    }
  }

  return results;
}

// RPC Proxy base URL - all external API calls go through this
const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';

// Chain configuration with Alchemy endpoint slugs and native token info
interface ChainConfig {
  chainId: number;
  alchemySlug: string;
  nativeSymbol: string;
  nativeDecimals: number;
  displayName: string;
  /** Whether this chain supports Alchemy's Enhanced APIs (alchemy_getTokenBalances) */
  supportsTokenApi: boolean;
  /** Whether this chain supports basic EVM RPC (eth_getBalance). Non-EVM chains like Starknet/Aptos don't. */
  supportsEvmRpc: boolean;
}

// All supported EVM chains via Alchemy
// supportsTokenApi: true = chain supports alchemy_getTokenBalances (Enhanced API)
// supportsEvmRpc: true = chain supports eth_getBalance (basic EVM RPC)
export const EVM_CHAINS: Record<string, ChainConfig> = {
  // Chains with full Token API support
  ethereum: { chainId: 1, alchemySlug: 'eth-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Ethereum', supportsTokenApi: true, supportsEvmRpc: true },
  base: { chainId: 8453, alchemySlug: 'base-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Base', supportsTokenApi: true, supportsEvmRpc: true },
  arbitrum: { chainId: 42161, alchemySlug: 'arb-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Arbitrum', supportsTokenApi: true, supportsEvmRpc: true },
  optimism: { chainId: 10, alchemySlug: 'opt-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'OP Mainnet', supportsTokenApi: true, supportsEvmRpc: true },
  polygon: { chainId: 137, alchemySlug: 'polygon-mainnet', nativeSymbol: 'POL', nativeDecimals: 18, displayName: 'Polygon', supportsTokenApi: true, supportsEvmRpc: true },
  bsc: { chainId: 56, alchemySlug: 'bnb-mainnet', nativeSymbol: 'BNB', nativeDecimals: 18, displayName: 'BNB Chain', supportsTokenApi: true, supportsEvmRpc: true },
  zksync: { chainId: 324, alchemySlug: 'zksync-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'ZKsync', supportsTokenApi: true, supportsEvmRpc: true },
  arbnova: { chainId: 42170, alchemySlug: 'arbnova-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Arbitrum Nova', supportsTokenApi: true, supportsEvmRpc: true },
  linea: { chainId: 59144, alchemySlug: 'linea-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Linea', supportsTokenApi: true, supportsEvmRpc: true },
  zora: { chainId: 7777777, alchemySlug: 'zora-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Zora', supportsTokenApi: true, supportsEvmRpc: true },
  scroll: { chainId: 534352, alchemySlug: 'scroll-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Scroll', supportsTokenApi: true, supportsEvmRpc: true },
  blast: { chainId: 81457, alchemySlug: 'blast-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Blast', supportsTokenApi: true, supportsEvmRpc: true },
  worldchain: { chainId: 480, alchemySlug: 'worldchain-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'World Chain', supportsTokenApi: true, supportsEvmRpc: true },
  shape: { chainId: 360, alchemySlug: 'shape-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Shape', supportsTokenApi: true, supportsEvmRpc: true },
  zetachain: { chainId: 7000, alchemySlug: 'zetachain-mainnet', nativeSymbol: 'ZETA', nativeDecimals: 18, displayName: 'ZetaChain', supportsTokenApi: true, supportsEvmRpc: true },
  berachain: { chainId: 80094, alchemySlug: 'berachain-mainnet', nativeSymbol: 'BERA', nativeDecimals: 18, displayName: 'Berachain', supportsTokenApi: true, supportsEvmRpc: true },
  gnosis: { chainId: 100, alchemySlug: 'gnosis-mainnet', nativeSymbol: 'xDAI', nativeDecimals: 18, displayName: 'Gnosis', supportsTokenApi: true, supportsEvmRpc: true },
  avalanche: { chainId: 43114, alchemySlug: 'avax-mainnet', nativeSymbol: 'AVAX', nativeDecimals: 18, displayName: 'Avalanche', supportsTokenApi: true, supportsEvmRpc: true },
  celo: { chainId: 42220, alchemySlug: 'celo-mainnet', nativeSymbol: 'CELO', nativeDecimals: 18, displayName: 'Celo', supportsTokenApi: true, supportsEvmRpc: true },
  abstract: { chainId: 2741, alchemySlug: 'abstract-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Abstract', supportsTokenApi: true, supportsEvmRpc: true },
  unichain: { chainId: 130, alchemySlug: 'unichain-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Unichain', supportsTokenApi: true, supportsEvmRpc: true },
  ink: { chainId: 57073, alchemySlug: 'ink-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Ink', supportsTokenApi: true, supportsEvmRpc: true },
  apechain: { chainId: 33139, alchemySlug: 'apechain-mainnet', nativeSymbol: 'APE', nativeDecimals: 18, displayName: 'ApeChain', supportsTokenApi: true, supportsEvmRpc: true },
  hyperevm: { chainId: 999, alchemySlug: 'hyperliquid-mainnet', nativeSymbol: 'HYPE', nativeDecimals: 18, displayName: 'HyperEVM', supportsTokenApi: true, supportsEvmRpc: true },

  // Chains with basic EVM RPC only (no Enhanced API / Token API support)
  monad: { chainId: 10143, alchemySlug: 'monad-mainnet', nativeSymbol: 'MON', nativeDecimals: 18, displayName: 'Monad', supportsTokenApi: false, supportsEvmRpc: true },
  astar: { chainId: 592, alchemySlug: 'astar-mainnet', nativeSymbol: 'ASTR', nativeDecimals: 18, displayName: 'Astar', supportsTokenApi: false, supportsEvmRpc: true },
  polygonzkevm: { chainId: 1101, alchemySlug: 'polygonzkevm-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Polygon zkEVM', supportsTokenApi: false, supportsEvmRpc: true },
  mantle: { chainId: 5000, alchemySlug: 'mantle-mainnet', nativeSymbol: 'MNT', nativeDecimals: 18, displayName: 'Mantle', supportsTokenApi: false, supportsEvmRpc: true },
  rootstock: { chainId: 30, alchemySlug: 'rootstock-mainnet', nativeSymbol: 'RBTC', nativeDecimals: 18, displayName: 'Rootstock', supportsTokenApi: false, supportsEvmRpc: true },
  story: { chainId: 1514, alchemySlug: 'story-mainnet', nativeSymbol: 'IP', nativeDecimals: 18, displayName: 'Story', supportsTokenApi: false, supportsEvmRpc: true },
  humanity: { chainId: 1942, alchemySlug: 'humanity-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Humanity', supportsTokenApi: false, supportsEvmRpc: true },
  frax: { chainId: 252, alchemySlug: 'frax-mainnet', nativeSymbol: 'frxETH', nativeDecimals: 18, displayName: 'Frax', supportsTokenApi: false, supportsEvmRpc: true },
  botanix: { chainId: 3637, alchemySlug: 'botanix-mainnet', nativeSymbol: 'BTC', nativeDecimals: 18, displayName: 'Botanix', supportsTokenApi: false, supportsEvmRpc: true },
  boba: { chainId: 288, alchemySlug: 'boba-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Boba', supportsTokenApi: false, supportsEvmRpc: true },
  flow: { chainId: 747, alchemySlug: 'flow-mainnet', nativeSymbol: 'FLOW', nativeDecimals: 18, displayName: 'Flow EVM', supportsTokenApi: false, supportsEvmRpc: true },
  degen: { chainId: 666666666, alchemySlug: 'degen-mainnet', nativeSymbol: 'DEGEN', nativeDecimals: 18, displayName: 'Degen', supportsTokenApi: false, supportsEvmRpc: true },
  mode: { chainId: 34443, alchemySlug: 'mode-mainnet', nativeSymbol: 'ETH', nativeDecimals: 18, displayName: 'Mode', supportsTokenApi: false, supportsEvmRpc: true },
  moonbeam: { chainId: 1284, alchemySlug: 'moonbeam-mainnet', nativeSymbol: 'GLMR', nativeDecimals: 18, displayName: 'Moonbeam', supportsTokenApi: false, supportsEvmRpc: true },
  sonic: { chainId: 146, alchemySlug: 'sonic-mainnet', nativeSymbol: 'S', nativeDecimals: 18, displayName: 'Sonic', supportsTokenApi: false, supportsEvmRpc: true },
  sei: { chainId: 1329, alchemySlug: 'sei-mainnet', nativeSymbol: 'SEI', nativeDecimals: 18, displayName: 'Sei', supportsTokenApi: false, supportsEvmRpc: true },
  anime: { chainId: 69000, alchemySlug: 'anime-mainnet', nativeSymbol: 'ANIME', nativeDecimals: 18, displayName: 'Anime', supportsTokenApi: false, supportsEvmRpc: true },
};

// Build Alchemy RPC endpoints from chain config (via proxy)
// The proxy expects: /api/alchemy/{chainId}/rpc for JSON-RPC calls
const ALCHEMY_ENDPOINTS: Record<string, string> = Object.fromEntries(
  Object.entries(EVM_CHAINS)
    .filter(([_, config]) => config.chainId > 0) // Skip non-EVM chains
    .map(([chain, config]) => [
      chain,
      `${RPC_PROXY_BASE}/api/alchemy/${config.chainId}/rpc`,
    ])
);

// Helper to get NFT endpoint for a chain
function getAlchemyNftEndpoint(chain: string): string | null {
  const config = EVM_CHAINS[chain];
  if (!config || config.chainId === 0) return null;
  return `${RPC_PROXY_BASE}/api/alchemy/${config.chainId}/nfts`;
}

// Non-EVM chain endpoints (via proxy)
// Proxy expects: /api/solana/rpc for JSON-RPC calls
const SOLANA_RPC = `${RPC_PROXY_BASE}/api/solana/rpc`;
const BITCOIN_API = `${RPC_PROXY_BASE}/api/bitcoin`;

// Fallback decimals for well-known tokens, keyed by lowercase contract
// address (when Alchemy metadata is unavailable). Without this, a failed
// metadata fetch falls back to 18 and misformats non-18-decimal balances.
const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  '0x8143182a775c54578c8b7b3ef77982498866945d': 8, // wQUIL on Ethereum
  '0x49b5a631f54927c0007232844f06fe18cbf69786': 6, // SNAP on Ethereum
};

// Fallback icons for well-known tokens (when Alchemy doesn't provide one)
const KNOWN_TOKEN_ICONS: Record<string, string> = {
  // Stablecoins
  USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
  USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  DAI: 'https://assets.coingecko.com/coins/images/9956/small/dai-multi-collateral-mcd.png',
  BUSD: 'https://assets.coingecko.com/coins/images/9576/small/BUSD.png',
  FRAX: 'https://assets.coingecko.com/coins/images/13422/small/FRAX_icon.png',
  LUSD: 'https://assets.coingecko.com/coins/images/14666/small/Group_3.png',
  // Wrapped tokens
  WETH: 'https://assets.coingecko.com/coins/images/2518/small/weth.png',
  WBTC: 'https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png',
  stETH: 'https://assets.coingecko.com/coins/images/13442/small/steth_logo.png',
  wstETH: 'https://assets.coingecko.com/coins/images/18834/small/wstETH.png',
  cbETH: 'https://assets.coingecko.com/coins/images/27008/small/cbeth.png',
  rETH: 'https://assets.coingecko.com/coins/images/20764/small/reth.png',
  // DeFi tokens
  UNI: 'https://assets.coingecko.com/coins/images/12504/small/uni.jpg',
  AAVE: 'https://assets.coingecko.com/coins/images/12645/small/AAVE.png',
  LINK: 'https://assets.coingecko.com/coins/images/877/small/chainlink-new-logo.png',
  CRV: 'https://assets.coingecko.com/coins/images/12124/small/Curve.png',
  MKR: 'https://assets.coingecko.com/coins/images/1364/small/Mark_Maker.png',
  COMP: 'https://assets.coingecko.com/coins/images/10775/small/COMP.png',
  SNX: 'https://assets.coingecko.com/coins/images/3406/small/SNX.png',
  LDO: 'https://assets.coingecko.com/coins/images/13573/small/Lido_DAO.png',
  // Meme/Social
  DEGEN: 'https://assets.coingecko.com/coins/images/34515/small/degen.png',
  PEPE: 'https://assets.coingecko.com/coins/images/29850/small/pepe-token.jpeg',
  SHIB: 'https://assets.coingecko.com/coins/images/11939/small/shiba.png',
};

/** USDC icon for surfaces that render it outside a balance row (e.g. the
 *  Apex token picker — wQUIL/SNAP ship bundled icons, USDC does not). */
export const USDC_ICON_URL = KNOWN_TOKEN_ICONS.USDC;

export interface TokenBalance {
  symbol: string;
  name: string;
  balance: string;
  balanceRaw: string;
  decimals: number;
  usdValue?: string;
  priceChange24h?: number; // Percentage change in last 24h
  chain: string;
  contractAddress?: string;
  logoUrl?: string;
}

export interface ChainBalance {
  chain: string;
  nativeBalance: string;
  nativeBalanceRaw: string;
  nativeSymbol: string;
  nativeDecimals: number;
  nativeUsdValue?: string;
  nativePriceChange24h?: number; // Percentage change in last 24h
  nativeIconUrl?: string; // Token icon URL from CoinGecko
  tokens: TokenBalance[];
  usdValue?: string;
  // Pending balance info (mainly for Bitcoin)
  pendingBalanceRaw?: string; // Unconfirmed balance in smallest units (positive = incoming, negative = outgoing)
  confirmedBalanceRaw?: string; // Confirmed balance in smallest units
}

// Dynamic wallet balances - keys are chain IDs
export interface WalletBalances {
  [chainId: string]: ChainBalance | null | undefined;
}

// NFT interfaces
export interface NFT {
  tokenId: string;
  name: string;
  description?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  chain: string;
  chainName: string;
  contractAddress: string;
  collectionName?: string;
  /** EVM (ERC-721/1155) or Tezos (FA2). Send paths branch on this. */
  tokenType: 'ERC721' | 'ERC1155' | 'FA2';
}

export interface NFTCollection {
  [chainId: string]: NFT[];
}

// Chains that support NFT API
const NFT_SUPPORTED_CHAINS = [
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'zksync', 'linea', 'scroll', 'blast', 'zora', 'shape', 'apechain', 'berachain', 'abstract', 'worldchain',
];

// 12MB ceiling: normal wallets are 5-10MB/chain; a misbehaving collection
// (e.g. on-chain SVG with multi-MB metadata) can balloon to 50+MB and OOM.
const NFT_RESPONSE_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Fetch NFTs for an address on a single chain
 */
async function fetchNFTsForChain(address: string, chain: string): Promise<NFT[]> {
  const config = EVM_CHAINS[chain];
  if (!NFT_SUPPORTED_CHAINS.includes(chain)) return [];

  const nftEndpoint = getAlchemyNftEndpoint(chain);
  if (!nftEndpoint) return [];

  try {
    // Proxy expects POST /api/alchemy/{chainId}/nfts with address in body
    const response = await fetch(nftEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return [];
    }

    // Defensive size cap before .json() materializes the payload.
    // BlobModule allocates a contiguous byte array sized to the whole
    // body, so a 50 MB response causes a 50 MB allocation even before
    // JSON parsing starts. Aborting at the header lets the socket
    // release without that allocation.
    const lenHeader = response.headers.get('content-length');
    if (lenHeader) {
      const len = parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > NFT_RESPONSE_MAX_BYTES) {
        try { await response.text(); } catch { /* drain */ }
        return [];
      }
    }

    const data = await response.json();
    const nfts: NFT[] = [];


    for (const nft of data.ownedNfts || []) {
      // Extract image URL from various possible locations in Alchemy response
      const imageUrl =
        nft.image?.cachedUrl ||
        nft.image?.thumbnailUrl ||
        nft.image?.pngUrl ||
        nft.image?.originalUrl ||
        nft.media?.[0]?.gateway ||
        nft.media?.[0]?.thumbnail ||
        nft.media?.[0]?.raw ||
        nft.raw?.metadata?.image ||
        nft.raw?.metadata?.image_url ||
        nft.metadata?.image ||
        nft.contract?.openSeaMetadata?.imageUrl;

      if (!imageUrl) continue;

      nfts.push({
        tokenId: nft.tokenId,
        name: nft.name || nft.title || nft.raw?.metadata?.name || nft.metadata?.name || `#${nft.tokenId}`,
        description: nft.description || nft.raw?.metadata?.description || nft.metadata?.description,
        imageUrl: imageUrl,
        thumbnailUrl: nft.image?.thumbnailUrl || nft.media?.[0]?.thumbnail || imageUrl,
        chain,
        chainName: config.displayName,
        contractAddress: nft.contract?.address,
        collectionName: nft.contract?.name || nft.contract?.openSeaMetadata?.collectionName || nft.contractMetadata?.name,
        tokenType: nft.tokenType === 'ERC1155' ? 'ERC1155' : 'ERC721',
      });
    }

    return nfts;
  } catch (error) {
    return [];
  }
}

/**
 * Resolve common ipfs:// URIs to a public HTTP gateway. tzkt's
 * metadata fields routinely return raw IPFS URIs that React Native's
 * Image component won't load. The resolution is best-effort — non-
 * IPFS URIs pass through unchanged.
 */
function resolveIpfsUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  }
  return uri;
}

/**
 * Fetch Tezos NFTs (FA2 tokens with balance > 0) from tzkt.io.
 *
 * tzkt returns token balances with embedded metadata. We filter for
 * FA2 (Tezos NFT standard) and skip zero-balance / non-NFT FA2
 * tokens (e.g. fungibles that happen to use FA2). Image URLs are
 * resolved from ipfs:// to a public HTTP gateway so React Native's
 * Image can render them.
 */
export async function fetchTezosNFTs(tezosAddress: string): Promise<NFT[]> {
  try {
    const url = `https://api.tzkt.io/v1/tokens/balances?account=${tezosAddress}&balance.gt=0&token.standard=fa2&limit=200`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return [];
    // Same size guard as the EVM path — pathological FA2 metadata can
    // be just as bloated as Alchemy responses.
    const lenHeader = response.headers.get('content-length');
    if (lenHeader) {
      const len = parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > NFT_RESPONSE_MAX_BYTES) {
        try { await response.text(); } catch { /* drain */ }
        return [];
      }
    }
    const balances = (await response.json()) as Array<{
      balance: string;
      token: {
        contract: { address: string; alias?: string };
        tokenId: string;
        standard: string;
        metadata?: {
          name?: string;
          description?: string;
          image?: string;
          thumbnailUri?: string;
          displayUri?: string;
          artifactUri?: string;
          symbol?: string;
          decimals?: string | number;
        };
      };
    }>;
    const nfts: NFT[] = [];
    for (const item of balances) {
      const md = item.token.metadata ?? {};
      // Skip fungible FA2s — NFTs typically have decimals 0.
      const decimals = typeof md.decimals === 'string' ? parseInt(md.decimals, 10) : (md.decimals ?? 0);
      if (Number.isFinite(decimals) && decimals > 0) continue;
      const imageUrl = resolveIpfsUri(
        md.displayUri ?? md.image ?? md.artifactUri ?? md.thumbnailUri,
      );
      if (!imageUrl) continue;
      nfts.push({
        tokenId: item.token.tokenId,
        name: md.name || `#${item.token.tokenId}`,
        description: md.description,
        imageUrl,
        thumbnailUrl: resolveIpfsUri(md.thumbnailUri) ?? imageUrl,
        chain: 'tezos',
        chainName: 'Tezos',
        contractAddress: item.token.contract.address,
        collectionName: item.token.contract.alias,
        tokenType: 'FA2',
      });
    }
    return nfts;
  } catch {
    return [];
  }
}

/**
 * Fetch NFTs across all supported chains (EVM + optional Tezos).
 *
 * Serialized rather than Promise.all to cap peak memory: 15 chains in
 * parallel holds ~75MB of JSON live and OOMs Android. Tezos runs last.
 */
export async function fetchAllNFTs(
  ethereumAddress: string,
  tezosAddress?: string,
): Promise<NFT[]> {
  const all: NFT[] = [];
  for (const chain of NFT_SUPPORTED_CHAINS) {
    const chunk = await fetchNFTsForChain(ethereumAddress, chain);
    if (chunk.length) all.push(...chunk);
  }
  if (tezosAddress) {
    const tez = await fetchTezosNFTs(tezosAddress);
    if (tez.length) all.push(...tez);
  }
  return all;
}

/**
 * Fetch native balance for an EVM chain via Alchemy
 */
async function fetchEvmNativeBalance(
  address: string,
  chain: string
): Promise<bigint> {
  const config = EVM_CHAINS[chain];
  const endpoint = ALCHEMY_ENDPOINTS[chain];
  if (!endpoint) return 0n;

  // Skip chains that don't support basic EVM RPC (eth_getBalance)
  if (!config?.supportsEvmRpc) {
    return 0n;
  }

  // Deduplicate concurrent requests for same address/chain
  const cacheKey = `balance:${chain}:${address}`;
  return deduplicatedFetch(cacheKey, async () => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getBalance',
          params: [address, 'latest'],
          id: 1,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error body');
        // Throw on rate limit so React Query preserves previous data
        if (response.status === 429) {
          throw new Error(`Rate limited on ${chain}`);
        }
        return 0n;
      }

      const data = await response.json();
      if (data.error) {
        return 0n;
      }

      return BigInt(data.result || '0x0');
    } catch (error) {
      return 0n;
    }
  });
}

/**
 * Fetch token balances for an address on a single chain using Alchemy API
 * Paginates through all results to ensure we get all tokens
 */
async function fetchTokenBalancesForChain(
  address: string,
  chain: string
): Promise<TokenBalance[]> {
  const config = EVM_CHAINS[chain];
  const endpoint = ALCHEMY_ENDPOINTS[chain];
  if (!endpoint) return [];

  // Skip token API call for chains that don't support it
  if (!config?.supportsTokenApi) {
    return [];
  }

  try {
    // Paginate through all token balances
    let allTokenBalances: any[] = [];
    let pageKey: string | undefined;
    const maxPages = 25; // Safety limit (~2500 tokens) — spam-heavy wallets exceed 1000
    let pageCount = 0;

    do {
      const params: any[] = [address, 'erc20'];
      if (pageKey) {
        params.push({ pageKey });
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'alchemy_getTokenBalances',
          params,
          id: 1,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error body');
        // Throw on rate limit so React Query preserves previous data
        if (response.status === 429) {
          throw new Error(`Rate limited on ${chain}`);
        }
        break;
      }

      const data = await response.json();

      if (data.error) {
        break;
      }

      const tokenBalances = data.result?.tokenBalances || [];
      allTokenBalances = [...allTokenBalances, ...tokenBalances];
      pageKey = data.result?.pageKey;
      pageCount++;
    } while (pageKey && pageCount < maxPages);

    const tokens: TokenBalance[] = [];

    // Deduplicate tokens by contract address (pagination may return duplicates)
    const seenAddresses = new Set<string>();
    const uniqueTokenBalances = allTokenBalances.filter((t: any) => {
      const addr = t.contractAddress?.toLowerCase();
      if (!addr || seenAddresses.has(addr)) return false;
      seenAddresses.add(addr);
      return true;
    });

    // Filter to non-zero balances
    const nonZeroTokens = uniqueTokenBalances.filter(
      (t: any) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x'
    );

    if (nonZeroTokens.length === 0) {
      return tokens;
    }

    // Fetch metadata in CHUNKS. A single giant batch (one request id per
    // token) gets rejected or truncated by the RPC for large/spam-heavy
    // wallets — the response comes back short, every token past the first
    // chunk loses its metadata, and they were silently dropped below. That's
    // the "wallet only shows the first page of coins" bug. Chunking keeps each
    // batch small enough to always come back whole, and a failed chunk no
    // longer wipes the entire list (it just falls back to best-effort below).
    const META_CHUNK = 100;
    const metadataById = new Map<number, any>();
    for (let start = 0; start < nonZeroTokens.length; start += META_CHUNK) {
      const chunk = nonZeroTokens.slice(start, start + META_CHUNK);
      const batchRequest = chunk.map((token: any, j: number) => ({
        jsonrpc: '2.0',
        method: 'alchemy_getTokenMetadata',
        params: [token.contractAddress],
        id: start + j, // globally-unique id so results map back precisely
      }));
      try {
        const metadataResponse = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batchRequest),
        });
        if (!metadataResponse.ok) {
          if (metadataResponse.status === 429) throw new Error(`Rate limited on ${chain}`);
          continue; // metadata missing for this chunk → fallback below
        }
        const metadataResults = await metadataResponse.json();
        const arr = Array.isArray(metadataResults) ? metadataResults : [metadataResults];
        for (const r of arr) {
          if (r && typeof r.id === 'number' && r.result) metadataById.set(r.id, r.result);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Rate limited')) throw e;
        // network error on this chunk — keep going; these tokens fall back.
      }
    }

    // Assemble every held token. A token whose metadata couldn't be resolved
    // is still included with a best-effort fallback (address-derived symbol,
    // 18 decimals) rather than dropped — so spam / no-metadata tokens still
    // appear when the user has filtering turned off.
    for (let i = 0; i < nonZeroTokens.length; i++) {
      const token = nonZeroTokens[i];
      const metadata = metadataById.get(i);
      let balanceRaw: bigint;
      try {
        balanceRaw = BigInt(token.tokenBalance);
      } catch {
        continue; // unparseable balance — skip
      }
      if (balanceRaw <= 0n) continue;
      const decimals =
        metadata?.decimals ??
        KNOWN_TOKEN_DECIMALS[String(token.contractAddress).toLowerCase()] ??
        18;
      const balance = Number(balanceRaw) / Math.pow(10, decimals);
      if (!(balance > 0)) continue;
      const symbol =
        metadata?.symbol || `${String(token.contractAddress).slice(0, 6)}…`;
      tokens.push({
        symbol,
        name: metadata?.name || metadata?.symbol || 'Unknown Token',
        balance: balance.toString(),
        balanceRaw: balanceRaw.toString(),
        decimals,
        chain,
        contractAddress: token.contractAddress,
        logoUrl:
          getLocalTokenIconUri(token.contractAddress) ||
          metadata?.logo ||
          KNOWN_TOKEN_ICONS[symbol.toUpperCase()],
      });
    }

    return tokens;
  } catch (error) {
    // Re-throw rate limit errors so React Query preserves previous data
    if (error instanceof Error && error.message.includes('Rate limited')) {
      throw error;
    }
    return [];
  }
}

/**
 * Fetch complete balance (native + tokens) for an EVM chain
 */
async function fetchEvmChainBalance(
  address: string,
  chain: string
): Promise<ChainBalance | null> {
  const config = EVM_CHAINS[chain];
  if (!config) return null;

  try {
    // Fetch sequentially to avoid concurrent requests to same endpoint
    const nativeBalance = await fetchEvmNativeBalance(address, chain);
    await delay(100); // Small delay between native and token balance fetch
    const tokens = await fetchTokenBalancesForChain(address, chain);

    // Only return if there's a balance or tokens
    const hasBalance = nativeBalance > 0n || tokens.length > 0;
    if (!hasBalance) return null;

    return {
      chain,
      nativeBalance: formatUnits(nativeBalance, config.nativeDecimals),
      nativeBalanceRaw: nativeBalance.toString(),
      nativeSymbol: config.nativeSymbol,
      nativeDecimals: config.nativeDecimals,
      tokens,
    };
  } catch (error) {
    // Re-throw rate limit errors so React Query preserves previous data
    if (error instanceof Error && error.message.includes('Rate limited')) {
      throw error;
    }
    return null;
  }
}

/**
 * Fetch Bitcoin balance using Blockstream API
 */
export async function fetchBitcoinBalance(address: string): Promise<ChainBalance> {
  try {
    // Proxy expects: POST /api/bitcoin/balance with {addresses}
    const response = await fetch(`${BITCOIN_API}/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [address] }),
    });

    if (!response.ok) {
      // Throw on rate limit so React Query preserves previous data
      if (response.status === 429) {
        throw new Error('Rate limited on bitcoin');
      }
      throw new Error(`Bitcoin API error: ${response.status}`);
    }

    const responseData = await response.json();
    const data = responseData[address] || {};
    // Calculate confirmed balance
    const confirmedBalance = (data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0);

    // Account for pending (mempool) transactions
    const pendingIncoming = data.mempool_stats?.funded_txo_sum || 0;
    const pendingOutgoing = data.mempool_stats?.spent_txo_sum || 0;

    // Total balance = confirmed + pending incoming - pending outgoing
    const balanceSats = confirmedBalance + pendingIncoming - pendingOutgoing;
    const balance = (balanceSats / 100000000).toFixed(8);

    if (pendingIncoming > 0 || pendingOutgoing > 0) {
    }

    // Net pending = incoming - outgoing (can be negative if outgoing > incoming)
    const pendingNet = pendingIncoming - pendingOutgoing;

    return {
      chain: 'bitcoin',
      nativeBalance: balance,
      nativeBalanceRaw: balanceSats.toString(),
      nativeSymbol: 'BTC',
      nativeDecimals: 8,
      tokens: [],
      confirmedBalanceRaw: confirmedBalance.toString(),
      pendingBalanceRaw: pendingNet !== 0 ? pendingNet.toString() : undefined,
    };
  } catch (error) {
    // Re-throw rate limit errors so React Query preserves previous data
    if (error instanceof Error && error.message.includes('Rate limited')) {
      throw error;
    }
    return {
      chain: 'bitcoin',
      nativeBalance: '0',
      nativeBalanceRaw: '0',
      nativeSymbol: 'BTC',
      nativeDecimals: 8,
      tokens: [],
      confirmedBalanceRaw: '0',
    };
  }
}

// Jupiter token list cache for SPL token metadata
interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

// Fallback list of common SPL tokens when Jupiter API fails
const COMMON_SPL_TOKENS: JupiterToken[] = [
  { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
  { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD', decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png' },
  { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
  { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5, logoURI: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I' },
  { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6, logoURI: 'https://static.jup.ag/jup/icon.png' },
  { address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', name: 'Marinade staked SOL', decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png' },
  { address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'ETH', name: 'Wormhole ETH', decimals: 8, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs/logo.png' },
  { address: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', symbol: 'stSOL', name: 'Lido Staked SOL', decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj/logo.png' },
  { address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', name: 'Pyth Network', decimals: 6, logoURI: 'https://pyth.network/token.svg' },
  { address: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RENDER', name: 'Render Token', decimals: 8, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof/logo.png' },
  { address: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', symbol: 'HNT', name: 'Helium', decimals: 8, logoURI: 'https://s2.coinmarketcap.com/static/img/coins/64x64/5665.png' },
  { address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', name: 'Jito', decimals: 9, logoURI: 'https://metadata.jito.network/token/jto/image' },
  { address: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', symbol: 'WEN', name: 'Wen', decimals: 5, logoURI: 'https://shdw-drive.genesysgo.net/CiKnD1EHy6gg9kVzQ2J6o1chLWzSAzjKGwKPfBPG8prK/wen_logo.png' },
  { address: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6', symbol: 'TNSR', name: 'Tensor', decimals: 9, logoURI: 'https://arweave.net/k4HIVJaQQVW_5S9JZRL1S5qPJxjcxHcxJSPLqUd0E_M' },
  { address: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', name: 'cat in a dogs world', decimals: 5, logoURI: 'https://bafkreidlwyr565dxtao2ipsze6bmzpszqzybz7sqi2zaet5fs7k53henju.ipfs.nftstorage.link/' },
  { address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat', decimals: 6, logoURI: 'https://bafkreibk3covs5ltyqxa272uodhber6kksiakq7sxd7x5e7bjvvhdngqcu.ipfs.nftstorage.link' },
  { address: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', symbol: 'JLP', name: 'Jupiter Perps LP', decimals: 6, logoURI: 'https://static.jup.ag/jlp/icon.png' },
  { address: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', name: 'BlazeStake Staked SOL', decimals: 9, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1/logo.png' },
  { address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', name: 'Raydium', decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png' },
  { address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', name: 'Orca', decimals: 6, logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE/logo.png' },
];

let jupiterTokenCache: Map<string, JupiterToken> | null = null;
let jupiterTokenCacheTimestamp = 0;
const JUPITER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get SPL token metadata from cache or fallback list
 */
function getSplTokenMetadata(): Map<string, JupiterToken> {
  // Return existing cache if valid
  if (jupiterTokenCache && Date.now() - jupiterTokenCacheTimestamp < JUPITER_CACHE_TTL) {
    return jupiterTokenCache;
  }

  // Use fallback list
  const tokenMap = new Map<string, JupiterToken>();
  for (const token of COMMON_SPL_TOKENS) {
    tokenMap.set(token.address, token);
  }
  return tokenMap;
}

/**
 * Fetch and cache Jupiter token list for SPL token metadata
 * Falls back to common tokens list if fetch fails
 */
async function getJupiterTokenList(): Promise<Map<string, JupiterToken>> {
  // Return cache if valid
  if (jupiterTokenCache && Date.now() - jupiterTokenCacheTimestamp < JUPITER_CACHE_TTL) {
    return jupiterTokenCache;
  }

  // Start with fallback tokens
  const tokenMap = new Map<string, JupiterToken>();
  for (const token of COMMON_SPL_TOKENS) {
    tokenMap.set(token.address, token);
  }

  try {
    // Try to fetch full list from Jupiter (via proxy)
    const response = await fetch(`${RPC_PROXY_BASE}/api/solana/jupiter/tokens`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const tokens: JupiterToken[] = await response.json();

    // Only cache verified/known tokens to avoid storing 100k+ entries in memory.
    // Filter to tokens with a symbol and logo (reduces ~100k to ~10-20k useful tokens).
    for (const token of tokens) {
      if (token.symbol && token.logoURI) {
        tokenMap.set(token.address, token);
      }
    }
  } catch {
    // Jupiter token list fetch failed — return whatever we have (may be empty)
  }

  jupiterTokenCache = tokenMap;
  jupiterTokenCacheTimestamp = Date.now();
  return tokenMap;
}

/**
 * Fetch Solana balance
 */
export async function fetchSolanaBalance(address: string): Promise<ChainBalance> {
  try {
    const connection = new Connection(SOLANA_RPC, {
      commitment: 'confirmed',
      wsEndpoint: undefined, // Disable WebSocket
    });
    const publicKey = new PublicKey(address);

    // Fetch SOL balance and Jupiter token list in parallel
    const [balance, jupiterTokens] = await Promise.all([
      connection.getBalance(publicKey),
      getJupiterTokenList(),
    ]);

    const solBalance = (balance / LAMPORTS_PER_SOL).toFixed(9);

    // Fetch SPL token balances
    const tokens: TokenBalance[] = [];

    try {
      // Enumerate BOTH token programs: classic SPL Token and Token-2022 (a
      // separate on-chain program). They parse identically via
      // getParsedTokenAccountsByOwner; querying only the classic program
      // leaves any Token-2022 holdings invisible. Each query is caught
      // independently so one failing doesn't drop the other's results.
      const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      const emptyValue = { value: [] as Awaited<ReturnType<typeof connection.getParsedTokenAccountsByOwner>>['value'] };
      const [splAccounts, token2022Accounts] = await Promise.all([
        connection
          .getParsedTokenAccountsByOwner(publicKey, { programId: SPL_TOKEN_PROGRAM })
          .catch(() => emptyValue),
        connection
          .getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM })
          .catch(() => emptyValue),
      ]);

      const seenMints = new Set<string>();
      for (const { account } of [...splAccounts.value, ...token2022Accounts.value]) {
        const parsed = account.data.parsed;
        const uiAmount = parsed?.info?.tokenAmount?.uiAmount;

        if (uiAmount > 0) {
          const mint = parsed.info.mint;
          if (seenMints.has(mint)) continue; // de-dupe across programs
          seenMints.add(mint);
          const jupiterToken = jupiterTokens.get(mint);
          tokens.push({
            symbol: jupiterToken?.symbol || mint.slice(0, 6) + '...',
            name: jupiterToken?.name || 'Unknown Token',
            balance: parsed.info.tokenAmount.uiAmountString,
            balanceRaw: parsed.info.tokenAmount.amount,
            decimals: parsed.info.tokenAmount.decimals,
            chain: 'solana',
            contractAddress: mint,
            logoUrl: jupiterToken?.logoURI,
          });
        }
      }
    } catch {
      // SPL token fetch failed — return native SOL balance without tokens
    }
    return {
      chain: 'solana',
      nativeBalance: solBalance,
      nativeBalanceRaw: balance.toString(),
      nativeSymbol: 'SOL',
      nativeDecimals: 9,
      tokens,
    };
  } catch (error) {
    // Re-throw rate limit errors so React Query preserves previous data
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('rate limit')) {
      throw new Error('Rate limited on solana');
    }
    return {
      chain: 'solana',
      nativeBalance: '0',
      nativeBalanceRaw: '0',
      nativeSymbol: 'SOL',
      nativeDecimals: 9,
      tokens: [],
    };
  }
}

/**
 * Fetch Kaspa balance from the Kaspa REST API
 * API: https://api.kaspa.org/addresses/{address}/balance
 */
export async function fetchKaspaBalance(address: string): Promise<ChainBalance> {
  try {
    // Validate address format - must be kaspa:[a-z0-9]{61,63}
    if (!address || !address.startsWith('kaspa:')) {
      return {
        chain: 'kaspa',
        nativeBalance: '0',
        nativeBalanceRaw: '0',
        nativeSymbol: 'KAS',
        nativeDecimals: 8,
        tokens: [],
      };
    }

    // Proxy expects: POST /api/kaspa/balance with {address}
    const response = await fetch(`${RPC_PROXY_BASE}/api/kaspa/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    if (!response.ok) {
      // Log the error for debugging
      const errorText = await response.text().catch(() => '');
      // Throw on rate limit so React Query preserves previous data
      if (response.status === 429) {
        throw new Error('Rate limited on kaspa');
      }
      // Return zero balance for other errors
      return {
        chain: 'kaspa',
        nativeBalance: '0',
        nativeBalanceRaw: '0',
        nativeSymbol: 'KAS',
        nativeDecimals: 8,
        tokens: [],
      };
    }

    const data = await response.json();
    // Balance is in sompi (1 KAS = 100,000,000 sompi, 8 decimals like Bitcoin)
    const balanceSompi = data.balance?.toString() || '0';
    const balanceKas = (Number(balanceSompi) / 100_000_000).toFixed(8);
    return {
      chain: 'kaspa',
      nativeBalance: balanceKas,
      nativeBalanceRaw: balanceSompi,
      nativeSymbol: 'KAS',
      nativeDecimals: 8,
      tokens: [],
    };
  } catch (error) {
    // Re-throw rate limit errors so React Query preserves previous data
    if (error instanceof Error && error.message.includes('Rate limited')) {
      throw error;
    }
    // Silently handle network errors - Kaspa API may have CORS/rate limit issues
    return {
      chain: 'kaspa',
      nativeBalance: '0',
      nativeBalanceRaw: '0',
      nativeSymbol: 'KAS',
      nativeDecimals: 8,
      tokens: [],
    };
  }
}

// Bittensor RPC endpoint (via proxy)
const BITTENSOR_RPC_ENDPOINT = `${RPC_PROXY_BASE}/api/bittensor/rpc`;

/**
 * Fetch Bittensor balance using Substrate RPC
 * Uses system.account query to get free balance
 */
/**
 * Fetch Tezos XTZ balance from tzkt.io public indexer.
 *
 * Why tzkt vs a raw RPC node:
 *  - The RPC `/chains/main/blocks/head/context/contracts/<addr>/balance`
 *    works too, but tzkt is consistently fast, cached, and rate-limited
 *    generously. It's the same source the major Tezos block explorers
 *    use.
 *  - tzkt returns 200 with `null` for never-funded accounts; we map
 *    that to "0 XTZ" so brand-new wallets render cleanly.
 *
 * Balance unit: mutez (10^-6 XTZ). 1 XTZ = 1,000,000 mutez.
 */
export async function fetchTezosBalance(address: string): Promise<ChainBalance> {
  const TEZOS_DECIMALS = 6;
  try {
    const response = await fetch(`https://api.tzkt.io/v1/accounts/${address}/balance`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Rate limited on tezos');
      }
      // 404 = address never seen on-chain; treat as 0.
      if (response.status === 404) {
        return {
          chain: 'tezos',
          nativeBalance: '0',
          nativeBalanceRaw: '0',
          nativeSymbol: 'XTZ',
          nativeDecimals: TEZOS_DECIMALS,
          tokens: [],
        };
      }
      throw new Error(`Tezos API error: ${response.status}`);
    }
    const mutez = (await response.json()) as number | null;
    const balanceRaw = (mutez ?? 0).toString();
    const balance = ((mutez ?? 0) / 1e6).toFixed(TEZOS_DECIMALS);
    return {
      chain: 'tezos',
      nativeBalance: balance,
      nativeBalanceRaw: balanceRaw,
      nativeSymbol: 'XTZ',
      nativeDecimals: TEZOS_DECIMALS,
      tokens: [],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Rate limited')) {
      throw error;
    }
    return {
      chain: 'tezos',
      nativeBalance: '0',
      nativeBalanceRaw: '0',
      nativeSymbol: 'XTZ',
      nativeDecimals: TEZOS_DECIMALS,
      tokens: [],
    };
  }
}

export async function fetchBittensorBalance(address: string): Promise<ChainBalance> {
  try {
    const response = await fetch(BITTENSOR_RPC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'state_getStorage',
        params: [getSubstrateAccountStorageKey(address)],
      }),
    });

    if (!response.ok) {
      // Throw on rate limit so React Query preserves previous data
      if (response.status === 429) {
        throw new Error('Rate limited on bittensor');
      }
      throw new Error(`Bittensor RPC error: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || 'RPC error');
    }

    if (data.result) {
      const balance = decodeSubstrateAccountBalance(data.result);
      const balanceTao = (Number(balance) / 1e9).toFixed(9);
      return {
        chain: 'bittensor',
        nativeBalance: balanceTao,
        nativeBalanceRaw: balance.toString(),
        nativeSymbol: 'TAO',
        nativeDecimals: 9,
        tokens: [],
      };
    }

    // No storage = zero balance
    return {
      chain: 'bittensor',
      nativeBalance: '0',
      nativeBalanceRaw: '0',
      nativeSymbol: 'TAO',
      nativeDecimals: 9,
      tokens: [],
    };
  } catch (error) {
    // Re-throw rate limit errors so React Query preserves previous data
    if (error instanceof Error && error.message.includes('Rate limited')) {
      throw error;
    }
    return {
      chain: 'bittensor',
      nativeBalance: '0',
      nativeBalanceRaw: '0',
      nativeSymbol: 'TAO',
      nativeDecimals: 9,
      tokens: [],
    };
  }
}

/**
 * Get the storage key for System.Account(address)
 * Format: twox128("System") + twox128("Account") + blake2_128_concat(address_bytes)
 */
function getSubstrateAccountStorageKey(ss58Address: string): string {
  // Decode SS58 address to get raw public key
  const decoded = bs58.decode(ss58Address);

  // Skip prefix byte(s) and checksum (last 2 bytes)
  let prefixLen = 1;
  if (decoded[0] >= 64) {
    prefixLen = 2;
  }
  const publicKey = decoded.slice(prefixLen, decoded.length - 2);

  // System module prefix: twox128("System") = 0x26aa394eea5630e07c48ae0c9558cef7
  // Account storage prefix: twox128("Account") = 0xb99d880ec681799c0cf30e8886371da9
  const systemPrefix = '26aa394eea5630e07c48ae0c9558cef7';
  const accountPrefix = 'b99d880ec681799c0cf30e8886371da9';

  // blake2_128_concat(publicKey) = blake2_128(publicKey) + publicKey
  const hash = blake2b(publicKey, { dkLen: 16 }); // 128 bits = 16 bytes

  const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
  const publicKeyHex = Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('');

  return '0x' + systemPrefix + accountPrefix + hashHex + publicKeyHex;
}

/**
 * Decode Substrate AccountInfo from storage value
 * Returns the free balance as a bigint
 */
function decodeSubstrateAccountBalance(hexData: string): bigint {
  // Remove 0x prefix
  const data = hexData.slice(2);

  // AccountInfo structure (SCALE encoded):
  // - nonce: u32 (4 bytes, little endian)
  // - consumers: u32 (4 bytes)
  // - providers: u32 (4 bytes)
  // - sufficients: u32 (4 bytes)
  // - data.free: u128 (16 bytes, little endian)
  // - data.reserved: u128 (16 bytes)
  // - data.frozen: u128 (16 bytes)
  // - data.flags: u128 (16 bytes)

  // Skip to free balance (offset: 4+4+4+4 = 16 bytes = 32 hex chars)
  const freeBalanceHex = data.slice(32, 32 + 32); // 16 bytes = 32 hex chars

  // Convert little-endian hex to bigint
  const bytes = [];
  for (let i = 0; i < freeBalanceHex.length; i += 2) {
    bytes.push(parseInt(freeBalanceHex.slice(i, i + 2), 16));
  }

  // Little endian to bigint
  let balance = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    balance = (balance << 8n) + BigInt(bytes[i]);
  }

  return balance;
}

/**
 * Bitcoin addresses structure (legacy, segwit, native segwit)
 */
export interface BitcoinAddressesInput {
  legacy: string;
  segwit: string;
  nativeSegwit: string;
}

/**
 * Fetch EVM chain balances for a single Ethereum address
 * Used for imported wallets that only have an ETH address
 */
export async function fetchEvmBalancesForAddress(address: string): Promise<WalletBalances> {
  const evmChainIds = Object.keys(EVM_CHAINS);

  // Fetch in batches of 5 concurrently
  const evmResults = await runInBatches(
    evmChainIds,
    (chain) => fetchEvmChainBalance(address, chain),
    5, 100
  );

  const result: WalletBalances = {};

  evmChainIds.forEach((chain, index) => {
    const balance = evmResults[index];
    if (balance) {
      result[chain] = balance;
    }
  });

  return result;
}

/**
 * Fetch all chain balances for a wallet
 * Uses concurrency limiting and request spacing to prevent rate limiting
 */
export async function fetchAllBalances(addresses: {
  ethereum: string;
  bitcoin: BitcoinAddressesInput;
  solana: string;
  kaspa?: string;
  bittensor?: string;
  tezos?: { slip10: string; bip32: string };
}): Promise<WalletBalances> {
  const evmChainIds = Object.keys(EVM_CHAINS);

  // Fetch EVM chains in batches of 5 concurrently
  const evmResults = await runInBatches(
    evmChainIds,
    (chain) => fetchEvmChainBalance(addresses.ethereum, chain),
    5, 100
  );

  // Fetch non-EVM chains concurrently (different APIs, no shared rate limit)
  const [btcLegacy, btcSegwit, btcNativeSegwit, solana, kaspa, bittensor, tezos] = await Promise.all([
    fetchBitcoinBalance(addresses.bitcoin.legacy),
    fetchBitcoinBalance(addresses.bitcoin.segwit),
    fetchBitcoinBalance(addresses.bitcoin.nativeSegwit),
    fetchSolanaBalance(addresses.solana),
    addresses.kaspa ? fetchKaspaBalance(addresses.kaspa) : Promise.resolve(null),
    addresses.bittensor ? fetchBittensorBalance(addresses.bittensor) : Promise.resolve(null),
    // Default to SLIP-10 address (the standard one). The BIP32 variant
    // is shown separately on its own card with its own balance fetch.
    addresses.tezos?.slip10 ? fetchTezosBalance(addresses.tezos.slip10) : Promise.resolve(null),
  ]);

  // Build result object
  const result: WalletBalances = {};

  // Add EVM chain balances (only if they have assets)
  evmChainIds.forEach((chain, index) => {
    const balance = evmResults[index];
    if (balance) {
      result[chain] = balance;
    }
  });

  // Aggregate Bitcoin balances from all address types
  const btcLegacySats = BigInt(btcLegacy?.nativeBalanceRaw || '0');
  const btcSegwitSats = BigInt(btcSegwit?.nativeBalanceRaw || '0');
  const btcNativeSegwitSats = BigInt(btcNativeSegwit?.nativeBalanceRaw || '0');
  const btcTotalSats = btcLegacySats + btcSegwitSats + btcNativeSegwitSats;

  // Aggregate confirmed and pending balances
  const btcConfirmedSats = BigInt(btcLegacy?.confirmedBalanceRaw || '0') +
    BigInt(btcSegwit?.confirmedBalanceRaw || '0') +
    BigInt(btcNativeSegwit?.confirmedBalanceRaw || '0');
  const btcPendingSats = BigInt(btcLegacy?.pendingBalanceRaw || '0') +
    BigInt(btcSegwit?.pendingBalanceRaw || '0') +
    BigInt(btcNativeSegwit?.pendingBalanceRaw || '0');
  result.bitcoin = {
    chain: 'bitcoin',
    nativeBalance: (Number(btcTotalSats) / 100000000).toFixed(8),
    nativeBalanceRaw: btcTotalSats.toString(),
    nativeSymbol: 'BTC',
    nativeDecimals: 8,
    tokens: [],
    confirmedBalanceRaw: btcConfirmedSats.toString(),
    pendingBalanceRaw: btcPendingSats !== 0n ? btcPendingSats.toString() : undefined,
  };

  // Add Solana
  result.solana = solana;

  // Add Kaspa
  if (kaspa) {
    result.kaspa = kaspa;
  }

  // Add Bittensor
  if (bittensor) {
    result.bittensor = bittensor;
  }

  // Add Tezos (SLIP-10 — the default/standard derivation).
  if (tezos) {
    result.tezos = tezos;
  }

  return result;
}

/** Price data including 24h change and icon */
interface PriceData {
  price: number;
  change24h?: number; // Percentage change
  iconUrl?: string;   // Token icon URL from CoinGecko
}

// CoinGecko API via proxy
const COINGECKO_API_BASE = `${RPC_PROXY_BASE}/api/price`;

// Price cache configuration (5 minute TTL)
const PRICE_CACHE_TTL = 5 * 60 * 1000;

interface PriceCache {
  data: Map<string, PriceData>;
  timestamp: number;
}

let nativePriceCache: PriceCache | null = null;
let erc20PriceCache: PriceCache | null = null;

// Map native token symbols to CoinGecko coin IDs
const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  SOL: 'solana',
  KAS: 'kaspa',
  TAO: 'bittensor',
  POL: 'matic-network',
  MATIC: 'matic-network',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  CELO: 'celo',
  xDAI: 'xdai',
  MNT: 'mantle',
  GLMR: 'moonbeam',
  ASTR: 'astar',
  ZETA: 'zetachain',
  BERA: 'berachain-bera',
  MON: 'monad', // May not exist on CoinGecko yet
  HYPE: 'hyperliquid',
  S: 'sonic-3',
  SEI: 'sei-network',
  APE: 'apecoin',
  DEGEN: 'degen-base',
  IP: 'story-protocol',
  FLOW: 'flow',
  RBTC: 'rootstock',
  frxETH: 'frax-ether',
};

/**
 * Fetch native token prices and icons from CoinGecko API
 * Uses /coins/markets endpoint which returns price, 24h change, AND image in one call
 * Caches results for 5 minutes to avoid excessive API calls
 * Handles cache misses by fetching only missing symbols
 */
async function fetchNativeTokenPrices(symbols: string[]): Promise<Map<string, PriceData>> {
  if (symbols.length === 0) return new Map();

  const cacheValid = nativePriceCache && Date.now() - nativePriceCache.timestamp < PRICE_CACHE_TTL;
  const prices = cacheValid ? new Map(nativePriceCache!.data) : new Map<string, PriceData>();

  // Find symbols that are missing from cache
  const uniqueSymbols = [...new Set(symbols)];
  const missingSymbols = uniqueSymbols.filter(s => !prices.has(s.toUpperCase()));

  // If all symbols are cached, return cache
  if (missingSymbols.length === 0) {
    return prices;
  }


  try {
    // Map symbols to CoinGecko IDs
    const coinIds = missingSymbols
      .map(s => SYMBOL_TO_COINGECKO_ID[s.toUpperCase()])
      .filter(Boolean);

    if (coinIds.length === 0) return prices;

    // Use /coins/markets which returns price, 24h change, AND image
    const response = await fetch(
      `${COINGECKO_API_BASE}/markets?vs_currency=usd&ids=${coinIds.join(',')}&price_change_percentage=24h`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!response.ok) {
      // Return stale cache if available
      return nativePriceCache?.data ?? prices;
    }

    const data = await response.json();

    // Create a map of coinId -> data for quick lookup
    const coinDataMap = new Map<string, any>();
    for (const coin of data) {
      coinDataMap.set(coin.id, coin);
    }

    // Map CoinGecko response back to symbols (only for missing symbols we just fetched)
    for (const symbol of missingSymbols) {
      const coinId = SYMBOL_TO_COINGECKO_ID[symbol.toUpperCase()];
      if (coinId && coinDataMap.has(coinId)) {
        const coinData = coinDataMap.get(coinId);
        prices.set(symbol.toUpperCase(), {
          price: coinData.current_price || 0,
          change24h: coinData.price_change_percentage_24h,
          iconUrl: coinData.image, // CoinGecko provides image URL
        });
      }
    }

    // Update cache with merged data
    nativePriceCache = { data: prices, timestamp: Date.now() };
  } catch {
    // CoinGecko API failure — return cached/partial prices
  }

  return prices;
}

// Map chain IDs to CoinGecko platform IDs for token price lookups
const CHAIN_TO_COINGECKO_PLATFORM: Record<string, string> = {
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
  moonbeam: 'moonbeam',
  sei: 'sei-network',
  solana: 'solana',
};

interface TokenAddress {
  chain: string;
  contractAddress: string;
}

/**
 * Fetch ERC-20 token prices from CoinGecko API (by contract address)
 * Batches requests to avoid URL length limits
 * Caches results for 5 minutes to avoid excessive API calls
 * Handles cache misses by fetching only missing tokens
 */
async function fetchErc20TokenPrices(tokens: TokenAddress[]): Promise<Map<string, PriceData>> {
  if (tokens.length === 0) return new Map();

  const BATCH_SIZE = 50; // Max addresses per request to avoid 414 errors
  const cacheValid = erc20PriceCache && Date.now() - erc20PriceCache.timestamp < PRICE_CACHE_TTL;

  // Start with cached data if available
  const prices = cacheValid ? new Map(erc20PriceCache!.data) : new Map<string, PriceData>();

  // Find tokens that are missing from cache
  const missingTokens: TokenAddress[] = [];
  for (const token of tokens) {
    const platform = CHAIN_TO_COINGECKO_PLATFORM[token.chain];
    if (!platform) continue;
    // Solana addresses are case-sensitive base58, others are hex (lowercase)
    const normalizedAddress = platform === 'solana' ? token.contractAddress : token.contractAddress.toLowerCase();
    const key = `${platform}:${normalizedAddress}`;
    if (!prices.has(key)) {
      missingTokens.push(token);
    }
  }

  // If all tokens are cached, return cache
  if (missingTokens.length === 0) {
    return prices;
  }


  try {
    // Group missing tokens by chain (CoinGecko requires separate calls per platform)
    const tokensByChain = new Map<string, string[]>();
    for (const token of missingTokens) {
      const platform = CHAIN_TO_COINGECKO_PLATFORM[token.chain];
      if (!platform) continue;

      if (!tokensByChain.has(platform)) {
        tokensByChain.set(platform, []);
      }
      // Solana addresses are case-sensitive base58, others are hex (lowercase)
      const address = platform === 'solana' ? token.contractAddress : token.contractAddress.toLowerCase();
      tokensByChain.get(platform)!.push(address);
    }

    // Fetch prices for each platform in batches
    for (const [platform, allAddresses] of tokensByChain.entries()) {
      // Split addresses into batches
      for (let i = 0; i < allAddresses.length; i += BATCH_SIZE) {
        const batch = allAddresses.slice(i, i + BATCH_SIZE);

        try {
          const response = await fetch(
            `${COINGECKO_API_BASE}/token/${platform}?contract_addresses=${batch.join(',')}&vs_currencies=usd&include_24hr_change=true`,
            {
              method: 'GET',
              headers: { 'Content-Type': 'application/json' },
            }
          );

          if (!response.ok) {
            continue;
          }

          const data = await response.json();

          // Store prices with platform:address key
          for (const [address, priceData] of Object.entries(data)) {
            if (priceData && typeof priceData === 'object') {
              const pd = priceData as { usd?: number; usd_24h_change?: number };
              // Key by platform:address for lookup (Solana is case-sensitive)
              const normalizedAddress = platform === 'solana' ? address : address.toLowerCase();
              const key = `${platform}:${normalizedAddress}`;
              prices.set(key, {
                price: pd.usd || 0,
                change24h: pd.usd_24h_change,
              });
            }
          }
        } catch {
          // Price fetch for this batch failed — continue with remaining batches
        }
      }
    }

    // Update cache with merged data
    erc20PriceCache = { data: prices, timestamp: Date.now() };
  } catch {
    // Token price fetch failed — return cached/partial prices
  }

  return prices;
}

/**
 * Enrich wallet balances with USD values (chain totals and individual tokens)
 */
export async function enrichBalancesWithPrices(
  balances: WalletBalances
): Promise<WalletBalances> {
  // Collect native token symbols and ERC-20 token addresses
  const nativeSymbols: string[] = [];
  const erc20Tokens: TokenAddress[] = [];

  for (const chainId of Object.keys(balances)) {
    const chainBalance = balances[chainId];
    if (chainBalance && typeof chainBalance === 'object' && 'chain' in chainBalance) {
      const cb = chainBalance as ChainBalance;
      nativeSymbols.push(cb.nativeSymbol);

      // Collect ERC-20 tokens with contract addresses
      for (const token of cb.tokens) {
        if (token.contractAddress) {
          erc20Tokens.push({
            chain: cb.chain,
            contractAddress: token.contractAddress,
          });
        }
      }
    }
  }

  // Fetch prices in parallel
  const [nativePrices, erc20Prices] = await Promise.all([
    fetchNativeTokenPrices(nativeSymbols),
    fetchErc20TokenPrices(erc20Tokens),
  ]);

  // Enrich balances with USD values
  const enrichedBalances: WalletBalances = {};

  for (const chainId of Object.keys(balances)) {
    const chainBalance = balances[chainId];
    if (chainBalance && typeof chainBalance === 'object' && 'chain' in chainBalance) {
      const cb = chainBalance as ChainBalance;

      // Calculate native token USD value, get 24h change, and icon
      const nativePriceData = nativePrices.get(cb.nativeSymbol.toUpperCase());
      const nativeUsdValue = nativePriceData
        ? parseFloat(cb.nativeBalance) * nativePriceData.price
        : 0;
      const nativePriceChange24h = nativePriceData?.change24h;
      const nativeIconUrl = nativePriceData?.iconUrl;

      // Get CoinGecko platform identifier for this chain
      const coingeckoPlatform = CHAIN_TO_COINGECKO_PLATFORM[cb.chain];

      // Enrich individual tokens with USD values and 24h change
      const enrichedTokens: TokenBalance[] = cb.tokens.map(token => {
        let tokenUsdValue = 0;
        let tokenPriceChange24h: number | undefined;

        if (token.contractAddress && coingeckoPlatform) {
          // Look up price by platform:address (Solana is case-sensitive)
          const normalizedAddress = coingeckoPlatform === 'solana' ? token.contractAddress : token.contractAddress.toLowerCase();
          const priceKey = `${coingeckoPlatform}:${normalizedAddress}`;
          const tokenPriceData = erc20Prices.get(priceKey);
          if (tokenPriceData) {
            tokenUsdValue = parseFloat(token.balance) * tokenPriceData.price;
            tokenPriceChange24h = tokenPriceData.change24h;
          }

        }

        return {
          ...token,
          usdValue: tokenUsdValue > 0 ? tokenUsdValue.toFixed(2) : undefined,
          priceChange24h: tokenPriceChange24h,
        };
      });


      // Calculate total chain USD value
      const totalUsdValue = nativeUsdValue + enrichedTokens.reduce(
        (sum, t) => sum + (t.usdValue ? parseFloat(t.usdValue) : 0),
        0
      );

      enrichedBalances[chainId] = {
        ...cb,
        nativeUsdValue: nativeUsdValue > 0 ? nativeUsdValue.toFixed(2) : undefined,
        nativePriceChange24h,
        nativeIconUrl,
        tokens: enrichedTokens,
        usdValue: totalUsdValue.toFixed(2),
      };
    }
  }

  return enrichedBalances;
}

/**
 * Format a balance for display
 */
export function formatBalance(balance: string, decimals: number = 4): string {
  const num = parseFloat(balance);
  if (num === 0) return '0';
  if (num < 0.0001) return '<0.0001';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format USD value for display
 */
export function formatUsdValue(value: string | undefined): string {
  if (!value) return '$0.00';
  const num = parseFloat(value);
  if (num === 0) return '$0.00';
  if (num < 0.01) return '<$0.01';
  return '$' + num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Get chain display name
 */
export function getChainName(chain: string): string {
  // Check EVM chains first
  const evmConfig = EVM_CHAINS[chain];
  if (evmConfig) return evmConfig.displayName;

  // Non-EVM chains
  switch (chain) {
    case 'quilibrium':
      return 'Quilibrium';
    case 'bitcoin':
      return 'Bitcoin';
    case 'solana':
      return 'Solana';
    case 'kaspa':
      return 'Kaspa';
    case 'bittensor':
      return 'Bittensor';
    default:
      // Capitalize first letter for unknown chains
      return chain.charAt(0).toUpperCase() + chain.slice(1);
  }
}

// Price History for Charts

export type PriceTimeframe = '1m' | '5m' | '1h' | '4h' | '1d' | '1w' | '1M' | '1y' | 'all';

export interface PricePoint {
  timestamp: number;
  price: number;
}

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OHLCResult {
  candles: CandleData[];
  minPrice: number;
  maxPrice: number;
  priceChange: number;
  priceChangePercent: number;
}

export interface PriceHistoryResult {
  prices: PricePoint[];
  minPrice: number;
  maxPrice: number;
  priceChange: number;
  priceChangePercent: number;
}

// Map timeframes to CoinGecko parameters
function getTimeframeParams(timeframe: PriceTimeframe): { days: string; interval?: string } {
  switch (timeframe) {
    case '1m':
      // CoinGecko doesn't support 1-minute intervals well, use 5-minute data from last hour
      return { days: '1' }; // Will get 5-min granularity
    case '5m':
      return { days: '1' }; // 5-minute granularity for last day
    case '1h':
      return { days: '1' }; // Hourly data for last day
    case '4h':
      return { days: '7' }; // Use 7 days of data
    case '1d':
      return { days: '30' }; // Daily data for month
    case '1w':
      return { days: '90' }; // Weekly view = 90 days
    case '1M':
      return { days: '365' }; // Monthly view = 1 year
    case '1y':
      return { days: '365' };
    case 'all':
      return { days: 'max' };
    default:
      return { days: '1' };
  }
}

// Get candle interval in milliseconds for grouping line data into candles
function getCandleIntervalMs(timeframe: PriceTimeframe): number {
  switch (timeframe) {
    case '1m':
    case '5m':
      return 5 * 60 * 1000; // 5 minutes
    case '1h':
      return 15 * 60 * 1000; // 15 minutes
    case '4h':
      return 60 * 60 * 1000; // 1 hour
    case '1d':
      return 4 * 60 * 60 * 1000; // 4 hours
    case '1w':
      return 24 * 60 * 60 * 1000; // 1 day
    case '1M':
      return 7 * 24 * 60 * 60 * 1000; // 1 week
    case '1y':
    case 'all':
      return 30 * 24 * 60 * 60 * 1000; // ~1 month
    default:
      return 60 * 60 * 1000; // 1 hour default
  }
}

// Filter/sample data based on timeframe for smoother charts
function filterDataForTimeframe(data: [number, number][], timeframe: PriceTimeframe): PricePoint[] {
  if (data.length === 0) return [];

  const now = Date.now();
  let cutoffTime: number;
  let maxPoints: number;

  switch (timeframe) {
    case '1m':
      cutoffTime = now - 60 * 1000; // Last 1 minute
      maxPoints = 60;
      break;
    case '5m':
      cutoffTime = now - 5 * 60 * 1000; // Last 5 minutes
      maxPoints = 60;
      break;
    case '1h':
      cutoffTime = now - 60 * 60 * 1000; // Last 1 hour
      maxPoints = 60;
      break;
    case '4h':
      cutoffTime = now - 4 * 60 * 60 * 1000; // Last 4 hours
      maxPoints = 60;
      break;
    case '1d':
      cutoffTime = now - 24 * 60 * 60 * 1000; // Last 24 hours
      maxPoints = 96; // 15-min intervals
      break;
    case '1w':
      cutoffTime = now - 7 * 24 * 60 * 60 * 1000; // Last 7 days
      maxPoints = 168; // Hourly
      break;
    case '1M':
      cutoffTime = now - 30 * 24 * 60 * 60 * 1000; // Last 30 days
      maxPoints = 120;
      break;
    case '1y':
      cutoffTime = now - 365 * 24 * 60 * 60 * 1000; // Last year
      maxPoints = 365;
      break;
    case 'all':
    default:
      cutoffTime = 0;
      maxPoints = 500;
  }

  // Filter to timeframe
  let filtered = data.filter(([ts]) => ts >= cutoffTime);

  // If we have more points than needed, sample evenly
  if (filtered.length > maxPoints) {
    const step = Math.ceil(filtered.length / maxPoints);
    filtered = filtered.filter((_, i) => i % step === 0);
  }

  return filtered.map(([timestamp, price]) => ({ timestamp, price }));
}

/**
 * Fetch price history for a token symbol
 */
export async function fetchPriceHistory(
  symbol: string,
  timeframe: PriceTimeframe,
  contractAddress?: string,
  chain?: string
): Promise<PriceHistoryResult | null> {
  try {
    // Get CoinGecko ID from symbol
    const coinId = SYMBOL_TO_COINGECKO_ID[symbol.toUpperCase()];

    if (!coinId && !contractAddress) {
      return null;
    }

    const { days } = getTimeframeParams(timeframe);

    let url: string;
    if (coinId) {
      // Use coin ID for native tokens
      url = `${COINGECKO_API_BASE}/chart/${coinId}?vs_currency=usd&days=${days}`;
    } else if (contractAddress && chain) {
      // Use contract address for ERC20/SPL tokens with chain-specific platform
      const platform = CHAIN_TO_COINGECKO_PLATFORM[chain];
      if (!platform) {
        return null;
      }
      // Solana addresses are case-sensitive, others are lowercase
      const normalizedAddress = platform === 'solana' ? contractAddress : contractAddress.toLowerCase();
      url = `${COINGECKO_API_BASE}/chart/${platform}/contract/${normalizedAddress}?vs_currency=usd&days=${days}`;
    } else {
      return null;
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!data.prices || data.prices.length === 0) {
      return null;
    }

    // Filter and format data for the timeframe
    const prices = filterDataForTimeframe(data.prices, timeframe);

    if (prices.length < 2) {
      return null;
    }

    // Calculate stats
    const priceValues = prices.map(p => p.price);
    const minPrice = Math.min(...priceValues);
    const maxPrice = Math.max(...priceValues);
    const firstPrice = prices[0].price;
    const lastPrice = prices[prices.length - 1].price;
    const priceChange = lastPrice - firstPrice;
    const priceChangePercent = (priceChange / firstPrice) * 100;

    return {
      prices,
      minPrice,
      maxPrice,
      priceChange,
      priceChangePercent,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Fetch OHLC (candlestick) data for a token symbol
 * CoinGecko OHLC endpoint returns data in format: [timestamp, open, high, low, close]
 */
export async function fetchOHLCData(
  symbol: string,
  timeframe: PriceTimeframe,
  contractAddress?: string,
  chain?: string
): Promise<OHLCResult | null> {
  try {
    const coinId = SYMBOL_TO_COINGECKO_ID[symbol.toUpperCase()];

    // CoinGecko OHLC endpoint only supports coin IDs, not contract addresses
    // For tokens without a coin ID, fall back to line chart data
    if (!coinId) {
      // Try to get line chart data and convert to pseudo-OHLC
      const lineData = await fetchPriceHistory(symbol, timeframe, contractAddress, chain);
      if (!lineData || lineData.prices.length < 2) {
        return null;
      }

      // Convert line chart data to candle format
      // Group prices into candles based on timeframe
      const candleInterval = getCandleIntervalMs(timeframe);
      const candles: CandleData[] = [];
      let currentCandle: { timestamp: number; prices: number[] } | null = null;

      for (const point of lineData.prices) {
        const candleStart = Math.floor(point.timestamp / candleInterval) * candleInterval;

        if (!currentCandle || currentCandle.timestamp !== candleStart) {
          if (currentCandle && currentCandle.prices.length > 0) {
            candles.push({
              timestamp: currentCandle.timestamp,
              open: currentCandle.prices[0],
              high: Math.max(...currentCandle.prices),
              low: Math.min(...currentCandle.prices),
              close: currentCandle.prices[currentCandle.prices.length - 1],
            });
          }
          currentCandle = { timestamp: candleStart, prices: [point.price] };
        } else {
          currentCandle.prices.push(point.price);
        }
      }

      // Add the last candle
      if (currentCandle && currentCandle.prices.length > 0) {
        candles.push({
          timestamp: currentCandle.timestamp,
          open: currentCandle.prices[0],
          high: Math.max(...currentCandle.prices),
          low: Math.min(...currentCandle.prices),
          close: currentCandle.prices[currentCandle.prices.length - 1],
        });
      }

      if (candles.length < 2) {
        return null;
      }

      return {
        candles,
        minPrice: lineData.minPrice,
        maxPrice: lineData.maxPrice,
        priceChange: lineData.priceChange,
        priceChangePercent: lineData.priceChangePercent,
      };
    }

    // CoinGecko OHLC endpoint only supports specific day values: 1, 7, 14, 30, 90, 180, 365, max
    const timeframeToDays: Record<PriceTimeframe, string> = {
      '1m': '1',
      '5m': '1',
      '1h': '1',
      '4h': '1',
      '1d': '1',
      '1w': '7',
      '1M': '30',
      '1y': '365',
      'all': 'max',
    };

    const days = timeframeToDays[timeframe];

    const url = `${COINGECKO_API_BASE}/ohlc/${coinId}?vs_currency=usd&days=${days}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    const data: [number, number, number, number, number][] = await response.json();

    if (!data || data.length === 0) {
      return null;
    }

    // Convert to CandleData format
    const candles: CandleData[] = data.map(([timestamp, open, high, low, close]) => ({
      timestamp,
      open,
      high,
      low,
      close,
    }));

    // Filter candles based on timeframe for shorter periods
    let filteredCandles = candles;
    const now = Date.now();

    if (timeframe === '1h') {
      filteredCandles = candles.filter(c => c.timestamp >= now - 60 * 60 * 1000);
    } else if (timeframe === '4h') {
      filteredCandles = candles.filter(c => c.timestamp >= now - 4 * 60 * 60 * 1000);
    }

    // Ensure we have at least some data
    if (filteredCandles.length < 2) {
      filteredCandles = candles.slice(-Math.max(2, Math.floor(candles.length / 4)));
    }

    // Calculate stats
    const allHighs = filteredCandles.map(c => c.high);
    const allLows = filteredCandles.map(c => c.low);
    const minPrice = Math.min(...allLows);
    const maxPrice = Math.max(...allHighs);
    const firstPrice = filteredCandles[0].open;
    const lastPrice = filteredCandles[filteredCandles.length - 1].close;
    const priceChange = lastPrice - firstPrice;
    const priceChangePercent = (priceChange / firstPrice) * 100;

    return {
      candles: filteredCandles,
      minPrice,
      maxPrice,
      priceChange,
      priceChangePercent,
    };
  } catch (error) {
    return null;
  }
}

// Export the symbol mapping for use elsewhere
export { SYMBOL_TO_COINGECKO_ID };
