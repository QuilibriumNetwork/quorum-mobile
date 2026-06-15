import React from 'react';
import Svg, { Path } from 'react-native-svg';

interface SendIconProps {
  /** Render width in px. Height is derived from the 5:4 (100:80) aspect ratio. */
  size?: number;
  color: string;
}

/**
 * Quorum send arrow — the chevron/arrowhead lifted from the Quorum symbol,
 * used as the message composer's send button. Geometry matches the desktop
 * web composer (viewBox 0 0 100 80) so the send glyph is identical across
 * platforms.
 */
export function SendIcon({ size = 22, color }: SendIconProps) {
  const height = (size * 80) / 100;
  return (
    <Svg width={size} height={height} viewBox="0 0 100 80" fill="none">
      <Path d="M0 80L25 40.4181L0 0L100 40.4181L0 80Z" fill={color} />
    </Svg>
  );
}

export default SendIcon;
