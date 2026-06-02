import React from 'react';
import { View } from 'react-native';
import type { AppTheme } from '@/theme';
import { useTranslatable } from '@/services/translation/useTranslatable';
import { TranslateToggle } from './TranslateToggle';

interface TranslatableProps {
  /** The raw text to detect/translate. */
  text: string;
  theme: AppTheme;
  enabled?: boolean;
  /** Render the (possibly-translated) text. Receives the text to display. */
  renderText: (displayText: string) => React.ReactNode;
}

/**
 * Render-prop wrapper that adds the on-device translation toggle beneath any
 * text renderer without that renderer needing to know about translation. Used
 * to wrap the feed's cast text (whose renderer is a large multi-return inline
 * component). The toggle only appears for non-target-language text — or when a
 * "Translate" context-menu request comes in for this text.
 */
export function Translatable({ text, theme, enabled = true, renderText }: TranslatableProps) {
  const { showToggle, displayText, state, label, errorText, toggle } = useTranslatable(
    text,
    enabled
  );
  const node = renderText(displayText);
  if (!showToggle) return <>{node}</>;
  return (
    <View>
      {node}
      <TranslateToggle
        state={state}
        label={label}
        errorText={errorText}
        onPress={toggle}
        theme={theme}
      />
    </View>
  );
}

export default Translatable;
