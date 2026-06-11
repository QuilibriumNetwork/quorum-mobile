/**
 * authTokenEvents — reactive backstop for Farcaster auth-token expiry.
 *
 * High-traffic Farcaster API call sites (feed fetch, notifications,
 * legacy cast submit) call `reportFarcasterAuthFailure()` when they see
 * a 401/403. That invokes a handler registered by AuthContext which
 * force-refreshes the token via the stored custody key and invalidates
 * the affected React Query caches so consumers refetch with the new
 * token.
 *
 * This module exists (instead of call sites importing AuthContext
 * directly) because the call sites are plain async functions, not
 * components — and importing the context here would create a cycle.
 *
 * Single-flight + cooldown: a feed page, a notifications poll, and a
 * cast submit can all 401 in the same second when the token expires.
 * Only the first report triggers a refresh; the rest are dropped until
 * the in-flight attempt settles AND the cooldown elapses.
 */

type FarcasterAuthFailureHandler = () => Promise<unknown>;

const REPORT_COOLDOWN_MS = 60_000;

let handler: FarcasterAuthFailureHandler | null = null;
let inFlight = false;
let lastAttemptAt = 0;

/**
 * Register the recovery handler (AuthContext's refreshFarcasterToken).
 * Returns an unregister function for useEffect cleanup. Last writer
 * wins — there's exactly one AuthProvider, so in practice this is a
 * singleton registration.
 */
export function registerFarcasterAuthFailureHandler(
  fn: FarcasterAuthFailureHandler,
): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/**
 * Report that a Farcaster API call was rejected with 401/403.
 * Fire-and-forget: the caller still throws its own error so the UI can
 * show the failure; the recovery runs in the background and the
 * handler invalidates queries on success, which refetches with the
 * fresh token.
 */
export function reportFarcasterAuthFailure(): void {
  const current = handler;
  if (!current || inFlight) return;
  const now = Date.now();
  if (now - lastAttemptAt < REPORT_COOLDOWN_MS) return;
  lastAttemptAt = now;
  inFlight = true;
  void (async () => {
    try {
      await current();
    } catch {
      // Handler reports its own failures via its result type; nothing
      // actionable here. Cooldown prevents a retry storm regardless.
    } finally {
      inFlight = false;
    }
  })();
}
