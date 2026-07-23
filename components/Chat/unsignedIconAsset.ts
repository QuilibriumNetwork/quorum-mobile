/**
 * Unsigned-message warning glyph, embedded as a base64 data-URI.
 *
 * Same rationale as receiptCheckAssets: a data-URI lives in the JS bundle, so it
 * never passes through expo-updates asset-embedding and can't be blanked by a
 * stale manifest in local release builds (see the apex lesson).
 *
 * Flat black (#000) template on a transparent bg. Color is applied at render
 * time via the <Image> `tintColor` style, so it follows whatever colour the
 * caller passes. Source: unsigned-indicator-filled.png (64x64).
 *
 * NOTE: currently the FILLED variant. An OUTLINE variant also exists (swap the
 * base64 to test); both are 64x64 so UNSIGNED_ICON_ASPECT stays 1.
 */

export const UNSIGNED_ICON_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAAl9JREFUeAHtmo1tnDAYhp9WHSDd4NugGcEbtBuEDZoNmg06QugE7Qa0E7Qb0A2STHDBOixd0HH5DP7BxI/0Spy4O15/xi8GDJVK5S3zjjzIoM+DPo6f+0F/Bv1n58igbtBhRj/H7+ySm0EPzDfeyX7nCztDeL3h0yJcsyPsGD946i874Sv+jXe6pXCEZb1/OhSuKJiW5Y13uqdQbIgdAslQID3hClBcIDaEa3xxgSiE7f3iArFF36gev2Lds3EEfcPN5HfaQhg2jLYR56a5Rvnbjo3SoB/Lc2huljYZiIK+9/sL/6P9j80FYotf8M2hLYDVdzaCoDcdsgCbCURf0yEL0JGZBj/DoQuQNRCFZYZDFyBbILb4m41RAKvkgSgsMxqrAFaGhKwxGqsAHYloWG4yZgGsogeiBDAZswDegfgeP+7Y9psb2/hvREJY1zspzgAngxKfM6CjHNRngbYADWW9tDQEDEQh7DO+S0NA+zwgSiDO0QY05XTuiZBEOM7qGaJEMOXOApkcp490LMMKYply6ji+9Ih9jEU0kY2llHcgCvF7P6W8A7EFcpsOLXUgCmQ3G0sGBX0iM3djse0l8TbRMTteoUlk5FwopSrCDRfoExgI8WZojV6sNTi9FxDSzPcfF+4LhR1y4j5MC5ACYX4qLKThk9vIUQDLdEms3e7IwIeT7X+kQzjmzW+OExQh7bP9J7dxulr8ajRV9Lo8BTZn3Cr1F0PA7vjB/vl1aaeQ5lKUSz2KrDPkNxpL6mX41+zrbrBn4fL7huPlqcRh8TB6t6vV9x7slUqlUqlUFvAMReNWB+c3R2cAAAAASUVORK5CYII=';

/** width / height of the source asset — multiply by render height for width. */
export const UNSIGNED_ICON_ASPECT = 64 / 64;
