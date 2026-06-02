import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { saveMediaToLibrary } from '@/services/media/saveToLibrary';
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SCREEN_WIDTH, SCREEN_HEIGHT } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

const ReanimatedView = Reanimated.View;

interface ImageViewerProps {
  visible: boolean;
  /** Single image URL (legacy support) */
  imageUrl?: string | null;
  /** Array of image URLs for gallery mode */
  images?: string[];
  /** Initial index when using images array */
  initialIndex?: number;
  onClose: () => void;
  /** Called when index changes in gallery mode */
  onIndexChange?: (index: number) => void;
}

const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;
const SWIPE_DOWN_THRESHOLD = 100;
const VELOCITY_THRESHOLD = 500;

/**
 * Full-screen image viewer with:
 * - Pinch-to-zoom and pan gestures
 * - Horizontal swipe to navigate between images (gallery mode)
 * - Swipe down to close
 * - Double-tap to zoom
 */
export function ImageViewer({
  visible,
  imageUrl,
  images,
  initialIndex = 0,
  onClose,
  onIndexChange,
}: ImageViewerProps) {
  // Normalize to array of images
  const imageArray = images ?? (imageUrl ? [imageUrl] : []);
  const hasMultipleImages = imageArray.length > 1;

  // Track current index in React state for UI updates
  const [displayIndex, setDisplayIndex] = useState(initialIndex);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    const url = imageArray[displayIndex];
    if (!url || saving) return;
    setSaving(true);
    const result = await saveMediaToLibrary(url, 'image');
    setSaving(false);
    if (result.ok) {
      Alert.alert('Saved', 'Photo saved to your library.');
    } else {
      const message =
        result.reason === 'permission_denied'
          ? 'Photo library permission was denied. Enable it in Settings → Quorum.'
          : result.reason === 'download_failed'
            ? `Couldn’t download the image${result.detail ? ` (${result.detail})` : ''}.`
            : result.reason === 'invalid_url'
              ? 'This image can’t be saved.'
              : `Couldn’t save the image${result.detail ? ` (${result.detail})` : ''}.`;
      Alert.alert('Save failed', message);
    }
  }, [imageArray, displayIndex, saving]);

  // Current image index (shared value for worklets)
  const currentIndex = useSharedValue(initialIndex);

  // Gallery horizontal position
  const galleryTranslateX = useSharedValue(-initialIndex * SCREEN_WIDTH);
  const savedGalleryTranslateX = useSharedValue(-initialIndex * SCREEN_WIDTH);

  // Per-image zoom and pan
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Swipe down to close
  const dismissTranslateY = useSharedValue(0);
  const dismissOpacity = useSharedValue(1);

  // Reset transforms when visibility or images change
  useEffect(() => {
    if (visible) {
      const startIndex = initialIndex;
      currentIndex.value = startIndex;
      setDisplayIndex(startIndex);
      galleryTranslateX.value = -startIndex * SCREEN_WIDTH;
      savedGalleryTranslateX.value = -startIndex * SCREEN_WIDTH;
      resetZoomJS();
      dismissTranslateY.value = 0;
      dismissOpacity.value = 1;
    }
  }, [visible, imageUrl, images, initialIndex]);

  const resetZoomJS = useCallback(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, []);

  const updateDisplayIndex = useCallback((index: number) => {
    setDisplayIndex(index);
    onIndexChange?.(index);
  }, [onIndexChange]);

  const goToIndex = useCallback((index: number) => {
    currentIndex.value = index;
    galleryTranslateX.value = withTiming(-index * SCREEN_WIDTH, { duration: 250 });
    savedGalleryTranslateX.value = -index * SCREEN_WIDTH;
    resetZoomJS();
    updateDisplayIndex(index);
  }, [updateDisplayIndex, resetZoomJS]);

  // Pinch to zoom gesture
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(savedScale.value * e.scale, 5));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value < 1) {
        scale.value = withSpring(1);
        savedScale.value = 1;
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  // Track if gesture direction is locked (0 = undecided, 1 = horizontal, 2 = vertical)
  const gestureDirection = useSharedValue(0);

  // Pan gesture for zoomed image OR swipe down to close OR horizontal gallery navigation
  const panGesture = Gesture.Pan()
    .onStart(() => {
      gestureDirection.value = 0; // Reset direction on new gesture
    })
    .onUpdate((e) => {
      if (scale.value > 1) {
        // Zoomed in - allow panning the image
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      } else {
        // Lock in direction after moving 10px in any direction
        if (gestureDirection.value === 0) {
          const absX = Math.abs(e.translationX);
          const absY = Math.abs(e.translationY);
          if (absX > 10 || absY > 10) {
            gestureDirection.value = absX > absY ? 1 : 2;
          }
        }

        if (gestureDirection.value === 1 && hasMultipleImages) {
          // Horizontal swipe for gallery navigation
          galleryTranslateX.value = savedGalleryTranslateX.value + e.translationX;
        } else if (gestureDirection.value === 2 || !hasMultipleImages) {
          // Vertical swipe for dismiss (only downward)
          dismissTranslateY.value = Math.max(0, e.translationY);
          dismissOpacity.value = interpolate(
            e.translationY,
            [0, SCREEN_HEIGHT * 0.3],
            [1, 0.3],
            Extrapolation.CLAMP
          );
        }
      }
    })
    .onEnd((e) => {
      if (scale.value > 1) {
        // Save pan position when zoomed
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
      } else {
        if (gestureDirection.value === 1 && hasMultipleImages) {
          // Handle horizontal swipe end
          const velocityThreshold = Math.abs(e.velocityX) > VELOCITY_THRESHOLD;
          const distanceThreshold = Math.abs(e.translationX) > SWIPE_THRESHOLD;

          if (velocityThreshold || distanceThreshold) {
            const direction = e.translationX > 0 ? -1 : 1;
            const newIndex = Math.max(0, Math.min(imageArray.length - 1, currentIndex.value + direction));

            if (newIndex !== currentIndex.value) {
              runOnJS(goToIndex)(newIndex);
            } else {
              // Snap back at edges
              galleryTranslateX.value = withTiming(savedGalleryTranslateX.value, { duration: 150 });
            }
          } else {
            // Snap back
            galleryTranslateX.value = withTiming(savedGalleryTranslateX.value, { duration: 150 });
          }
        } else {
          // Handle vertical swipe end (dismiss)
          const shouldDismiss =
            e.translationY > SWIPE_DOWN_THRESHOLD ||
            e.velocityY > VELOCITY_THRESHOLD;

          if (shouldDismiss) {
            dismissTranslateY.value = withTiming(SCREEN_HEIGHT, { duration: 200 });
            dismissOpacity.value = withTiming(0, { duration: 200 });
            runOnJS(onClose)();
          } else {
            // Snap back without spring bounce
            dismissTranslateY.value = withTiming(0, { duration: 150 });
            dismissOpacity.value = withTiming(1, { duration: 150 });
          }
        }
      }
      gestureDirection.value = 0;
    });

  // Double tap to zoom - use maxDuration to reduce delay before pan starts
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(200)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withSpring(1);
        savedScale.value = 1;
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        scale.value = withSpring(2.5);
        savedScale.value = 2.5;
      }
    });

  // Compose gestures - pan runs simultaneously with pinch, double tap is exclusive
  // This allows immediate pan response while still supporting double-tap zoom
  const composedGesture = Gesture.Race(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture)
  );

  // Animated styles
  const containerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: dismissOpacity.value,
    transform: [{ translateY: dismissTranslateY.value }],
  }));

  const galleryAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: galleryTranslateX.value }],
  }));

  const imageAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  if (!visible || imageArray.length === 0) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.gestureRoot}>
        <ReanimatedView style={[styles.container, containerAnimatedStyle]}>
          {/* Header with page indicator on left, close button on right */}
          <View style={styles.header}>
            {hasMultipleImages ? (
              <View style={styles.pageIndicator}>
                <Text style={styles.pageIndicatorText}>
                  {displayIndex + 1} / {imageArray.length}
                </Text>
              </View>
            ) : (
              <View />
            )}

            <View style={styles.headerActions}>
              <TouchableOpacity
                style={[styles.headerButton, saving && { opacity: 0.5 }]}
                onPress={handleSave}
                disabled={saving}
                hitSlop={8}
                accessibilityLabel="Save to library"
              >
                <IconSymbol name="square.and.arrow.down" color="#fff" size={22} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.headerButton}
                onPress={onClose}
                hitSlop={8}
                accessibilityLabel="Close"
              >
                <IconSymbol name="xmark" color="#fff" size={24} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Image gallery */}
          <GestureDetector gesture={composedGesture}>
            <ReanimatedView style={[styles.gallery, galleryAnimatedStyle]}>
              {imageArray.map((url, index) => (
                <ReanimatedView
                  key={`${url}-${index}`}
                  style={[
                    styles.imageContainer,
                    // Only apply zoom/pan transforms to current image
                    index === displayIndex ? imageAnimatedStyle : undefined,
                  ]}
                >
                  <Image
                    source={{ uri: url }}
                    style={styles.image}
                    contentFit="contain"
                  />
                </ReanimatedView>
              ))}
            </ReanimatedView>
          </GestureDetector>

          {/* Dot indicators */}
          {hasMultipleImages && (
            <View style={styles.dotsContainer}>
              {imageArray.map((_, index) => (
                <View
                  key={index}
                  style={[
                    styles.dot,
                    index === displayIndex && styles.dotActive,
                  ]}
                />
              ))}
            </View>
          )}
        </ReanimatedView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  header: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Skin.space(20),
  },
  closeButton: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: Skin.radius(20),
    padding: Skin.space(10),
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(8),
  },
  headerButton: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: Skin.radius(20),
    padding: Skin.space(10),
  },
  pageIndicator: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: Skin.radius(12),
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(6),
  },
  pageIndicatorText: {
    color: '#fff',
    fontSize: Skin.font(14),
    fontWeight: '600',
  },
  gallery: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  imageContainer: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.7,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  dotsContainer: {
    position: 'absolute',
    bottom: 50,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Skin.space(8),
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: Skin.radius(4),
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  dotActive: {
    backgroundColor: '#fff',
    width: 10,
    height: 10,
    borderRadius: Skin.radius(5),
  },
}));

export default ImageViewer;
