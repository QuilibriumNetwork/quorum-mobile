// Address/name truncation helpers for display.
//
// The actual address slicing is delegated to the canonical, Qm-aware
// `formatAddress` in @quilibrium/quorum-shared so a given preset renders
// IDENTICALLY on desktop and mobile. The old device-width `scaleFactor`
// (which scaled leading chars by phone size, not by the label's container)
// has been dropped for true cross-platform parity.
//
// `formatAddress(address, start, end)` keeps the constant `Qm` CIDv0 prefix
// visible but counts `start` AFTER it, so `start`/`end` are meaningful entropy
// chars. See the shared helper's docstring for the full rationale.
import { formatAddress } from '@quilibrium/quorum-shared';

// Re-export the canonical helper so call sites can use it directly.
export { formatAddress };

// Fixed start/end pairs per mode, frozen from the old phone (scaleFactor ≈ 1.0)
// values and matching desktop's presets.
const MODES = {
  short: [4, 3],
  medium: [6, 4],
  long: [8, 6],
} as const;

export function truncateAddress(
  address: string | undefined,
  mode: 'short' | 'medium' | 'long' = 'medium',
): string {
  if (!address) return 'Unknown';
  if (address.startsWith('@')) return address;

  const [start, end] = MODES[mode];
  return formatAddress(address, start, end);
}

export function truncateName(name: string, maxLength: number = 16): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength)}…`;
}
