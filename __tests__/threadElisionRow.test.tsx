/**
 * The "…" elision row inside a feed thread unit: accessible, tappable,
 * and purely presentational (it must never fetch — the collapsed context
 * stays collapsed until the user opens the thread).
 */
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import { renderWithProviders } from '@/jest/renderWithProviders';
import { ThreadElisionRow } from '@/components/SocialFeed/ThreadElisionRow';
import { DarkTheme } from '@/theme';

describe('ThreadElisionRow', () => {
  it('renders the show-full-thread affordance and fires its press handler', () => {
    const onPress = jest.fn();
    renderWithProviders(<ThreadElisionRow theme={DarkTheme} onPress={onPress} />);
    const label = screen.getByText('Show full thread');
    fireEvent.press(label);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is announced as a button for screen readers', () => {
    renderWithProviders(<ThreadElisionRow theme={DarkTheme} />);
    expect(screen.getByLabelText('Show full thread')).toBeTruthy();
  });
});
