// NETWORKED. Registers a throwaway account on PRODUCTION and subscribes to its
// device inbox — the full identity path, through mobile's own onboarding code.
//
// This is the last piece before two bots can exchange DMs. It proves mobile's
// real keyService + quorumClient + transport work headlessly end to end:
// derive → register → connect → listen.
//
// ⚠️ Creates a REAL registration on the live relay. Throwaway account only. The
// device keyset persists to .state/, so re-runs reuse the same device instead of
// registering a new one each time — see identity.ts for why that matters.
//
// Run: yarn harness ping          (skip with HARNESS_OFFLINE=1)
import { RNWebSocketClient } from '@quilibrium/quorum-shared';
import { loadOrCreateIdentity } from './identity';
import { getQuorumClient } from '@/services/api/quorumClient';

const WS_URL = process.env.QUORUM_WS_URL ?? 'wss://api.quorummessenger.com/ws';
const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const maybe = OFFLINE ? describe.skip : describe;

maybe('ping (networked — production relay)', () => {
  it('registers a throwaway account and subscribes to its inbox', async () => {
    // Stable name → same device across runs. Changing it registers a new device.
    const bot = await loadOrCreateIdentity('ping-bot');

    expect(bot.address).toMatch(/^Qm/);
    expect(bot.inboxAddress).toMatch(/^Qm/);

    // The relay is the source of truth, not our local state: read the
    // registration back and confirm this device is actually in it. Without this
    // the test would pass on a silently failed upload — and a device missing
    // from the registration is precisely how the investigation's "desktop prunes
    // sessions for an unregistered device" failure begins.
    const client = getQuorumClient();
    const reg = await client.fetchUserRegistration(bot.address, { fresh: true });
    expect(reg).toBeTruthy();

    const devices = reg?.device_registrations ?? [];
    const inboxes = devices.map(
      (d: { inbox_registration?: { inbox_address?: string } }) =>
        d.inbox_registration?.inbox_address
    );
    expect(inboxes).toContain(bot.inboxAddress);

    // Re-running must NOT add a device. This assertion is the guard against the
    // harness itself feeding ghost-device accumulation.
    const again = await loadOrCreateIdentity('ping-bot');
    expect(again.inboxAddress).toBe(bot.inboxAddress);

    const after = await client.fetchUserRegistration(bot.address, { fresh: true });
    expect((after?.device_registrations ?? []).length).toBe(devices.length);

    // Now subscribe, over mobile's own transport.
    const ws = new RNWebSocketClient({ url: WS_URL, maxReconnectAttempts: 1 });
    try {
      await ws.connect();
      expect(ws.state).toBe('connected');
      await ws.listen?.([bot.inboxAddress]);
      await new Promise((r) => setTimeout(r, 1500));
      expect(ws.state).toBe('connected');
    } finally {
      ws.disconnect?.();
    }
  }, 180_000);
});
