import React from 'react';
import Svg, { Path } from 'react-native-svg';

interface VariantProps {
  /** Render size in px (height of the icon box). Width derives from the
   *  tight content aspect ratio so the hand fills the box. */
  size?: number;
  color: string;
}

/**
 * Candidate snap (tip) glyph — kept local to mobile (NOT in quorum-shared)
 * for a future swap of the cast tip icon. See CastActions `SNAP_VARIANT`.
 */

/**
 * Outline variant — line-art snapping hand with motion ticks.
 *
 * The source artwork lives in a 24x27 space but the hand only occupies part
 * of it (wide left/right margins, slack above the motion ticks). Rendering
 * that raw box at `size` makes the icon optically smaller than the SF Symbol
 * action icons beside it AND taller than them (the box height = size, but the
 * visible mass sits low → bottom-heavy, misaligned in a center-aligned row).
 *
 * Fix: a tight viewBox cropped to the hand's bounding box (content bounds
 * x 4.18–19.36, y 2.57–25.24, plus ~1.4u stroke padding). Now the box wraps
 * the content, so at `size={20}` the box is 20px tall — same as a 20px SF
 * Symbol, no taller row — and the hand is centered, not bottom-weighted.
 */
const VIEWBOX = { x: 2.8, y: 1.2, w: 17.8, h: 25.2 };

export function SnapIconOutline({ size = 20, color }: VariantProps) {
  const width = (size * VIEWBOX.w) / VIEWBOX.h;
  // Source stroke is 2 at viewBox-height 25.2; scale so it reads ~1.6px
  // regardless of render size (matches the thin SF Symbol strokes).
  const strokeWidth = (1.6 * VIEWBOX.h) / size;
  const common = {
    stroke: color,
    strokeWidth,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Svg
      width={width}
      height={size}
      viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
      fill="none"
    >
      <Path
        d="M9.51163 12.802L15.652 6.92443C15.9394 6.64934 16.3243 6.49968 16.722 6.50838C17.1197 6.51708 17.4977 6.68341 17.7728 6.9708C18.0479 7.25819 18.1976 7.64308 18.1889 8.04081C18.1802 8.43854 18.0138 8.81653 17.7264 9.09161L12.3085 14.2777"
        {...common}
      />
      <Path
        d="M12.6696 13.9319L14.1144 12.5489C14.2567 12.4127 14.4244 12.3059 14.608 12.2345C14.7916 12.1631 14.9875 12.1286 15.1844 12.1329C15.3814 12.1372 15.5755 12.1803 15.7558 12.2596C15.9361 12.3389 16.099 12.453 16.2352 12.5953C16.3714 12.7376 16.4783 12.9053 16.5497 13.0889C16.621 13.2725 16.6556 13.4684 16.6513 13.6653C16.647 13.8623 16.6039 14.0564 16.5246 14.2367C16.4452 14.417 16.3311 14.5799 16.1888 14.7161L14.3829 16.4448"
        {...common}
      />
      <Path
        d="M15.4665 15.4076C15.7538 15.1325 16.1387 14.9828 16.5365 14.9915C16.9342 15.0002 17.3122 15.1666 17.5873 15.454C17.8624 15.7413 18.012 16.1262 18.0033 16.524C17.9946 16.9217 17.8283 17.2997 17.5409 17.5748L16.4573 18.612"
        {...common}
      />
      <Path
        d="M16.8184 18.2661C17.1058 17.991 17.4907 17.8414 17.8884 17.8501C18.2862 17.8588 18.6642 18.0251 18.9392 18.3125C19.2143 18.5999 19.364 18.9848 19.3553 19.3825C19.3466 19.7802 19.1803 20.1582 18.8929 20.4333L15.6421 23.545C14.4925 24.6453 12.953 25.2439 11.362 25.2092C9.77112 25.1744 8.25919 24.509 7.15884 23.3595L5.77588 21.9147L5.9197 22.0649C5.23249 21.3472 4.73427 20.4701 4.4698 19.5123C4.20533 18.5544 4.18289 17.5459 4.40448 16.5773C4.43125 16.4609 4.45831 16.3445 4.48567 16.2283C4.61596 15.6716 5.23784 13.5606 6.35135 9.89367C6.46485 9.51987 6.71971 9.20509 7.06171 9.01629C7.40371 8.82749 7.80588 8.77956 8.18267 8.8827C8.58414 8.99244 8.93742 9.23317 9.18642 9.56666C9.43541 9.90016 9.56583 10.3073 9.55697 10.7234L9.51153 12.8018"
        {...common}
      />
      <Path d="M9.2591 4.656L9.23634 2.57196" {...common} strokeLinejoin={undefined} />
      <Path d="M12.2594 4.99506L13.8625 3.66324" {...common} strokeLinejoin={undefined} />
      <Path d="M6.23573 5.25336L4.63261 3.92154" {...common} strokeLinejoin={undefined} />
    </Svg>
  );
}
