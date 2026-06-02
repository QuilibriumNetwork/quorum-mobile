import React from 'react';
import { StyleProp, Text, TextStyle, ViewStyle } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme } from '@/theme';
import { useRouter } from 'expo-router';

interface BrowserLinkProps {
  url: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  openInApp?: boolean; // Whether to open in in-app browser or external
  isQNative?: boolean;
}

export default function BrowserLink({ 
  url, 
  children, 
  style, 
  textStyle,
  openInApp = true,
  isQNative = false
}: BrowserLinkProps) {
  const { theme } = useTheme();
  const router = useRouter();

  const handlePress = () => {
    if (openInApp) {
      router.push({
        pathname: '/browser',
        params: { 
          url,
          isQNative: isQNative.toString()
        }
      });
    } else {
      // In a real app, you would use Linking.openURL(url) here
    }
  };

  const baseTextStyle: TextStyle = {
    color: theme.colors.primary,
    textDecorationLine: 'underline',
  };
  const mergedTextStyle: StyleProp<TextStyle> = [baseTextStyle, textStyle];

  return (
    <TouchableOpacity onPress={handlePress} style={style} activeOpacity={0.7}>
      {typeof children === 'string' ? (
        <Text style={mergedTextStyle}>{children}</Text>
      ) : (
        children
      )}
    </TouchableOpacity>
  );
}
