/**
 * Initials must come from the name being displayed, never from an address.
 *
 * `Qm7f3a…` yields "Q" — a letter that belongs to no member, next to a label
 * showing their real name. The operator's rule: the initials always render
 * whatever the displayed name is at that moment.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';

const ADDR = 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';

describe('DefaultAvatar initials', () => {
  it('uses the resolved name', () => {
    render(<DefaultAvatar resolvedName="Alice Smith" address={ADDR} size={40} />);
    expect(screen.getByText('AS')).toBeTruthy();
  });

  it('renders a neutral placeholder rather than initials from an address', () => {
    render(<DefaultAvatar resolvedName={undefined} address={ADDR} size={40} />);
    expect(screen.queryByText('Q')).toBeNull();
    expect(screen.queryByText('QM')).toBeNull();
  });

  it('strips a .q before deriving initials', () => {
    // getInitials splits on non-letters, so "gatto.q" would yield two initials
    // from one name.
    render(<DefaultAvatar resolvedName="gatto.q" address={ADDR} size={40} />);
    expect(screen.getByText('G')).toBeTruthy();
  });
});
