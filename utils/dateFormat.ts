/**
 * Mobile bindings for the shared date formatters (quorum-shared `dateFormatting`).
 *
 * Shared owns the calendar logic + locale-driven clock; mobile owns the wording.
 * The app is currently English-only (no i18n framework), so we bind English
 * labels here once and expose two ready-to-use string formatters that every
 * Quorum surface calls. When i18n lands, swap these labels for translated
 * strings (or consume the shared `describe*` parts directly).
 *
 * Fixes the ambiguous locale-numeric date (`28/6/2026`) that the old per-file
 * `toLocaleDateString()` formatters produced; older messages now bucket to
 * weekday / "N days ago", and the time-of-day follows the device's locale clock.
 *
 * NOTE: the Farcaster feed (`components/SocialFeed/utils.ts`) keeps its own
 * sub-hour format (`5s/3m/2h`) on purpose — feed recency is a different UX job.
 */
import { formatMessageDate, formatConversationTime } from '@quilibrium/quorum-shared';

const MESSAGE_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  yesterdayAt: (time: string) => `Yesterday at ${time}`,
};

/**
 * Per-message time inside a chat.
 * Today → locale time; Yesterday → "Yesterday at HH:MM"; last week → weekday;
 * older → "N days ago".
 */
export function formatMessageTime(timestamp: number): string {
  return formatMessageDate(timestamp, { labels: MESSAGE_LABELS });
}

/**
 * Conversation / list / row time.
 * Today → locale time; 1–6 days → "Nd"; older → "Jun 28" / "Jun 28, 2025".
 */
export function formatRowTime(timestamp: number): string {
  return formatConversationTime(timestamp);
}
