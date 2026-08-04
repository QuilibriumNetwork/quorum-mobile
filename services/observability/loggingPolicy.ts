/**
 * Logging policy — installs once, as early as the entry point allows.
 *
 * The shared logger decides at import time whether logging happens at all:
 * it reads `__DEV__` and, in a release bundle, sets `enabled = false`. Its
 * level check runs *after* that flag, so in production every call is
 * discarded — `error` exactly like `debug`. There is no severity that
 * survives a release build unless something reconfigures it, and nothing did.
 *
 * Its default `minLevel` is also `'log'`, which sits above `debug`, so every
 * `logger.debug(...)` in the app was unreachable even with Metro attached.
 * That is not a cosmetic gap: it created pressure to write routine lines at
 * `warn` purely to make them visible, which is why a handful of success
 * messages were sitting in the warning tier.
 *
 * The policy:
 *   dev         debug and up  — everything, including logger.debug
 *   production  warn and up   — a thing failed, or a thing was refused
 *
 * Production therefore keeps the two severities that mean something went
 * wrong, and drops the routine chatter. Every warn/error call site was read
 * before this was turned on: ids are truncated, errors are reduced to their
 * message, and no call site prints message content or key material. Anything
 * added later inherits that obligation — a `warn` now reaches real devices.
 */

import { logger } from '@quilibrium/quorum-shared';

declare const __DEV__: boolean;

let installed = false;

export function installLoggingPolicy(): void {
  if (installed) return;
  installed = true;

  logger.configure({
    // The shared logger set this from __DEV__ at import time; override it so
    // the level below is what actually decides, on both build types.
    enabled: true,
    minLevel: __DEV__ ? 'debug' : 'warn',
  });
}
