// useCenteredPillScroll — headless behaviour for a horizontal selector row that
// scrolls the tapped item toward the centre of the viewport.
//
// Kept separate from the visual <SegmentedPills> so non-pill selectors (e.g.
// underline-style tab rows) can adopt centring without inheriting pill styling.
//
// Usage:
//   const pills = useCenteredPillScroll();
//   <ScrollView {...pills.scrollViewProps}>
//     {items.map(it => (
//       <Pressable
//         key={it.key}
//         onLayout={pills.onItemLayout(it.key)}
//         onPress={() => { setActive(it.key); pills.center(it.key); }}
//       />
//     ))}
//   </ScrollView>

import { useCallback, useRef } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

export interface CenteredPillScroll {
  /** Spread onto the horizontal ScrollView. Captures the ref + viewport width. */
  scrollViewProps: {
    ref: React.RefObject<ScrollView | null>;
    horizontal: true;
    showsHorizontalScrollIndicator: false;
    onLayout: (e: LayoutChangeEvent) => void;
  };
  /** Spread onto each item: `onLayout={onItemLayout(key)}`. */
  onItemLayout: (key: string) => (e: LayoutChangeEvent) => void;
  /** Scroll so the item with `key` is centred in the viewport (animated). */
  center: (key: string) => void;
}

export function useCenteredPillScroll(): CenteredPillScroll {
  const scrollRef = useRef<ScrollView | null>(null);
  const viewportWidth = useRef(0);
  const layouts = useRef<Record<string, { x: number; width: number }>>({});

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    viewportWidth.current = e.nativeEvent.layout.width;
  }, []);

  const onItemLayout = useCallback(
    (key: string) => (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      layouts.current[key] = { x, width };
    },
    [],
  );

  const center = useCallback((key: string) => {
    const item = layouts.current[key];
    const sv = scrollRef.current;
    if (!item || !sv) return;
    // Target offset that puts the item's midpoint at the viewport midpoint.
    // Clamp the lower bound to 0; RN clamps the upper bound to content width.
    const target = item.x + item.width / 2 - viewportWidth.current / 2;
    sv.scrollTo({ x: Math.max(0, target), animated: true });
  }, []);

  return {
    scrollViewProps: {
      ref: scrollRef,
      horizontal: true,
      showsHorizontalScrollIndicator: false,
      onLayout,
    },
    onItemLayout,
    center,
  };
}
