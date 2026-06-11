/**
 * QNS Payment Service - ERC20 permit signing and splitter contract calls
 * Handles payments for marketplace purchases, auction payments, and name registration.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hash,
  type Hex,
  type Address,
  type Chain,
  parseUnits,
  encodeFunctionData,
  hexToSignature,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, optimism, arbitrum, polygon } from 'viem/chains';

// RPC Proxy base URL (same as transactionService.ts)
const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';

export function getRpcUrl(chainId: number): string {
  return `${RPC_PROXY_BASE}/api/alchemy/${chainId}/rpc`;
}

// The rpc proxy is intermittently slower than viem's 10s default timeout.
export const RPC_TIMEOUT_MS = 30_000;

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  137: polygon,
  8453: base,
  42161: arbitrum,
};

// Chain name to ID mapping
export const QNS_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
};

export const QNS_CHAIN_NAMES: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  137: 'polygon',
  10: 'optimism',
};

// TimedExactTokenSplitter contract addresses per chain
export const QNS_SPLITTER_ADDRESSES: Record<number, Address> = {
  1: '0x374f62D4b1bC9582cA789A96653379C01129cB90',
  8453: '0x3D92D5837A7Da99852dBFf939dfcb359a64c7d34',
  42161: '0x6C7dDF7978eC9c83F52be04cb362F1BFC2E233A4',
  137: '0x5E2e9657099e285Fd1Ff17F344ab7a0c276a6E2E',
  10: '0xD767003287fc0008b5c86BbaE6F712c9386BA462',
};

// Token contract addresses per chain
export const QNS_TOKEN_ADDRESSES: Record<number, Record<string, Address>> = {
  1: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    wQUIL: '0x8143182a775C54578c8B7b3Ef77982498866945D',
  },
  8453: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  42161: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  137: {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  10: {
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
};

export const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  wQUIL: 8,
};

// EIP-2612 Permit domain names
const TOKEN_PERMIT_NAMES: Record<string, string> = {
  USDC: 'USD Coin',
  wQUIL: 'Wrapped QUIL',
};

const TOKEN_PERMIT_VERSIONS: Record<string, string> = {
  USDC: '2',
  wQUIL: '1',
};

// TimedExactTokenSplitter ABI
const SPLITTER_ABI = [
  {
    name: 'paySplitExactWithPermit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'primary', type: 'address' },
      { name: 'secondary', type: 'address' },
      { name: 'amountPrimary', type: 'uint256' },
      { name: 'amountSecondary', type: 'uint256' },
      { name: 'paymentDeadline', type: 'uint256' },
      { name: 'permitDeadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// ERC20 ABI fragments
const ERC20_NONCES_ABI = [
  {
    name: 'nonces',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

function formatKey(privateKey: string): Hex {
  return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
}

/**
 * Read the ERC20 permit nonce for a wallet address
 */
export async function getTokenNonce(
  chainId: number,
  tokenAddress: string,
  walletAddress: string
): Promise<bigint> {
  const chain = CHAIN_MAP[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

  const transport = http(getRpcUrl(chainId), { timeout: RPC_TIMEOUT_MS });
  const publicClient = createPublicClient({ chain, transport });

  const nonce = await publicClient.readContract({
    address: tokenAddress as Address,
    abi: ERC20_NONCES_ABI,
    functionName: 'nonces',
    args: [walletAddress as Address],
  });

  return nonce;
}

/**
 * Sign an ERC20 Permit (EIP-2612) using EIP-712 typed data
 */
export async function signERC20Permit(
  privateKey: string,
  chainId: number,
  tokenSymbol: string,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint,
  nonce: bigint,
  deadline: bigint
): Promise<{ v: number; r: Hex; s: Hex }> {
  const chain = CHAIN_MAP[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

  const account = privateKeyToAccount(formatKey(privateKey));
  const transport = http(getRpcUrl(chainId), { timeout: RPC_TIMEOUT_MS });
  const walletClient = createWalletClient({ account, chain, transport });

  const signature = await walletClient.signTypedData({
    domain: {
      name: TOKEN_PERMIT_NAMES[tokenSymbol] || tokenSymbol,
      version: TOKEN_PERMIT_VERSIONS[tokenSymbol] || '1',
      chainId,
      verifyingContract: tokenAddress as Address,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: account.address,
      spender: spenderAddress as Address,
      value: amount,
      nonce,
      deadline,
    },
  });

  const { v, r, s } = hexToSignature(signature);
  return { v: Number(v), r, s };
}

/**
 * Send a payment through the TimedExactTokenSplitter contract with permit
 */
export async function sendSplitterPayment(
  privateKey: string,
  chainId: number,
  tokenAddress: string,
  primaryRecipient: string,
  secondaryRecipient: string,
  primaryAmount: bigint,
  secondaryAmount: bigint,
  paymentDeadline: bigint,
  permitDeadline: bigint,
  v: number,
  r: Hex,
  s: Hex
): Promise<Hash> {
  const chain = CHAIN_MAP[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

  const splitterAddress = QNS_SPLITTER_ADDRESSES[chainId];
  if (!splitterAddress) throw new Error(`Splitter not deployed on chain ${chainId}`);

  const account = privateKeyToAccount(formatKey(privateKey));
  const transport = http(getRpcUrl(chainId), { timeout: RPC_TIMEOUT_MS });

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const data = encodeFunctionData({
    abi: SPLITTER_ABI,
    functionName: 'paySplitExactWithPermit',
    args: [
      tokenAddress as Address,
      primaryRecipient as Address,
      secondaryRecipient as Address,
      primaryAmount,
      secondaryAmount,
      paymentDeadline,
      permitDeadline,
      v,
      r,
      s,
    ],
  });

  // Estimate gas
  let gasLimit: bigint;
  try {
    gasLimit = await publicClient.estimateGas({
      to: splitterAddress,
      data,
      account: account.address,
    });
    gasLimit = (gasLimit * 130n) / 100n; // 30% buffer for permit+splitter
  } catch {
    gasLimit = 500000n;
  }

  const hash = await walletClient.sendTransaction({
    to: splitterAddress,
    data,
    gas: gasLimit,
    chain,
    account,
  });

  return hash;
}

/**
 * Send a simple ERC20 transfer (for registration payments)
 */
export async function sendERC20Transfer(
  privateKey: string,
  chainId: number,
  tokenAddress: string,
  to: string,
  amount: bigint
): Promise<Hash> {
  const chain = CHAIN_MAP[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);

  const account = privateKeyToAccount(formatKey(privateKey));
  const transport = http(getRpcUrl(chainId), { timeout: RPC_TIMEOUT_MS });

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [to as Address, amount],
  });

  let gasLimit: bigint;
  try {
    gasLimit = await publicClient.estimateGas({
      to: tokenAddress as Address,
      data,
      account: account.address,
    });
    gasLimit = (gasLimit * 120n) / 100n;
  } catch {
    gasLimit = 100000n;
  }

  const hash = await walletClient.sendTransaction({
    to: tokenAddress as Address,
    data,
    gas: gasLimit,
    chain,
    account,
  });

  return hash;
}

/**
 * Execute a full permit+splitter payment flow
 * Used for marketplace purchases, auction payments, and offer payments
 */
export async function executePermitSplitterPayment(params: {
  privateKey: string;
  chainId: number;
  tokenSymbol: string;
  platformAddress: string;
  sellerAddress: string;
  feeAmount: string;
  sellerAmount: string;
  lockExpiresAt?: string;
}): Promise<Hash> {
  const {
    privateKey,
    chainId,
    tokenSymbol,
    platformAddress,
    sellerAddress,
    feeAmount,
    sellerAmount,
    lockExpiresAt,
  } = params;

  const tokenAddress = QNS_TOKEN_ADDRESSES[chainId]?.[tokenSymbol];
  if (!tokenAddress) throw new Error(`Token ${tokenSymbol} not available on chain ${chainId}`);

  const splitterAddress = QNS_SPLITTER_ADDRESSES[chainId];
  if (!splitterAddress) throw new Error(`Splitter not deployed on chain ${chainId}`);

  const account = privateKeyToAccount(formatKey(privateKey));
  const decimals = TOKEN_DECIMALS[tokenSymbol] || 18;

  const feeAmountWei = parseUnits(feeAmount, decimals);
  const sellerAmountWei = parseUnits(sellerAmount, decimals);
  const totalAmountWei = feeAmountWei + sellerAmountWei;

  // Payment deadline: before lock expires (30s buffer) or 10 min from now
  let paymentDeadline: bigint;
  if (lockExpiresAt) {
    const lockExpiresMs = new Date(lockExpiresAt).getTime();
    paymentDeadline = BigInt(Math.floor(lockExpiresMs / 1000) - 30);
  } else {
    paymentDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  }

  // Permit deadline: 10 minutes from now
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Get nonce
  const nonce = await getTokenNonce(chainId, tokenAddress, account.address);

  // Sign permit
  const { v, r, s } = await signERC20Permit(
    privateKey,
    chainId,
    tokenSymbol,
    tokenAddress,
    splitterAddress,
    totalAmountWei,
    nonce,
    permitDeadline
  );

  // Send splitter tx
  const hash = await sendSplitterPayment(
    privateKey,
    chainId,
    tokenAddress,
    platformAddress,
    sellerAddress,
    feeAmountWei,
    sellerAmountWei,
    paymentDeadline,
    permitDeadline,
    v,
    r,
    s
  );

  return hash;
}

/**
 * Get available chains for a token
 */
export function getAvailableChains(tokenSymbol: string): { chainId: number; name: string }[] {
  const chains: { chainId: number; name: string }[] = [];
  for (const [chainIdStr, tokens] of Object.entries(QNS_TOKEN_ADDRESSES)) {
    const chainId = parseInt(chainIdStr);
    if (tokens[tokenSymbol]) {
      chains.push({ chainId, name: QNS_CHAIN_NAMES[chainId] || `Chain ${chainId}` });
    }
  }
  return chains;
}

/**
 * Get token address for a specific chain
 */
export function getTokenAddress(chainId: number, tokenSymbol: string): Address | null {
  return QNS_TOKEN_ADDRESSES[chainId]?.[tokenSymbol] ?? null;
}
