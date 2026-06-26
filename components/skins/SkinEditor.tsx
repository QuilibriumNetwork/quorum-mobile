/**
 * SkinEditor — author a skin from the current theme with live preview.
 *
 * Edits a draft SkinOverride and applies it live (debounced) so changes are
 * visible immediately. "Done" keeps it applied; "Discard" restores whatever was
 * active when the editor opened; "Publish" shares it to the gallery. Every
 * draft is run through `validateSkin` before it's applied, so half-typed hex or
 * a bad image never reaches the engine.
 */

import React from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import { useAuth } from '@/context/AuthContext';
import { validateSkin } from '@/theme/skins/validate';
import { publishSkin } from '@/services/skins/skinsClient';
import { logger } from '@quilibrium/quorum-shared';
import type { FrameCorner, SkinColorTokens, SkinOverride } from '@/theme/skins/types';
import * as Skin from '@/theme/skins/geometry';

// The handful of high-impact color tokens the editor exposes.
const COLOR_FIELDS: { key: keyof SkinColorTokens; label: string }[] = [
  { key: 'accent', label: 'Accent' },
  { key: 'surface1', label: 'Background' },
  { key: 'surface2', label: 'Cards' },
  { key: 'textMain', label: 'Text' },
  { key: 'textMuted', label: 'Muted text' },
];

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface EditorState {
  name: string;
  base: 'light' | 'dark';
  colors: Partial<Record<keyof SkinColorTokens, string>>;
  corner: FrameCorner;
  spacingScale: number;
  fontScale: number;
  borderScale: number;
  wallpaper: string | null;
  surfaceAlpha: number;
  accentBorder: boolean;
  panelGlow: boolean;
  /** slot -> background (color hex or data:image). */
  surfaces: Record<string, string>;
  /** currently-edited slot. */
  slot: string;
}

// Slots wired to components today (more can be added as they're adopted).
const EDITOR_SLOTS: { v: string; l: string }[] = [
  { v: 'feed', l: 'Feed' },
  { v: 'wallet', l: 'Wallet' },
  { v: 'cast', l: 'Casts' },
  { v: 'button', l: 'Buttons' },
];

const isColorVal = (v?: string) => !!v && HEX_RE.test(v);
const isImageVal = (v?: string) => !!v && /^data:image\//i.test(v);

function seedState(active: SkinOverride | null, isDark: boolean): EditorState {
  const base = active?.base ?? (isDark ? 'dark' : 'light');
  return {
    name: active?.meta.name ?? 'My skin',
    base,
    colors: { ...(active?.colors?.[base] ?? {}) },
    corner: active?.frame?.corner ?? 'rounded',
    spacingScale: active?.spacing?.scale ?? 1,
    fontScale: active?.fontScale ?? 1,
    borderScale: active?.borders?.scale ?? 1,
    wallpaper: active?.wallpaper?.source.dataUri ?? null,
    surfaceAlpha: active?.wallpaper?.surfaceAlpha ?? 0.8,
    accentBorder: Boolean(active?.frame?.accentBorder),
    panelGlow: active?.frame?.panelGlow ?? false,
    surfaces: Object.fromEntries(
      Object.entries(active?.surfaces ?? {}).map(([k, v]) => [k, v.background ?? '']),
    ),
    slot: 'feed',
  };
}

function buildSkin(id: string, st: EditorState): SkinOverride {
  const colorMap: Partial<SkinColorTokens> = {};
  for (const { key } of COLOR_FIELDS) {
    const v = st.colors[key];
    if (v && HEX_RE.test(v)) colorMap[key] = v;
  }
  const skin: SkinOverride = {
    schemaVersion: 1,
    id,
    meta: { name: st.name.trim() || 'My skin' },
    base: st.base,
    frame: {
      corner: st.corner,
      ...(st.accentBorder ? { accentBorder: { width: 'thin' } } : {}),
      ...(st.panelGlow ? { panelGlow: true } : {}),
    },
  };
  if (Object.keys(colorMap).length) skin.colors = { [st.base]: colorMap };
  if (st.spacingScale !== 1) skin.spacing = { scale: st.spacingScale };
  if (st.borderScale !== 1) skin.borders = { scale: st.borderScale };
  if (st.fontScale !== 1) skin.fontScale = st.fontScale;
  if (st.wallpaper) {
    skin.wallpaper = {
      source: { dataUri: st.wallpaper },
      fit: 'cover',
      scrimOpacity: 0.6,
      surfaceAlpha: st.surfaceAlpha,
    };
  }
  const surf: Record<string, { background: string }> = {};
  for (const [k, v] of Object.entries(st.surfaces)) {
    if (isColorVal(v) || isImageVal(v)) surf[k] = { background: v };
  }
  if (Object.keys(surf).length) skin.surfaces = surf;
  return skin;
}

export function SkinEditor({ onClose }: { onClose: () => void }) {
  const { theme, isDark, activeSkin, setActiveSkin, previewSkin } = useTheme();
  const { user } = useAuth();
  const idRef = React.useRef(`editor-${Date.now()}`);
  // Capture what was active when the editor mounted so Discard can restore it.
  const originalRef = React.useRef<SkinOverride | null>(activeSkin);
  const [st, setSt] = React.useState<EditorState>(() => seedState(activeSkin, isDark));
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    idRef.current = activeSkin?.id?.startsWith('editor-') ? activeSkin.id : `editor-${Date.now()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced live preview — invalid intermediate states never apply.
  React.useEffect(() => {
    const t = setTimeout(() => {
      const draft = buildSkin(idRef.current, st);
      // Preview only — don't persist transient drafts to the library.
      if (validateSkin(draft).ok) void previewSkin(draft);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) =>
    setSt((p) => ({ ...p, [k]: v }));

  const pickImage = async (): Promise<string | null> => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to pick an image.');
      return null;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (res.canceled || !res.assets?.[0]) return null;
    const a = res.assets[0];
    try {
      // Re-encode to JPEG so HEIC (the iOS default) and any other format are
      // normalized to something the validator accepts; downscale very large
      // photos so the skin stays under the asset budget.
      const actions = a.width && a.width > 2048 ? [{ resize: { width: 2048 } }] : [];
      const out = await ImageManipulator.manipulateAsync(a.uri, actions, {
        compress: 0.85,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      });
      if (!out.base64) return null;
      return `data:image/jpeg;base64,${out.base64}`;
    } catch (e) {
      logger.warn('[skins] image processing failed:', e instanceof Error ? e.message : e);
      Alert.alert('Couldn’t process image', 'Please try another image.');
      return null;
    }
  };

  const pickWallpaper = async () => {
    const uri = await pickImage();
    if (uri) set('wallpaper', uri);
  };

  const pickSurfaceImage = async (slot: string) => {
    const uri = await pickImage();
    if (uri) set('surfaces', { ...st.surfaces, [slot]: uri });
  };

  const onDone = async () => {
    const draft = buildSkin(idRef.current, st);
    const r = validateSkin(draft);
    if (!r.ok) {
      Alert.alert('Can’t save', r.error);
      return;
    }
    await setActiveSkin(draft); // persist to library + set active
    onClose();
  };

  const onDiscard = async () => {
    await setActiveSkin(originalRef.current); // restore what was active on open
    onClose();
  };

  const onPublish = async () => {
    const draft = buildSkin(idRef.current, st);
    const r = validateSkin(draft);
    if (!r.ok) {
      Alert.alert('Can’t publish', r.error);
      return;
    }
    if (!user?.address) {
      Alert.alert('Sign in required', 'You need an account to publish.');
      return;
    }
    await setActiveSkin(draft);
    setBusy(true);
    try {
      await publishSkin({ skin: draft, authorAddress: user.address });
      Alert.alert('Published', 'Your skin is now in the gallery.');
    } catch (e) {
      Alert.alert('Publish failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const s = makeStyles(theme);

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: Skin.space(40) }} keyboardShouldPersistTaps="handled">
        <View style={s.headerRow}>
          <TouchableOpacity onPress={onDiscard} hitSlop={10}>
            <IconSymbol name="chevron.left" size={24} color={theme.colors.textMain} />
          </TouchableOpacity>
          <Text style={s.title}>Skin editor</Text>
        </View>

        <Field label="Name" theme={theme}>
          <TextInput
            value={st.name}
            onChangeText={(v) => set('name', v)}
            placeholder="My skin"
            placeholderTextColor={theme.colors.textMuted}
            style={s.input}
          />
        </Field>

        <Field label="Base" theme={theme}>
          <Segmented
            options={[{ v: 'light', l: 'Light' }, { v: 'dark', l: 'Dark' }]}
            value={st.base}
            onChange={(v) => set('base', v as 'light' | 'dark')}
            theme={theme}
          />
        </Field>

        <Text style={s.section}>Colors</Text>
        {COLOR_FIELDS.map(({ key, label }) => {
          const val = st.colors[key] ?? '';
          const valid = !val || HEX_RE.test(val);
          return (
            <View key={key} style={s.colorRow}>
              <View
                style={[
                  s.swatch,
                  { backgroundColor: valid && val ? val : theme.colors[key as 'accent'] },
                ]}
              />
              <Text style={s.colorLabel}>{label}</Text>
              <TextInput
                value={val}
                onChangeText={(v) => set('colors', { ...st.colors, [key]: v })}
                placeholder="#hex / inherit"
                placeholderTextColor={theme.colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[s.hexInput, !valid && { color: theme.colors.danger }]}
              />
            </View>
          );
        })}

        <Text style={s.section}>Shape</Text>
        <Field label="Corners" theme={theme}>
          <Segmented
            options={[{ v: 'square', l: 'Square' }, { v: 'rounded', l: 'Rounded' }, { v: 'pill', l: 'Pill' }]}
            value={st.corner}
            onChange={(v) => set('corner', v as FrameCorner)}
            theme={theme}
          />
        </Field>
        <Stepper label="Spacing" value={st.spacingScale} onChange={(v) => set('spacingScale', v)} min={0.5} max={2} theme={theme} />
        <Stepper label="Text size" value={st.fontScale} onChange={(v) => set('fontScale', v)} min={0.8} max={1.5} theme={theme} />
        <Stepper label="Borders" value={st.borderScale} onChange={(v) => set('borderScale', v)} min={0} max={4} theme={theme} />
        <Row label="Accent border" value={st.accentBorder} onChange={(v) => set('accentBorder', v)} theme={theme} />
        <Row label="Panel glow" value={st.panelGlow} onChange={(v) => set('panelGlow', v)} theme={theme} />

        <Text style={s.section}>Wallpaper</Text>
        <View style={{ flexDirection: 'row', gap: Skin.space(10), paddingHorizontal: Skin.space(16) }}>
          <TouchableOpacity onPress={pickWallpaper} style={s.btnOutline}>
            <Text style={{ color: theme.colors.textMain }}>{st.wallpaper ? 'Replace image' : 'Choose image'}</Text>
          </TouchableOpacity>
          {st.wallpaper && (
            <TouchableOpacity onPress={() => set('wallpaper', null)} style={s.btnOutline}>
              <Text style={{ color: theme.colors.danger }}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
        {st.wallpaper && (
          <Stepper label="Surface opacity" value={st.surfaceAlpha} onChange={(v) => set('surfaceAlpha', v)} min={0.2} max={1} theme={theme} />
        )}

        <Text style={s.section}>Backgrounds</Text>
        <View style={{ paddingHorizontal: Skin.space(16), paddingBottom: Skin.space(8) }}>
          <Segmented options={EDITOR_SLOTS} value={st.slot} onChange={(v) => set('slot', v)} theme={theme} />
        </View>
        <View style={s.colorRow}>
          <View
            style={[
              s.swatch,
              { backgroundColor: isColorVal(st.surfaces[st.slot]) ? st.surfaces[st.slot] : 'transparent' },
            ]}
          />
          <Text style={s.colorLabel}>{isImageVal(st.surfaces[st.slot]) ? 'Image set' : 'Color'}</Text>
          <TextInput
            value={isColorVal(st.surfaces[st.slot]) ? st.surfaces[st.slot] : ''}
            onChangeText={(v) => set('surfaces', { ...st.surfaces, [st.slot]: v })}
            placeholder="#hex / inherit"
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={s.hexInput}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: Skin.space(10), paddingHorizontal: Skin.space(16) }}>
          <TouchableOpacity onPress={() => pickSurfaceImage(st.slot)} style={s.btnOutline}>
            <Text style={{ color: theme.colors.textMain }}>Image…</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => set('surfaces', { ...st.surfaces, [st.slot]: '' })} style={s.btnOutline}>
            <Text style={{ color: theme.colors.danger }}>Clear</Text>
          </TouchableOpacity>
        </View>

        <View style={s.footer}>
          <TouchableOpacity onPress={onDiscard} style={s.btnOutline}>
            <Text style={{ color: theme.colors.textMain }}>Discard</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onPublish} disabled={busy} style={[s.btnOutline, busy && { opacity: 0.5 }]}>
            <Text style={{ color: theme.colors.textMain }}>Publish</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDone} style={s.btnPrimary}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Done</Text>
          </TouchableOpacity>
        </View>
    </ScrollView>
  );
}

function Field({ label, children, theme }: { label: string; children: React.ReactNode; theme: ReturnType<typeof useTheme>['theme'] }) {
  return (
    <View style={{ paddingHorizontal: Skin.space(16), paddingVertical: Skin.space(8) }}>
      <Text style={{ color: theme.colors.textSubtle, fontSize: Skin.font(13), marginBottom: Skin.space(6) }}>{label}</Text>
      {children}
    </View>
  );
}

function Segmented({ options, value, onChange, theme }: {
  options: { v: string; l: string }[];
  value: string;
  onChange: (v: string) => void;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <View style={{ flexDirection: 'row', gap: Skin.space(8) }}>
      {options.map((o) => (
        <TouchableOpacity
          key={o.v}
          onPress={() => onChange(o.v)}
          style={{
            paddingHorizontal: Skin.space(14),
            paddingVertical: Skin.space(8),
            borderRadius: theme.radii.pill,
            backgroundColor: value === o.v ? theme.colors.accent : theme.colors.surface3,
          }}
        >
          <Text style={{ color: value === o.v ? '#fff' : theme.colors.textMain, fontWeight: '600' }}>{o.l}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function Stepper({ label, value, onChange, min, max, theme }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  const step = 0.05;
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v * 100) / 100));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Skin.space(16), paddingVertical: Skin.space(8) }}>
      <Text style={{ flex: 1, color: theme.colors.textMain, fontSize: Skin.font(15) }}>{label}</Text>
      <TouchableOpacity onPress={() => onChange(clamp(value - step))} style={{ padding: Skin.space(6) }}>
        <IconSymbol name="minus" size={18} color={theme.colors.textMain} />
      </TouchableOpacity>
      <Text style={{ width: Skin.space(48), textAlign: 'center', color: theme.colors.textMain }}>{value.toFixed(2)}×</Text>
      <TouchableOpacity onPress={() => onChange(clamp(value + step))} style={{ padding: Skin.space(6) }}>
        <IconSymbol name="plus" size={18} color={theme.colors.textMain} />
      </TouchableOpacity>
    </View>
  );
}

function Row({ label, value, onChange, theme }: {
  label: string; value: boolean; onChange: (v: boolean) => void;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <TouchableOpacity
      onPress={() => onChange(!value)}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Skin.space(16), paddingVertical: Skin.space(10) }}
    >
      <Text style={{ flex: 1, color: theme.colors.textMain, fontSize: Skin.font(15) }}>{label}</Text>
      <IconSymbol name={value ? 'checkmark.circle.fill' : 'circle'} size={22} color={value ? theme.colors.accent : theme.colors.textMuted} />
    </TouchableOpacity>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>['theme']) {
  return StyleSheet.create({
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: Skin.space(8), paddingHorizontal: Skin.space(16), paddingTop: Skin.space(8), paddingBottom: Skin.space(4) },
    title: { color: theme.colors.textStrong, fontSize: Skin.font(22), fontWeight: '700' },
    section: { color: theme.colors.textSubtle, fontSize: Skin.font(13), fontWeight: '600', textTransform: 'uppercase', paddingHorizontal: Skin.space(16), paddingTop: Skin.space(16), paddingBottom: Skin.space(4) },
    input: { backgroundColor: theme.colors.surface3, borderRadius: theme.radii.md, paddingHorizontal: Skin.space(12), paddingVertical: Skin.space(10), color: theme.colors.textMain, fontSize: Skin.font(15) },
    colorRow: { flexDirection: 'row', alignItems: 'center', gap: Skin.space(10), paddingHorizontal: Skin.space(16), paddingVertical: Skin.space(6) },
    swatch: { width: Skin.space(26), height: Skin.space(26), borderRadius: theme.radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.surface5 },
    colorLabel: { width: Skin.space(90), color: theme.colors.textMain, fontSize: Skin.font(14) },
    hexInput: { flex: 1, backgroundColor: theme.colors.surface3, borderRadius: theme.radii.sm, paddingHorizontal: Skin.space(10), paddingVertical: Skin.space(8), color: theme.colors.textMain, fontSize: Skin.font(14) },
    btnOutline: { flex: 1, alignItems: 'center', paddingVertical: Skin.space(11), borderRadius: theme.radii.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.surface4 },
    btnPrimary: { flex: 1, alignItems: 'center', paddingVertical: Skin.space(11), borderRadius: theme.radii.lg, backgroundColor: theme.colors.accent },
    footer: { flexDirection: 'row', gap: Skin.space(10), paddingHorizontal: Skin.space(16), paddingTop: Skin.space(20) },
  });
}
