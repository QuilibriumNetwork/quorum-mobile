/**
 * The sync status line is failures-only: it renders for `held`, `rejected`,
 * `timeout` and `no-keys`, and stays silent for everything else.
 *
 * The silent cases carry the weight here. A line that reported success read as
 * a health indicator while actually reporting the last time this device had
 * something to PUBLISH — so a healthy device that had changed nothing in three
 * days announced "Last synced 3 days ago", which is indistinguishable from
 * three days broken. Tests that only assert the failure copy would pass against
 * that version too, so the "renders nothing" cases are the ones that pin the
 * behaviour actually chosen.
 *
 * Two more exist because the toggle and the stored record CAN disagree: sync
 * just switched off while the record still says `rejected`, and sync just
 * switched on with no save since. Both must trust the toggle rather than
 * contradict what the user did a second ago.
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';
import type { LastPublish, PublishOutcome } from '@quilibrium/quorum-shared';

const mockReadLastPublish = jest.fn<LastPublish | null, []>();
jest.mock('@/services/config/lastPublish', () => ({
  readLastPublish: () => mockReadLastPublish(),
}));

import SyncStatusLine from '@/components/SyncStatusLine';

// Only the colour is read off it; the rest of AppTheme is irrelevant here.
const theme = { colors: { warning: '#e7b04a' } } as never;

const record = (outcome: PublishOutcome, extra: Partial<LastPublish> = {}): LastPublish => ({
  at: 1_700_000_000_000,
  outcome,
  ...extra,
});

const renderLine = (allowSync = true) =>
  render(<SyncStatusLine allowSync={allowSync} theme={theme} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockReadLastPublish.mockReturnValue(null);
});

describe('SyncStatusLine renders only when publishing is failing', () => {
  it('names the hold, so the user knows it is waiting rather than broken', () => {
    mockReadLastPublish.mockReturnValue(record('held', { spacesPublished: 1, spacesHeld: 2 }));

    const { getByRole } = renderLine();

    expect(getByRole('alert')).toHaveTextContent(/waiting for spaces/i);
  });

  it('says a rejected publish is still saved locally', () => {
    // Omitting the reassurance makes the message read as data loss, and the
    // change IS on the device.
    mockReadLastPublish.mockReturnValue(record('rejected', { detail: 'invalid config' }));

    const { getByRole } = renderLine();

    expect(getByRole('alert')).toHaveTextContent(/saved on this device/i);
  });

  it('does not blame the server for a `rejected` outcome', () => {
    // saveConfig's try also covers key collection, encryption and signing, so
    // `rejected` is reached by local crypto faults too. Naming the server would
    // send someone debugging a device-local fault to the wrong system. Desktop
    // CAN say "the server refused" because its try wraps only the POST.
    mockReadLastPublish.mockReturnValue(record('rejected', { detail: 'before send: boom' }));

    expect(renderLine().getByRole('alert')).not.toHaveTextContent(/server/i);
  });

  it('does not promise a retry on timeout, because this client never retries', () => {
    // Copied verbatim from desktop, this line used to read "It will keep
    // retrying." True there — its action queue retries transient failures. On
    // mobile saveConfig's catch swallows the error and there is no queue, so
    // nothing happens until the user next changes a setting. Promising an
    // automatic retry is the exact false reassurance this line exists to remove.
    mockReadLastPublish.mockReturnValue(record('timeout'));

    const { getByRole } = renderLine();

    expect(getByRole('alert')).toHaveTextContent(/timed out/i);
    expect(getByRole('alert')).not.toHaveTextContent(/retry|retrying/i);
  });

  it('reports a missing key, which only mobile can reach', () => {
    mockReadLastPublish.mockReturnValue(record('no-keys'));

    const { getByRole } = renderLine();

    expect(getByRole('alert')).toHaveTextContent(/no key is available/i);
  });

  it('renders nothing after a successful publish', () => {
    // The case that makes this component worth having in this shape. A version
    // that announced success would pass every failure test above.
    mockReadLastPublish.mockReturnValue(record('published', { payloadBytes: 4096 }));

    expect(renderLine().queryByRole('alert')).toBeNull();
  });

  it('renders nothing when sync is off, even though `off` was recorded', () => {
    // Not a fault, and the toggle directly above already says it.
    mockReadLastPublish.mockReturnValue(record('off'));

    expect(renderLine(false).queryByRole('alert')).toBeNull();
  });

  it('renders nothing when sync was just switched off but the record still says rejected', () => {
    // The stored failure predates the switch. Contradicting what the user did a
    // second ago is worse than saying nothing.
    mockReadLastPublish.mockReturnValue(record('rejected'));

    expect(renderLine(false).queryByRole('alert')).toBeNull();
  });

  it('renders nothing when sync was just switched on and nothing has been saved since', () => {
    mockReadLastPublish.mockReturnValue(null);

    expect(renderLine(true).queryByRole('alert')).toBeNull();
  });

  it('renders nothing for an outcome a newer build invented', () => {
    // Forward compatibility: an unknown value is not a fault we can describe.
    mockReadLastPublish.mockReturnValue(record('something-new' as PublishOutcome));

    expect(renderLine().queryByRole('alert')).toBeNull();
  });

  it('picks up a failure that happens while the panel is already open', () => {
    // MMKV writes from this same process fire no event the component listens
    // to, so without the poll a user watching the panel sees nothing change.
    jest.useFakeTimers();
    try {
      mockReadLastPublish.mockReturnValue(record('published'));
      const { queryByRole } = renderLine();
      expect(queryByRole('alert')).toBeNull();

      mockReadLastPublish.mockReturnValue(record('rejected'));
      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(queryByRole('alert')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears once publishing recovers, without needing the panel reopened', () => {
    jest.useFakeTimers();
    try {
      mockReadLastPublish.mockReturnValue(record('rejected'));
      const { queryByRole } = renderLine();
      expect(queryByRole('alert')).not.toBeNull();

      mockReadLastPublish.mockReturnValue(record('published'));
      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(queryByRole('alert')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
