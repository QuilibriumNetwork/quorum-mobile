// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SymbolViewProps, SymbolWeight } from 'expo-symbols';
import { ComponentProps } from 'react';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

type IconMapping = Record<SymbolViewProps['name'], ComponentProps<typeof MaterialIcons>['name']>;
export type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
const MAPPING = {
  'flag': 'flag',
  'flag.fill': 'flag',
  'house.fill': 'home',
  'paperplane': 'send',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'chevron.left': 'chevron-left',
  'chevron.up': 'expand-less',
  'chevron.down': 'expand-more',
  'wallet.bifold.fill': 'wallet',
  'bitcoinsign.circle': 'monetization-on',
  // Onboarding icons
  'lock.shield.fill': 'security',
  'shield.checkered': 'verified-user',
  'globe': 'public',
  'hand.raised.fill': 'pan-tool',
  'key.fill': 'vpn-key',
  'plus.circle.fill': 'add-circle',
  'rectangle.grid.2x2': 'apps',
  'number': 'numbers',
  'exclamationmark.circle.fill': 'error',
  'exclamationmark.circle': 'error-outline',
  'eye.fill': 'visibility',
  'eye': 'visibility',
  'eye.slash.fill': 'visibility-off',
  'eye.slash': 'visibility-off',
  'doc.on.doc': 'content-copy',
  'exclamationmark.triangle.fill': 'warning',
  'exclamationmark.triangle': 'warning',
  'checkmark.circle.fill': 'check-circle',
  'checkmark': 'check',
  'person.fill': 'person',
  'person.2.fill': 'group',
  'bolt.fill': 'flash-on',
  'server.rack': 'storage',
  'doc.on.clipboard': 'content-paste',
  'info.circle': 'info',
  'info.circle.fill': 'info',
  'camera.fill': 'photo-camera',
  'photo': 'photo-library',
  'camera': 'camera-alt',
  // UserPanel icons
  'waveform.path.ecg': 'graphic-eq',
  'square.grid.2x2': 'grid-view',
  'square.stack': 'collections',
  'banknote.fill': 'account-balance-wallet',
  'mic': 'mic',
  'mic.fill': 'mic',
  'headphones': 'headset',
  'gearshape.fill': 'settings',
  'gearshape': 'settings',
  // Chat icons
  'xmark.circle.fill': 'cancel',
  'xmark': 'close',
  'line.3.horizontal': 'menu',
  'arrow.left': 'arrow-back',
  'plus': 'add',
  'face.smiling': 'emoji-emotions',
  'photo.fill': 'image',
  // Browser icons
  'arrow.clockwise': 'refresh',
  'exclamationmark.shield.fill': 'gpp-maybe',
  'square.and.arrow.up': 'share',
  'square.and.arrow.down': 'save-alt',
  'safari': 'open-in-browser',
  // Communication icons
  'bubble.left.and.bubble.right': 'forum',
  'bubble.left.and.bubble.right.fill': 'forum',
  'bubble.left': 'chat-bubble-outline',
  'phone': 'phone',
  'phone.fill': 'phone',
  'video': 'videocam',
  'video.fill': 'videocam',
  'video.slash.fill': 'videocam-off',
  'square.and.pencil': 'edit',
  'magnifyingglass': 'search',
  'paperclip': 'attach-file',
  'at': 'alternate-email',
  'heart.fill': 'favorite',
  // Wallet icons
  'arrow.up.circle.fill': 'arrow-circle-up',
  'arrow.down.circle.fill': 'arrow-circle-down',
  'arrow.2.squarepath': 'swap-horiz',
  'arrow.2.circlepath': 'sync',
  // Media icons
  'play.fill': 'play-arrow',
  'pause.fill': 'pause',
  // Social/Profile icons
  'star.fill': 'star',
  'mappin': 'place',
  'crown.fill': 'workspace-premium',
  'pencil': 'edit',
  'shield.fill': 'shield',
  'doc.text.fill': 'description',
  'trash.fill': 'delete',
  'arrow.counterclockwise': 'restore',
  // Status icons
  'wifi.slash': 'wifi-off',
  // Additional icons
  'arrow.right.circle.fill': 'arrow-circle-right',
  'link': 'link',
  'link.badge.plus': 'add-link',
  'person.2': 'group',
  'person.3': 'groups',
  'person.3.fill': 'groups',
  'person.badge.plus': 'person-add',
  'play.circle.fill': 'play-circle-filled',
  'questionmark': 'help-outline',
  'shield': 'shield',
  'shield.lefthalf.filled.trianglebadge.exclamationmark': 'gpp-bad',
  'star': 'star-outline',
  'trash': 'delete-outline',
  'sparkles': 'auto-awesome',
  // Additional missing icons
  'arrow.up': 'arrow-upward',
  'arrow.up.right': 'north-east',
  'arrow.triangle.2.circlepath': 'repeat',
  'bubble.left.fill': 'chat-bubble',
  'heart': 'favorite-border',
  'qrcode.viewfinder': 'qr-code-scanner',
  'person.crop.circle.badge.exclamationmark': 'person-off',
  // Reply icon used in MessageActionSheet
  'arrowshape.turn.up.left.fill': 'reply',
  // Recast/share icons used in Farcaster feed
  'arrowshape.turn.up.right': 'repeat',
  'arrowshape.turn.up.right.fill': 'repeat',
  'arrowshape.turn.up.left': 'reply',
  // Username/QNS icons
  'ticket.fill': 'confirmation-number',
  'checkmark.seal.fill': 'verified',
  'hand.thumbsup.fill': 'thumb-up',
  'hand.thumbsdown.fill': 'thumb-down',
  'person.badge.shield.checkmark.fill': 'verified-user',
  // Device icons
  'iphone': 'smartphone',
  'desktopcomputer': 'computer',
  // Wallet transaction icons
  'arrow.down.left': 'south-west',
  'creditcard.fill': 'credit-card',
  'wallet.pass': 'account-balance-wallet',
  'wallet.pass.fill': 'account-balance-wallet',
  'photo.on.rectangle.angled': 'collections',
  'clock.arrow.circlepath': 'history',
  'arrow.up.arrow.down': 'swap-vert',
  'plus.circle': 'add-circle-outline',
  // Marketplace icons
  'tag.fill': 'sell',
  'rectangle.stack.fill': 'layers',
  'play.rectangle.fill': 'slideshow',
  'quote.bubble': 'format-quote',
  'lock.fill': 'lock',
  'person': 'person-outline',
  'chart.xyaxis.line': 'show-chart',
  'chart.bar.fill': 'bar-chart',
  'arrow.up.right.square': 'open-in-new',
  // Pin icons
  'pin.fill': 'push-pin',
  'pin': 'push-pin',
  'pin.slash': 'push-pin',
  // Bookmark icons
  'bookmark': 'bookmark-border',
  'bookmark.fill': 'bookmark',
  'bookmark.slash.fill': 'bookmark-border',
  'bookmark.slash': 'bookmark-border',
  // Notification/mute icons
  'bell': 'notifications-none',
  'bell.slash.fill': 'notifications-off',
  'bell.fill': 'notifications',
  // More icons for new features
  'checkmark.circle': 'check-circle-outline',
  'text.bubble': 'textsms',
  'star.square': 'stars',
  'arrow.left.circle.fill': 'arrow-back',
  'xmark.circle': 'cancel',
  // Call screen icons
  'mic.slash': 'mic-off',
  'mic.slash.fill': 'mic-off',
  'speaker.wave.1.fill': 'volume-down',
  'speaker.wave.2': 'volume-up',
  'speaker.wave.2.fill': 'volume-up',
  'phone.down': 'call-end',
  'phone.down.fill': 'call-end',
  'camera.rotate': 'flip-camera-android',
  'arrow.down.right.and.arrow.up.left': 'close-fullscreen',
  'arrow.up.left.and.arrow.down.right': 'open-in-full',
  'arrow.right.arrow.left': 'compare-arrows',
  'clock': 'schedule',
  'dot.radiowaves.up.forward': 'cell-tower',
  'envelope.fill': 'email',
  'envelope.open': 'drafts',
  'faceid': 'face',
  'hammer': 'build',
  'hammer.fill': 'build',
  'message': 'chat',
  'message.fill': 'chat',
  'qrcode': 'qr-code',
  'storefront.fill': 'storefront',
  'tag.slash': 'label-off',
  'creditcard': 'credit-card',
  'person.crop.circle': 'account-circle',
  'person.crop.circle.fill': 'account-circle',
  'safari.fill': 'explore',
  'square.grid.2x2.fill': 'grid-view',
  // Snap embed icons
  'trophy.fill': 'emoji-events',
  'flame.fill': 'local-fire-department',
  'gift.fill': 'card-giftcard',
  'centsign.circle.fill': 'monetization-on',
  'minus': 'remove',
  'arrow.down.right': 'south-east',
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  const mappedName = MAPPING[name];
  if (!mappedName) {
    throw new Error(`IconSymbol: No Android/Material icon mapping for SF Symbol "${name}". Add it to MAPPING in IconSymbol.tsx`);
  }
  return <MaterialIcons color={color} size={size} name={mappedName} style={style} />;
}
