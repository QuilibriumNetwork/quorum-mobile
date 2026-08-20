/**
 * Names and avatars read from DIFFERENT caches:
 *  - avatars: queryKeys.spaces.members(spaceId)  (updated in place by handlers)
 *  - names:   ['identity-roster', spaceId]       (read by the identity ladder)
 * The update-profile handlers updated only the first, so a partner's rename
 * showed its avatar immediately and its name only after an app restart.
 * MEASURED on device 2026-08-18: restart made the name appear.
 */
import { QueryClient } from '@tanstack/react-query';
import { invalidateRosterCaches } from '../identity/invalidateRoster';

describe('invalidateRosterCaches', () => {
  it('invalidates the identity-roster query for exactly that space', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    invalidateRosterCaches(qc, 'space-1');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['identity-roster', 'space-1'] });
  });
});
