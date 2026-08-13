import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { FarcasterLogoIcon } from '@/components/ui/FarcasterLogoIcon';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { QuorumLogoIcon } from '@/components/SocialFeed/content/QuorumLogoIcon';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import type { UserInfo } from '@/context/AuthContext';
import type { ProfileAuthor } from '@/hooks/useFarcasterProfile';
import { truncateAddress } from '@/utils/formatAddress';
import { MemberName, useMemberIdentity, useResolvedMemberName } from '@/identity';
// `formatResolvedName` is not re-exported from the `@/identity` barrel (only
// the hooks and `<MemberName>` are), so it is imported from its owning module
// directly — the same reach used by `ShareInviteSheet.tsx`/`SpaceSettingsModal.tsx`
// and others. It stays the ONLY place a `.q` suffix is spelled out; this just
// reaches it by a longer path, for the two call sites below (a plain string
// prop, not a render) that need the formatted name outside of `<MemberName>`.
import { formatResolvedName } from '@/identity/useResolvedName';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

/** Which identity the big profile card shows when unmerged with both profiles. */
export type IdentityTab = 'quorum' | 'farcaster';


interface UnifiedProfileHeaderProps {
  user: UserInfo;
  farcasterProfile?: ProfileAuthor | null;
  splitMode: boolean;
  /** Selected identity (unmerged-with-both layout). Owned by the parent. */
  identityTab: IdentityTab;
  onIdentityTabChange: (tab: IdentityTab) => void;
  onEditQuorum?: () => void;
  onEditFarcaster?: () => void;
  onEditUnified?: () => void;
  /** Copy the Quorum address (tappable address line on the Quorum card). */
  onCopyAddress?: () => void;
}

const IDENTITY_PILLS: SegmentedPillItem[] = [
  { key: 'quorum', label: 'Quorum', leading: <QuorumLogoIcon size={14} /> },
  { key: 'farcaster', label: 'Farcaster', leading: <FarcasterLogoIcon size={14} /> },
];

export default function UnifiedProfileHeader({
  user,
  farcasterProfile,
  splitMode,
  identityTab,
  onIdentityTabChange,
  onEditQuorum,
  onEditFarcaster,
  onEditUnified,
  onCopyAddress,
}: UnifiedProfileHeaderProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  // Own name through the SAME verified ladder every other member resolves
  // through (see HeaderAvatar.tsx for the full reasoning), rather than
  // trusting `primaryUsername`/`displayName` off the live auth profile
  // directly. Called unconditionally, before any early return below — these
  // are hooks. `global: true`: self has no per-space tier, so an ambient
  // Space scope must not let a roster nickname outrank the QNS name here.
  const identity = useMemberIdentity(user.address);
  const resolved = useResolvedMemberName(user.address, { global: true });
  // ANY Quorum tier — not only the QNS one — outranks Farcaster below. The
  // previous code reached the same priority two different ways (a `.q`
  // check, and a `user.displayName ||` chain that put the global name ahead
  // of Farcaster too); this is that same combined priority under one gate.
  const hasQuorumName = !!(identity.qnsName || identity.globalName);

  const hasFarcaster = Boolean(user.farcaster?.fid);

  if (!hasFarcaster) {
    return <QuorumOnlyHeader user={user} onEdit={onEditQuorum} onCopyAddress={onCopyAddress} theme={theme} styles={styles} />;
  }

  // Unmerged with both profiles: one big card + a [Quorum | Farcaster] switcher
  // above it. Swapping changes only this card; the nav pills below are separate.
  if (splitMode) {
    const showingFarcaster = identityTab === 'farcaster';

    return (
      <View style={styles.switcherContainer}>
        {/* 'segmented' (iOS track) look distinguishes the identity switcher from
            the solid nav pills below, so the two rows don't read as one. */}
        <SegmentedPills
          items={IDENTITY_PILLS}
          activeKey={identityTab}
          onChange={(key) => onIdentityTabChange(key as IdentityTab)}
          variant="segmented"
          scrollable={false}
          itemRole="tab"
          style={styles.identitySwitcher}
        />
        {showingFarcaster ? (
          <BigProfileCard
            displayName={farcasterProfile?.displayName || user.farcaster?.username || 'Unnamed'}
            avatarUri={farcasterProfile?.pfp?.url || user.farcaster?.pfpUrl}
            username={user.farcaster?.username ? `@${user.farcaster.username}` : undefined}
            fid={user.farcaster?.fid}
            onEdit={onEditFarcaster}
            theme={theme}
            styles={styles}
          />
        ) : (
          <BigProfileCard
            displayName={formatResolvedName(resolved)}
            avatarName={resolved.name}
            avatarUri={user.profileImage}
            address={user.address}
            onCopyAddress={onCopyAddress}
            onEdit={onEditQuorum}
            theme={theme}
            styles={styles}
          />
        )}
      </View>
    );
  }

  // Merged mode — show one identity, prefer Quorum display fields with Farcaster
  // as fallback. Handle + address are always shown together.
  //
  // The `.q` leads here too when there is one. Farcaster only supplies a name
  // when Quorum has none at all — neither a `.q` nor a verified/local global name.
  const farcasterFallbackName = farcasterProfile?.displayName || user.farcaster?.username || 'Unnamed';
  const displayName = hasQuorumName ? formatResolvedName(resolved) : farcasterFallbackName;
  const avatarName = hasQuorumName ? resolved.name : farcasterFallbackName;
  const avatarUri = user.profileImage || farcasterProfile?.pfp?.url || user.farcaster?.pfpUrl;

  return (
    <View style={styles.mergedContainer}>
      <TouchableOpacity onPress={onEditUnified} activeOpacity={0.8} style={styles.mergedAvatarWrap}>
        <CachedAvatar
          source={avatarUri ? { uri: avatarUri } : null}
          style={styles.mergedAvatar}
          fallbackName={avatarName}
        />
        <View style={styles.editBadge}>
          <IconSymbol name="pencil" size={12} color="#fff" />
        </View>
      </TouchableOpacity>

      <Text style={styles.mergedDisplayName} numberOfLines={1}>
        {displayName}
      </Text>

      <View style={styles.handlesRow}>
        {user.farcaster?.username && (
          <Text style={styles.handleText} numberOfLines={1}>
            @{user.farcaster.username}
          </Text>
        )}
        {/* A second "the `.q` is not already the name above" handle line used to
            live here, hand-appending the suffix onto the raw claim. It could
            never actually fire — `hasQuorumName`'s predecessor gated it on the
            SAME condition (a QNS name present) that already made the name
            rendered above be the `.q`, so the two were mutually exclusive by
            construction — and it built the suffix outside `identity/`, which
            nothing may do. Removed rather than ported. */}
      </View>
      <TouchableOpacity
        style={styles.addressRow}
        onPress={onCopyAddress}
        accessibilityRole="button"
        accessibilityLabel="Copy address"
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
      >
        <Text style={styles.addressText}>{truncateAddress(user.address, 'medium')}</Text>
        <IconSymbol name="doc.on.doc" size={13} color={theme.colors.textMuted} />
      </TouchableOpacity>
      {/* Bio intentionally omitted — shown only in the Profile section's Bio. */}
    </View>
  );
}

/**
 * The big single-identity profile card (96px avatar, pencil badge) used in the
 * unmerged switcher layout. Renders identity-specific lines under the name:
 *  - Quorum: `.q` name (accent) + a tappable, copyable address.
 *  - Farcaster: @username + FID, with a top-right Disconnect control.
 * Bio is omitted here — it lives in the Profile section below.
 */
function BigProfileCard({
  displayName,
  avatarName,
  avatarUri,
  qname,
  username,
  fid,
  address,
  onCopyAddress,
  onEdit,
  theme,
  styles,
}: {
  displayName: string;
  /** Name the avatar placeholder derives initials from. Defaults to
   *  `displayName`; pass the bare name when `displayName` carries a `.q`
   *  suffix, so `gatto.q` initials as "G" rather than splitting on the dot. */
  avatarName?: string;
  avatarUri?: string | null;
  /** Quorum `.q` primary username, e.g. "alice.q". Only for cards where the
   *  `.q` is NOT already the name above — otherwise it repeats itself. */
  qname?: string;
  /** Farcaster @handle. */
  username?: string;
  /** Farcaster ID. */
  fid?: number;
  /** Quorum on-chain address (tappable to copy). */
  address?: string;
  onCopyAddress?: () => void;
  onEdit?: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.bigCardContainer}>
      <TouchableOpacity onPress={onEdit} activeOpacity={0.8} style={styles.mergedAvatarWrap}>
        <CachedAvatar
          source={avatarUri ? { uri: avatarUri } : null}
          style={styles.mergedAvatar}
          fallbackName={avatarName ?? displayName}
        />
        <View style={styles.editBadge}>
          <IconSymbol name="pencil" size={12} color="#fff" />
        </View>
      </TouchableOpacity>

      <Text style={styles.mergedDisplayName} numberOfLines={1}>
        {displayName}
      </Text>

      {/* Quorum: .q name */}
      {qname ? (
        <Text style={[styles.handleText, { color: theme.colors.accent }]} numberOfLines={1}>
          {qname}
        </Text>
      ) : null}

      {/* Quorum: tappable address + copy icon */}
      {address ? (
        <TouchableOpacity
          style={styles.addressRow}
          onPress={onCopyAddress}
          accessibilityRole="button"
          accessibilityLabel="Copy address"
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
        >
          <Text style={styles.addressText}>{truncateAddress(address, 'medium')}</Text>
          <IconSymbol name="doc.on.doc" size={13} color={theme.colors.textMuted} />
        </TouchableOpacity>
      ) : null}

      {/* Farcaster: @username */}
      {username ? (
        <Text style={styles.handleText} numberOfLines={1}>
          {username}
        </Text>
      ) : null}

      {/* Farcaster: FID — same size/style as the username line */}
      {typeof fid === 'number' ? (
        <Text style={styles.handleText}>FID: {fid}</Text>
      ) : null}
    </View>
  );
}

function QuorumOnlyHeader({
  user,
  onEdit,
  onCopyAddress,
  theme,
  styles,
}: {
  user: UserInfo;
  onEdit?: () => void;
  onCopyAddress?: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  // Same ladder as every other surface, and verified the same way — see
  // HeaderAvatar.tsx: the `.q` IS the name when there is one, but only once it
  // resolves back to this address through a published public profile.
  const resolved = useResolvedMemberName(user.address, { global: true });
  return (
    <View style={styles.mergedContainer}>
      <TouchableOpacity onPress={onEdit} activeOpacity={0.8} style={styles.mergedAvatarWrap}>
        <CachedAvatar
          source={user.profileImage ? { uri: user.profileImage } : null}
          style={styles.mergedAvatar}
          fallbackName={resolved.name}
        />
        <View style={styles.editBadge}>
          <IconSymbol name="pencil" size={12} color="#fff" />
        </View>
      </TouchableOpacity>
      <MemberName address={user.address} global style={styles.mergedDisplayName} numberOfLines={1} />
      <TouchableOpacity
        style={styles.addressRow}
        onPress={onCopyAddress}
        accessibilityRole="button"
        accessibilityLabel="Copy address"
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
      >
        <Text style={styles.addressText}>{truncateAddress(user.address, 'medium')}</Text>
        <IconSymbol name="doc.on.doc" size={13} color={theme.colors.textMuted} />
      </TouchableOpacity>
      {/* Bio intentionally omitted — shown only in the Profile section's Bio. */}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    mergedContainer: {
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(20),
      gap: Skin.space(6),
    },
    mergedAvatarWrap: {
      marginBottom: Skin.space(4),
    },
    mergedAvatar: {
      width: 96,
      height: 96,
      borderRadius: Skin.circleOrSquare(48),
      backgroundColor: theme.colors.surface2,
    },
    editBadge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 28,
      height: 28,
      borderRadius: Skin.circleOrSquare(14),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.accent,
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
    mergedDisplayName: {
      fontSize: Skin.font(22),
      fontWeight: '700',
      color: theme.colors.textStrong,
    },
    handlesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: Skin.space(8),
    },
    handleText: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      // Allow a very long handle to shrink + ellipsize instead of overflowing
      // the card or pushing a sibling handle off-screen (see issue #61).
      flexShrink: 1,
    },
    addressText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      fontFamily: 'Menlo',
    },
    bioText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      textAlign: 'center',
      marginTop: Skin.space(6),
      lineHeight: Skin.font(19),
    },
    // Unmerged switcher layout: [Quorum|Farcaster] track + one big card.
    switcherContainer: {
      alignItems: 'center',
      paddingTop: Skin.space(20),
    },
    identitySwitcher: {
      alignSelf: 'center',
      marginBottom: Skin.space(4),
    },
    bigCardContainer: {
      alignItems: 'center',
      position: 'relative',
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(16),
      gap: Skin.space(6),
    },
    // Tappable address line (copy on press) with a trailing copy icon.
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      // Padding enlarges the tap target so the copy action is comfortably
      // hittable on Android (the row is otherwise just text + a 13px icon).
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(8),
    },
  });
}
