/**
 * formatMuteRemaining — human label for how long a moderation mute lasts.
 *
 * Mirrors desktop's helper of the same name (quorum-desktop
 * src/utils/dateFormatting.ts): "X days" when more than a day remains, "X hours"
 * when a day or less, using Math.ceil so 23h45m reads as "24 hours". Returns a
 * forever string when there's no expiry.
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function formatMuteRemaining(expiresAt: number | undefined, now: number = Date.now()): string {
  if (expiresAt === undefined) return 'You have been muted in this space';

  const remaining = expiresAt - now;
  if (remaining <= 0) return 'Your mute has expired';

  if (remaining > MS_PER_DAY) {
    const days = Math.ceil(remaining / MS_PER_DAY);
    return `You are muted for ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const hours = Math.ceil(remaining / MS_PER_HOUR);
  return `You are muted for ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
