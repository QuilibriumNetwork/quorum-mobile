/**
 * Whether the screen this component is rendered in is focused, for stopping
 * polls on screens nobody is looking at. Tabs never unmount here and
 * `freezeOnBlur` is off (it crashed), so work in a visited tab keeps running
 * unless it checks this.
 *
 * Unlike React Navigation's `useIsFocused`, this doesn't throw outside a
 * screen (a component in an overlay or modal host): it reports focused there,
 * so callers behave as they did before.
 */
import { useContext, useEffect, useState } from 'react';
import { NavigationContext } from '@react-navigation/native';

export function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);

  useEffect(() => {
    if (!navigation) {
      setFocused(true);
      return;
    }
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);

  return focused;
}
