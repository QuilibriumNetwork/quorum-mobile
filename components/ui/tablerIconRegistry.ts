/**
 * tablerIconRegistry — GENERATED. Do not edit by hand.
 *
 * Explicit deep-imports of ONLY the Tabler icons the app can render. Built from
 * TWO sources (see scripts/gen-tabler-registry.mjs):
 *   1. every IconXxx token referenced in components/ui/IconSymbol.tsx, and
 *   2. the shared channel-icon-picker vocabulary (ICON_OPTIONS + FILLED_ICONS),
 *      resolved through IconSymbol's runtime logic so picker cells never blank.
 *
 * IconSymbol previously imported the whole @tabler/icons-react-native barrel
 * (~6000 icons), which Metro can't tree-shake in dev — every route bundled
 * ~14k modules and OOM-crashed the dev server. This keeps the graph small.
 *
 * Regenerate after changing IconSymbol's map OR when the shared picker
 * vocabulary grows:
 *   node scripts/gen-tabler-registry.mjs   (npm run gen:icons)
 *
 * Names not listed here resolve to null in IconSymbol (its documented
 * "unknown names render null" behavior).
 */

import IconAi from '@tabler/icons-react-native/IconAi';
import IconAlertCircle from '@tabler/icons-react-native/IconAlertCircle';
import IconAlertCircleFilled from '@tabler/icons-react-native/IconAlertCircleFilled';
import IconAlertTriangle from '@tabler/icons-react-native/IconAlertTriangle';
import IconAlertTriangleFilled from '@tabler/icons-react-native/IconAlertTriangleFilled';
import IconArrowBackUp from '@tabler/icons-react-native/IconArrowBackUp';
import IconArrowDownLeft from '@tabler/icons-react-native/IconArrowDownLeft';
import IconArrowDownRight from '@tabler/icons-react-native/IconArrowDownRight';
import IconArrowForwardUp from '@tabler/icons-react-native/IconArrowForwardUp';
import IconArrowLeft from '@tabler/icons-react-native/IconArrowLeft';
import IconArrowUp from '@tabler/icons-react-native/IconArrowUp';
import IconArrowUpRight from '@tabler/icons-react-native/IconArrowUpRight';
import IconArrowsExchange from '@tabler/icons-react-native/IconArrowsExchange';
import IconArrowsUpDown from '@tabler/icons-react-native/IconArrowsUpDown';
import IconAt from '@tabler/icons-react-native/IconAt';
import IconBadge from '@tabler/icons-react-native/IconBadge';
import IconBadgeFilled from '@tabler/icons-react-native/IconBadgeFilled';
import IconBan from '@tabler/icons-react-native/IconBan';
import IconBell from '@tabler/icons-react-native/IconBell';
import IconBellFilled from '@tabler/icons-react-native/IconBellFilled';
import IconBellOff from '@tabler/icons-react-native/IconBellOff';
import IconBolt from '@tabler/icons-react-native/IconBolt';
import IconBoltFilled from '@tabler/icons-react-native/IconBoltFilled';
import IconBook from '@tabler/icons-react-native/IconBook';
import IconBookFilled from '@tabler/icons-react-native/IconBookFilled';
import IconBookmark from '@tabler/icons-react-native/IconBookmark';
import IconBookmarkFilled from '@tabler/icons-react-native/IconBookmarkFilled';
import IconBookmarkOff from '@tabler/icons-react-native/IconBookmarkOff';
import IconBriefcase from '@tabler/icons-react-native/IconBriefcase';
import IconBriefcaseFilled from '@tabler/icons-react-native/IconBriefcaseFilled';
import IconBroadcast from '@tabler/icons-react-native/IconBroadcast';
import IconBrush from '@tabler/icons-react-native/IconBrush';
import IconBug from '@tabler/icons-react-native/IconBug';
import IconBugFilled from '@tabler/icons-react-native/IconBugFilled';
import IconBuildingBank from '@tabler/icons-react-native/IconBuildingBank';
import IconBuildingStore from '@tabler/icons-react-native/IconBuildingStore';
import IconCalendar from '@tabler/icons-react-native/IconCalendar';
import IconCalendarFilled from '@tabler/icons-react-native/IconCalendarFilled';
import IconCamera from '@tabler/icons-react-native/IconCamera';
import IconCameraFilled from '@tabler/icons-react-native/IconCameraFilled';
import IconCameraRotate from '@tabler/icons-react-native/IconCameraRotate';
import IconCash from '@tabler/icons-react-native/IconCash';
import IconCertificate from '@tabler/icons-react-native/IconCertificate';
import IconChartBar from '@tabler/icons-react-native/IconChartBar';
import IconChartLine from '@tabler/icons-react-native/IconChartLine';
import IconCheck from '@tabler/icons-react-native/IconCheck';
import IconChevronDown from '@tabler/icons-react-native/IconChevronDown';
import IconChevronLeft from '@tabler/icons-react-native/IconChevronLeft';
import IconChevronRight from '@tabler/icons-react-native/IconChevronRight';
import IconChevronUp from '@tabler/icons-react-native/IconChevronUp';
import IconCircle from '@tabler/icons-react-native/IconCircle';
import IconCircleArrowDown from '@tabler/icons-react-native/IconCircleArrowDown';
import IconCircleArrowDownFilled from '@tabler/icons-react-native/IconCircleArrowDownFilled';
import IconCircleArrowLeft from '@tabler/icons-react-native/IconCircleArrowLeft';
import IconCircleArrowLeftFilled from '@tabler/icons-react-native/IconCircleArrowLeftFilled';
import IconCircleArrowRight from '@tabler/icons-react-native/IconCircleArrowRight';
import IconCircleArrowRightFilled from '@tabler/icons-react-native/IconCircleArrowRightFilled';
import IconCircleArrowUp from '@tabler/icons-react-native/IconCircleArrowUp';
import IconCircleArrowUpFilled from '@tabler/icons-react-native/IconCircleArrowUpFilled';
import IconCircleCheck from '@tabler/icons-react-native/IconCircleCheck';
import IconCircleCheckFilled from '@tabler/icons-react-native/IconCircleCheckFilled';
import IconCircleFilled from '@tabler/icons-react-native/IconCircleFilled';
import IconCircleMinus from '@tabler/icons-react-native/IconCircleMinus';
import IconCirclePlus from '@tabler/icons-react-native/IconCirclePlus';
import IconCirclePlusFilled from '@tabler/icons-react-native/IconCirclePlusFilled';
import IconCircleX from '@tabler/icons-react-native/IconCircleX';
import IconCircleXFilled from '@tabler/icons-react-native/IconCircleXFilled';
import IconClipboard from '@tabler/icons-react-native/IconClipboard';
import IconClock from '@tabler/icons-react-native/IconClock';
import IconClockFilled from '@tabler/icons-react-native/IconClockFilled';
import IconCode from '@tabler/icons-react-native/IconCode';
import IconCompass from '@tabler/icons-react-native/IconCompass';
import IconCompassFilled from '@tabler/icons-react-native/IconCompassFilled';
import IconConfetti from '@tabler/icons-react-native/IconConfetti';
import IconConfettiFilled from '@tabler/icons-react-native/IconConfettiFilled';
import IconCopy from '@tabler/icons-react-native/IconCopy';
import IconCreditCard from '@tabler/icons-react-native/IconCreditCard';
import IconCreditCardFilled from '@tabler/icons-react-native/IconCreditCardFilled';
import IconCrown from '@tabler/icons-react-native/IconCrown';
import IconCrownFilled from '@tabler/icons-react-native/IconCrownFilled';
import IconCurrencyBitcoin from '@tabler/icons-react-native/IconCurrencyBitcoin';
import IconCurrencyDollar from '@tabler/icons-react-native/IconCurrencyDollar';
import IconDeviceDesktop from '@tabler/icons-react-native/IconDeviceDesktop';
import IconDeviceDesktopFilled from '@tabler/icons-react-native/IconDeviceDesktopFilled';
import IconDeviceFloppy from '@tabler/icons-react-native/IconDeviceFloppy';
import IconDeviceFloppyFilled from '@tabler/icons-react-native/IconDeviceFloppyFilled';
import IconDeviceGamepad from '@tabler/icons-react-native/IconDeviceGamepad';
import IconDeviceMobile from '@tabler/icons-react-native/IconDeviceMobile';
import IconDots from '@tabler/icons-react-native/IconDots';
import IconDotsVertical from '@tabler/icons-react-native/IconDotsVertical';
import IconDownload from '@tabler/icons-react-native/IconDownload';
import IconEdit from '@tabler/icons-react-native/IconEdit';
import IconExternalLink from '@tabler/icons-react-native/IconExternalLink';
import IconEye from '@tabler/icons-react-native/IconEye';
import IconEyeFilled from '@tabler/icons-react-native/IconEyeFilled';
import IconEyeOff from '@tabler/icons-react-native/IconEyeOff';
import IconFaceId from '@tabler/icons-react-native/IconFaceId';
import IconFeather from '@tabler/icons-react-native/IconFeather';
import IconFile from '@tabler/icons-react-native/IconFile';
import IconFileCode from '@tabler/icons-react-native/IconFileCode';
import IconFileCodeFilled from '@tabler/icons-react-native/IconFileCodeFilled';
import IconFileFilled from '@tabler/icons-react-native/IconFileFilled';
import IconFileText from '@tabler/icons-react-native/IconFileText';
import IconFileTextFilled from '@tabler/icons-react-native/IconFileTextFilled';
import IconFlag from '@tabler/icons-react-native/IconFlag';
import IconFlagFilled from '@tabler/icons-react-native/IconFlagFilled';
import IconFlame from '@tabler/icons-react-native/IconFlame';
import IconFlameFilled from '@tabler/icons-react-native/IconFlameFilled';
import IconFlask from '@tabler/icons-react-native/IconFlask';
import IconFlaskFilled from '@tabler/icons-react-native/IconFlaskFilled';
import IconFolder from '@tabler/icons-react-native/IconFolder';
import IconFolderFilled from '@tabler/icons-react-native/IconFolderFilled';
import IconGift from '@tabler/icons-react-native/IconGift';
import IconGiftFilled from '@tabler/icons-react-native/IconGiftFilled';
import IconGripVertical from '@tabler/icons-react-native/IconGripVertical';
import IconHammer from '@tabler/icons-react-native/IconHammer';
import IconHandStop from '@tabler/icons-react-native/IconHandStop';
import IconHandTwoFingers from '@tabler/icons-react-native/IconHandTwoFingers';
import IconHash from '@tabler/icons-react-native/IconHash';
import IconHeadphones from '@tabler/icons-react-native/IconHeadphones';
import IconHeadset from '@tabler/icons-react-native/IconHeadset';
import IconHeadsetFilled from '@tabler/icons-react-native/IconHeadsetFilled';
import IconHeart from '@tabler/icons-react-native/IconHeart';
import IconHeartFilled from '@tabler/icons-react-native/IconHeartFilled';
import IconHelpCircle from '@tabler/icons-react-native/IconHelpCircle';
import IconHelpCircleFilled from '@tabler/icons-react-native/IconHelpCircleFilled';
import IconHistory from '@tabler/icons-react-native/IconHistory';
import IconHome from '@tabler/icons-react-native/IconHome';
import IconHomeFilled from '@tabler/icons-react-native/IconHomeFilled';
import IconInfoCircle from '@tabler/icons-react-native/IconInfoCircle';
import IconInfoCircleFilled from '@tabler/icons-react-native/IconInfoCircleFilled';
import IconKey from '@tabler/icons-react-native/IconKey';
import IconKeyFilled from '@tabler/icons-react-native/IconKeyFilled';
import IconKeyboard from '@tabler/icons-react-native/IconKeyboard';
import IconLayoutGrid from '@tabler/icons-react-native/IconLayoutGrid';
import IconLeaf from '@tabler/icons-react-native/IconLeaf';
import IconLifebuoy from '@tabler/icons-react-native/IconLifebuoy';
import IconLink from '@tabler/icons-react-native/IconLink';
import IconLinkPlus from '@tabler/icons-react-native/IconLinkPlus';
import IconLock from '@tabler/icons-react-native/IconLock';
import IconLockFilled from '@tabler/icons-react-native/IconLockFilled';
import IconMail from '@tabler/icons-react-native/IconMail';
import IconMailFilled from '@tabler/icons-react-native/IconMailFilled';
import IconMailOpened from '@tabler/icons-react-native/IconMailOpened';
import IconMapPin from '@tabler/icons-react-native/IconMapPin';
import IconMapPinFilled from '@tabler/icons-react-native/IconMapPinFilled';
import IconMaximize from '@tabler/icons-react-native/IconMaximize';
import IconMenu2 from '@tabler/icons-react-native/IconMenu2';
import IconMessage from '@tabler/icons-react-native/IconMessage';
import IconMessageFilled from '@tabler/icons-react-native/IconMessageFilled';
import IconMessages from '@tabler/icons-react-native/IconMessages';
import IconMessagesFilled from '@tabler/icons-react-native/IconMessagesFilled';
import IconMicrophone from '@tabler/icons-react-native/IconMicrophone';
import IconMicrophoneFilled from '@tabler/icons-react-native/IconMicrophoneFilled';
import IconMicrophoneOff from '@tabler/icons-react-native/IconMicrophoneOff';
import IconMinimize from '@tabler/icons-react-native/IconMinimize';
import IconMinus from '@tabler/icons-react-native/IconMinus';
import IconMoodHappy from '@tabler/icons-react-native/IconMoodHappy';
import IconMoodHappyFilled from '@tabler/icons-react-native/IconMoodHappyFilled';
import IconMoodSmile from '@tabler/icons-react-native/IconMoodSmile';
import IconMoodSmileFilled from '@tabler/icons-react-native/IconMoodSmileFilled';
import IconMoon from '@tabler/icons-react-native/IconMoon';
import IconMoonFilled from '@tabler/icons-react-native/IconMoonFilled';
import IconPalette from '@tabler/icons-react-native/IconPalette';
import IconPaletteFilled from '@tabler/icons-react-native/IconPaletteFilled';
import IconPaperclip from '@tabler/icons-react-native/IconPaperclip';
import IconPaw from '@tabler/icons-react-native/IconPaw';
import IconPawFilled from '@tabler/icons-react-native/IconPawFilled';
import IconPencil from '@tabler/icons-react-native/IconPencil';
import IconPhone from '@tabler/icons-react-native/IconPhone';
import IconPhoneFilled from '@tabler/icons-react-native/IconPhoneFilled';
import IconPhoneOff from '@tabler/icons-react-native/IconPhoneOff';
import IconPhoto from '@tabler/icons-react-native/IconPhoto';
import IconPhotoFilled from '@tabler/icons-react-native/IconPhotoFilled';
import IconPin from '@tabler/icons-react-native/IconPin';
import IconPinFilled from '@tabler/icons-react-native/IconPinFilled';
import IconPinnedOff from '@tabler/icons-react-native/IconPinnedOff';
import IconPlane from '@tabler/icons-react-native/IconPlane';
import IconPlayerPause from '@tabler/icons-react-native/IconPlayerPause';
import IconPlayerPauseFilled from '@tabler/icons-react-native/IconPlayerPauseFilled';
import IconPlayerPlay from '@tabler/icons-react-native/IconPlayerPlay';
import IconPlayerPlayFilled from '@tabler/icons-react-native/IconPlayerPlayFilled';
import IconPlus from '@tabler/icons-react-native/IconPlus';
import IconQrcode from '@tabler/icons-react-native/IconQrcode';
import IconQuestionMark from '@tabler/icons-react-native/IconQuestionMark';
import IconQuote from '@tabler/icons-react-native/IconQuote';
import IconRefresh from '@tabler/icons-react-native/IconRefresh';
import IconRepeat from '@tabler/icons-react-native/IconRepeat';
import IconRobot from '@tabler/icons-react-native/IconRobot';
import IconRosetteDiscountCheck from '@tabler/icons-react-native/IconRosetteDiscountCheck';
import IconRosetteDiscountCheckFilled from '@tabler/icons-react-native/IconRosetteDiscountCheckFilled';
import IconScan from '@tabler/icons-react-native/IconScan';
import IconSearch from '@tabler/icons-react-native/IconSearch';
import IconSeedling from '@tabler/icons-react-native/IconSeedling';
import IconSeedlingFilled from '@tabler/icons-react-native/IconSeedlingFilled';
import IconSend from '@tabler/icons-react-native/IconSend';
import IconSendFilled from '@tabler/icons-react-native/IconSendFilled';
import IconServer from '@tabler/icons-react-native/IconServer';
import IconSettings from '@tabler/icons-react-native/IconSettings';
import IconSettingsFilled from '@tabler/icons-react-native/IconSettingsFilled';
import IconShare from '@tabler/icons-react-native/IconShare';
import IconShield from '@tabler/icons-react-native/IconShield';
import IconShieldCheck from '@tabler/icons-react-native/IconShieldCheck';
import IconShieldCheckFilled from '@tabler/icons-react-native/IconShieldCheckFilled';
import IconShieldFilled from '@tabler/icons-react-native/IconShieldFilled';
import IconShieldLock from '@tabler/icons-react-native/IconShieldLock';
import IconShieldLockFilled from '@tabler/icons-react-native/IconShieldLockFilled';
import IconShieldX from '@tabler/icons-react-native/IconShieldX';
import IconSparkles from '@tabler/icons-react-native/IconSparkles';
import IconSparklesFilled from '@tabler/icons-react-native/IconSparklesFilled';
import IconSpeakerphone from '@tabler/icons-react-native/IconSpeakerphone';
import IconSquare from '@tabler/icons-react-native/IconSquare';
import IconSquareFilled from '@tabler/icons-react-native/IconSquareFilled';
import IconStack from '@tabler/icons-react-native/IconStack';
import IconStack2 from '@tabler/icons-react-native/IconStack2';
import IconStack2Filled from '@tabler/icons-react-native/IconStack2Filled';
import IconStackFilled from '@tabler/icons-react-native/IconStackFilled';
import IconStar from '@tabler/icons-react-native/IconStar';
import IconStarFilled from '@tabler/icons-react-native/IconStarFilled';
import IconSun from '@tabler/icons-react-native/IconSun';
import IconSunFilled from '@tabler/icons-react-native/IconSunFilled';
import IconSword from '@tabler/icons-react-native/IconSword';
import IconTag from '@tabler/icons-react-native/IconTag';
import IconTagFilled from '@tabler/icons-react-native/IconTagFilled';
import IconTagOff from '@tabler/icons-react-native/IconTagOff';
import IconTarget from '@tabler/icons-react-native/IconTarget';
import IconThumbDown from '@tabler/icons-react-native/IconThumbDown';
import IconThumbDownFilled from '@tabler/icons-react-native/IconThumbDownFilled';
import IconThumbUp from '@tabler/icons-react-native/IconThumbUp';
import IconThumbUpFilled from '@tabler/icons-react-native/IconThumbUpFilled';
import IconTicket from '@tabler/icons-react-native/IconTicket';
import IconTicketFilled from '@tabler/icons-react-native/IconTicketFilled';
import IconTools from '@tabler/icons-react-native/IconTools';
import IconToolsKitchen2 from '@tabler/icons-react-native/IconToolsKitchen2';
import IconTrash from '@tabler/icons-react-native/IconTrash';
import IconTrashFilled from '@tabler/icons-react-native/IconTrashFilled';
import IconTree from '@tabler/icons-react-native/IconTree';
import IconTrophy from '@tabler/icons-react-native/IconTrophy';
import IconTrophyFilled from '@tabler/icons-react-native/IconTrophyFilled';
import IconUser from '@tabler/icons-react-native/IconUser';
import IconUserCircle from '@tabler/icons-react-native/IconUserCircle';
import IconUserExclamation from '@tabler/icons-react-native/IconUserExclamation';
import IconUserFilled from '@tabler/icons-react-native/IconUserFilled';
import IconUserPlus from '@tabler/icons-react-native/IconUserPlus';
import IconUsers from '@tabler/icons-react-native/IconUsers';
import IconUsersGroup from '@tabler/icons-react-native/IconUsersGroup';
import IconVideo from '@tabler/icons-react-native/IconVideo';
import IconVideoFilled from '@tabler/icons-react-native/IconVideoFilled';
import IconVideoOff from '@tabler/icons-react-native/IconVideoOff';
import IconVolume from '@tabler/icons-react-native/IconVolume';
import IconWallet from '@tabler/icons-react-native/IconWallet';
import IconWifiOff from '@tabler/icons-react-native/IconWifiOff';
import IconWorld from '@tabler/icons-react-native/IconWorld';
import IconX from '@tabler/icons-react-native/IconX';

export const TablerIcons = {
  IconAi,
  IconAlertCircle,
  IconAlertCircleFilled,
  IconAlertTriangle,
  IconAlertTriangleFilled,
  IconArrowBackUp,
  IconArrowDownLeft,
  IconArrowDownRight,
  IconArrowForwardUp,
  IconArrowLeft,
  IconArrowUp,
  IconArrowUpRight,
  IconArrowsExchange,
  IconArrowsUpDown,
  IconAt,
  IconBadge,
  IconBadgeFilled,
  IconBan,
  IconBell,
  IconBellFilled,
  IconBellOff,
  IconBolt,
  IconBoltFilled,
  IconBook,
  IconBookFilled,
  IconBookmark,
  IconBookmarkFilled,
  IconBookmarkOff,
  IconBriefcase,
  IconBriefcaseFilled,
  IconBroadcast,
  IconBrush,
  IconBug,
  IconBugFilled,
  IconBuildingBank,
  IconBuildingStore,
  IconCalendar,
  IconCalendarFilled,
  IconCamera,
  IconCameraFilled,
  IconCameraRotate,
  IconCash,
  IconCertificate,
  IconChartBar,
  IconChartLine,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleArrowDown,
  IconCircleArrowDownFilled,
  IconCircleArrowLeft,
  IconCircleArrowLeftFilled,
  IconCircleArrowRight,
  IconCircleArrowRightFilled,
  IconCircleArrowUp,
  IconCircleArrowUpFilled,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconCircleFilled,
  IconCircleMinus,
  IconCirclePlus,
  IconCirclePlusFilled,
  IconCircleX,
  IconCircleXFilled,
  IconClipboard,
  IconClock,
  IconClockFilled,
  IconCode,
  IconCompass,
  IconCompassFilled,
  IconConfetti,
  IconConfettiFilled,
  IconCopy,
  IconCreditCard,
  IconCreditCardFilled,
  IconCrown,
  IconCrownFilled,
  IconCurrencyBitcoin,
  IconCurrencyDollar,
  IconDeviceDesktop,
  IconDeviceDesktopFilled,
  IconDeviceFloppy,
  IconDeviceFloppyFilled,
  IconDeviceGamepad,
  IconDeviceMobile,
  IconDots,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconExternalLink,
  IconEye,
  IconEyeFilled,
  IconEyeOff,
  IconFaceId,
  IconFeather,
  IconFile,
  IconFileCode,
  IconFileCodeFilled,
  IconFileFilled,
  IconFileText,
  IconFileTextFilled,
  IconFlag,
  IconFlagFilled,
  IconFlame,
  IconFlameFilled,
  IconFlask,
  IconFlaskFilled,
  IconFolder,
  IconFolderFilled,
  IconGift,
  IconGiftFilled,
  IconGripVertical,
  IconHammer,
  IconHandStop,
  IconHandTwoFingers,
  IconHash,
  IconHeadphones,
  IconHeadset,
  IconHeadsetFilled,
  IconHeart,
  IconHeartFilled,
  IconHelpCircle,
  IconHelpCircleFilled,
  IconHistory,
  IconHome,
  IconHomeFilled,
  IconInfoCircle,
  IconInfoCircleFilled,
  IconKey,
  IconKeyFilled,
  IconKeyboard,
  IconLayoutGrid,
  IconLeaf,
  IconLifebuoy,
  IconLink,
  IconLinkPlus,
  IconLock,
  IconLockFilled,
  IconMail,
  IconMailFilled,
  IconMailOpened,
  IconMapPin,
  IconMapPinFilled,
  IconMaximize,
  IconMenu2,
  IconMessage,
  IconMessageFilled,
  IconMessages,
  IconMessagesFilled,
  IconMicrophone,
  IconMicrophoneFilled,
  IconMicrophoneOff,
  IconMinimize,
  IconMinus,
  IconMoodHappy,
  IconMoodHappyFilled,
  IconMoodSmile,
  IconMoodSmileFilled,
  IconMoon,
  IconMoonFilled,
  IconPalette,
  IconPaletteFilled,
  IconPaperclip,
  IconPaw,
  IconPawFilled,
  IconPencil,
  IconPhone,
  IconPhoneFilled,
  IconPhoneOff,
  IconPhoto,
  IconPhotoFilled,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlane,
  IconPlayerPause,
  IconPlayerPauseFilled,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconPlus,
  IconQrcode,
  IconQuestionMark,
  IconQuote,
  IconRefresh,
  IconRepeat,
  IconRobot,
  IconRosetteDiscountCheck,
  IconRosetteDiscountCheckFilled,
  IconScan,
  IconSearch,
  IconSeedling,
  IconSeedlingFilled,
  IconSend,
  IconSendFilled,
  IconServer,
  IconSettings,
  IconSettingsFilled,
  IconShare,
  IconShield,
  IconShieldCheck,
  IconShieldCheckFilled,
  IconShieldFilled,
  IconShieldLock,
  IconShieldLockFilled,
  IconShieldX,
  IconSparkles,
  IconSparklesFilled,
  IconSpeakerphone,
  IconSquare,
  IconSquareFilled,
  IconStack,
  IconStack2,
  IconStack2Filled,
  IconStackFilled,
  IconStar,
  IconStarFilled,
  IconSun,
  IconSunFilled,
  IconSword,
  IconTag,
  IconTagFilled,
  IconTagOff,
  IconTarget,
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
  IconTicket,
  IconTicketFilled,
  IconTools,
  IconToolsKitchen2,
  IconTrash,
  IconTrashFilled,
  IconTree,
  IconTrophy,
  IconTrophyFilled,
  IconUser,
  IconUserCircle,
  IconUserExclamation,
  IconUserFilled,
  IconUserPlus,
  IconUsers,
  IconUsersGroup,
  IconVideo,
  IconVideoFilled,
  IconVideoOff,
  IconVolume,
  IconWallet,
  IconWifiOff,
  IconWorld,
  IconX,
};
