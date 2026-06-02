import type { AppTheme } from '@/theme';
import React, { useCallback } from 'react';
import { FlatList, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { AutoHeightImage } from './AutoHeightImage';
import { SCREEN_WIDTH } from '../utils';
import * as Skin from '@/theme/skins/geometry';

interface PaginationDotProps {
  index: number;
  activeIndex: { value: number };
  activeColor: string;
  inactiveColor: string;
}

/** Single pagination dot driven by a Reanimated shared value (no React re-renders). */
function PaginationDot({ index, activeIndex, activeColor, inactiveColor }: PaginationDotProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: index === activeIndex.value ? activeColor : inactiveColor,
  }));

  return (
    <Animated.View
      style={[
        { width: 6, height: 6, borderRadius: Skin.radius(3) },
        animatedStyle,
      ]}
    />
  );
}

interface ImageCarouselProps {
  urls: string[];
  maxHeight: number;
  theme: AppTheme;
  /** Called when an image is pressed. Receives the tapped URL and its index. */
  onImagePress?: (url: string, index: number) => void;
}

/**
 * Horizontal scrollable image carousel with pagination dots.
 */
export function ImageCarousel({
  urls,
  maxHeight,
  theme,
  onImagePress,
}: ImageCarouselProps) {
  const activeIndex = useSharedValue(0);

  const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { x: number } } }) => {
    const contentOffsetX = event.nativeEvent.contentOffset.x;
    const index = Math.round(contentOffsetX / SCREEN_WIDTH);
    activeIndex.value = index;
  }, [activeIndex]);

  const renderItem = useCallback(({ item, index }: { item: string; index: number }) => (
    <View style={{ width: SCREEN_WIDTH }}>
      <AutoHeightImage
        uri={item}
        maxHeight={maxHeight}
        maxWidth={SCREEN_WIDTH}
        style={{ backgroundColor: theme.colors.surface3 }}
        onPress={onImagePress ? () => onImagePress(item, index) : undefined}
      />
    </View>
  ), [maxHeight, theme.colors.surface3, onImagePress]);

  return (
    <View style={{ width: SCREEN_WIDTH }}>
      <FlatList
        data={urls}
        renderItem={renderItem}
        keyExtractor={(_, index) => index.toString()}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        getItemLayout={(_, index) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * index,
          index,
        })}
        decelerationRate="fast"
        snapToAlignment="start"
      />
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
          paddingVertical: Skin.space(12),
          gap: Skin.space(6),
        }}
      >
        {urls.map((_, index) => (
          <PaginationDot
            key={index}
            index={index}
            activeIndex={activeIndex}
            activeColor={theme.colors.textMain}
            inactiveColor={theme.colors.surface4}
          />
        ))}
      </View>
    </View>
  );
}

export default ImageCarousel;
