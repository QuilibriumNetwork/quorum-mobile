// IconSymbol — temporary shim. Renders Tabler icons on all platforms via
// @tabler/icons-react-native, keeping the legacy SF Symbol call signature so
// the 121 existing call sites keep compiling unchanged.
//
// Why this exists: desktop manifests carry Tabler icon names (e.g. "users")
// that the old SF-Symbol-only mapping threw on, crashing render trees on
// mobile. This shim accepts both legacy SF names (via SF_TO_TABLER) and raw
// Tabler semantic names from desktop. Unknown names render null.
//
// Phase 2 (after mobile bumps @quilibrium/quorum-shared to 2.1.0-25+): sweep
// call sites to use the shared <Icon /> primitive with semantic names, then
// delete this file. SF_TO_TABLER below is the migration cheat-sheet.
// Plan: .agents/tasks/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md

import * as TablerIcons from '@tabler/icons-react-native';
import type { SymbolViewProps, SymbolWeight } from 'expo-symbols';
import type { ComponentType } from 'react';
import {
  Image,
  OpaqueColorValue,
  type ImageStyle,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useThemeOptional } from '@/theme';

// Accepts legacy SF Symbol names AND every semantic name in the SF_TO_TABLER
// map (Tabler-only names like 'bullhorn'/'hashtag' that aren't SF Symbols but
// are valid here because the resolver maps them at runtime). Deriving the union
// from the map's keys keeps the type and the runtime map from drifting.
export type IconSymbolName = SymbolViewProps['name'] | keyof typeof SF_TO_TABLER;

interface TablerComponentName {
  base: string;
  filled?: string;
}

const tabler = (base: string, filled?: string): TablerComponentName => ({
  base,
  filled,
});

/**
 * Map legacy SF Symbol names to Tabler component names. `filled` is used when
 * the SF name ends in `.fill` (or when we explicitly want the filled variant).
 *
 * Keep this list complete: every SF Symbol name passed to IconSymbol from
 * existing call sites must appear here. Names sent in via desktop manifests
 * (raw Tabler semantic names) don't need to be listed — they fall through to
 * the dynamic lookup at the bottom of the resolver.
 */
const SF_TO_TABLER = {
  // Status & flags
  'flag': tabler('IconFlag', 'IconFlagFilled'),
  'flag.fill': tabler('IconFlag', 'IconFlagFilled'),
  'nosign': tabler('IconBan'),
  'ellipsis': tabler('IconDots'),
  'ellipsis.vertical': tabler('IconDotsVertical'),
  'exclamationmark.circle': tabler('IconAlertCircle'),
  'exclamationmark.circle.fill': tabler('IconAlertCircle', 'IconAlertCircleFilled'),
  'exclamationmark.triangle': tabler('IconAlertTriangle'),
  'exclamationmark.triangle.fill': tabler('IconAlertTriangle', 'IconAlertTriangleFilled'),
  'checkmark.circle': tabler('IconCircleCheck'),
  'checkmark.circle.fill': tabler('IconCircleCheck', 'IconCircleCheckFilled'),
  'checkmark': tabler('IconCheck'),
  'checkmark.seal.fill': tabler('IconRosetteDiscountCheck', 'IconRosetteDiscountCheckFilled'),

  // Documents
  'doc': tabler('IconFile'),
  'doc.on.doc': tabler('IconCopy'),
  'doc.on.clipboard': tabler('IconClipboard'),
  'doc.text.fill': tabler('IconFileText', 'IconFileTextFilled'),

  // Geometry
  'circle': tabler('IconCircle', 'IconCircleFilled'),
  'paintbrush': tabler('IconBrush'),
  'square.grid.2x2': tabler('IconLayoutGrid'),
  'square.grid.2x2.fill': tabler('IconLayoutGrid'),
  'rectangle.grid.2x2': tabler('IconLayoutGrid'),
  'square.stack': tabler('IconStack2'),
  'rectangle.stack.fill': tabler('IconStack2', 'IconStack2Filled'),
  'number': tabler('IconHash'),

  // Home & navigation
  'house.fill': tabler('IconHome', 'IconHomeFilled'),
  'chevron.left': tabler('IconChevronLeft'),
  'chevron.right': tabler('IconChevronRight'),
  'chevron.up': tabler('IconChevronUp'),
  'chevron.down': tabler('IconChevronDown'),
  'chevron.left.forwardslash.chevron.right': tabler('IconCode'),
  'line.3.horizontal': tabler('IconMenu2'),
  'grip.vertical': tabler('IconGripVertical'),

  // Arrows
  'arrow.left': tabler('IconArrowLeft'),
  'arrow.up': tabler('IconArrowUp'),
  'arrow.up.right': tabler('IconArrowUpRight'),
  'arrow.down.left': tabler('IconArrowDownLeft'),
  'arrow.down.right': tabler('IconArrowDownRight'),
  'arrow.up.arrow.down': tabler('IconArrowsUpDown'),
  'arrow.up.circle.fill': tabler('IconCircleArrowUp', 'IconCircleArrowUpFilled'),
  'arrow.down.circle.fill': tabler('IconCircleArrowDown', 'IconCircleArrowDownFilled'),
  'arrow.right.circle.fill': tabler('IconCircleArrowRight', 'IconCircleArrowRightFilled'),
  'arrow.left.circle.fill': tabler('IconCircleArrowLeft', 'IconCircleArrowLeftFilled'),
  'arrow.2.squarepath': tabler('IconArrowsExchange'),
  'arrow.2.circlepath': tabler('IconRefresh'),
  'arrow.triangle.2.circlepath': tabler('IconRepeat'),
  'arrow.clockwise': tabler('IconRefresh'),
  'arrow.counterclockwise': tabler('IconArrowBackUp'),
  'arrow.right.arrow.left': tabler('IconArrowsExchange'),
  'arrow.up.right.square': tabler('IconExternalLink'),
  'arrowshape.turn.up.left': tabler('IconArrowBackUp'),
  'arrowshape.turn.up.left.fill': tabler('IconArrowBackUp', 'IconArrowBackUpFilled'),
  'arrowshape.turn.up.right': tabler('IconArrowForwardUp'),
  'arrowshape.turn.up.right.fill': tabler('IconArrowForwardUp', 'IconArrowForwardUpFilled'),

  // Send / send-arrow
  'paperplane': tabler('IconSend'),
  'paperplane.fill': tabler('IconSend', 'IconSendFilled'),

  // Wallet & money
  'wallet.bifold.fill': tabler('IconWallet'),
  'wallet.pass': tabler('IconWallet'),
  'wallet.pass.fill': tabler('IconWallet'),
  'banknote.fill': tabler('IconCash'),
  'creditcard': tabler('IconCreditCard'),
  'creditcard.fill': tabler('IconCreditCard', 'IconCreditCardFilled'),
  'bitcoinsign.circle': tabler('IconCurrencyBitcoin'),
  'centsign.circle.fill': tabler('IconCurrencyDollar'),

  // Security
  'lock.fill': tabler('IconLock', 'IconLockFilled'),
  'lock.shield.fill': tabler('IconShieldLock', 'IconShieldLockFilled'),
  'shield': tabler('IconShield', 'IconShieldFilled'),
  'shield.fill': tabler('IconShield', 'IconShieldFilled'),
  'shield.checkered': tabler('IconShieldCheck'),
  'exclamationmark.shield.fill': tabler('IconShieldX', 'IconShieldXFilled'),
  'shield.lefthalf.filled.trianglebadge.exclamationmark': tabler('IconShieldX'),
  'key.fill': tabler('IconKey'),
  'faceid': tabler('IconFaceId'),

  // Add / remove
  'plus': tabler('IconPlus'),
  'keyboard': tabler('IconKeyboard'),
  'minus': tabler('IconMinus'),
  'plus.circle': tabler('IconCirclePlus'),
  'plus.circle.fill': tabler('IconCirclePlus', 'IconCirclePlusFilled'),
  'minus.circle': tabler('IconCircleMinus'),
  'xmark': tabler('IconX'),
  'xmark.circle': tabler('IconCircleX'),
  'xmark.circle.fill': tabler('IconCircleX', 'IconCircleXFilled'),

  // Globe / web
  'globe': tabler('IconWorld'),
  'safari': tabler('IconCompass'),
  'safari.fill': tabler('IconCompass', 'IconCompassFilled'),

  // People
  'person': tabler('IconUser'),
  'person.fill': tabler('IconUser', 'IconUserFilled'),
  'person.2': tabler('IconUsers'),
  'person.2.fill': tabler('IconUsers'),
  'person.3': tabler('IconUsersGroup'),
  'person.3.fill': tabler('IconUsersGroup'),
  'person.badge.plus': tabler('IconUserPlus'),
  'person.crop.circle': tabler('IconUserCircle'),
  'person.crop.circle.fill': tabler('IconUserCircle', 'IconUserCircleFilled'),
  'person.crop.circle.badge.exclamationmark': tabler('IconUserExclamation'),
  'person.badge.shield.checkmark.fill': tabler('IconShieldCheck', 'IconShieldCheckFilled'),
  'hand.raised.fill': tabler('IconHandStop'),
  'hand.thumbsup.fill': tabler('IconThumbUp', 'IconThumbUpFilled'),
  'hand.thumbsdown.fill': tabler('IconThumbDown', 'IconThumbDownFilled'),

  // Eye
  'eye': tabler('IconEye', 'IconEyeFilled'),
  'eye.fill': tabler('IconEye', 'IconEyeFilled'),
  'eye.slash': tabler('IconEyeOff'),
  'eye.slash.fill': tabler('IconEyeOff'),

  // Hardware / signals
  'bolt.fill': tabler('IconBolt', 'IconBoltFilled'),
  'server.rack': tabler('IconServer'),
  'wifi.slash': tabler('IconWifiOff'),
  'dot.radiowaves.up.forward': tabler('IconBroadcast'),
  'iphone': tabler('IconDeviceMobile'),
  'desktopcomputer': tabler('IconDeviceDesktop'),
  'qrcode': tabler('IconQrcode'),
  'qrcode.viewfinder': tabler('IconScan'),

  // Info
  'info.circle': tabler('IconInfoCircle'),
  'info.circle.fill': tabler('IconInfoCircle', 'IconInfoCircleFilled'),
  'questionmark': tabler('IconQuestionMark'),

  // Camera / image
  'camera': tabler('IconCamera', 'IconCameraFilled'),
  'camera.fill': tabler('IconCamera', 'IconCameraFilled'),
  'camera.rotate': tabler('IconCameraRotate'),
  'photo': tabler('IconPhoto'),
  'photo.fill': tabler('IconPhoto', 'IconPhotoFilled'),
  'photo.on.rectangle.angled': tabler('IconPhoto'),

  // Audio
  'mic': tabler('IconMicrophone'),
  'mic.fill': tabler('IconMicrophone', 'IconMicrophoneFilled'),
  'mic.slash': tabler('IconMicrophoneOff'),
  'mic.slash.fill': tabler('IconMicrophoneOff'),
  'headphones': tabler('IconHeadphones'),
  'speaker.wave.1.fill': tabler('IconVolume', 'IconVolumeFilled'),
  'speaker.wave.2': tabler('IconVolume'),
  'speaker.wave.2.fill': tabler('IconVolume', 'IconVolumeFilled'),
  'waveform.path.ecg': tabler('IconChartLine'),

  // Settings
  'gearshape': tabler('IconSettings'),
  'gearshape.fill': tabler('IconSettings', 'IconSettingsFilled'),

  // Building / share
  'building.columns': tabler('IconBuildingBank'),
  'storefront.fill': tabler('IconBuildingStore', 'IconBuildingStoreFilled'),
  'square.and.arrow.up': tabler('IconShare'),
  'square.and.arrow.down': tabler('IconDownload'),

  // Conversation
  'bubble.left': tabler('IconMessage'),
  'bubble.left.fill': tabler('IconMessage', 'IconMessageFilled'),
  'bubble.left.and.bubble.right': tabler('IconMessages'),
  'bubble.left.and.bubble.right.fill': tabler('IconMessages'),
  'face.smiling': tabler('IconMoodSmile'),
  'quote.bubble': tabler('IconQuote'),
  'text.bubble': tabler('IconMessage'),
  'message': tabler('IconMessage', 'IconMessageFilled'),
  'message.fill': tabler('IconMessage', 'IconMessageFilled'),
  'magnifyingglass': tabler('IconSearch'),
  'paperclip': tabler('IconPaperclip'),
  'at': tabler('IconAt'),
  'envelope.fill': tabler('IconMail', 'IconMailFilled'),
  'envelope.open': tabler('IconMailOpened'),

  // Calls
  'phone': tabler('IconPhone', 'IconPhoneFilled'),
  'phone.fill': tabler('IconPhone', 'IconPhoneFilled'),
  'phone.down': tabler('IconPhoneOff'),
  'phone.down.fill': tabler('IconPhoneOff'),
  'video': tabler('IconVideo', 'IconVideoFilled'),
  'video.fill': tabler('IconVideo', 'IconVideoFilled'),
  'video.slash.fill': tabler('IconVideoOff'),

  // Edit
  'square.and.pencil': tabler('IconEdit'),
  'pencil': tabler('IconPencil'),
  'hammer': tabler('IconHammer'),
  'hammer.fill': tabler('IconHammer'),

  // Hearts / likes
  'heart': tabler('IconHeart', 'IconHeartFilled'),
  'heart.fill': tabler('IconHeart', 'IconHeartFilled'),

  // Player
  'play.fill': tabler('IconPlayerPlay', 'IconPlayerPlayFilled'),
  'play.circle.fill': tabler('IconPlayerPlay', 'IconPlayerPlayFilled'),
  'play.rectangle.fill': tabler('IconVideo', 'IconVideoFilled'),
  'pause.fill': tabler('IconPlayerPause', 'IconPlayerPauseFilled'),

  // Markers / locations
  'mappin': tabler('IconMapPin', 'IconMapPinFilled'),
  'crown.fill': tabler('IconCrown', 'IconCrownFilled'),
  'star': tabler('IconStar', 'IconStarFilled'),
  'star.fill': tabler('IconStar', 'IconStarFilled'),
  'star.square': tabler('IconStar'),
  'sparkles': tabler('IconSparkles', 'IconSparklesFilled'),
  'trash': tabler('IconTrash'),
  'trash.fill': tabler('IconTrash', 'IconTrashFilled'),

  // Links
  'link': tabler('IconLink'),
  'link.badge.plus': tabler('IconLinkPlus'),

  // Pins
  'pin': tabler('IconPin', 'IconPinFilled'),
  'pin.fill': tabler('IconPin', 'IconPinFilled'),
  'pin.slash': tabler('IconPinnedOff'),

  // Bookmarks
  'bookmark': tabler('IconBookmark', 'IconBookmarkFilled'),
  'bookmark.fill': tabler('IconBookmark', 'IconBookmarkFilled'),
  'bookmark.slash': tabler('IconBookmarkOff'),
  'bookmark.slash.fill': tabler('IconBookmarkOff'),

  // Notifications
  'bell': tabler('IconBell', 'IconBellFilled'),
  'bell.fill': tabler('IconBell', 'IconBellFilled'),
  'bell.slash': tabler('IconBellOff'),
  'bell.slash.fill': tabler('IconBellOff'),

  // History / time
  'clock': tabler('IconClock', 'IconClockFilled'),
  'clock.arrow.circlepath': tabler('IconHistory'),

  // Tags
  'tag.fill': tabler('IconTag', 'IconTagFilled'),
  'tag.slash': tabler('IconTagOff'),

  // Charts
  'chart.bar.fill': tabler('IconChartBar', 'IconChartBarFilled'),
  'chart.xyaxis.line': tabler('IconChartLine'),

  // Awards / rewards
  'trophy.fill': tabler('IconTrophy', 'IconTrophyFilled'),
  'flame.fill': tabler('IconFlame', 'IconFlameFilled'),
  'gift.fill': tabler('IconGift', 'IconGiftFilled'),
  'ticket.fill': tabler('IconTicket', 'IconTicketFilled'),

  // Window controls
  'arrow.down.right.and.arrow.up.left': tabler('IconMinimize'),
  'arrow.up.left.and.arrow.down.right': tabler('IconMaximize'),

  // Shared icon-picker vocabulary (semantic Tabler names whose PascalCase form
  // doesn't match Tabler's actual export, so they need explicit mapping).
  'bullhorn': tabler('IconSpeakerphone'),
  'hashtag': tabler('IconHash'),
  'hand-peace': tabler('IconHandTwoFingers'),
  'smile': tabler('IconMoodSmile', 'IconMoodSmileFilled'),
  'party': tabler('IconConfetti', 'IconConfettiFilled'),
  'envelope': tabler('IconMail', 'IconMailFilled'),
  'image': tabler('IconPhoto', 'IconPhotoFilled'),
  'dollar-sign': tabler('IconCurrencyDollar'),
  'utensils': tabler('IconToolsKitchen2'),
  'fire': tabler('IconFlame', 'IconFlameFilled'),
  'gamepad': tabler('IconDeviceGamepad'),
  'question-circle': tabler('IconHelpCircle', 'IconHelpCircleFilled'),
  'check-circle': tabler('IconCircleCheck', 'IconCircleCheckFilled'),
  'warning': tabler('IconAlertTriangle', 'IconAlertTriangleFilled'),
  'support': tabler('IconLifebuoy'),
  'calendar-alt': tabler('IconCalendar', 'IconCalendarFilled'),
  'desktop': tabler('IconDeviceDesktop', 'IconDeviceDesktopFilled'),
  // 'certificate' maps to Rosette (matches shared iconMapping); IconCertificate has no filled form.
  'certificate': tabler('IconRosetteDiscountCheck', 'IconRosetteDiscountCheckFilled'),
} satisfies Record<string, TablerComponentName>;

/**
 * Resolve a name to a Tabler component. Tries (in order):
 *   1. The SF_TO_TABLER table — covers all legacy SF Symbol names.
 *   2. If `name` looks like a kebab-case semantic name ("users", "bell-off"),
 *      PascalCase + "Icon" prefix and look up directly in TablerIcons.
 *   3. If `name` is already a PascalCase Tabler component name, try it as-is.
 *
 * Returns null if nothing matches — caller fails soft.
 */
function pascalCase(s: string): string {
  return s
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const warnedNames = new Set<string>();

function resolveTablerComponent(name: string, wantFilled: boolean): ComponentType<any> | null {
  const lib = TablerIcons as unknown as Record<string, ComponentType<any>>;

  // 1. Legacy SF Symbol lookup. The map's value type is uniform, so a keyed
  //    cast is safe — a miss returns undefined and falls through to step 2.
  const entry = (SF_TO_TABLER as Record<string, TablerComponentName>)[name];
  if (entry) {
    if (wantFilled && entry.filled && lib[entry.filled]) {
      return lib[entry.filled];
    }
    return lib[entry.base] ?? null;
  }

  // 2. Semantic kebab name (e.g. "users", "bell-off") sent from desktop manifests
  const pascal = `Icon${pascalCase(name)}`;
  if (lib[pascal]) {
    if (wantFilled && lib[`${pascal}Filled`]) return lib[`${pascal}Filled`];
    return lib[pascal];
  }

  // 3. Already-PascalCase Tabler component name
  if (lib[name]) return lib[name];

  return null;
}

/**
 * Cross-platform icon component.
 *
 * Legacy signature preserved so existing call sites compile unchanged.
 * Renders Tabler icons on all platforms via @tabler/icons-react-native.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  variant,
  strokeWidth,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
  variant?: 'outline' | 'filled';
  /** Outline-icon line thickness (Tabler `strokeWidth`, default 2). Lower =
   *  thinner. Ignored by filled variants and skin PNG substitutions. */
  strokeWidth?: number;
}) {
  // Skin icon substitution: when the active skin overrides this glyph, render
  // its (validated PNG/JPEG) image. `tint` (default true) renders it as a
  // template tinted by the requested color; false renders it full-color.
  const skinIcon = useThemeOptional()?.activeSkin?.icons?.[name];
  if (skinIcon) {
    return (
      <Image
        source={{ uri: skinIcon.image }}
        style={[
          { width: size, height: size },
          skinIcon.tint === false ? null : { tintColor: color as string },
          style as unknown as StyleProp<ImageStyle>,
        ]}
        resizeMode="contain"
      />
    );
  }

  const nameStr = String(name);
  const wantFilled = variant === 'filled' || nameStr.endsWith('.fill');
  const Component = resolveTablerComponent(nameStr, wantFilled);

  if (!Component) {
    if (__DEV__ && !warnedNames.has(nameStr)) {
      warnedNames.add(nameStr);
      console.warn(`IconSymbol: no Tabler mapping for "${nameStr}", rendering nothing.`);
    }
    return null;
  }

  return (
    <Component
      color={color as string}
      size={size}
      // Tabler RN uses `strokeWidth` for line thickness (the `stroke` prop is the
      // COLOR — passing a number there triggers "not a valid color or brush" and
      // the icon renders invisible). Only forward when set, so unspecified icons
      // keep Tabler's default width (2).
      {...(strokeWidth !== undefined ? { strokeWidth } : null)}
      style={style}
    />
  );
}
