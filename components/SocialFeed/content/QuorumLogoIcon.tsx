import React from 'react';
import Svg, { Path } from 'react-native-svg';

interface QuorumLogoIconProps {
  /** Render size in px (square). Defaults to 20 to match the like-row icons. */
  size?: number;
  /** Opacity, used to mirror the like icon's not-liked (0.6) / liked (1) states. */
  opacity?: number;
}

/**
 * Quorum brand mark, used as the like icon for casts mentioning "quorum".
 * Vector source (single color #0287F2) replaces the former raster
 * `icon.png`, so it stays crisp at any size. Tint is fixed to the brand
 * color; the liked/not-liked distinction is expressed via `opacity`, exactly
 * as the raster version did.
 *
 * The viewBox is cropped to the artwork's exact geometry bounds (the disc
 * occupies x/y 95–405 of the source 500x500 box). Cropping out that ~19%
 * internal padding makes the logo fill its `size`-px box like the heart and
 * other action icons beside it, rather than reading visibly smaller.
 */
export function QuorumLogoIcon({ size = 20, opacity = 1 }: QuorumLogoIconProps) {
  return (
    <Svg width={size} height={size} viewBox="95 96 308 308" fill="none" opacity={opacity}>
      <Path
        d="M263.872 264.817L179.722 262.817L392.243 398.246L401.868 388.341L258.821 180.817L263.872 264.817Z"
        fill="#0287F2"
      />
      <Path
        d="M249.101 97C164.093 97 95 166.143 95 251C95 335.857 164.188 405 249.101 405C276.167 405 301.422 397.857 323.531 385.571L326.962 383.762L285.506 357.286C274.07 361.19 261.872 363.476 249.101 363.476C232.71 363.476 217.271 359.952 203.166 353.667C200.784 352.619 198.401 351.476 196.114 350.238C193.636 348.905 191.254 347.476 188.967 345.952C177.816 338.905 168 329.952 159.995 319.476C154.849 312.81 150.37 305.476 146.844 297.762C145.7 295.19 144.747 292.524 143.699 289.952C140.458 281.381 138.267 272.333 137.218 262.905C136.742 259 136.456 255.095 136.456 251C136.456 246.905 136.742 242.81 137.123 238.81C142.65 187.667 182.677 146.81 233.377 139.762C238.523 139 243.765 138.524 249.006 138.524C251.96 138.524 254.82 138.714 257.679 139C315.717 143.476 361.556 191.952 361.556 251.095C361.556 262.143 359.746 272.714 356.696 282.81L384.715 323.476C396.341 301.857 403.108 277.286 403.108 251.095C403.108 166.143 333.919 97.0953 249.006 97.0953L249.101 97Z"
        fill="#0287F2"
      />
    </Svg>
  );
}

export default QuorumLogoIcon;
