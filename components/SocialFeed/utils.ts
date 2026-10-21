import { Dimensions } from 'react-native';
import type { FeedFilter } from './types';

export const SCREEN_WIDTH = Dimensions.get('window').width;
export const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * LRU cache of image aspect ratios (height ÷ width) by URL, so an image seen
 * before gets its box size on first render instead of after it loads.
 * Limited to maxSize entries to prevent unbounded memory growth.
 */
class ImageDimensionCache {
  private cache = new Map<string, number>();
  private maxSize = 500;

  get(uri: string): number | undefined {
    const value = this.cache.get(uri);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(uri);
      this.cache.set(uri, value);
    }
    return value;
  }

  set(uri: string, ratio: number): void {
    // If at capacity, remove oldest entry (first in map)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(uri, ratio);
  }

  has(uri: string): boolean {
    return this.cache.has(uri);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const imageDimensionCache = new ImageDimensionCache();

/**
 * Format video duration from milliseconds to mm:ss
 */
export function formatDuration(ms?: number): string {
  if (!ms) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format timestamp as relative time (e.g., "5m", "2h", "Jan 15")
 */
export function formatTimestamp(timestamp?: number): string {
  if (!timestamp) {
    return '';
  }
  const diff = Math.max(Date.now() - timestamp, 0);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) {
    return `${Math.max(1, Math.floor(diff / 1000))}s`;
  }
  if (diff < hour) {
    return `${Math.floor(diff / minute)}m`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}h`;
  }
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format count with locale formatting
 */
export function formatCount(value?: number): string {
  if (!value) {
    return '0';
  }
  return value.toLocaleString();
}

/**
 * Derive feed filter category from cast content
 */
export function deriveFilter(cast: any, hasMedia: boolean): FeedFilter {
  if (hasMedia) {
    return 'media';
  }
  const channelTags = cast.tags?.map((tag: any) => (tag.id || tag.name || '').toLowerCase()) ?? [];
  if (channelTags.some((tag: string) => tag.includes('node'))) {
    return 'node-ops';
  }
  if (channelTags.some((tag: string) => tag.includes('event'))) {
    return 'events';
  }
  return 'all';
}
