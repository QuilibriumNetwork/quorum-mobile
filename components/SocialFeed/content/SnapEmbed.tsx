import type { AppTheme } from '@/theme';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedModule, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { logger } from '@quilibrium/quorum-shared';

const ReanimatedView = ReanimatedModule.View;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SnapTheme {
  accent?: string;
}

interface SnapElementBase {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  on?: {
    press?: SnapAction;
  };
}

interface SnapAction {
  action: string;
  params?: Record<string, unknown>;
}

interface SnapResponse {
  version: string;
  theme?: SnapTheme;
  effects?: string[];
  ui?: {
    root: string;
    elements: Record<string, SnapElementBase>;
  };
}

export interface SnapEmbedProps {
  url: string;
  theme: AppTheme;
  userFid?: number;
  token?: string;
  onOpenUrl?: (url: string) => void;
  onOpenProfile?: (fid: number) => void;
  onOpenMiniApp?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// Icon mapping: snap icon names -> SF Symbol names (must exist in MAPPING)
// ---------------------------------------------------------------------------

const SNAP_ICON_MAP: Record<string, IconSymbolName> = {
  // Spec icons (34) — keyed with dashes to match spec icon names
  'arrow-right': 'chevron.right',
  'arrow-left': 'arrow.left',
  'external-link': 'arrow.up.right',
  'chevron-right': 'chevron.right',
  check: 'checkmark',
  x: 'xmark',
  'alert-triangle': 'exclamationmark.triangle.fill',
  info: 'info.circle',
  clock: 'clock',
  heart: 'heart.fill',
  'message-circle': 'bubble.left',
  repeat: 'arrow.2.squarepath',
  share: 'square.and.arrow.up',
  user: 'person.fill',
  users: 'person.2.fill',
  star: 'star.fill',
  trophy: 'trophy.fill',
  zap: 'bolt.fill',
  flame: 'flame.fill',
  gift: 'gift.fill',
  image: 'photo.fill',
  play: 'play.fill',
  pause: 'pause.fill',
  wallet: 'wallet.bifold.fill',
  coins: 'centsign.circle.fill',
  plus: 'plus',
  minus: 'minus',
  'refresh-cw': 'arrow.clockwise',
  bookmark: 'bookmark.fill',
  'thumbs-up': 'hand.thumbsup.fill',
  'thumbs-down': 'hand.thumbsdown.fill',
  'trending-up': 'arrow.up.right',
  'trending-down': 'arrow.down.right',
  // Extra icons beyond spec
  'check-circle': 'checkmark.circle.fill',
  'x-circle': 'xmark.circle.fill',
  search: 'magnifyingglass',
  settings: 'gearshape.fill',
  home: 'house.fill',
  link: 'link',
  send: 'paperplane.fill',
  edit: 'pencil',
  trash: 'trash.fill',
  warning: 'exclamationmark.triangle.fill',
  error: 'exclamationmark.circle.fill',
  lock: 'lock.fill',
  unlock: 'lock.fill',
  eye: 'eye.fill',
  'eye-off': 'eye.slash.fill',
  camera: 'camera.fill',
  refresh: 'arrow.clockwise',
  external: 'arrow.up.right',
  copy: 'doc.on.doc',
  bell: 'bell.fill',
  mail: 'envelope.fill',
  phone: 'phone.fill',
  globe: 'globe',
  chart: 'chart.bar.fill',
  crown: 'crown.fill',
  shield: 'shield.fill',
  tag: 'tag.fill',
  sparkles: 'sparkles',
};

function resolveSnapIcon(name?: string): IconSymbolName | null {
  if (!name) return null;
  // Try direct lookup
  const mapped = SNAP_ICON_MAP[name];
  if (mapped) return mapped;
  // Try with underscores → dashes (spec uses dashes, legacy code may use underscores)
  const dashed = SNAP_ICON_MAP[name.replace(/_/g, '-')];
  if (dashed) return dashed;
  return null;
}

// ---------------------------------------------------------------------------
// Aspect ratio helpers
// ---------------------------------------------------------------------------

const ASPECT_RATIOS: Record<string, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
};

// ---------------------------------------------------------------------------
// Gap helpers
// ---------------------------------------------------------------------------

const GAP_VALUES: Record<string, number> = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
};

// ---------------------------------------------------------------------------
// Palette color helpers
// ---------------------------------------------------------------------------

const PALETTE_COLORS: Record<string, string> = {
  gray: '#6B7280',
  blue: '#3B82F6',
  red: '#EF4444',
  amber: '#F59E0B',
  green: '#22C55E',
  teal: '#14B8A6',
  purple: '#8B5CF6',
  pink: '#EC4899',
};

function resolvePaletteColor(color: string | undefined, ctx: RenderCtx): string | undefined {
  if (!color) return undefined;
  if (color === 'accent') return ctx.accent;
  return PALETTE_COLORS[color] ?? color;
}

const StackDirectionContext = createContext<'horizontal' | 'vertical'>('vertical');

function resolveGap(gap?: unknown): number {
  if (typeof gap === 'number') return gap;
  if (typeof gap === 'string') return GAP_VALUES[gap] ?? 8;
  return 0;
}

// ---------------------------------------------------------------------------
// Snap detection cache
// ---------------------------------------------------------------------------

const snapDetectionCache = new Map<string, boolean>();

/**
 * Probe a URL to see if it responds with snap content-type.
 * The result is cached to avoid repeated probing on re-render.
 */
export async function isSnapUrl(url: string): Promise<boolean> {
  const cached = snapDetectionCache.get(url);
  if (cached !== undefined) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/vnd.farcaster.snap+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') ?? '';
    const isSnap = ct.includes('application/vnd.farcaster.snap+json');
    logger.debug(`[Snap] detection: ${url.slice(0, 60)} → ct="${ct}" isSnap=${isSnap}`);
    snapDetectionCache.set(url, isSnap);
    return isSnap;
  } catch (e) {
    logger.debug(`[Snap] detection failed: ${url.slice(0, 60)} → ${e}`);
    snapDetectionCache.set(url, false);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Custom Slider (no external dep)
// ---------------------------------------------------------------------------

function SnapSlider({
  min = 0,
  max = 100,
  step = 1,
  value,
  onValueChange,
  accentColor,
  trackColor,
}: {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onValueChange: (v: number) => void;
  accentColor: string;
  trackColor: string;
}) {
  const trackWidth = useSharedValue(0);
  const thumbX = useSharedValue(0);
  const startX = useSharedValue(0);

  const fraction = max > min ? (value - min) / (max - min) : 0;

  // Sync thumb position when value/width changes
  useEffect(() => {
    if (trackWidth.value > 0) {
      thumbX.value = fraction * trackWidth.value;
    }
  }, [fraction, trackWidth, thumbX]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    trackWidth.value = w;
    thumbX.value = fraction * w;
  }, [fraction, trackWidth, thumbX]);

  const clampAndSnap = useCallback(
    (rawX: number) => {
      const w = trackWidth.value;
      if (w <= 0) return;
      const clamped = Math.max(0, Math.min(rawX, w));
      const rawValue = min + (clamped / w) * (max - min);
      const snapped = Math.round(rawValue / step) * step;
      const final = Math.max(min, Math.min(snapped, max));
      onValueChange(final);
    },
    [min, max, step, trackWidth, onValueChange],
  );

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = thumbX.value;
    })
    .onUpdate((e) => {
      const newX = startX.value + e.translationX;
      const clamped = Math.max(0, Math.min(newX, trackWidth.value));
      thumbX.value = clamped;
      runOnJS(clampAndSnap)(clamped);
    })
    .minDistance(0);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value - 10 }],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: thumbX.value,
  }));

  return (
    <View style={sliderStyles.container} onLayout={onLayout}>
      <View style={[sliderStyles.track, { backgroundColor: trackColor }]}>
        <ReanimatedView style={[sliderStyles.fill, { backgroundColor: accentColor }, fillStyle]} />
      </View>
      <GestureDetector gesture={pan}>
        <ReanimatedView style={[sliderStyles.thumb, { backgroundColor: accentColor }, thumbStyle]} />
      </GestureDetector>
    </View>
  );
}

const sliderStyles = StyleSheet.create({
  container: { height: 28, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2 },
  fill: { height: 4, borderRadius: 2, position: 'absolute', left: 0, top: 0 },
  thumb: {
    position: 'absolute',
    top: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    elevation: 3,
  },
});

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------

interface RenderCtx {
  elements: Record<string, SnapElementBase>;
  formState: Record<string, unknown>;
  setFormValue: (name: string, value: unknown) => void;
  accent: string;
  theme: AppTheme;
  onAction: (action: SnapAction) => void;
}

function renderElement(id: string, ctx: RenderCtx): React.ReactNode {
  const el = ctx.elements[id];
  if (!el) return null;

  switch (el.type) {
    case 'text':
      return <SnapText key={id} el={el} ctx={ctx} />;
    case 'button':
      return <SnapButton key={id} el={el} ctx={ctx} />;
    case 'icon':
      return <SnapIcon key={id} el={el} ctx={ctx} />;
    case 'image':
      return <SnapImage key={id} el={el} ctx={ctx} />;
    case 'stack':
      return <SnapStack key={id} el={el} ctx={ctx} />;
    case 'input':
      return <SnapInput key={id} el={el} ctx={ctx} />;
    case 'slider':
      return <SnapSliderElement key={id} el={el} ctx={ctx} />;
    case 'switch':
      return <SnapSwitchElement key={id} el={el} ctx={ctx} />;
    case 'progress':
      return <SnapProgress key={id} el={el} ctx={ctx} />;
    case 'badge':
      return <SnapBadge key={id} el={el} ctx={ctx} />;
    case 'separator':
      return <SnapSeparator key={id} el={el} ctx={ctx} />;
    case 'item':
      return <SnapItem key={id} el={el} ctx={ctx} />;
    case 'item_group':
      return <SnapItemGroup key={id} el={el} ctx={ctx} />;
    case 'bar_chart':
      return <SnapBarChart key={id} el={el} ctx={ctx} />;
    case 'toggle_group':
      return <SnapToggleGroup key={id} el={el} ctx={ctx} />;
    case 'cell_grid':
      return <SnapCellGrid key={id} el={el} ctx={ctx} />;
    default:
      return null;
  }
}

function renderChildren(el: SnapElementBase, ctx: RenderCtx): React.ReactNode[] {
  return (el.children ?? []).map((childId) => renderElement(childId, ctx));
}

// -- text ------------------------------------------------------------------

function SnapText({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const size = p.size === 'sm' ? 13 : 15;
  const weight = p.weight === 'bold' ? '700' : '400';
  const align = (p.align as 'left' | 'center' | 'right') ?? 'left';
  return (
    <Text style={{ fontSize: size, fontWeight: weight as any, textAlign: align, color: ctx.theme.colors.textMain }}>
      {String(p.content ?? '')}
    </Text>
  );
}

// -- button ----------------------------------------------------------------

function SnapButton({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const isPrimary = p.variant !== 'secondary';
  const iconName = resolveSnapIcon(p.icon as string | undefined);
  const stackDirection = useContext(StackDirectionContext);
  const isInHorizontalStack = stackDirection === 'horizontal';

  const handlePress = () => {
    if (el.on?.press) {
      ctx.onAction(el.on.press);
    }
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.8}
      style={[
        elStyles.button,
        isPrimary
          ? { backgroundColor: ctx.accent }
          : { backgroundColor: ctx.theme.colors.surface3 },
        isInHorizontalStack && { flex: 1, minWidth: 0 },
      ]}
    >
      {iconName && (
        <IconSymbol
          name={iconName}
          color={isPrimary ? '#fff' : ctx.theme.colors.textMain}
          size={16}
          style={{ marginRight: 6 }}
        />
      )}
      <Text
        numberOfLines={1}
        style={[
          elStyles.buttonLabel,
          { color: isPrimary ? '#fff' : ctx.theme.colors.textMain, flexShrink: 1 },
        ]}
      >
        {String(p.label ?? '')}
      </Text>
    </TouchableOpacity>
  );
}

// -- icon ------------------------------------------------------------------

function SnapIcon({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const iconName = resolveSnapIcon(p.name as string | undefined);
  const size = p.size === 'sm' ? 16 : 20;
  const color = resolvePaletteColor(p.color as string | undefined, ctx) ?? ctx.theme.colors.textMuted;
  if (!iconName) {
    // Render a fallback dot
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: 0.4 }} />;
  }
  return <IconSymbol name={iconName} size={size} color={color} />;
}

// -- image -----------------------------------------------------------------

function SnapImage({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const aspectStr = (p.aspect as string) ?? '16:9';
  const aspectRatio = ASPECT_RATIOS[aspectStr] ?? 16 / 9;
  return (
    <Image
      source={{ uri: String(p.url ?? '') }}
      style={{
        width: '100%',
        aspectRatio,
        borderRadius: 8,
        backgroundColor: ctx.theme.colors.surface3,
      }}
      contentFit="cover"
      accessibilityLabel={p.alt ? String(p.alt) : undefined}
    />
  );
}

// -- stack -----------------------------------------------------------------

function SnapStack({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const isHorizontal = p.direction === 'horizontal';
  // Spec default for stack gap is "md" (8px)
  const gap = resolveGap(p.gap ?? 'md');
  const justify = (p.justify as string) ?? undefined;

  const justifyMap: Record<string, 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around'> = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
    between: 'space-between',
    around: 'space-around',
  };

  return (
    <StackDirectionContext.Provider value={isHorizontal ? 'horizontal' : 'vertical'}>
      <View
        style={{
          flexDirection: isHorizontal ? 'row' : 'column',
          gap,
          justifyContent: justify ? justifyMap[justify] ?? 'flex-start' : undefined,
          alignItems: isHorizontal ? 'center' : undefined,
        }}
      >
        {renderChildren(el, ctx)}
      </View>
    </StackDirectionContext.Provider>
  );
}

// -- input -----------------------------------------------------------------

function SnapInput({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const name = String(p.name ?? '');
  const current = (ctx.formState[name] as string) ?? '';

  return (
    <View>
      {p.label ? (
        <Text style={{ fontSize: 13, color: ctx.theme.colors.textMuted, marginBottom: 4 }}>
          {String(p.label)}
        </Text>
      ) : null}
      <TextInput
        value={current}
        onChangeText={(text) => ctx.setFormValue(name, text)}
        placeholder={p.placeholder ? String(p.placeholder) : undefined}
        placeholderTextColor={ctx.theme.colors.textMuted}
        keyboardType={p.type === 'number' ? 'numeric' : 'default'}
        style={[
          elStyles.input,
          {
            color: ctx.theme.colors.textMain,
            backgroundColor: ctx.theme.colors.surface2,
            borderColor: ctx.theme.colors.surface4,
          },
        ]}
      />
    </View>
  );
}

// -- slider ----------------------------------------------------------------

function SnapSliderElement({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const name = String(p.name ?? '');
  const min = Number(p.min ?? 0);
  const max = Number(p.max ?? 100);
  const step = Number(p.step ?? 1);
  const value = (ctx.formState[name] as number) ?? Number(p.defaultValue ?? min);

  const showValue = Boolean(p.showValue);

  return (
    <View>
      {(p.label || showValue) ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          {p.label ? (
            <Text style={{ fontSize: 13, color: ctx.theme.colors.textMuted }}>
              {String(p.label)}
            </Text>
          ) : <View />}
          {showValue && (
            <Text style={{ fontSize: 13, color: ctx.theme.colors.textMain, fontWeight: '600' }}>
              {value}
            </Text>
          )}
        </View>
      ) : null}
      <SnapSlider
        min={min}
        max={max}
        step={step}
        value={value}
        onValueChange={(v) => ctx.setFormValue(name, v)}
        accentColor={ctx.accent}
        trackColor={ctx.theme.colors.surface4}
      />
    </View>
  );
}

// -- switch ----------------------------------------------------------------

function SnapSwitchElement({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const name = String(p.name ?? '');
  const checked = (ctx.formState[name] as boolean) ?? Boolean(p.defaultChecked);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      {p.label ? (
        <Text style={{ fontSize: 15, color: ctx.theme.colors.textMain, flex: 1 }}>
          {String(p.label)}
        </Text>
      ) : null}
      <Switch
        value={checked}
        onValueChange={(v) => ctx.setFormValue(name, v)}
        trackColor={{ false: ctx.theme.colors.surface4, true: ctx.accent }}
        thumbColor="#fff"
      />
    </View>
  );
}

// -- progress --------------------------------------------------------------

function SnapProgress({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const value = Number(p.value ?? 0);
  const max = Number(p.max ?? 100);
  const pct = max > 0 ? Math.min(value / max, 1) : 0;

  return (
    <View>
      {p.label ? (
        <Text style={{ fontSize: 13, color: ctx.theme.colors.textMuted, marginBottom: 4 }}>
          {String(p.label)}
        </Text>
      ) : null}
      <View style={[elStyles.progressTrack, { backgroundColor: ctx.theme.colors.surface3 }]}>
        <View style={[elStyles.progressFill, { backgroundColor: ctx.accent, width: `${pct * 100}%` }]} />
      </View>
    </View>
  );
}

// -- badge -----------------------------------------------------------------

function SnapBadge({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const isOutline = p.variant === 'outline';
  const color = resolvePaletteColor(p.color as string | undefined, ctx) ?? ctx.accent;
  const iconName = resolveSnapIcon(p.icon as string | undefined);

  return (
    <View
      style={[
        elStyles.badge,
        isOutline
          ? { borderWidth: 1, borderColor: color }
          : { backgroundColor: color + '22' },
      ]}
    >
      {iconName && <IconSymbol name={iconName} size={12} color={color} style={{ marginRight: 4 }} />}
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{String(p.label ?? '')}</Text>
    </View>
  );
}

// -- separator -------------------------------------------------------------

function SnapSeparator({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const isVertical = p.orientation === 'vertical';
  return (
    <View
      style={
        isVertical
          ? { width: 1, alignSelf: 'stretch', backgroundColor: ctx.theme.colors.surface4 }
          : { height: 1, backgroundColor: ctx.theme.colors.surface4 }
      }
    />
  );
}

// -- item ------------------------------------------------------------------

function SnapItem({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const hasPress = Boolean(el.on?.press);
  const Wrapper = hasPress ? TouchableOpacity : View;
  const wrapperProps = hasPress
    ? { onPress: () => ctx.onAction(el.on!.press!), activeOpacity: 0.7 }
    : {};
  return (
    <Wrapper style={[elStyles.item, { backgroundColor: ctx.theme.colors.surface2 }]} {...wrapperProps}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: '600', color: ctx.theme.colors.textStrong }}>
          {String(p.title ?? '')}
        </Text>
        {p.description ? (
          <Text style={{ fontSize: 13, color: ctx.theme.colors.textMuted, marginTop: 2 }}>
            {String(p.description)}
          </Text>
        ) : null}
      </View>
      {el.children && el.children.length > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 8 }}>
          {renderChildren(el, ctx)}
        </View>
      ) : null}
    </Wrapper>
  );
}

// -- item_group ------------------------------------------------------------

function SnapItemGroup({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const hasBorder = p.border !== false;
  const hasSeparator = p.separator !== false;
  const gap = resolveGap(p.gap);
  const children = el.children ?? [];

  return (
    <View
      style={[
        hasBorder && {
          borderWidth: 1,
          borderColor: ctx.theme.colors.surface4,
          borderRadius: 12,
          overflow: 'hidden',
        },
      ]}
    >
      {children.map((childId, i) => (
        <React.Fragment key={childId}>
          {hasSeparator && i > 0 && (
            <View style={{ height: 1, backgroundColor: ctx.theme.colors.surface4 }} />
          )}
          {!hasSeparator && i > 0 && gap > 0 && <View style={{ height: gap }} />}
          {renderElement(childId, ctx)}
        </React.Fragment>
      ))}
    </View>
  );
}

// -- bar_chart -------------------------------------------------------------

function SnapBarChart({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const bars = (p.bars as { label: string; value: number; color?: string }[]) ?? [];
  const maxVal = Number(p.max ?? Math.max(...bars.map((b) => b.value), 1));
  const defaultBarColor = resolvePaletteColor(p.color as string | undefined, ctx) ?? ctx.accent;

  return (
    <View style={{ gap: 6 }}>
      {bars.map((bar, i) => {
        const pct = maxVal > 0 ? Math.min(bar.value / maxVal, 1) : 0;
        return (
          <View key={i} style={{ gap: 2 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, color: ctx.theme.colors.textMain }}>{bar.label}</Text>
              <Text style={{ fontSize: 13, color: ctx.theme.colors.textMuted }}>{bar.value}</Text>
            </View>
            <View style={[elStyles.progressTrack, { backgroundColor: ctx.theme.colors.surface3, height: 8 }]}>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: resolvePaletteColor(bar.color, ctx) ?? defaultBarColor, width: `${pct * 100}%` }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// -- toggle_group ----------------------------------------------------------

function SnapToggleGroup({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const name = String(p.name ?? '');
  // Spec: options is string[] (each string is both label and value)
  const rawOptions = (p.options as string[]) ?? [];
  const multiple = Boolean(p.multiple);
  const isOutline = p.variant === 'outline';
  const selected = ctx.formState[name] as string | string[] | undefined;

  const isSelected = (val: string) => {
    if (multiple && Array.isArray(selected)) return selected.includes(val);
    return selected === val;
  };

  const handlePress = (val: string) => {
    if (multiple) {
      const arr = Array.isArray(selected) ? [...selected] : [];
      const idx = arr.indexOf(val);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(val);
      ctx.setFormValue(name, arr);
    } else {
      ctx.setFormValue(name, val);
    }
  };

  const isVertical = p.orientation === 'vertical';

  return (
    <View>
      {p.label ? (
        <Text style={{ fontSize: 13, color: ctx.theme.colors.textMuted, marginBottom: 6 }}>
          {String(p.label)}
        </Text>
      ) : null}
      <View style={{ flexDirection: isVertical ? 'column' : 'row', flexWrap: 'wrap', gap: 6 }}>
        {rawOptions.map((opt) => {
          const active = isSelected(opt);
          return (
            <TouchableOpacity
              key={opt}
              onPress={() => handlePress(opt)}
              activeOpacity={0.7}
              style={[
                elStyles.toggleOption,
                active
                  ? { backgroundColor: ctx.accent, borderColor: ctx.accent }
                  : isOutline
                    ? { backgroundColor: 'transparent', borderColor: ctx.theme.colors.surface4 }
                    : { backgroundColor: ctx.theme.colors.surface2, borderColor: ctx.theme.colors.surface4 },
              ]}
            >
              <Text style={{ fontSize: 13, fontWeight: '500', color: active ? '#fff' : ctx.theme.colors.textMain }}>
                {opt}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// -- cell_grid -------------------------------------------------------------

function SnapCellGrid({ el, ctx }: { el: SnapElementBase; ctx: RenderCtx }) {
  const p = el.props ?? {};
  const cols = Number(p.cols ?? 2);
  const rows = Number(p.rows ?? 2);
  const cells = (p.cells as { color?: string; content?: string; row?: number; col?: number }[]) ?? [];
  const name = String(p.name ?? 'grid_tap');
  const selectMode = (p.select as string) ?? 'off';
  const selectable = selectMode !== 'off';
  const rowHeight = Number(p.rowHeight ?? 28);
  const gap = resolveGap(p.gap ?? 'sm');

  // Build a 2D grid
  const grid: ({ color?: string; content?: string; row: number; col: number } | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      grid[r][c] = null;
    }
  }
  for (const cell of cells) {
    const cr = cell.row ?? 0;
    const cc = cell.col ?? 0;
    if (cr < rows && cc < cols) {
      grid[cr][cc] = { color: resolvePaletteColor(cell.color, ctx), content: cell.content, row: cr, col: cc };
    }
  }

  const selectedCell = ctx.formState[name] as string | string[] | undefined;

  const isCellSelected = (row: number, col: number) => {
    const key = `${row},${col}`;
    if (selectMode === 'multiple' && Array.isArray(selectedCell)) return selectedCell.includes(key);
    return selectedCell === key;
  };

  const handleCellPress = (row: number, col: number) => {
    const key = `${row},${col}`;
    if (selectMode === 'multiple') {
      const arr = Array.isArray(selectedCell) ? [...selectedCell] : [];
      const idx = arr.indexOf(key);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(key);
      ctx.setFormValue(name, arr);
    } else if (selectMode === 'single') {
      ctx.setFormValue(name, key);
    } else {
      // select: 'off' — fire on.press action
      ctx.setFormValue(name, key);
      if (el.on?.press) ctx.onAction(el.on.press);
    }
  };

  return (
    <View style={{ gap }}>
      {grid.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', gap }}>
          {row.map((cell, c) => {
            const isActive = isCellSelected(r, c);
            return (
              <TouchableOpacity
                key={c}
                activeOpacity={0.7}
                onPress={() => handleCellPress(r, c)}
                style={[
                  {
                    height: rowHeight,
                    borderRadius: 4,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 1,
                    backgroundColor: cell?.color ?? ctx.theme.colors.surface3,
                    borderColor: isActive ? ctx.accent : 'transparent',
                    borderWidth: isActive ? 2 : 0,
                  },
                ]}
              >
                {cell?.content ? (
                  <Text style={{ fontSize: 10, color: ctx.theme.colors.textMain, textAlign: 'center' }}>
                    {cell.content}
                  </Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Element styles
// ---------------------------------------------------------------------------

const elStyles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  buttonLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  toggleOption: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
  },
  gridCell: {
    aspectRatio: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
    minHeight: 20,
  },
});

// ---------------------------------------------------------------------------
// Confetti effect
// ---------------------------------------------------------------------------

const CONFETTI_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];
const CONFETTI_COUNT = 40;

function ConfettiPiece({ index, containerHeight }: { index: number; containerHeight: number }) {
  const progress = useSharedValue(0);
  const startX = useMemo(() => Math.random() * 100, []);
  const drift = useMemo(() => (Math.random() - 0.5) * 60, []);
  const rotation = useMemo(() => Math.random() * 720 - 360, []);
  const delay = useMemo(() => Math.random() * 400, []);
  const color = useMemo(() => CONFETTI_COLORS[index % CONFETTI_COLORS.length], [index]);
  const size = useMemo(() => 4 + Math.random() * 6, []);
  const isCircle = useMemo(() => Math.random() > 0.5, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      progress.value = withTiming(1, { duration: 2000 + Math.random() * 1000, easing: Easing.out(Easing.quad) });
    }, delay);
    return () => clearTimeout(timer);
  }, [delay, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    left: `${startX + drift * progress.value}%`,
    top: -10 + (containerHeight + 20) * progress.value,
    width: size,
    height: isCircle ? size : size * 1.6,
    borderRadius: isCircle ? size / 2 : 1,
    backgroundColor: color,
    opacity: 1 - progress.value * 0.6,
    transform: [{ rotate: `${rotation * progress.value}deg` }],
  }));

  return <ReanimatedView style={animatedStyle} />;
}

function ConfettiOverlay({ show }: { show: boolean }) {
  const [containerHeight, setContainerHeight] = useState(200);
  const [visible, setVisible] = useState(show);

  useEffect(() => {
    if (show) {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 3500);
      return () => clearTimeout(timer);
    }
  }, [show]);

  if (!visible) return null;

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
    >
      {Array.from({ length: CONFETTI_COUNT }).map((_, i) => (
        <ConfettiPiece key={i} index={i} containerHeight={containerHeight} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SnapEmbed({
  url,
  theme,
  userFid,
  token,
  onOpenUrl,
  onOpenProfile,
  onOpenMiniApp,
}: SnapEmbedProps) {
  const [snapResponse, setSnapResponse] = useState<SnapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfetti, setShowConfetti] = useState(false);
  const confettiKeyRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formState, setFormState] = useState<Record<string, unknown>>({});
  const mountedRef = useRef(true);

  const applySnapResponse = useCallback((data: SnapResponse) => {
    setSnapResponse(data);
    if (data.effects?.includes('confetti')) {
      confettiKeyRef.current += 1;
      setShowConfetti(false);
      // Trigger on next tick so React re-mounts the overlay
      setTimeout(() => setShowConfetti(true), 0);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch snap data
  const fetchSnap = useCallback(async (targetUrl: string) => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: { Accept: 'application/vnd.farcaster.snap+json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data: SnapResponse = await res.json();
      const majorVersion = parseInt(data.version, 10);
      if (isNaN(majorVersion) || majorVersion < 1) {
        throw new Error('Unsupported snap version');
      }
      if (!mountedRef.current) return;
      applySnapResponse(data);
      // Initialize form defaults from elements
      if (data.ui?.elements) {
        const defaults: Record<string, unknown> = {};
        for (const el of Object.values(data.ui.elements)) {
          const p = el.props ?? {};
          const name = p.name as string | undefined;
          if (!name) continue;
          if (el.type === 'input' && p.defaultValue !== undefined) {
            defaults[name] = String(p.defaultValue);
          } else if (el.type === 'slider' && p.defaultValue !== undefined) {
            defaults[name] = Number(p.defaultValue);
          } else if (el.type === 'switch') {
            defaults[name] = Boolean(p.defaultChecked);
          } else if (el.type === 'toggle_group' && p.defaultValue !== undefined) {
            defaults[name] = p.defaultValue;
          }
        }
        setFormState(defaults);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e?.name === 'AbortError' ? 'Timed out' : (e?.message ?? 'Failed to load'));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchSnap(url);
  }, [url, fetchSnap]);

  // Form state setter
  const setFormValue = useCallback((name: string, value: unknown) => {
    setFormState((prev) => ({ ...prev, [name]: value }));
  }, []);

  // Handle actions
  const handleAction = useCallback(async (action: SnapAction) => {
    const { action: type, params } = action;

    switch (type) {
      case 'submit': {
        const target = params?.target as string | undefined;
        if (!target) return;
        setSubmitting(true);
        try {
          let data: SnapResponse | null = null;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);

          // Prefer the Farcaster signed-actions proxy when we have a token + fid;
          // it signs the JFS request on the server using the user's stored signer.
          if (token && userFid) {
            const idempotencyKey =
              (globalThis as any).crypto?.randomUUID?.() ??
              `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const proxyRes = await fetch('https://farcaster.xyz/~api/v2/signed-actions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Accept: '*/*',
                Authorization: `Bearer ${token}`,
                'Idempotency-Key': idempotencyKey,
                Origin: 'https://farcaster.xyz',
                Referer: 'https://farcaster.xyz/',
              },
              body: JSON.stringify({
                targetUrl: target,
                payload: {
                  fid: userFid,
                  inputs: formState,
                  button_index: 0,
                  timestamp: Math.floor(Date.now() / 1000),
                },
              }),
              signal: controller.signal,
            });
            clearTimeout(timer);
            if (proxyRes.ok) {
              const wrapped = await proxyRes.json();
              if (wrapped?.result?.success && wrapped.result.response) {
                data = wrapped.result.response as SnapResponse;
              }
            }
          }

          // Fallback: plain GET (pure-navigation snaps work, form-submit snaps won't)
          if (!data) {
            const targetUrl = new URL(target);
            for (const [key, val] of Object.entries(formState)) {
              if (Array.isArray(val)) {
                for (const v of val) targetUrl.searchParams.append(key, String(v));
              } else {
                targetUrl.searchParams.set(key, String(val));
              }
            }
            const getController = new AbortController();
            const getTimer = setTimeout(() => getController.abort(), 10000);
            const res = await fetch(targetUrl.toString(), {
              method: 'GET',
              headers: { Accept: 'application/vnd.farcaster.snap+json' },
              signal: getController.signal,
            });
            clearTimeout(getTimer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            data = await res.json();
          }

          if (data?.version && mountedRef.current) {
            applySnapResponse(data);
            // Re-initialize form defaults
            if (data.ui?.elements) {
              const defaults: Record<string, unknown> = {};
              for (const el of Object.values(data.ui.elements)) {
                const p = el.props ?? {};
                const name = p.name as string | undefined;
                if (!name) continue;
                if (el.type === 'input' && p.defaultValue !== undefined) {
                  defaults[name] = String(p.defaultValue);
                } else if (el.type === 'slider' && p.defaultValue !== undefined) {
                  defaults[name] = Number(p.defaultValue);
                } else if (el.type === 'switch') {
                  defaults[name] = Boolean(p.defaultChecked);
                } else if (el.type === 'toggle_group' && p.defaultValue !== undefined) {
                  defaults[name] = p.defaultValue;
                }
              }
              setFormState(defaults);
            }
          }
        } catch {
          // Submit failed — snap stays as-is
        } finally {
          if (mountedRef.current) {
            setSubmitting(false);
          }
        }
        break;
      }
      case 'open_url':
        if (params?.target) onOpenUrl?.(String(params.target));
        break;
      case 'open_snap':
        // Re-fetch with the new snap URL
        if (params?.target) fetchSnap(String(params.target));
        break;
      case 'open_mini_app':
        if (params?.target) onOpenMiniApp?.(String(params.target));
        break;
      case 'view_cast':
        // Navigate to cast — use onOpenUrl as fallback
        if (params?.hash) onOpenUrl?.(`https://farcaster.xyz/~/conversations/${params.hash}`);
        break;
      case 'view_profile':
        if (params?.fid) onOpenProfile?.(Number(params.fid));
        break;
      case 'compose_cast': {
        const text = params?.text ? String(params.text) : '';
        const embeds = (params?.embeds as string[]) ?? [];
        const composeUrl = new URL('https://farcaster.xyz/~/compose');
        if (text) composeUrl.searchParams.set('text', text);
        if (embeds.length > 0) composeUrl.searchParams.set('embeds', embeds.join(','));
        if (params?.channelKey) composeUrl.searchParams.set('channel', String(params.channelKey));
        onOpenUrl?.(composeUrl.toString());
        break;
      }
      case 'view_token':
        if (params?.token) onOpenUrl?.(`https://farcaster.xyz/~/token/${params.token}`);
        break;
      case 'send_token':
        if (params?.token) onOpenUrl?.(`https://farcaster.xyz/~/token/${params.token}`);
        break;
      case 'swap_token':
        onOpenUrl?.('https://farcaster.xyz');
        break;
      default:
        break;
    }
  }, [userFid, formState, fetchSnap, onOpenUrl, onOpenProfile, onOpenMiniApp]);

  // Resolved accent color
  const accent = PALETTE_COLORS[snapResponse?.theme?.accent ?? ''] ?? snapResponse?.theme?.accent ?? theme.colors.accent;

  const styles = useMemo(
    () => ({
      container: {
        borderWidth: 1,
        borderColor: theme.colors.surface4,
        borderRadius: 12,
        overflow: 'hidden' as const,
        backgroundColor: theme.colors.surface2,
      },
      content: {
        padding: 12,
      },
      loadingContainer: {
        padding: 24,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
      },
      errorContainer: {
        padding: 16,
        alignItems: 'center' as const,
      },
      errorText: {
        fontSize: 13,
        color: theme.colors.textMuted,
        textAlign: 'center' as const,
      },
      retryButton: {
        marginTop: 8,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        backgroundColor: theme.colors.surface3,
      },
      retryText: {
        fontSize: 13,
        color: theme.colors.textMain,
      },
      overlayLoading: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.dark ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.5)',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 12,
      },
    }),
    [theme],
  );

  // Loading state
  if (loading && !snapResponse) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={theme.colors.textMuted} />
        </View>
      </View>
    );
  }

  // Error state — render nothing rather than a confusing error card. Detection
  // misfires (e.g. a server returning HTML for a URL we thought was a snap)
  // shouldn't leave a broken embed in the feed.
  if (error && !snapResponse) {
    return null;
  }

  // No snap data
  if (!snapResponse?.ui) return null;

  const ctx: RenderCtx = {
    elements: snapResponse.ui.elements,
    formState,
    setFormValue,
    accent,
    theme,
    onAction: handleAction,
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {renderElement(snapResponse.ui.root, ctx)}
      </View>
      {submitting && (
        <View style={styles.overlayLoading}>
          <ActivityIndicator size="small" color={accent} />
        </View>
      )}
      <ConfettiOverlay key={confettiKeyRef.current} show={showConfetti} />
    </View>
  );
}

/**
 * Hook to detect if a URL is a snap. Returns `true`, `false`, or `null` (pending).
 * Uses the snap detection cache so subsequent renders are instant.
 */
export function useSnapDetection(url: string | undefined): boolean | null {
  const [result, setResult] = useState<boolean | null>(() => {
    if (!url) return false;
    const cached = snapDetectionCache.get(url);
    return cached !== undefined ? cached : null;
  });

  useEffect(() => {
    if (!url) {
      setResult(false);
      return;
    }
    const cached = snapDetectionCache.get(url);
    if (cached !== undefined) {
      setResult(cached);
      return;
    }
    let cancelled = false;
    isSnapUrl(url).then((val) => {
      if (!cancelled) setResult(val);
    });
    return () => { cancelled = true; };
  }, [url]);

  return result;
}

export default SnapEmbed;
