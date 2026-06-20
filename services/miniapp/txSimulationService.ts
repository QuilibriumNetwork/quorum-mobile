/**
 * txSimulationService — pre-sign sanity check for mini-app transactions.
 *
 * Before the user is asked to approve a transaction a mini app requested,
 * we simulate it against the target chain so the approval sheet can warn
 * when it would obviously fail:
 *
 *   1. The call reverts (estimateGas throws) — e.g. a contract require()
 *      fails, the allowance is missing, etc.
 *   2. The wallet lacks enough NATIVE token on THAT chain to cover
 *      value + gas. This is the common "I have Base ETH but the tx is on
 *      mainnet" trap: the funds exist, just not on the chain the tx pays
 *      gas from. Nothing else in the flow checks per-chain balance.
 *
 * Best-effort only: any network hiccup yields status 'unknown' and never
 * blocks signing — the user can still confirm. We only surface a warning.
 */

import { createPublicClient, http, formatEther, type Address } from 'viem';
import { CHAIN_MAP, getRpcUrl } from '@/services/miniapp/secureSigningService';
import type { TransactionForApproval } from '@/services/miniapp/ethereumProvider';

export type TxSimulationStatus =
  | 'ok'
  | 'will-revert'
  | 'insufficient-funds'
  | 'unknown';

export interface TxSimulationResult {
  status: TxSimulationStatus;
  /** Short human-readable warning for the approval sheet (undefined when ok/unknown). */
  warning?: string;
  /** Estimated total cost in wei (value + gas*fee), when computable. */
  estimatedCostWei?: bigint;
  /** The wallet's native balance on the tx chain, in wei. */
  balanceWei?: bigint;
  /** Native currency symbol for the tx chain (e.g. 'ETH'). */
  nativeSymbol: string;
  /** Chain display name. */
  chainName: string;
}

/** Trim a formatEther string to a few significant decimals for display. */
function trimAmount(v: string): string {
  if (!v.includes('.')) return v;
  const [whole, frac] = v.split('.');
  // Keep up to 6 decimals, drop trailing zeros.
  const trimmed = frac.slice(0, 6).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** Pull a concise revert reason out of a viem error, if any. */
function shortRevertReason(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { shortMessage?: string; details?: string; message?: string };
  const raw = e.shortMessage ?? e.details ?? e.message;
  if (!raw) return undefined;
  // viem messages can be multi-line and verbose; take the first line and cap it.
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
}

/**
 * Simulate a mini-app transaction against its target chain. Never throws —
 * returns status 'unknown' when the simulation itself can't be completed.
 */
export async function simulateMiniAppTransaction(
  tx: TransactionForApproval,
): Promise<TxSimulationResult> {
  const chain = CHAIN_MAP[tx.chainId];
  const nativeSymbol = chain?.nativeCurrency?.symbol ?? 'ETH';
  const chainName = chain?.name ?? `chain ${tx.chainId}`;

  let rpcUrl: string;
  try {
    rpcUrl = getRpcUrl(tx.chainId);
  } catch {
    // Unsupported chain — can't simulate, don't block.
    return { status: 'unknown', nativeSymbol, chainName };
  }

  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const from = tx.from as Address;
  const value = tx.value ?? 0n;

  // 1. Native balance on the tx's chain (the load-bearing cross-chain check).
  let balanceWei: bigint | undefined;
  try {
    balanceWei = await client.getBalance({ address: from });
  } catch {
    // Inconclusive — leave undefined.
  }

  // 2. Gas limit. If the mini app supplied one we trust it, but we still
  //    run estimateGas as a revert probe so we can warn on a doomed tx.
  let gasLimit = tx.gas;
  try {
    const estimated = await client.estimateGas({
      account: from,
      to: tx.to,
      value,
      data: tx.data,
    });
    if (gasLimit == null) gasLimit = estimated;
  } catch (e) {
    const reason = shortRevertReason(e);
    return {
      status: 'will-revert',
      warning: reason
        ? `This transaction is expected to fail: ${reason}`
        : 'This transaction is expected to fail — it reverts in simulation.',
      balanceWei,
      nativeSymbol,
      chainName,
    };
  }

  // 3. Fee per gas — prefer what the mini app set, else estimate.
  let feePerGas = tx.maxFeePerGas ?? tx.gasPrice;
  if (feePerGas == null) {
    try {
      const fees = await client.estimateFeesPerGas();
      feePerGas = fees.maxFeePerGas;
    } catch {
      try {
        feePerGas = await client.getGasPrice();
      } catch {
        // leave undefined → sufficiency check is skipped below
      }
    }
  }

  // 4. Sufficiency: balance must cover value + worst-case gas cost.
  if (balanceWei != null && gasLimit != null && feePerGas != null) {
    const estimatedCostWei = value + gasLimit * feePerGas;
    if (balanceWei < estimatedCostWei) {
      const need = trimAmount(formatEther(estimatedCostWei));
      const have = trimAmount(formatEther(balanceWei));
      return {
        status: 'insufficient-funds',
        warning:
          `Not enough ${nativeSymbol} on ${chainName} for this transaction. ` +
          `Needs ~${need} ${nativeSymbol}, this wallet holds ${have} ${nativeSymbol}.`,
        estimatedCostWei,
        balanceWei,
        nativeSymbol,
        chainName,
      };
    }
    return { status: 'ok', estimatedCostWei, balanceWei, nativeSymbol, chainName };
  }

  return { status: 'unknown', balanceWei, nativeSymbol, chainName };
}
