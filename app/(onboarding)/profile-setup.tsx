/**
 * Profile Setup - Step 3 of Onboarding
 *
 * Optional profile configuration:
 * - Avatar (camera/gallery)
 * - Display name
 * - Bio
 */

import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, StyleSheet, Image, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as ImagePicker from 'expo-image-picker';
import { useTheme, type AppTheme } from '@/theme';
import { useOnboarding } from '@/context';
import { OnboardingLayout, StepNavigation } from '@/components/onboarding';
import { IconSymbol } from '@/components/ui/IconSymbol';
import * as Skin from '@/theme/skins/geometry';
import {
  validateDisplayName,
  validateUserBio,
  MAX_BIO_BYTES,
  MAX_DISPLAY_NAME_BYTES,
} from '@quilibrium/quorum-shared';
import {
  translateValidationResult,
  translateValidationResults,
} from '@/hooks/validation/errorTranslator';

export default function ProfileSetupScreen() {
  const { theme } = useTheme();
  const { state, updateProfile, skipProfile, goBack } = useOnboarding();
  const styles = createStyles(theme);

  const [displayName, setDisplayName] = useState(state.profile.displayName ?? '');
  const [bio, setBio] = useState(state.profile.bio ?? '');
  const [profileImage, setProfileImage] = useState<string | undefined>(state.profile.profileImageUri);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [bioError, setBioError] = useState<string | undefined>(undefined);

  // Sync from state.profile if it changes (e.g., from config sync during import)
  // Only update fields that are empty locally but have values in state
  useEffect(() => {
    if (!displayName && state.profile.displayName) {
      setDisplayName(state.profile.displayName);
    }
    if (!profileImage && state.profile.profileImageUri) {
      setProfileImage(state.profile.profileImageUri);
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
    });

    if (!result.canceled && result.assets[0]) {
      setProfileImage(result.assets[0].uri);
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
    });

    if (!result.canceled && result.assets[0]) {
      setProfileImage(result.assets[0].uri);
    }
  };

  const handleContinue = () => {
    const trimmedName = displayName.trim();
    const trimmedBio = bio.trim();

    // Validate only what the user actually entered — both fields are optional
    // at onboarding (the screen is skippable). Shared byte validators match
    // Farcaster's USER_DATA limits so a name/bio set here can be published later.
    const nameMsg = trimmedName ? translateValidationResult(validateDisplayName(trimmedName)) : undefined;
    const bioMsg = trimmedBio ? translateValidationResults(validateUserBio(trimmedBio))[0] : undefined;
    setNameError(nameMsg);
    setBioError(bioMsg);
    if (nameMsg || bioMsg) return;

    updateProfile({
      displayName: trimmedName || undefined,
      bio: trimmedBio || undefined,
      profileImageUri: profileImage,
    });
    skipProfile(); // This advances to next step
  };

  const handleSkip = () => {
    skipProfile();
  };

  const hasAnyInput = displayName.trim() || bio.trim() || profileImage;

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
              <Text style={styles.inputLabel}>Display Name</Text>
              <TextInput
                style={styles.textInput}
                value={displayName}
                onChangeText={(t) => { setDisplayName(t); if (nameError) setNameError(undefined); }}
                placeholder="Your name"
                placeholderTextColor={theme.colors.textMuted}
                // Coarse guard ~ MAX_DISPLAY_NAME_BYTES; the byte validator on
                // save catches multi-byte overflow the char cap can't.
                maxLength={MAX_DISPLAY_NAME_BYTES}
                aria-label="Display name"
                aria-invalid={!!nameError}
              />
              {nameError ? (
                <Text style={styles.fieldError} role="alert">{nameError}</Text>
              ) : null}
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Bio</Text>
              <TextInput
                style={[styles.textInput, styles.bioInput]}
                value={bio}
                onChangeText={(t) => { setBio(t); if (bioError) setBioError(undefined); }}
                placeholder="Tell us about yourself..."
                placeholderTextColor={theme.colors.textMuted}
                multiline
                numberOfLines={3}
                maxLength={MAX_BIO_BYTES}
                textAlignVertical="top"
                aria-label="Bio"
                aria-invalid={!!bioError}
              />
              {bioError ? (
                <Text style={styles.fieldError} role="alert">{bioError}</Text>
              ) : null}
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

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    keyboardView: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      paddingBottom: Skin.space(16),
    },
    header: {
      alignItems: 'center',
      marginBottom: Skin.space(32),
    },
    title: {
      fontSize: Skin.font(24),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textAlign: 'center',
      marginBottom: Skin.space(8),
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(20),
    },
    avatarSection: {
      alignItems: 'center',
      marginBottom: Skin.space(32),
    },
    avatarContainer: {
      position: 'relative',
      marginBottom: Skin.space(16),
    },
    avatarImage: {
      width: 100,
      height: 100,
      borderRadius: Skin.radius(50),
    },
    avatarPlaceholder: {
      width: 100,
      height: 100,
      borderRadius: Skin.radius(50),
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
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(3),
      borderColor: theme.colors.background,
    },
    avatarButtons: {
      flexDirection: 'row',
      gap: Skin.space(16),
    },
    avatarButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    avatarButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    form: {
      gap: Skin.space(20),
    },
    inputGroup: {
      gap: Skin.space(8),
    },
    inputLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    textInput: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      fontSize: Skin.font(16),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    bioInput: {
      minHeight: 80,
      textAlignVertical: 'top',
    },
    fieldError: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
      fontFamily: theme.fonts.regular.fontFamily,
      marginTop: Skin.space(1),
    },
  });
