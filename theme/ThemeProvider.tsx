import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';
import { useColorScheme as useDeviceColorScheme } from 'react-native';
import { createTheme, AccentColor } from './themes';
import type { SkinOverride } from './skins/types';
import { ensureSkinFontLoaded } from './skins/fontLoader';
import { setSkinGeometry } from './skins/geometry';
import { bumpStyleVersion } from './skins/skinnableStyleSheet';
import {
  saveSkin,
  setActiveSkinId,
  setAppearancePref,
  type AppearancePref,
} from '@/services/theme/skinPrefs';

type ThemeContextType = {
  theme: ReturnType<typeof createTheme>;
  isDark: boolean;
  accentColor: AccentColor;
  /** The applied custom skin, or null for the built-in theme. */
  activeSkin: SkinOverride | null;
  setIsDark: (isDark: boolean) => void;
  /** Manual appearance choice for the built-in theme: system | light | dark. */
  appearance: AppearancePref;
  /** Set + persist the appearance choice. Canonical entry point for the UI —
   *  use this instead of setIsDark so the choice survives restarts. */
  setAppearance: (pref: AppearancePref) => void;
  setAccentColor: (color: AccentColor) => void;
  toggleTheme: () => void;
  /** Apply (or clear) a skin. Loads its embedded font before switching so
   *  there's no flash of the fallback font. Persists the choice. */
  setActiveSkin: (skin: SkinOverride | null) => Promise<void>;
  /** Apply a skin in-memory only (no persistence) — for the editor's live
   *  preview, so transient drafts don't pile up in the library. */
  previewSkin: (skin: SkinOverride | null) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/** Non-throwing variant for low-level/widely-rendered components (e.g.
 *  IconSymbol) that may, in rare cases, render outside the provider. */
export const useThemeOptional = () => useContext(ThemeContext);

type ThemeProviderProps = {
  children: ReactNode;
  defaultAccentColor?: AccentColor;
  forceTheme?: 'light' | 'dark' | null;
  /** Appearance pref restored from storage at boot (see app/_layout.tsx). */
  defaultAppearance?: AppearancePref;
  /** Skin resolved + font-preloaded at boot (see app/_layout.tsx). */
  defaultSkin?: SkinOverride | null;
};

export const CustomThemeProvider: React.FC<ThemeProviderProps> = ({
  children,
  defaultAccentColor = 'blue',
  forceTheme = null,
  defaultAppearance = 'system',
  defaultSkin = null,
}) => {
  const deviceColorScheme = useDeviceColorScheme();
  const [isDarkOverride, setIsDarkOverride] = useState<boolean | null>(
    defaultAppearance === 'system' ? null : defaultAppearance === 'dark',
  );
  const [accentColor, setAccentColor] = useState<AccentColor>(defaultAccentColor);
  const [skin, setSkin] = useState<SkinOverride | null>(defaultSkin);

  const baseIsDark = forceTheme
    ? forceTheme === 'dark'
    : isDarkOverride !== null
      ? isDarkOverride
      : deviceColorScheme === 'dark';
  // An active skin pins light/dark to its declared base so its color overrides
  // land on the variant the author designed for.
  const isDark = skin ? skin.base === 'dark' : baseIsDark;

  const theme = useMemo(() => createTheme(isDark, accentColor, skin), [isDark, accentColor, skin]);

  const toggleTheme = useCallback(() => {
    setIsDarkOverride(prev => prev === null ? !baseIsDark : !prev);
  }, [baseIsDark]);

  const setIsDarkCb = useCallback((dark: boolean) => {
    setIsDarkOverride(dark);
  }, []);

  const setAppearance = useCallback((pref: AppearancePref) => {
    setAppearancePref(pref); // persist first
    setIsDarkOverride(pref === 'system' ? null : pref === 'dark');
  }, []);

  const appearance: AppearancePref =
    isDarkOverride === null ? 'system' : isDarkOverride ? 'dark' : 'light';

  const setActiveSkin = useCallback(async (next: SkinOverride | null) => {
    if (next) {
      await ensureSkinFontLoaded(next); // before swap → no fallback-font flash
      saveSkin(next);
      setActiveSkinId(next.id);
    } else {
      setActiveSkinId(null);
    }
    setSkinGeometry(next); // update radius()/space()/border() before re-render
    bumpStyleVersion(); // invalidate skin-reactive static stylesheets
    setSkin(next);
  }, []);

  const previewSkin = useCallback(async (next: SkinOverride | null) => {
    if (next?.font) await ensureSkinFontLoaded(next);
    setSkinGeometry(next);
    bumpStyleVersion();
    setSkin(next); // in-memory only — no saveSkin / setActiveSkinId
  }, []);

  const value = useMemo(() => ({
    theme,
    isDark,
    accentColor,
    activeSkin: skin,
    appearance,
    setIsDark: setIsDarkCb,
    setAppearance,
    setAccentColor,
    toggleTheme,
    setActiveSkin,
    previewSkin,
  }), [theme, isDark, accentColor, skin, appearance, setIsDarkCb, setAppearance, setAccentColor, toggleTheme, setActiveSkin, previewSkin]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
