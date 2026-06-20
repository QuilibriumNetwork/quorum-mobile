/**
 * Apex pricing — convert the fixed $5/month subscription price into
 * token units for the chosen payment token.
 *
 * USD price sources per token:
 *   - USDC : pegged, always $1.
 *   - wQUIL: DexScreener — the actual market price from the token's most
 *     liquid pool (NOT the QNS pricing API's internal rate).
 *   - SNAP : DexScreener, same way.
 *
 * Conversion uses the raw decimal rate exactly: the price string is scaled
 * to an integer and the token amount computed with BigInt arithmetic
 * (units = $5 * 10^(decimals+scale) / scaledPrice) — no float division,
 * so the quote is floor-exact at the token's full precision.
 *
 * The total is split 5 ways exactly: amountEachUnits = floor(total / 5),
 * then totalUnits = amountEachUnits * 5 — so the on-chain 5-way split
 * never produces dust and the payer is charged a hair under $5 rather
 * than over.
 */

import { formatUnits } from 'viem';
import { APEX_PRICE_USD, APEX_TOKENS, type ApexToken } from './config';

export interface ApexQuote {
  /** Token units each of the 5 recipients receives. */
  amountEachUnits: bigint;
  /** Total token units pulled from the payer (= amountEachUnits * 5). */
  totalUnits: bigint;
  /** Human-readable amount per recipient (e.g. "5.00"). */
  amountEachDisplay: string;
  /** Human-readable total (e.g. "25.00"). */
  totalDisplay: string;
  /** USD price of one token used for the conversion (display only). */
  priceUsd: number;
}

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens';

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Normalize an API price value (string or number) into a plain decimal
 * string. Returns null when the value isn't a positive decimal.
 */
function normalizePriceString(value: unknown): string | null {
  let str: string;
  if (typeof value === 'string') {
    str = value.trim();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    // Avoid exponent notation for very small/large floats.
    str = value.toFixed(18);
  } else {
    return null;
  }
  if (!DECIMAL_RE.test(str)) return null;
  if (!/[1-9]/.test(str)) return null; // all zeros
  return str;
}

/**
 * Convert a USD amount into token base units using the raw decimal rate:
 *   units = usd * 10^(tokenDecimals + scale) / scaledPrice
 * where the price string `p.q` is treated exactly as the integer `pq`
 * scaled by 10^len(q). Pure BigInt — floor-exact, no float drift.
 */
function usdToTokenUnits(usd: number, priceDecimal: string, tokenDecimals: number): bigint {
  const [intPart, fracPart = ''] = priceDecimal.split('.');
  const scale = fracPart.length;
  const scaledPrice = BigInt(intPart + fracPart);
  if (scaledPrice <= 0n) {
    throw new Error('token price is zero');
  }
  return (BigInt(usd) * 10n ** BigInt(tokenDecimals + scale)) / scaledPrice;
}

/**
 * Fetch a token's USD market price from DexScreener (mirrors the fetch
 * pattern in hooks/useTokenInfo.ts). Throws if no usable price is
 * available. Returns the raw decimal string straight from the API.
 */
async function fetchDexPriceUsd(token: ApexToken): Promise<string> {
  const tokenAddress = APEX_TOKENS[token].address;
  const res = await fetch(`${DEXSCREENER_BASE}/${tokenAddress}`);
  if (!res.ok) {
    throw new Error(`${token} price lookup failed: DexScreener HTTP ${res.status}`);
  }
  const json = await res.json();
  const pairs: any[] = json.pairs ?? [];
  if (pairs.length === 0) {
    throw new Error(`${token} price unavailable: no DexScreener pairs for token`);
  }
  // Prefer the Ethereum pair when the address has cross-chain listings.
  const onChain = pairs.find((p) => p.chainId === 'ethereum') ?? pairs[0];
  const price = normalizePriceString(onChain.priceUsd);
  if (!price) {
    throw new Error(`${token} price unavailable: DexScreener returned no priceUsd`);
  }
  return price;
}

/**
 * Resolve the current USD price of one unit of the given Apex token, as a
 * raw decimal string straight from the source API.
 */
async function getTokenPriceUsd(token: ApexToken): Promise<string> {
  if (token === 'USDC') return '1';
  return fetchDexPriceUsd(token);
}

/**
 * Quote the $5 Apex subscription in the given token, split 5 ways with
 * no dust. Throws with a descriptive error if the token's USD price
 * cannot be determined.
 */
export async function getApexQuote(token: ApexToken): Promise<ApexQuote> {
  const tokenConfig = APEX_TOKENS[token];
  const priceDecimal = await getTokenPriceUsd(token);

  const rawTotalUnits = usdToTokenUnits(APEX_PRICE_USD, priceDecimal, tokenConfig.decimals);
  if (rawTotalUnits <= 0n) {
    throw new Error(`Apex quote for ${token} resolved to zero units`);
  }

  // Exact 5-way split: floor, then recompute the total so total = each * 5.
  const amountEachUnits = rawTotalUnits / 5n;
  const totalUnits = amountEachUnits * 5n;
  if (amountEachUnits <= 0n) {
    throw new Error(`Apex quote for ${token} is too small to split 5 ways`);
  }

  return {
    amountEachUnits,
    totalUnits,
    amountEachDisplay: formatUnits(amountEachUnits, tokenConfig.decimals),
    totalDisplay: formatUnits(totalUnits, tokenConfig.decimals),
    priceUsd: Number(priceDecimal),
  };
}
