/**
 * useUserConfig refreshes from a recent download and writes receipts once.
 *
 * ## The regression this pins
 *
 * `useUserConfig` downloads the whole config blob (megabytes: it carries every
 * Space's encryption state) when it mounts. It mounts on every DM screen open
 * (through useReceiptSettings) and twice when the profile screen opens, and
 * each mount fetched afresh. Separately, turning delivery receipts off made
 * TWO config writes from the screen — delivery off, then read off — each one
 * a whole-blob upload.
 *
 * ## What is asserted
 *
 * - The mount refresh lets getConfig reuse a recent download; an explicit
 *   refresh still asks for a fresh one.
 * - Turning delivery off is one coalesced write that also turns read off.
 * - The switch shows its new value before the upload finishes, and falls back
 *   to what is stored if the write fails.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';

const ADDRESS = 'QmUserAddress';

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { address: 'QmUserAddress' } }),
}));

const mockGetConfig = jest.fn();
const mockUpdateConfig = jest.fn();
const mockGetLocalUserConfig = jest.fn();
jest.mock('../services/config', () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  updateConfig: (...a: unknown[]) => mockUpdateConfig(...a),
  getLocalUserConfig: (...a: unknown[]) => mockGetLocalUserConfig(...a),
  setAllowSync: jest.fn(),
  getLocalBookmarks: () => [],
  addBookmark: jest.fn(),
  removeBookmark: jest.fn(),
}));
jest.mock('../services/config/configService', () => ({
  CONFIG_REFRESH_MAX_AGE_MS: 300_000,
  scheduleConfigPublish: jest.fn(async () => {}),
}));

import { useReceiptSettings, useSyncSettings } from '../hooks/useUserConfig';

const stored = { address: ADDRESS, deliveryReceipts: true, readReceipts: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLocalUserConfig.mockReturnValue(stored);
  mockGetConfig.mockResolvedValue(stored);
});

it('lets the mount refresh reuse a recent download', async () => {
  renderHook(() => useReceiptSettings());
  await waitFor(() => expect(mockGetConfig).toHaveBeenCalled());
  expect(mockGetConfig).toHaveBeenCalledWith(ADDRESS, { maxAgeMs: 300_000 });
});

it('still fetches afresh on an explicit refresh', async () => {
  const { result } = renderHook(() => useSyncSettings());
  await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(1));

  await act(async () => {
    await result.current.refreshConfig();
  });
  expect(mockGetConfig).toHaveBeenLastCalledWith(ADDRESS);
});

it('turns delivery and read receipts off in one coalesced write', async () => {
  mockUpdateConfig.mockResolvedValue({ ...stored, deliveryReceipts: false, readReceipts: false });
  const { result } = renderHook(() => useReceiptSettings());
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  await act(async () => {
    await result.current.setDeliveryReceipts(false);
  });

  expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
  expect(mockUpdateConfig).toHaveBeenCalledWith(
    ADDRESS,
    { deliveryReceipts: false, readReceipts: false },
    { coalesce: true },
  );
  expect(result.current.deliveryReceipts).toBe(false);
  expect(result.current.readReceipts).toBe(false);
});

it('shows the new value before the upload finishes', async () => {
  let finish!: (value: unknown) => void;
  mockUpdateConfig.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const { result } = renderHook(() => useReceiptSettings());
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  let pending!: Promise<void>;
  act(() => {
    pending = result.current.setReadReceipts(false);
  });
  expect(result.current.readReceipts).toBe(false);

  await act(async () => {
    finish({ ...stored, readReceipts: false });
    await pending;
  });
  expect(result.current.readReceipts).toBe(false);
});

it('falls back to the stored value and rethrows when the write fails', async () => {
  mockUpdateConfig.mockRejectedValue(new Error('keystore unavailable'));
  const { result } = renderHook(() => useReceiptSettings());
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  let caught: unknown;
  await act(async () => {
    try {
      await result.current.setReadReceipts(false);
    } catch (e) {
      caught = e;
    }
  });
  expect(caught).toBeInstanceOf(Error);
  expect(result.current.readReceipts).toBe(true);
});
