/**
 * Bundled sample skins — small, asset-free recolors so the skin engine is
 * demonstrable before the gallery (Phase 2) exists. Each is a normal
 * SkinOverride and passes `validateSkin` like any imported skin.
 */

import type { SkinOverride } from './types';

export const SAMPLE_SKINS: SkinOverride[] = [
  {
    schemaVersion: 1,
    id: 'sample-midnight-neon',
    meta: { name: 'Midnight Neon', description: 'Deep purple-black with a neon accent.' },
    base: 'dark',
    colors: {
      dark: {
        accent: '#7c5cff',
        accentLight: '#b9a7ff',
        accentDark: '#4a32b8',
        surface0: '#0a0612',
        surface1: '#120a22',
        surface2: '#190e2e',
        surface3: '#22143d',
        surface4: '#2c1a4d',
        surface5: '#382163',
        textStrong: '#f3eeff',
        textMain: '#e7defc',
        textSubtle: '#b9a7e6',
        textMuted: '#7a6aa6',
      },
    },
    radii: { sm: 4, md: 6, lg: 10 },
    frame: { corner: 'rounded' },
  },
  {
    schemaVersion: 1,
    id: 'sample-paper',
    meta: { name: 'Paper', description: 'Warm light theme with soft rounded chrome.' },
    base: 'light',
    colors: {
      light: {
        accent: '#c2410c',
        accentLight: '#fdba74',
        accentDark: '#7c2d12',
        surface0: '#fffdf8',
        surface1: '#fbf6ec',
        surface2: '#f3ead9',
        surface3: '#ebe0cb',
        surface4: '#e2d4ba',
        surface5: '#d8c7a6',
        textStrong: '#33291c',
        textMain: '#403425',
        textSubtle: '#7a6a52',
        textMuted: '#a8997e',
      },
    },
    radii: { sm: 10, md: 14, lg: 20, pill: 999 },
  },
  {
    schemaVersion: 1,
    id: 'sample-brutalist',
    meta: { name: 'Brutalist', description: 'Square corners and heavy borders everywhere.' },
    base: 'dark',
    // Global geometry scales: square ALL corners, double ALL border widths.
    radii: { scale: 0 },
    borders: { scale: 2 },
    frame: { corner: 'square' },
  },
  {
    schemaVersion: 1,
    id: 'sample-roomy',
    meta: { name: 'Roomy', description: 'More breathing room and softer, rounder chrome.' },
    base: 'light',
    spacing: { scale: 1.25 },
    radii: { scale: 1.5 },
  },
];
