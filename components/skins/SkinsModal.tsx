/**
 * SkinsModal — local skin management (Phase 1).
 *
 * Apply/reset a skin, import one (clipboard or .json file → validated →
 * saved), and export the active skin to the clipboard. The gallery (browse +
 * install from quorum-api) lands in Phase 2; this surface already exercises the
 * full engine: every imported skin passes the same `validateSkin` allow-list,
 * so a malformed/oversized/non-PNG-JPEG skin is rejected before it can apply.
 */

import React from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import { useAuth } from '@/context/AuthContext';
import { deleteSkin, listSkins, saveSkin, type AppearancePref } from '@/services/theme/skinPrefs';
import { validateSkin } from '@/theme/skins/validate';
import { SAMPLE_SKINS } from '@/theme/skins/samples';
import type { SkinOverride } from '@/theme/skins/types';
import {
  fetchSkin,
  fetchSkinGallery,
  publishSkin,
  recordSkinInstall,
  type SkinSummary,
} from '@/services/skins/skinsClient';
import { SkinEditor } from '@/components/skins/SkinEditor';
import { SkinSwatch } from '@/components/skins/SkinSwatch';
import { LightTheme, DarkTheme } from '@/theme';
import { logger } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';

/** Swatch preview (accent + background + own corner radius) for a skin row. */
interface SwatchSpec {
  accent: string;
  background: string;
  cornerRadius: number;
}

/**
 * Resolve a skin's preview swatch WITHOUT applying it.
 *
 * - Colors: the skin's own `accent`/`surface1` for its base; a color-less skin
 *   (Brutalist/Roomy — geometry only) falls back to the UNSKINNED base theme's
 *   real accent/surface1, NOT a grey placeholder. That fallback is fixed per
 *   `base` (light vs dark) so the chip never shifts with the app's live
 *   appearance toggle — a skin pins its own base.
 * - Corner radius: mirrors `geometry.ts:radius()`, scaled by the SKIN's OWN
 *   `deriveGeometry`. The base multiplier is the unskinned `LightTheme.radii.md`
 *   — using the LIVE `theme.radii.md` was the bug that made every swatch turn
 *   square whenever a square-corner skin (Brutalist) was the active one.
 */
function swatchForSkin(skin: SkinOverride): SwatchSpec {
  const baseTheme = skin.base === 'dark' ? DarkTheme : LightTheme;
  const tokens = skin.colors?.[skin.base];
  const { radiusScale, radiusSet } = Skin.deriveGeometry(skin);
  const cornerRadius =
    radiusSet !== undefined
      ? radiusSet === 0
        ? 0
        : radiusSet
      : Math.round(baseTheme.radii.md * radiusScale);
  return {
    accent: tokens?.accent ?? baseTheme.colors.accent,
    background: tokens?.surface1 ?? baseTheme.colors.surface1,
    cornerRadius,
  };
}

export function SkinsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { theme, activeSkin, setActiveSkin, appearance, setAppearance } = useTheme();
  const { user } = useAuth();
  const address = user?.address;
  const [refresh, setRefresh] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<'local' | 'gallery'>('local');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [gallery, setGallery] = React.useState<SkinSummary[] | null>(null);
  const [galleryError, setGalleryError] = React.useState<string | null>(null);
  const [galleryLoading, setGalleryLoading] = React.useState(false);

  // Union of bundled samples + locally-saved skins, deduped by id.
  const skins = React.useMemo<SkinOverride[]>(() => {
    const byId = new Map<string, SkinOverride>();
    for (const s of SAMPLE_SKINS) byId.set(s.id, s);
    for (const s of listSkins()) byId.set(s.id, s);
    return Array.from(byId.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, visible]);

  const apply = async (skin: SkinOverride | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await setActiveSkin(skin);
      setRefresh((n) => n + 1);
    } catch (e) {
      logger.warn('[skins] apply failed:', e instanceof Error ? e.message : e);
      Alert.alert('Couldn’t apply skin', 'Something went wrong applying that skin.');
    } finally {
      setBusy(false);
    }
  };

  const loadGallery = React.useCallback(async () => {
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const page = await fetchSkinGallery({ sort: 'popular', limit: 50 });
      setGallery(page.entries);
    } catch (e) {
      logger.warn('[skins] gallery load failed:', e instanceof Error ? e.message : e);
      setGalleryError('Couldn’t load the gallery.');
    } finally {
      setGalleryLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (visible && tab === 'gallery' && gallery === null && !galleryLoading) {
      void loadGallery();
    }
  }, [visible, tab, gallery, galleryLoading, loadGallery]);

  const installFromGallery = async (entry: SkinSummary, andApply: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const skin = await fetchSkin(entry.id); // validated client-side
      saveSkin(skin);
      if (address) void recordSkinInstall(entry.id, address);
      setRefresh((n) => n + 1);
      if (andApply) await setActiveSkin(skin);
      else Alert.alert('Installed', `“${entry.name}” added to your skins.`);
    } catch (e) {
      Alert.alert('Couldn’t install', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const publishActive = async () => {
    if (!activeSkin) {
      Alert.alert('No active skin', 'Apply a skin first, then publish it.');
      return;
    }
    if (!address) {
      Alert.alert('Sign in required', 'You need an account to publish skins.');
      return;
    }
    Alert.alert('Publish skin?', `Share “${activeSkin.meta.name}” to the public gallery.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Publish',
        onPress: async () => {
          setBusy(true);
          try {
            await publishSkin({ skin: activeSkin, authorAddress: address });
            Alert.alert('Published', 'Your skin is now in the gallery.');
          } catch (e) {
            Alert.alert('Publish failed', e instanceof Error ? e.message : 'Please try again.');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const handleImportText = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      Alert.alert('Invalid skin', 'That isn’t valid JSON.');
      return;
    }
    const result = validateSkin(parsed);
    if (!result.ok) {
      Alert.alert('Invalid skin', result.error);
      return;
    }
    saveSkin(result.skin);
    setRefresh((n) => n + 1);
    Alert.alert('Skin imported', `Added “${result.skin.meta.name}”. Apply it now?`, [
      { text: 'Later', style: 'cancel' },
      { text: 'Apply', onPress: () => apply(result.skin) },
    ]);
  };

  const importFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) {
      Alert.alert('Clipboard empty', 'Copy a skin’s JSON first.');
      return;
    }
    handleImportText(text);
  };

  const importFromFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const text = await readAsStringAsync(res.assets[0].uri);
      handleImportText(text);
    } catch (e) {
      logger.warn('[skins] file import failed:', e instanceof Error ? e.message : e);
      Alert.alert('Import failed', 'Couldn’t read that file.');
    }
  };

  const exportActive = async () => {
    if (!activeSkin) return;
    await Clipboard.setStringAsync(JSON.stringify(activeSkin));
    Alert.alert('Copied', 'The active skin’s JSON is on your clipboard.');
  };

  const confirmDelete = (skin: SkinOverride) => {
    Alert.alert(`Remove “${skin.meta.name}”?`, 'This removes it from your library.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          deleteSkin(skin.id);
          setRefresh((n) => n + 1);
        },
      },
    ]);
  };

  const s = styles(theme);

  // Resetting editorOpen on close keeps the modal from reopening into the
  // editor next time. Only ONE BaseModal is ever mounted — the editor is an
  // inline view, not a second modal.
  const handleClose = () => {
    setEditorOpen(false);
    onClose();
  };

  return (
    <BaseModal
      visible={visible}
      onClose={handleClose}
      height={editorOpen ? 0.92 : 0.85}
      avoidKeyboard={editorOpen}
    >
      {editorOpen ? (
        <SkinEditor
          onClose={() => {
            setEditorOpen(false);
            setRefresh((n) => n + 1);
          }}
        />
      ) : (
      <ScrollView contentContainerStyle={{ paddingBottom: Skin.space(32) }}>
        <Text style={s.title}>Skins</Text>

        {/* Local / Gallery tabs */}
        <View style={s.tabs}>
          {(['local', 'gallery'] as const).map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => setTab(t)}
              style={[s.tab, tab === t && { backgroundColor: theme.colors.surface3 }]}
            >
              <Text style={{ color: tab === t ? theme.colors.textMain : theme.colors.textSubtle, fontWeight: '600' }}>
                {t === 'local' ? 'My Skins' : 'Gallery'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'local' ? (
          <>
            <SkinRow
              label="Default"
              description="The built-in Quorum theme"
              active={!activeSkin}
              onPress={() => apply(null)}
              // Default = the built-in unskinned theme, so ALL of its swatch
              // (accent, background, radius) must come from the base theme, not
              // the live `theme` — otherwise an active skin (e.g. Midnight Neon)
              // bleeds its purple accent / square corners into the Default chip.
              // Tracks light/dark via `theme.dark`, which is correct.
              swatch={{
                accent: (theme.dark ? DarkTheme : LightTheme).colors.accent,
                background: (theme.dark ? DarkTheme : LightTheme).colors.surface1,
                cornerRadius: (theme.dark ? DarkTheme : LightTheme).radii.md,
              }}
              footer={
                !activeSkin ? (
                  <AppearanceSegments value={appearance} onChange={setAppearance} theme={theme} />
                ) : undefined
              }
              theme={theme}
            />
            {skins.map((skin) => {
              const isSample = SAMPLE_SKINS.some((x) => x.id === skin.id);
              return (
                <SkinRow
                  key={skin.id}
                  label={skin.meta.name}
                  description={skin.meta.description ?? (skin.base === 'dark' ? 'Dark skin' : 'Light skin')}
                  active={activeSkin?.id === skin.id}
                  onPress={() => apply(skin)}
                  onLongPress={isSample ? undefined : () => confirmDelete(skin)}
                  onDelete={isSample ? undefined : () => confirmDelete(skin)}
                  swatch={swatchForSkin(skin)}
                  theme={theme}
                />
              );
            })}
            <View style={s.actions}>
              <ActionButton icon="paintbrush" label="Create / edit a skin" onPress={() => setEditorOpen(true)} theme={theme} />
              <ActionButton icon="square.and.arrow.down" label="Import from clipboard" onPress={importFromClipboard} theme={theme} />
              <ActionButton icon="doc" label="Import from file" onPress={importFromFile} theme={theme} />
              <ActionButton icon="square.and.arrow.up" label="Export active skin" onPress={exportActive} disabled={!activeSkin} theme={theme} />
              <ActionButton icon="paperplane" label="Publish active skin" onPress={publishActive} disabled={!activeSkin} theme={theme} />
            </View>
          </>
        ) : (
          <>
            {galleryLoading && <Text style={s.subtitle}>Loading…</Text>}
            {galleryError && <Text style={[s.subtitle, { color: theme.colors.danger }]}>{galleryError}</Text>}
            {gallery && gallery.length === 0 && !galleryLoading && (
              <Text style={s.subtitle}>No skins published yet. Be the first!</Text>
            )}
            {gallery?.map((entry) => (
              <SkinRow
                key={entry.id}
                label={entry.name}
                description={`${entry.authorName ? `by ${entry.authorName} · ` : ''}${entry.installs} install${entry.installs === 1 ? '' : 's'}`}
                active={activeSkin?.id === entry.id}
                onPress={() => installFromGallery(entry, true)}
                // No swatch here on purpose: gallery summaries carry no color
                // data, so a chip would be a misleading all-grey fake-preview
                // identical for every skin. Real per-skin gallery previews are
                // deferred — see .agents/tasks/2026-06-15-skin-gallery-real-color-swatches.md.
                theme={theme}
              />
            ))}
          </>
        )}
      </ScrollView>
      )}
    </BaseModal>
  );
}

function SkinRow({
  label,
  description,
  active,
  onPress,
  onLongPress,
  onDelete,
  swatch,
  footer,
  theme,
}: {
  label: string;
  description: string;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete?: () => void;
  swatch?: SwatchSpec;
  footer?: React.ReactNode;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  // When a footer is present (the Default row), the highlighted card wraps BOTH
  // the tappable label and the footer so the pills sit inside the same rounded
  // container. Without a footer, the highlight stays on the touchable itself so
  // every other row looks exactly as before.
  return (
    <View
      style={{
        borderRadius: theme.radii.md,
        backgroundColor: active && footer ? theme.colors.surface3 : 'transparent',
        marginHorizontal: Skin.space(12),
        marginBottom: Skin.space(4),
      }}
    >
      <TouchableOpacity
        onPress={onPress}
        onLongPress={onLongPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(12),
          paddingVertical: Skin.space(14),
          paddingHorizontal: Skin.space(16),
          borderRadius: theme.radii.md,
          backgroundColor: active && !footer ? theme.colors.surface3 : 'transparent',
        }}
      >
        {swatch && (
          <SkinSwatch
            accent={swatch.accent}
            background={swatch.background}
            cornerRadius={swatch.cornerRadius}
            theme={theme}
          />
        )}
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.colors.textMain, fontWeight: '600', fontSize: Skin.font(15) }}>{label}</Text>
          <Text style={{ color: theme.colors.textSubtle, fontSize: Skin.font(13), marginTop: Skin.space(2) }}>{description}</Text>
        </View>
        {active && <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.accent} />}
        {onDelete && (
          <TouchableOpacity onPress={onDelete} hitSlop={10} style={{ padding: Skin.space(4) }}>
            <IconSymbol name="trash" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
      {footer}
    </View>
  );
}

const APPEARANCE_SEGMENTS: { key: AppearancePref; label: string }[] = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

function AppearanceSegments({
  value,
  onChange,
  theme,
}: {
  value: AppearancePref;
  onChange: (pref: AppearancePref) => void;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: 'row',
        gap: Skin.space(8),
        paddingHorizontal: Skin.space(16),
        paddingBottom: Skin.space(12),
      }}
    >
      {APPEARANCE_SEGMENTS.map((seg) => {
        const active = value === seg.key;
        return (
          <TouchableOpacity
            key={seg.key}
            onPress={() => onChange(seg.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            accessibilityLabel={`${seg.label} appearance`}
            style={{
              paddingHorizontal: Skin.space(14),
              paddingVertical: Skin.space(7),
              borderRadius: theme.radii.pill,
              backgroundColor: active ? theme.colors.surface3 : 'transparent',
            }}
          >
            <Text
              style={{
                color: active ? theme.colors.textMain : theme.colors.textSubtle,
                fontWeight: '600',
                fontSize: Skin.font(13),
              }}
            >
              {seg.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  disabled,
  theme,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: Skin.space(10),
        paddingVertical: Skin.space(12),
        paddingHorizontal: Skin.space(16),
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <IconSymbol name={icon as never} size={18} color={theme.colors.textMain} />
      <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(15) }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = (theme: ReturnType<typeof useTheme>['theme']) =>
  StyleSheet.create({
    title: {
      color: theme.colors.textStrong,
      fontSize: Skin.font(22),
      fontWeight: '700',
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(8),
    },
    subtitle: {
      color: theme.colors.textSubtle,
      fontSize: Skin.font(13),
      paddingHorizontal: Skin.space(16),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(12),
    },
    actions: {
      marginTop: Skin.space(16),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.surface3,
      paddingTop: Skin.space(8),
    },
    tabs: {
      flexDirection: 'row',
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(8),
    },
    tab: {
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(7),
      borderRadius: theme.radii.pill,
    },
  });
