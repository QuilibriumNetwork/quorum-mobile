/**
 * Profile Setup - Step 3 of Onboarding
 *
 * Optional profile configuration:
 * - Avatar (camera/gallery)
 * - Username (@handle)
 * - Display name
 * - Bio
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '@/theme';
import { useOnboarding } from '@/context';
import { OnboardingLayout, StepNavigation } from '@/components/onboarding';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { stripImageMetadata } from '@/utils/imageMetadata';

export default function ProfileSetupScreen() {
  const { theme } = useTheme();
  const { state, updateProfile, skipProfile, goBack } = useOnboarding();
  const styles = createStyles(theme);

  const [username, setUsername] = useState(state.profile.username ?? '');
  const [displayName, setDisplayName] = useState(state.profile.displayName ?? '');
  const [bio, setBio] = useState(state.profile.bio ?? '');
  const [profileImage, setProfileImage] = useState<string | undefined>(state.profile.profileImageUri);

  // Sync from state.profile if it changes (e.g., from config sync during import)
  // Only update fields that are empty locally but have values in state
  useEffect(() => {
    if (!displayName && state.profile.displayName) {
      setDisplayName(state.profile.displayName);
    }
    if (!profileImage && state.profile.profileImageUri) {
      setProfileImage(state.profile.profileImageUri);
    }
    if (!username && state.profile.username) {
      setUsername(state.profile.username);
    }
    if (!bio && state.profile.bio) {
      setBio(state.profile.bio);
    }
  }, [state.profile]);

  const handlePickImage = async () => {
    // Request permission
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      exif: false,
    });

    if (!result.canceled && result.assets[0]) {
      try {
        // Strip metadata from the image
        const strippedUri = await stripImageMetadata(result.assets[0].uri);
        setProfileImage(strippedUri);
      } catch (error) {
        console.warn('[ProfileSetup] Failed to strip metadata, using original:', error);
        setProfileImage(result.assets[0].uri);
      }
    }
  };

  const handleTakePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      exif: false,
    });

    if (!result.canceled && result.assets[0]) {
      try {
        // Strip metadata from the image
        const strippedUri = await stripImageMetadata(result.assets[0].uri);
        setProfileImage(strippedUri);
      } catch (error) {
        console.warn('[ProfileSetup] Failed to strip metadata, using original:', error);
        setProfileImage(result.assets[0].uri);
      }
    }
  };

  const handleContinue = () => {
    updateProfile({
      username: username.trim() || undefined,
      displayName: displayName.trim() || undefined,
      bio: bio.trim() || undefined,
      profileImageUri: profileImage,
    });
    skipProfile(); // This advances to next step
  };

  const handleSkip = () => {
    skipProfile();
  };

  // Format username to lowercase and remove spaces
  const handleUsernameChange = (text: string) => {
    const formatted = text.toLowerCase().replace(/[^a-z0-9_]/g, '');
    setUsername(formatted);
  };

  const hasAnyInput = username.trim() || displayName.trim() || bio.trim() || profileImage;

  return (
    <OnboardingLayout currentStep="profile-setup">
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.title}>Set Up Your Profile</Text>
            <Text style={styles.subtitle}>
              Add some details to help others recognize you. You can always change these later.
            </Text>
          </View>

          {/* Avatar Picker */}
          <View style={styles.avatarSection}>
            <TouchableOpacity
              style={styles.avatarContainer}
              onPress={handlePickImage}
              activeOpacity={0.7}
            >
              {profileImage ? (
                <Image source={{ uri: profileImage }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <IconSymbol name="person.fill" size={40} color={theme.colors.textMuted} />
                </View>
              )}
              <View style={styles.avatarEditBadge}>
                <IconSymbol name="camera.fill" size={14} color={theme.colors.background} />
              </View>
            </TouchableOpacity>

            <View style={styles.avatarButtons}>
              <TouchableOpacity style={styles.avatarButton} onPress={handlePickImage}>
                <IconSymbol name="photo" size={16} color={theme.colors.primary} />
                <Text style={styles.avatarButtonText}>Choose Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.avatarButton} onPress={handleTakePhoto}>
                <IconSymbol name="camera" size={16} color={theme.colors.primary} />
                <Text style={styles.avatarButtonText}>Take Photo</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Form Fields */}
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Username</Text>
              <View style={styles.usernameInputContainer}>
                <Text style={styles.usernamePrefix}>@</Text>
                <TextInput
                  style={styles.usernameInput}
                  value={username}
                  onChangeText={handleUsernameChange}
                  placeholder="username"
                  placeholderTextColor={theme.colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={20}
                />
              </View>
              <Text style={styles.inputHint}>
                Lowercase letters, numbers, and underscores only
              </Text>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Display Name</Text>
              <TextInput
                style={styles.textInput}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Your name"
                placeholderTextColor={theme.colors.textMuted}
                maxLength={50}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Bio</Text>
              <TextInput
                style={[styles.textInput, styles.bioInput]}
                value={bio}
                onChangeText={setBio}
                placeholder="Tell us about yourself..."
                placeholderTextColor={theme.colors.textMuted}
                multiline
                numberOfLines={3}
                maxLength={160}
                textAlignVertical="top"
              />
              <Text style={styles.charCount}>{bio.length}/160</Text>
            </View>
          </View>
        </ScrollView>

        <StepNavigation
          onBack={goBack}
          onNext={handleContinue}
          onSkip={handleSkip}
          nextLabel={hasAnyInput ? 'Continue' : 'Skip'}
          showSkip={!!hasAnyInput}
          skipLabel="Skip for now"
          isLoading={state.isLoading}
        />
      </KeyboardAvoidingView>
    </OnboardingLayout>
  );
}

const createStyles = (theme: any) =>
  StyleSheet.create({
    keyboardView: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      paddingBottom: 16,
    },
    header: {
      alignItems: 'center',
      marginBottom: 32,
    },
    title: {
      fontSize: 24,
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textAlign: 'center',
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 14,
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: 20,
    },
    avatarSection: {
      alignItems: 'center',
      marginBottom: 32,
    },
    avatarContainer: {
      position: 'relative',
      marginBottom: 16,
    },
    avatarImage: {
      width: 100,
      height: 100,
      borderRadius: 50,
    },
    avatarPlaceholder: {
      width: 100,
      height: 100,
      borderRadius: 50,
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarEditBadge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 3,
      borderColor: theme.colors.background,
    },
    avatarButtons: {
      flexDirection: 'row',
      gap: 16,
    },
    avatarButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    avatarButtonText: {
      fontSize: 14,
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    form: {
      gap: 20,
    },
    inputGroup: {
      gap: 8,
    },
    inputLabel: {
      fontSize: 14,
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    textInput: {
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      padding: 16,
      fontSize: 16,
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    usernameInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: 12,
      paddingHorizontal: 16,
    },
    usernamePrefix: {
      fontSize: 16,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      marginRight: 2,
    },
    usernameInput: {
      flex: 1,
      paddingVertical: 16,
      fontSize: 16,
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    inputHint: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    bioInput: {
      minHeight: 80,
      textAlignVertical: 'top',
    },
    charCount: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'right',
    },
  });
