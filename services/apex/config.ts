/**
 * Quorum Apex configuration — pricing, chain, contract, and token constants.
 *
 * Apex is a $25/month subscription paid in wQUIL, SNAP, or USDC on
 * Ethereum mainnet (the only chain where all three tokens exist). The
 * payment goes through the ApexSplitter contract (contracts/ApexSplitter.sol),
 * which splits it 5 ways: 1/5 to the Q Inc registry address and 1/5 each
 * to the four space owners the subscriber chose.
 */

import type { Address } from 'viem';
import { QNS_TOKEN_ADDRESSES, TOKEN_DECIMALS } from '@/services/wallet/qnsPaymentService';

/** Monthly subscription price, in USD. Converted to token units at quote time. */
export const APEX_PRICE_USD = 25;

/** Q Inc registry address — always recipients[0] of the 5-way split. */
export const Q_INC_ADDRESS: Address = '0x4EB75d50C70faBAaF5f5980dE7c11009318C8635';

/** Apex payments are Ethereum mainnet only. */
export const APEX_CHAIN_ID = 1;

/**
 * ApexSplitter contract addresses per chain (contracts/ApexSplitter.sol).
 *
 * Mainnet deployment: 2026-06-11. The backend's /apex/subscriptions
 * verifier must match ApexPayment events from this exact address
 * (topic0 0x9551976b75c46988fab102a079e808dd12b1ecb24955eca688d899ca9e96ac88).
 */
export const APEX_SPLITTER_ADDRESSES: Record<number, Address> = {
  1: '0xF09480bDcF2E9500af4838c73Ad56F0af2190329',
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Whether the ApexSplitter is deployed on the given chain (i.e. an address
 * is configured and isn't the zero-address placeholder).
 */
export function isApexSplitterDeployed(chainId: number): boolean {
  const address = APEX_SPLITTER_ADDRESSES[chainId];
  return !!address && address.toLowerCase() !== ZERO_ADDRESS;
}

/** The three tokens accepted for Apex subscriptions. */
export type ApexToken = 'wQUIL' | 'SNAP' | 'USDC';

export interface ApexTokenConfig {
  symbol: ApexToken;
  /** ERC20 contract address on Ethereum mainnet. */
  address: Address;
  decimals: number;
  /**
   * Whether the token is known to support EIP-2612 permit. Tokens where
   * this is false skip the permit probe and go straight to the
   * approve + paySplitExact fallback.
   */
  supportsPermit: boolean;
}

/**
 * Accepted tokens with their mainnet addresses and decimals. wQUIL and
 * USDC reuse the QNS payment constants so the two services can't drift.
 */
export const APEX_TOKENS: Record<ApexToken, ApexTokenConfig> = {
  wQUIL: {
    symbol: 'wQUIL',
    address: QNS_TOKEN_ADDRESSES[1].wQUIL,
    decimals: TOKEN_DECIMALS.wQUIL,
    supportsPermit: true,
  },
  SNAP: {
    symbol: 'SNAP',
    address: '0x49B5a631F54927c0007232844f06FE18cbf69786',
    decimals: 6,
    // SNAP likely lacks EIP-2612; the payment service probes nonces() and
    // falls back to approve + paySplitExact when the probe reverts.
    supportsPermit: false,
  },
  USDC: {
    symbol: 'USDC',
    address: QNS_TOKEN_ADDRESSES[1].USDC,
    decimals: TOKEN_DECIMALS.USDC,
    supportsPermit: true,
  },
};
