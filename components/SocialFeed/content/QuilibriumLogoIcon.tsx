import React from 'react';
import Svg, { Path } from 'react-native-svg';

interface QuilibriumLogoIconProps {
  /** Render size in px (square). Defaults to 20 to match the like-row icons. */
  size?: number;
  /** Opacity, used to mirror the like icon's not-liked (0.6) / liked (1) states. */
  opacity?: number;
}

/**
 * Quilibrium brand mark, used as the like icon for casts mentioning
 * "quilibrium". Vector source (single color #FF056D) replaces the former
 * raster `qlogo.png`, so it stays crisp at any size. Tint is fixed to the
 * brand color; the liked/not-liked distinction is expressed via `opacity`,
 * exactly as the raster version did.
 *
 * The viewBox is cropped to the artwork's exact geometry bounds (the disc
 * occupies x/y 95–405 of the source 500x500 box). Cropping out that ~19%
 * internal padding makes the logo fill its `size`-px box like the heart and
 * other action icons beside it, rather than reading visibly smaller.
 */
export function QuilibriumLogoIcon({ size = 20, opacity = 1 }: QuilibriumLogoIconProps) {
  return (
    <Svg width={size} height={size} viewBox="95 95 310 310" fill="none" opacity={opacity}>
      <Path
        d="M296.112 353.244C281.983 359.54 266.395 363.15 249.962 363.15C233.529 363.15 217.94 359.617 203.811 353.244C201.431 352.169 199.05 351.017 196.746 349.788C194.289 348.483 191.909 346.947 189.528 345.488C178.317 338.347 168.488 329.362 160.425 318.842C155.203 312.084 150.749 304.789 147.217 296.957C146.065 294.423 145.067 291.735 144.069 289.048C139.538 276.838 136.85 263.707 136.85 249.962C136.85 187.532 187.608 136.774 250.038 136.774C312.468 136.774 363.226 187.532 363.226 249.962C363.226 263.784 360.539 276.838 356.008 289.048L386.34 323.065C398.089 301.257 405 276.377 405 249.962C404.923 164.495 335.352 95 249.962 95C164.571 95 95 164.495 95 249.962C95 335.429 164.495 404.923 249.962 404.923C277.145 404.923 302.563 397.705 324.755 385.342L296.112 353.244Z"
        fill="#FF056D"
      />
      <Path
        d="M249.961 235.986C264.889 235.986 276.991 223.885 276.991 208.956C276.991 194.028 264.889 181.926 249.961 181.926C235.033 181.926 222.931 194.028 222.931 208.956C222.931 223.885 235.033 235.986 249.961 235.986Z"
        fill="#FF056D"
      />
      <Path
        d="M401.161 373.977L369.293 401.007L249.962 267.239L200.279 322.912C188.607 314.926 178.855 304.252 172.097 291.735L212.949 245.969C222.241 254.953 234.834 260.559 248.81 260.559C262.786 260.559 276.454 254.492 285.823 244.817L401.084 374.054L401.161 373.977Z"
        fill="#FF056D"
      />
    </Svg>
  );
}

export default QuilibriumLogoIcon;
