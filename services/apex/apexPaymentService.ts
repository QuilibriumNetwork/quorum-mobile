/**
 * Apex payment service — execute the 5-way ApexSplitter payment for a
 * Quorum Apex subscription on Ethereum mainnet.
 *
 * Flow (mirrors services/wallet/qnsPaymentService.ts):
 *   1. Build the four-element space-owner recipients array (the contract
 *      hardcodes the Q Inc registry address as recipients[0] itself).
 *   2. Try the EIP-2612 permit path first (USDC, wQUIL): read nonces(),
 *      sign the permit for amountEach * 5, call paySplitExactWithPermit.
 *   3. If the token doesn't support permit (nonces() reverts — SNAP), fall
 *      back to: check allowance → approve(splitter, total) tx → wait for
 *      the receipt → paySplitExact.
 *
 * The splitter contract source lives in contracts/ApexSplitter.sol; its
 * deployed address must be set in services/apex/config.ts before this
 * service will run (see isApexSplitterDeployed).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import {
  getRpcUrl,
  getTokenNonce,
  signERC20Permit,
  RPC_TIMEOUT_MS,
} from '@/services/wallet/qnsPaymentService';
import {
  APEX_CHAIN_ID,
  APEX_SPLITTER_ADDRESSES,
  APEX_TOKENS,
  isApexSplitterDeployed,
  type ApexToken,
} from './config';

/** ApexSplitter contract ABI (contracts/ApexSplitter.sol). */
export const APEX_SPLITTER_ABI = [
  {
    name: 'paySplitExactWithPermit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spaceRecipients', type: 'address[4]' },
      { name: 'amountEach', type: 'uint256' },
      { name: 'paymentDeadline', type: 'uint256' },
      { name: 'permitDeadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      { name: 'subscriber', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'paySplitExact',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spaceRecipients', type: 'address[4]' },
      { name: 'amountEach', type: 'uint256' },
      { name: 'paymentDeadline', type: 'uint256' },
      { name: 'subscriber', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/**
 * Canonical on-chain subscriber identifier: keccak256 of the UTF-8 bytes of
 * the lowercased Quorum address. Emitted as the indexed `subscriber` topic
 * in the ApexPayment event so the Quorum API can bind the payment to the
 * claiming account without any extra wallet-ownership proof. The server
 * MUST apply the same canonicalization (lowercase, no trimming of 0x).
 */
export function apexSubscriberId(quorumAddress: string): Hex {
  return keccak256(stringToBytes(quorumAddress.toLowerCase()));
}

const ERC20_ALLOWANCE_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** Payment + permit deadlines: 30 minutes from now. */
const DEADLINE_SECONDS = 30 * 60;

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function formatKey(privateKey: string): Hex {
  return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
}

export interface PayApexSubscriptionParams {
  /** Hex-encoded Ethereum private key of the paying wallet. */
  privateKey: string;
  /** Token to pay with — must match the apex-config of all four chosen spaces. */
  token: ApexToken;
  /** ETH payout addresses of the four chosen space owners, in display order. */
  recipientPayoutAddresses: [string, string, string, string];
  /** Units each of the 5 recipients receives (from getApexQuote). */
  amountEachUnits: bigint;
  /** Subscriber's Quorum address — hashed into the on-chain event so the
   *  server can bind the payment to this account (see apexSubscriberId). */
  quorumAddress: string;
}

/**
 * Execute the full Apex subscription payment through the ApexSplitter.
 * Returns the splitter transaction hash on success; throws a descriptive
 * Error on any failure (no partial state to clean up — the splitter is
 * all-or-nothing within one transaction).
 */
export async function payApexSubscription(
  params: PayApexSubscriptionParams
): Promise<{ txHash: string }> {
  const { privateKey, token, recipientPayoutAddresses, amountEachUnits, quorumAddress } = params;

  if (!quorumAddress) {
    throw new Error('Apex payment requires the subscriber Quorum address');
  }
  const subscriber = apexSubscriberId(quorumAddress);

  if (!isApexSplitterDeployed(APEX_CHAIN_ID)) {
    throw new Error(
      'Apex splitter contract is not deployed yet — set its address in services/apex/config.ts'
    );
  }
  const splitterAddress = APEX_SPLITTER_ADDRESSES[APEX_CHAIN_ID];
  const tokenConfig = APEX_TOKENS[token];

  if (amountEachUnits <= 0n) {
    throw new Error('Apex payment amount must be greater than zero');
  }
  if (recipientPayoutAddresses.length !== 4) {
    throw new Error('Apex payment requires exactly four space payout addresses');
  }
  for (const address of recipientPayoutAddresses) {
    if (!ETH_ADDRESS_RE.test(address) || address.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(`Invalid space payout address: ${address}`);
    }
  }

  // The contract hardcodes the Q Inc registry address as recipients[0] and
  // takes only the four space-owner payout addresses from the caller.
  const recipients: readonly [Address, Address, Address, Address] = [
    recipientPayoutAddresses[0] as Address,
    recipientPayoutAddresses[1] as Address,
    recipientPayoutAddresses[2] as Address,
    recipientPayoutAddresses[3] as Address,
  ];

  const totalUnits = amountEachUnits * 5n;
  const account = privateKeyToAccount(formatKey(privateKey));
  const transport = http(getRpcUrl(APEX_CHAIN_ID), { timeout: RPC_TIMEOUT_MS });
  const publicClient = createPublicClient({ chain: mainnet, transport });
  const walletClient = createWalletClient({ account, chain: mainnet, transport });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const paymentDeadline = BigInt(nowSeconds + DEADLINE_SECONDS);
  const permitDeadline = paymentDeadline;

  // Probe EIP-2612 support: read nonces(). Tokens flagged supportsPermit
  // false (SNAP) skip the probe; for others a revert means no permit.
  let permitNonce: bigint | null = null;
  if (tokenConfig.supportsPermit) {
    try {
      permitNonce = await getTokenNonce(APEX_CHAIN_ID, tokenConfig.address, account.address);
    } catch {
      permitNonce = null;
    }
  }

  let data: Hex;
  if (permitNonce !== null) {
    // Permit path — sign EIP-2612 for the full 5x total. Domain names and
    // versions (USDC = 'USD Coin' v2, wQUIL = 'Wrapped QUIL' v1) come from
    // qnsPaymentService's TOKEN_PERMIT_NAMES/TOKEN_PERMIT_VERSIONS maps.
    const { v, r, s } = await signERC20Permit(
      privateKey,
      APEX_CHAIN_ID,
      token,
      tokenConfig.address,
      splitterAddress,
      totalUnits,
      permitNonce,
      permitDeadline
    );

    data = encodeFunctionData({
      abi: APEX_SPLITTER_ABI,
      functionName: 'paySplitExactWithPermit',
      args: [
        tokenConfig.address,
        recipients,
        amountEachUnits,
        paymentDeadline,
        permitDeadline,
        v,
        r,
        s,
        subscriber,
      ],
    });
  } else {
    // Approve fallback — for tokens without EIP-2612 (SNAP).
    await ensureAllowance(
      publicClient,
      walletClient,
      account.address,
      tokenConfig.address,
      splitterAddress,
      totalUnits,
      token
    );

    data = encodeFunctionData({
      abi: APEX_SPLITTER_ABI,
      functionName: 'paySplitExact',
      args: [tokenConfig.address, recipients, amountEachUnits, paymentDeadline, subscriber],
    });
  }

  // Estimate gas with a buffer; fall back to a generous fixed limit.
  let gasLimit: bigint;
  try {
    gasLimit = await publicClient.estimateGas({
      to: splitterAddress,
      data,
      account: account.address,
    });
    gasLimit = (gasLimit * 130n) / 100n; // 30% buffer for permit + 5 transfers
  } catch {
    gasLimit = 600000n;
  }

  try {
    const txHash = await walletClient.sendTransaction({
      to: splitterAddress,
      data,
      gas: gasLimit,
      chain: mainnet,
      account,
    });
    return { txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Apex splitter payment failed: ${message}`);
  }
}

/**
 * Ensure the splitter has at least `totalUnits` of allowance, sending an
 * approve transaction and waiting for its receipt if needed.
 */
async function ensureAllowance(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  owner: Address,
  tokenAddress: Address,
  splitterAddress: Address,
  totalUnits: bigint,
  token: ApexToken
): Promise<void> {
  let allowance: bigint;
  try {
    allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [owner, splitterAddress],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${token} allowance: ${message}`);
  }

  if (allowance >= totalUnits) return;

  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [splitterAddress, totalUnits],
  });

  let approveHash: Hex;
  try {
    approveHash = await walletClient.sendTransaction({
      to: tokenAddress,
      data: approveData,
      chain: mainnet,
      account: walletClient.account!,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${token} approval transaction failed: ${message}`);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (receipt.status !== 'success') {
    throw new Error(`${token} approval transaction reverted (tx ${approveHash})`);
  }
}
