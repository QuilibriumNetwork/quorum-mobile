/**
 * SecureSigningService - Isolated signing service for mini apps
 *
 * This service handles all cryptographic signing operations in isolation.
 * Private keys are NEVER passed to or stored by the Ethereum provider.
 * Instead, the provider requests signatures through callbacks, and this
 * service performs the actual signing only after user approval.
 *
 * Security architecture:
 * 1. Mini app requests a signature via the provider
 * 2. Provider calls the approval callback (shows UI to user)
 * 3. User approves in native UI (MiniAppApprovalModal)
 * 4. Only then does this service fetch the private key and sign
 * 5. Signature is returned to provider, which returns it to mini app
 *
 * The private key is:
 * - Never stored in the provider instance
 * - Never passed to the WebView context
 * - Only accessed momentarily during signing
 * - Immediately discarded after use
 */

import {
  type Hash,
  type Hex,
  type Address,
  type TransactionRequest,
  createPublicClient,
  http,
  type Chain,
} from 'viem';
import { privateKeyToAccount, signTransaction } from 'viem/accounts';
import {
  mainnet,
  base,
  optimism,
  arbitrum,
  polygon,
  bsc,
  avalanche,
  linea,
  scroll,
  blast,
  zksync,
  gnosis,
  celo,
  zora,
} from 'viem/chains';

// Chain ID to viem chain mapping
export const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  56: bsc,
  137: polygon,
  324: zksync,
  8453: base,
  42161: arbitrum,
  43114: avalanche,
  59144: linea,
  534352: scroll,
  81457: blast,
  100: gnosis,
  42220: celo,
  7777777: zora,
};

// RPC Proxy base URL
const RPC_PROXY_BASE = 'https://rpc-proxy.quorummessenger.com';

// Supported chain IDs for Alchemy RPC
const SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 137, 324, 8453, 42161, 43114, 59144, 534352, 81457, 100, 42220, 7777777
]);

// Get RPC URL for a chain (via proxy)
// Proxy expects: /api/alchemy/{chainId}/rpc
export function getRpcUrl(chainId: number): string {
  if (SUPPORTED_CHAIN_IDS.has(chainId)) {
    return `${RPC_PROXY_BASE}/api/alchemy/${chainId}/rpc`;
  }
  throw new Error(`Unsupported chain: ${chainId}`);
}

/**
 * Transaction parameters for signing
 */
export interface SignTransactionParams {
  to?: Address;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  chainId: number;
}

/**
 * Sign a personal message (EIP-191)
 * Private key is passed in, used once, then discarded.
 */
export async function signPersonalMessage(
  privateKey: string,
  message: Hex | string
): Promise<Hex> {
  const formattedKey = (privateKey.startsWith('0x')
    ? privateKey
    : `0x${privateKey}`) as Hex;

  const account = privateKeyToAccount(formattedKey);

  const signature = await account.signMessage({
    message: typeof message === 'string' && !message.startsWith('0x')
      ? message
      : { raw: message as Hex },
  });

  // Note: In JS we can't securely wipe memory, but we minimize exposure
  // by not storing the key and letting it be garbage collected
  return signature;
}

/**
 * Sign typed data (EIP-712)
 * Private key is passed in, used once, then discarded.
 */
export async function signTypedData(
  privateKey: string,
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }
): Promise<Hex> {
  const formattedKey = (privateKey.startsWith('0x')
    ? privateKey
    : `0x${privateKey}`) as Hex;

  const account = privateKeyToAccount(formattedKey);

  const signature = await account.signTypedData({
    domain: typedData.domain as any,
    types: typedData.types as any,
    primaryType: typedData.primaryType,
    message: typedData.message as any,
  });

  return signature;
}

/**
 * Sign a transaction without sending
 * Private key is passed in, used once, then discarded.
 */
export async function signTransactionOnly(
  privateKey: string,
  txParams: SignTransactionParams
): Promise<Hex> {
  const formattedKey = (privateKey.startsWith('0x')
    ? privateKey
    : `0x${privateKey}`) as Hex;

  const account = privateKeyToAccount(formattedKey);
  const chain = CHAIN_MAP[txParams.chainId] || mainnet;
  const transport = http(getRpcUrl(txParams.chainId));

  // Create a public client for nonce fetching if needed
  const publicClient = createPublicClient({
    chain,
    transport,
  });

  // Fetch nonce if not provided
  let nonce = txParams.nonce;
  if (nonce === undefined) {
    nonce = await publicClient.getTransactionCount({
      address: account.address,
    });
  }

  // Fetch gas prices if not provided
  let maxFeePerGas = txParams.maxFeePerGas;
  let maxPriorityFeePerGas = txParams.maxPriorityFeePerGas;
  let gasPrice = txParams.gasPrice;

  if (!maxFeePerGas && !gasPrice) {
    const feeData = await publicClient.estimateFeesPerGas();
    if (feeData.maxFeePerGas) {
      maxFeePerGas = feeData.maxFeePerGas;
      maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 1000000000n;
    } else if (feeData.gasPrice) {
      gasPrice = feeData.gasPrice;
    }
  }

  // Fetch gas limit if not provided
  let gas = txParams.gas;
  if (!gas) {
    gas = await publicClient.estimateGas({
      account: account.address,
      to: txParams.to,
      data: txParams.data,
      value: txParams.value,
    });
    gas = (gas * 120n) / 100n; // 20% buffer
  }

  const useEip1559 = !!maxFeePerGas;

  const signedTx = await account.signTransaction({
    to: txParams.to,
    value: txParams.value,
    data: txParams.data,
    gas,
    ...(useEip1559
      ? { maxFeePerGas, maxPriorityFeePerGas }
      : { gasPrice }
    ),
    nonce,
    chainId: txParams.chainId,
    type: useEip1559 ? 'eip1559' : 'legacy',
  } as any);

  return signedTx;
}

/**
 * Sign and send a transaction
 * Private key is passed in, used once, then discarded.
 * Returns the transaction hash.
 */
export async function signAndSendTransaction(
  privateKey: string,
  txParams: SignTransactionParams
): Promise<Hash> {
  const formattedKey = (privateKey.startsWith('0x')
    ? privateKey
    : `0x${privateKey}`) as Hex;

  const account = privateKeyToAccount(formattedKey);
  const chain = CHAIN_MAP[txParams.chainId] || mainnet;
  const transport = http(getRpcUrl(txParams.chainId));

  // Create a public client for gas estimation if needed
  const publicClient = createPublicClient({
    chain,
    transport,
  });

  // Estimate gas if not provided
  let gas = txParams.gas;
  if (!gas) {
    gas = await publicClient.estimateGas({
      account: account.address,
      to: txParams.to,
      data: txParams.data,
      value: txParams.value,
    });
    // Add 20% buffer
    gas = (gas * 120n) / 100n;
  }

  // Fetch nonce if not provided
  let nonce = txParams.nonce;
  if (nonce === undefined) {
    nonce = await publicClient.getTransactionCount({
      address: account.address,
    });
  }

  // Fetch gas prices if not provided
  let maxFeePerGas = txParams.maxFeePerGas;
  let maxPriorityFeePerGas = txParams.maxPriorityFeePerGas;
  let gasPrice = txParams.gasPrice;

  if (!maxFeePerGas && !gasPrice) {
    // Fetch current gas prices from network
    const feeData = await publicClient.estimateFeesPerGas();
    if (feeData.maxFeePerGas) {
      // Use EIP-1559 pricing
      maxFeePerGas = feeData.maxFeePerGas;
      maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 1000000000n; // 1 gwei default
    } else if (feeData.gasPrice) {
      // Fallback to legacy pricing
      gasPrice = feeData.gasPrice;
    }
  }

  // Determine transaction type
  const useEip1559 = !!maxFeePerGas;

  // Sign the transaction
  const signedTx = await account.signTransaction({
    to: txParams.to,
    value: txParams.value,
    data: txParams.data,
    gas,
    ...(useEip1559
      ? { maxFeePerGas, maxPriorityFeePerGas }
      : { gasPrice }
    ),
    nonce,
    chainId: txParams.chainId,
    type: useEip1559 ? 'eip1559' : 'legacy',
  } as any);

  // Broadcast the signed transaction
  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx,
  });
  return hash;
}

/**
 * Get address from private key (for verification)
 */
export function getAddressFromPrivateKey(privateKey: string): Address {
  const formattedKey = (privateKey.startsWith('0x')
    ? privateKey
    : `0x${privateKey}`) as Hex;

  const account = privateKeyToAccount(formattedKey);
  return account.address;
}
