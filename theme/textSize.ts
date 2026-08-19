/**
 * The user's own text-size choice — a multiplier applied on top of everything
 * else that sizes text.
 *
 * WHY THIS EXISTS AT ALL. React Native sizes in `sp`, so our text already
 * follows the OS font-size setting. That is an accessibility requirement and is
 * not replaced here. But the OS setting is one blunt dial applied to every app
 * at once, and people want the app they read most to be readable on its own
 * terms — which is why Telegram, WhatsApp, Discord and Signal all ship a
 * per-app control despite the OS one existing. The 2026-08-19 sizing work spent
 * a whole session failing to find one message size that felt right on one
 * device, for exactly this reason: no single default can be correct across
 * users sitting at different OS scales.
 *
 * THE MULTIPLIERS COMPOSE, and that is the thing to keep in mind when picking
 * the range:
 *
 *     rendered = base × skin.fontScale × userScale × OS font scale
 *
 * The top step (1.2) on a phone at the common Android maximum of 1.3 lands at
 * 1.56, just under the 1.6 ceiling that `theme/skins/validate.ts` already
 * treats as the top of the safe band for a global font multiplier. Raising the
 * top step past 1.2 pushes the combined scale into territory no layout here has
 * ever been checked at; anyone who needs more has the OS control, which we keep
 * honouring.
 *
 * Deliberately DISCRETE, not a slider: a report of "I'm on Large" is
 * reproducible, and "about two thirds along" is not.
 *
 * Kept free of native imports so `theme/skins/geometry.ts` can use it at module
 * load without pulling MMKV into the import graph.
 */

export type TextSizePref = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export const DEFAULT_TEXT_SIZE: TextSizePref = 'md';

/**
 * Ordered smallest → largest; the UI renders them left → right in this order.
 *
 * The stored value is the KEY, never the number, so these scales can be
 * retuned later without silently moving every existing user to a different
 * size than the one they chose.
 */
export const TEXT_SIZE_STEPS: readonly { key: TextSizePref; label: string; scale: number }[] = [
  { key: 'xs', label: 'Extra small', scale: 0.8 },
  { key: 'sm', label: 'Small', scale: 0.9 },
  { key: 'md', label: 'Default', scale: 1 },
  { key: 'lg', label: 'Large', scale: 1.1 },
  { key: 'xl', label: 'Extra large', scale: 1.2 },
] as const;

export function textSizeScale(pref: TextSizePref): number {
  return TEXT_SIZE_STEPS.find((s) => s.key === pref)?.scale ?? 1;
}

export function textSizeLabel(pref: TextSizePref): string {
  return TEXT_SIZE_STEPS.find((s) => s.key === pref)?.label ?? 'Default';
}

export function isTextSizePref(value: unknown): value is TextSizePref {
  return TEXT_SIZE_STEPS.some((s) => s.key === value);
}
