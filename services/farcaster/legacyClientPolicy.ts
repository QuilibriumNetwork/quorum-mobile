/**
 * quorum-shared's Farcaster hooks fall back to farcaster.xyz through a default
 * "legacy" client (user lookups, feeds, cast/like/profile writes). This app
 * reads and writes those through Hypersnap only, so the default is replaced
 * with one that refuses every call Hypersnap can serve. The refusal looks like
 * any other failed fallback to the shared hooks: a user lookup resolves to
 * null, a write rejects.
 *
 * Only the image-upload URL request is let through: Hypersnap does not host
 * images, so a profile picture still has to be uploaded to Farcaster's CDN
 * (FARCASTER_TECH_DEBT.md).
 */

import { LegacyFarcasterClient, setDefaultLegacyClient } from '@quilibrium/quorum-shared';

function refused(method: string): Error {
  return new Error(`farcaster.xyz fallback disabled: ${method} is served by Hypersnap`);
}

export class HypersnapOnlyLegacyClient extends LegacyFarcasterClient {
  override async getFeedItems(): Promise<never> {
    throw refused('getFeedItems');
  }
  override async getUserByFid(): Promise<never> {
    throw refused('getUserByFid');
  }
  override async getUserByFidExt(): Promise<never> {
    throw refused('getUserByFidExt');
  }
  override async getUserByUsername(): Promise<never> {
    throw refused('getUserByUsername');
  }
  override async submitCast(): Promise<never> {
    throw refused('submitCast');
  }
  override async deleteCast(): Promise<never> {
    throw refused('deleteCast');
  }
  override async likeCast(): Promise<never> {
    throw refused('likeCast');
  }
  override async unlikeCast(): Promise<never> {
    throw refused('unlikeCast');
  }
  override async updateProfile(): Promise<never> {
    throw refused('updateProfile');
  }
}

/** Install the refusing client. Called once at startup, before any shared
 *  Farcaster hook runs. */
export function installHypersnapOnlyLegacyClient(): void {
  setDefaultLegacyClient(new HypersnapOnlyLegacyClient());
}
