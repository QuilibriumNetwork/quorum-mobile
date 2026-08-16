import * as React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { formatResolvedName, useResolvedMemberName, type UseResolvedNameOptions } from './useResolvedName';

interface MemberNameProps extends UseResolvedNameOptions {
  address: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

/**
 * The only name-rendering API.
 *
 * Owns the `.q` suffix. Nothing else in the app may append it: the suffix is
 * the entire trust claim, so it must only ever come from a resolution that
 * earned it.
 *
 * Avatars are deliberately NOT rendered here, unlike desktop's version. Mobile
 * already has a separate avatar ladder (`resolveMemberAvatar`) with no QNS
 * step, because a `.q` carries no picture, and folding the two would merge
 * ladders that are correctly different. What must agree is the INITIALS: pass
 * this component's resolved name to the avatar, never a raw field. That is
 * what `resolvedName` on the avatar primitive is for (Task 6).
 */
export const MemberName: React.FunctionComponent<MemberNameProps> = ({
  address,
  style,
  numberOfLines,
  ...opts
}) => {
  const resolved = useResolvedMemberName(address, opts);
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {formatResolvedName(resolved)}
    </Text>
  );
};
