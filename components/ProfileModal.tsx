import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth, useWebSocket } from '@/context';
import { getAllSpaces } from '@/services/config/spaceStorage';
import {
  deriveFarcasterKeys,
  lookupFarcasterAccount,
  validateFarcasterMnemonic,
} from '@/services/onboarding/farcasterService';
import {
  getMnemonic,
  storeFarcasterAuthToken,
  storeFarcasterCustodyKey,
  storeFarcasterFid,
  storeFarcasterSignerKey,
} from '@/services/onboarding/secureStorage';
import { sendUpdateProfileMessage } from '@/services/space/spaceMessageService';
import { useTheme } from '@/theme';
import { logger } from '@quilibrium/quorum-shared';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import React from 'react';
import { stripImageMetadata } from '@/utils/imageMetadata';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ProfileModalProps {
  visible: boolean;
  onClose: () => void;
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function ProfileModal({ visible, onClose }: ProfileModalProps) {
  const { theme, isDark } = useTheme();
  const { user, signOut, updateProfile } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = React.useState<'profile' | 'premium' | 'settings'>('profile');
  const [usernameSearch, setUsernameSearch] = React.useState('');
  const [notifications, setNotifications] = React.useState(true);

  // Editable profile fields
  const [isEditing, setIsEditing] = React.useState(false);
  const [editDisplayName, setEditDisplayName] = React.useState(user?.displayName || '');
  const [editBio, setEditBio] = React.useState(user?.bio || '');
  const [isSaving, setIsSaving] = React.useState(false);

  // Recovery phrase display
  const [showRecoveryPhrase, setShowRecoveryPhrase] = React.useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = React.useState<string[] | null>(null);

  // Farcaster import
  const [showFarcasterImport, setShowFarcasterImport] = React.useState(false);
  const [farcasterMnemonic, setFarcasterMnemonic] = React.useState('');
  const [farcasterImporting, setFarcasterImporting] = React.useState(false);
  const [farcasterError, setFarcasterError] = React.useState<string | null>(null);

  // Reset edit state when modal opens/closes or user changes
  React.useEffect(() => {
    if (visible && user) {
      setEditDisplayName(user.displayName || '');
      setEditBio(user.bio || '');
      setIsEditing(false);
      setShowRecoveryPhrase(false);
      setRecoveryPhrase(null);
      setShowFarcasterImport(false);
      setFarcasterMnemonic('');
      setFarcasterError(null);
    }
  }, [visible, user]);

  const styles = createStyles(theme, isDark, insets);

  const handleResetAppData = () => {
    Alert.alert(
      'Reset App Data',
      'This will delete all your data including your private keys. Make sure you have backed up your recovery phrase. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            // Clear React Query cache
            queryClient.clear();
            // Sign out clears MMKV storage and secure storage
            await signOut();
            onClose();
          },
        },
      ]
    );
  };

  const handleExportRecoveryPhrase = () => {
    Alert.alert(
      'Export Recovery Phrase',
      'Your recovery phrase is the only way to restore your account. Never share it with anyone. Make sure no one is looking at your screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Show Phrase',
          style: 'destructive',
          onPress: async () => {
            const phrase = await getMnemonic();
            if (phrase) {
              setRecoveryPhrase(phrase);
              setShowRecoveryPhrase(true);
            } else {
              Alert.alert('Error', 'Could not retrieve recovery phrase.');
            }
          },
        },
      ]
    );
  };

  const handleCopyRecoveryPhrase = async () => {
    if (recoveryPhrase) {
      await Clipboard.setStringAsync(recoveryPhrase.join(' '));
      Alert.alert('Copied', 'Recovery phrase copied to clipboard. Make sure to store it securely and clear your clipboard.');
    }
  };

  const handleImportFarcaster = async () => {
    if (!farcasterMnemonic.trim()) {
      setFarcasterError('Please enter your recovery phrase');
      return;
    }

    const words = farcasterMnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      setFarcasterError('Recovery phrase must be 12 or 24 words');
      return;
    }

    if (!validateFarcasterMnemonic(words)) {
      setFarcasterError('Invalid recovery phrase');
      return;
    }

    setFarcasterImporting(true);
    setFarcasterError(null);

    try {
      // Derive keys from mnemonic
      const keys = deriveFarcasterKeys(words);
      logger.log('[ProfileModal] Derived Farcaster keys, custody address:', keys.custodyAddress);

      // Look up account from custody address using official Farcaster API
      const account = await lookupFarcasterAccount(keys.custodyAddress, keys.custodyPrivateKey);

      if (!account) {
        setFarcasterError('No Farcaster account found for this recovery phrase');
        setFarcasterImporting(false);
        return;
      }

      logger.log('[ProfileModal] Found Farcaster account:', account.username, 'FID:', account.fid);

      // Store Farcaster keys and auth token securely
      const storePromises = [
        storeFarcasterCustodyKey(keys.custodyPrivateKey),
        storeFarcasterSignerKey(keys.signerPrivateKey),
        storeFarcasterFid(account.fid),
      ];
      if (account.authToken) {
        storePromises.push(storeFarcasterAuthToken(account.authToken));
      }
      await Promise.all(storePromises);

      // Update user profile with Farcaster info
      updateProfile({
        farcaster: {
          fid: account.fid,
          username: account.username,
          signerPublicKey: keys.signerPublicKey,
          custodyAddress: keys.custodyAddress,
        },
      });

      // Reset state and show success
      setShowFarcasterImport(false);
      setFarcasterMnemonic('');
      Alert.alert('Success', `Connected as @${account.username}`);
    } catch (error) {
      logger.log('[ProfileModal] Farcaster import error:', error);
      setFarcasterError('Failed to import Farcaster account. Please try again.');
    } finally {
      setFarcasterImporting(false);
    }
  };

  const handleDisconnectFarcaster = () => {
    Alert.alert(
      'Disconnect Farcaster',
      'Are you sure you want to disconnect your Farcaster account?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            updateProfile({ farcaster: undefined });
          },
        },
      ]
    );
  };

  const handlePickImage = async () => {
    if (!user?.address) return;

    // Request permission
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please grant photo library access to change your profile picture.');
      return;
    }

    // Launch image picker
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      base64: true,
      exif: false,
    });

    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const mimeType = asset.mimeType || 'image/jpeg';

      // Strip metadata before converting to base64
      let profileImage: string;
      try {
        if (asset.uri) {
          const strippedUri = await stripImageMetadata(asset.uri);
          const response = await fetch(strippedUri);
          const blob = await response.blob();
          profileImage = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result as string;
              resolve(result); // Already includes data: prefix
            };
            reader.onerror = () => reject(new Error('Failed to read stripped image'));
            reader.readAsDataURL(blob);
          });
        } else if (asset.base64) {
          // Fallback if URI not available
          profileImage = `data:${mimeType};base64,${asset.base64}`;
        } else {
          throw new Error('No image data available');
        }
      } catch (error) {
        console.warn('[ProfileModal] Failed to strip metadata, using original:', error);
        // Fallback to original base64
        profileImage = asset.base64
          ? `data:${mimeType};base64,${asset.base64}`
          : '';
      }

      if (profileImage) {
        updateProfile({ profileImage });

      // Broadcast profile image update to all spaces
      const spaces = getAllSpaces();
      if (spaces.length > 0) {
        logger.log('[ProfileModal] Broadcasting profile image update to', spaces.length, 'spaces');

        enqueueOutbound(async () => {
          const envelopes: string[] = [];

          for (const space of spaces) {
            try {
              const updateResult = await sendUpdateProfileMessage({
                spaceId: space.spaceId,
                channelId: space.defaultChannelId,
                senderAddress: user.address,
                displayName: user.displayName || '',
                userIcon: profileImage,
              });
              envelopes.push(updateResult.wsEnvelope);
              logger.log('[ProfileModal] Prepared profile image update for space:', space.spaceId);
            } catch (err) {
              logger.log('[ProfileModal] Failed to prepare profile image update for space:', space.spaceId, err);
            }
          }

          return envelopes;
        });
      }
    }
  };

  const handleSaveProfile = async () => {
    if (!user?.address) return;

    setIsSaving(true);
    try {
      const newDisplayName = editDisplayName.trim() || '';
      const newBio = editBio.trim() || '';

      // Update local profile
      updateProfile({
        displayName: newDisplayName || undefined,
        bio: newBio || undefined,
      });

      // Broadcast profile update to all spaces
      const spaces = getAllSpaces();
      if (spaces.length > 0) {
        logger.log('[ProfileModal] Broadcasting profile update to', spaces.length, 'spaces');

        enqueueOutbound(async () => {
          const envelopes: string[] = [];

          for (const space of spaces) {
            try {
              const result = await sendUpdateProfileMessage({
                spaceId: space.spaceId,
                channelId: space.defaultChannelId,
                senderAddress: user.address,
                displayName: newDisplayName,
                userIcon: user.profileImage || '',
              });
              envelopes.push(result.wsEnvelope);
              logger.log('[ProfileModal] Prepared update-profile for space:', space.spaceId);
            } catch (err) {
              logger.log('[ProfileModal] Failed to prepare update-profile for space:', space.spaceId, err);
            }
          }

          return envelopes;
        });
      }

      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditDisplayName(user?.displayName || '');
    setEditBio(user?.bio || '');
    setIsEditing(false);
  };

  // Format address for display (truncate middle)
  const formatAddress = (address: string) => {
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
  };

  const availableUsernames = [
    { username: 'cassie', price: 'N/A', availability: 'taken' },
    { username: 'cassie.q', price: '100', availability: 'available' },
    { username: 'cassie123', price: '100', availability: 'available' },
    { username: 'cassie_node', price: '100', availability: 'available' },
  ];

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height={0.9}
      avoidKeyboard
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Profile</Text>
        {activeTab === 'profile' && !isEditing && (
          <TouchableOpacity onPress={() => setIsEditing(true)} style={styles.editButton}>
            <IconSymbol name="pencil" size={18} color={theme.colors.primary} />
            <Text style={styles.editButtonText}>Edit</Text>
          </TouchableOpacity>
        )}
        {activeTab === 'profile' && isEditing && (
          <View style={styles.editActions}>
            <TouchableOpacity onPress={handleCancelEdit} style={styles.cancelButton}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSaveProfile} style={styles.saveButton} disabled={isSaving}>
              {isSaving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.saveButtonText}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'profile' && styles.tabActive]}
          onPress={() => setActiveTab('profile')}
        >
          <Text style={[styles.tabText, activeTab === 'profile' && styles.tabTextActive]}>Profile</Text>
        </TouchableOpacity>
        {/* <TouchableOpacity
          style={[styles.tab, activeTab === 'premium' && styles.tabActive]}
          onPress={() => setActiveTab('premium')}
        >
          <Text style={[styles.tabText, activeTab === 'premium' && styles.tabTextActive]}>Premium</Text>
        </TouchableOpacity> */}
        <TouchableOpacity
          style={[styles.tab, activeTab === 'settings' && styles.tabActive]}
          onPress={() => setActiveTab('settings')}
        >
          <Text style={[styles.tabText, activeTab === 'settings' && styles.tabTextActive]}>Settings</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={styles.scrollContent}>
        {activeTab === 'profile' && (
          <>
            {/* Profile Header */}
            <View style={styles.profileHeader}>
              <TouchableOpacity style={styles.avatarContainer} onPress={handlePickImage}>
                {user?.profileImage ? (
                  <Image source={{ uri: user.profileImage }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarPlaceholder]}>
                    <IconSymbol name="person.fill" size={40} color={theme.colors.textMuted} />
                  </View>
                )}
                <View style={styles.editAvatarButton}>
                  <IconSymbol name="camera.fill" size={16} color={theme.colors.textMain} />
                </View>
              </TouchableOpacity>
              <View style={styles.profileInfo}>
                {isEditing ? (
                  <TextInput
                    style={styles.displayNameInput}
                    value={editDisplayName}
                    onChangeText={setEditDisplayName}
                    placeholder="Display Name"
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="words"
                  />
                ) : (
                  <Text style={styles.displayName}>
                    {user?.displayName || 'Anonymous'}
                  </Text>
                )}
                {user?.username && (
                  <View style={styles.usernameRow}>
                    <Text style={styles.username}>@{user.username}</Text>
                  </View>
                )}
                <Text style={styles.userId}>
                  {user?.address ? formatAddress(user.address) : ''}
                </Text>
              </View>
            </View>

            {/* Bio Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Bio</Text>
              {isEditing ? (
                <TextInput
                  style={styles.bioInput}
                  value={editBio}
                  onChangeText={setEditBio}
                  placeholder="Tell us about yourself..."
                  placeholderTextColor={theme.colors.textMuted}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              ) : (
                <View style={styles.bioContainer}>
                  <Text style={styles.bioText}>
                    {user?.bio || 'No bio yet. Tap Edit to add one.'}
                  </Text>
                </View>
              )}
            </View>

            {/* Account Info */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account Info</Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Address</Text>
                <Text style={styles.infoValue} numberOfLines={1}>
                  {user?.address ? formatAddress(user.address) : 'N/A'}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Privacy Level</Text>
                <Text style={styles.infoValue}>
                  {user?.privacyLevel ? user.privacyLevel.charAt(0).toUpperCase() + user.privacyLevel.slice(1) : 'Standard'}
                </Text>
              </View>
              {user?.farcaster && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Farcaster</Text>
                  <Text style={styles.infoValue}>@{user.farcaster.username}</Text>
                </View>
              )}
            </View>
          </>
        )}

        {activeTab === 'settings' && (
          <>
            {/* Privacy Settings */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Privacy</Text>
              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <Text style={styles.settingLabel}>Show Online Status</Text>
                  <Text style={styles.settingDescription}>Let others see when you're active</Text>
                </View>
                <Switch
                  value={true}
                  trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
                  thumbColor={'#ffffff'}
                />
              </View>
            </View>

            {/* Notification Settings */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Notifications</Text>
              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <Text style={styles.settingLabel}>Push Notifications</Text>
                  <Text style={styles.settingDescription}>Receive notifications on your device</Text>
                </View>
                <Switch
                  value={notifications}
                  onValueChange={setNotifications}
                  trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
                  thumbColor={notifications ? '#ffffff' : '#f4f3f4'}
                />
              </View>
            </View>

            {/* Farcaster */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Farcaster</Text>
              {user?.farcaster ? (
                // Connected state
                <View style={styles.farcasterConnected}>
                  <View style={styles.farcasterInfo}>
                    <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success} />
                    <View style={styles.farcasterDetails}>
                      <Text style={styles.farcasterUsername}>@{user.farcaster.username}</Text>
                      <Text style={styles.farcasterFid}>FID: {user.farcaster.fid}</Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.farcasterDisconnectButton}
                    onPress={handleDisconnectFarcaster}
                  >
                    <Text style={styles.farcasterDisconnectText}>Disconnect</Text>
                  </TouchableOpacity>
                </View>
              ) : !showFarcasterImport ? (
                // Not connected state
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => setShowFarcasterImport(true)}
                >
                  <IconSymbol name="person.badge.plus" size={20} color={theme.colors.textMain} />
                  <Text style={styles.actionButtonText}>Import Farcaster Account</Text>
                  <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
                </TouchableOpacity>
              ) : (
                // Import state
                <View style={styles.farcasterImportContainer}>
                  <Text style={styles.farcasterImportDescription}>
                    Enter your Farcaster recovery phrase (12 or 24 words) to import your account.
                  </Text>
                  <TextInput
                    style={styles.farcasterMnemonicInput}
                    value={farcasterMnemonic}
                    onChangeText={(text) => {
                      setFarcasterMnemonic(text);
                      setFarcasterError(null);
                    }}
                    placeholder="Enter recovery phrase..."
                    placeholderTextColor={theme.colors.textMuted}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!farcasterImporting}
                  />
                  {farcasterError && (
                    <View style={styles.farcasterErrorContainer}>
                      <IconSymbol name="exclamationmark.circle.fill" size={16} color={theme.colors.danger} />
                      <Text style={styles.farcasterErrorText}>{farcasterError}</Text>
                    </View>
                  )}
                  <View style={styles.farcasterImportActions}>
                    <TouchableOpacity
                      style={styles.farcasterCancelButton}
                      onPress={() => {
                        setShowFarcasterImport(false);
                        setFarcasterMnemonic('');
                        setFarcasterError(null);
                      }}
                      disabled={farcasterImporting}
                    >
                      <Text style={styles.farcasterCancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.farcasterImportButton, farcasterImporting && styles.farcasterImportButtonDisabled]}
                      onPress={handleImportFarcaster}
                      disabled={farcasterImporting}
                    >
                      {farcasterImporting ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.farcasterImportButtonText}>Import</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            {/* Account Actions */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Account</Text>
              {!showRecoveryPhrase ? (
                <TouchableOpacity style={styles.actionButton} onPress={handleExportRecoveryPhrase}>
                  <IconSymbol name="key.fill" size={20} color={theme.colors.textMain} />
                  <Text style={styles.actionButtonText}>Export Recovery Phrase</Text>
                  <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
                </TouchableOpacity>
              ) : (
                <View style={styles.recoveryPhraseContainer}>
                  <View style={styles.recoveryPhraseWarning}>
                    <IconSymbol name="exclamationmark.triangle.fill" size={20} color={theme.colors.warning} />
                    <Text style={styles.recoveryPhraseWarningText}>
                      Never share this phrase with anyone!
                    </Text>
                  </View>
                  <View style={styles.recoveryPhraseGrid}>
                    {recoveryPhrase?.map((word, index) => (
                      <View key={index} style={styles.recoveryPhraseWord}>
                        <Text style={styles.recoveryPhraseIndex}>{index + 1}.</Text>
                        <Text style={styles.recoveryPhraseText}>{word}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={styles.recoveryPhraseActions}>
                    <TouchableOpacity style={styles.copyButton} onPress={handleCopyRecoveryPhrase}>
                      <IconSymbol name="doc.on.doc" size={16} color={theme.colors.primary} />
                      <Text style={styles.copyButtonText}>Copy</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.hideButton}
                      onPress={() => {
                        setShowRecoveryPhrase(false);
                        setRecoveryPhrase(null);
                      }}
                    >
                      <Text style={styles.hideButtonText}>Hide</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            {/* Danger Zone */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Danger Zone</Text>
              <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={handleResetAppData}>
                <IconSymbol name="arrow.counterclockwise" size={20} color={theme.colors.danger} />
                <Text style={[styles.actionButtonText, styles.dangerText]}>Reset App Data</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>
    </BaseModal>
  );
}

const createStyles = (theme: any, isDark: boolean, insets: any) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingBottom: 16,
    },
    title: {
      fontSize: 24,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    editButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    editButtonText: {
      fontSize: 14,
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    editActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    cancelButton: {
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    cancelButtonText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    saveButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: 6,
      paddingHorizontal: 16,
      borderRadius: 16,
      minWidth: 60,
      alignItems: 'center',
    },
    saveButtonText: {
      fontSize: 14,
      color: '#fff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    tabs: {
      flexDirection: 'row',
      marginHorizontal: 20,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    tab: {
      flex: 1,
      paddingVertical: 12,
      alignItems: 'center',
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    tabActive: {
      borderBottomColor: theme.colors.primary,
    },
    tabText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    tabTextActive: {
      color: theme.colors.primary,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingTop: 20,
    },
    profileHeader: {
      flexDirection: 'row',
      marginBottom: 24,
    },
    avatarContainer: {
      position: 'relative',
      marginRight: 16,
    },
    avatar: {
      width: 80,
      height: 80,
      borderRadius: 40,
    },
    avatarPlaceholder: {
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editAvatarButton: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: theme.colors.background,
    },
    profileInfo: {
      flex: 1,
      justifyContent: 'center',
    },
    displayName: {
      fontSize: 20,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: 4,
    },
    displayNameInput: {
      fontSize: 20,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: 4,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.primary,
      paddingVertical: 4,
    },
    username: {
      fontSize: 14,
      color: theme.colors.primary,
      marginRight: 6,
    },
    usernameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    userId: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    section: {
      marginBottom: 24,
    },
    sectionTitle: {
      fontSize: 16,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: 12,
    },
    bioContainer: {
      backgroundColor: theme.colors.surface2,
      padding: 12,
      borderRadius: 8,
    },
    bioText: {
      fontSize: 14,
      color: theme.colors.textMain,
      lineHeight: 20,
    },
    bioInput: {
      backgroundColor: theme.colors.surface2,
      padding: 12,
      borderRadius: 8,
      fontSize: 14,
      color: theme.colors.textMain,
      lineHeight: 20,
      minHeight: 100,
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    infoLabel: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    infoValue: {
      fontSize: 14,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      maxWidth: '50%',
    },
    premiumBanner: {
      padding: 24,
      borderRadius: 16,
      alignItems: 'center',
      marginBottom: 24,
    },
    premiumTitle: {
      fontSize: 20,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: isDark ? theme.colors.textMain : '#ffffff',
      marginTop: 12,
      marginBottom: 8,
    },
    premiumSubtitle: {
      fontSize: 14,
      color: isDark ? theme.colors.textSubtle : '#ffffffcc',
      textAlign: 'center',
    },
    searchSection: {
      marginBottom: 24,
    },
    searchContainer: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface2,
      borderRadius: 8,
      overflow: 'hidden',
    },
    searchInput: {
      flex: 1,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontSize: 14,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    searchButton: {
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
    },
    usernameItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      padding: 16,
      borderRadius: 8,
      marginBottom: 8,
    },
    usernameItemTaken: {
      opacity: 0.5,
    },
    usernameLeft: {
      flex: 1,
    },
    usernameText: {
      fontSize: 16,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginBottom: 4,
    },
    usernameTextTaken: {
      textDecorationLine: 'line-through',
    },
    availabilityText: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    usernameRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    priceText: {
      fontSize: 14,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    buyButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: 16,
      paddingVertical: 6,
      borderRadius: 16,
    },
    buyButtonText: {
      fontSize: 12,
      color: '#ffffff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    benefitsSection: {
      backgroundColor: theme.colors.surface2,
      padding: 16,
      borderRadius: 12,
      marginBottom: 24,
    },
    benefitItem: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    benefitText: {
      fontSize: 14,
      color: theme.colors.textMain,
      marginLeft: 12,
      flex: 1,
    },
    settingRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    settingLeft: {
      flex: 1,
      marginRight: 16,
    },
    settingLabel: {
      fontSize: 14,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      marginBottom: 4,
    },
    settingDescription: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      padding: 16,
      borderRadius: 8,
      marginBottom: 8,
    },
    actionButtonText: {
      fontSize: 14,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      flex: 1,
      marginLeft: 12,
    },
    dangerButton: {
      backgroundColor: theme.colors.danger + '20',
    },
    dangerText: {
      color: theme.colors.danger,
    },
    recoveryPhraseContainer: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      padding: 16,
    },
    recoveryPhraseWarning: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.warning + '20',
      padding: 12,
      borderRadius: 8,
      marginBottom: 16,
      gap: 8,
    },
    recoveryPhraseWarningText: {
      fontSize: 13,
      color: theme.colors.warning,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      flex: 1,
    },
    recoveryPhraseGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    recoveryPhraseWord: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 8,
      minWidth: '30%',
    },
    recoveryPhraseIndex: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginRight: 6,
      minWidth: 20,
    },
    recoveryPhraseText: {
      fontSize: 14,
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    recoveryPhraseActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: 16,
      gap: 12,
    },
    copyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.primary + '20',
      gap: 6,
    },
    copyButtonText: {
      fontSize: 14,
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    hideButton: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.surface3,
    },
    hideButtonText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    // Farcaster styles
    farcasterConnected: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface2,
      padding: 16,
      borderRadius: 8,
    },
    farcasterInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    farcasterDetails: {
      gap: 2,
    },
    farcasterUsername: {
      fontSize: 14,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    farcasterFid: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    farcasterDisconnectButton: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.danger + '20',
    },
    farcasterDisconnectText: {
      fontSize: 12,
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    farcasterImportContainer: {
      backgroundColor: theme.colors.surface2,
      padding: 16,
      borderRadius: 8,
    },
    farcasterImportDescription: {
      fontSize: 13,
      color: theme.colors.textMuted,
      marginBottom: 12,
      lineHeight: 18,
    },
    farcasterMnemonicInput: {
      backgroundColor: theme.colors.surface3,
      padding: 12,
      borderRadius: 8,
      fontSize: 14,
      color: theme.colors.textMain,
      minHeight: 80,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    farcasterErrorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
    },
    farcasterErrorText: {
      fontSize: 12,
      color: theme.colors.danger,
    },
    farcasterImportActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      marginTop: 12,
    },
    farcasterCancelButton: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.surface3,
    },
    farcasterCancelText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    farcasterImportButton: {
      paddingVertical: 8,
      paddingHorizontal: 20,
      borderRadius: 8,
      backgroundColor: theme.colors.primary,
      minWidth: 80,
      alignItems: 'center',
    },
    farcasterImportButtonDisabled: {
      opacity: 0.6,
    },
    farcasterImportButtonText: {
      fontSize: 14,
      color: '#fff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
  });
