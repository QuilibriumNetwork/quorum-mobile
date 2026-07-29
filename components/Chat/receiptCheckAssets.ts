/**
 * Read/delivery receipt check glyphs, embedded as base64 data-URIs.
 *
 * WHY data-URI and not a file under `assets/`: a data-URI source lives in the
 * JS bundle (a string), so it never passes through expo-updates asset-embedding
 * (`createReleaseUpdatesResources` / `app.manifest`). That sidesteps the
 * stale-manifest bug that blanked `apex-metallic` in local release builds
 * (see .agents/tasks/2026-07-23-inline-dm-receipts-mobile.md, apex lesson).
 *
 * Both are flat black (#000) shapes on transparent bg — templates. Color is
 * applied at render time via the <Image> `tintColor` style, so they follow the
 * theme. Rendered inline inside <Text> so the tick flows with the message text.
 *
 * The checks do NOT fill their canvas: they are centered in a 64px-tall box with
 * transparent padding above and below, so this asset renders at the same box
 * height as every other trailing glyph (see trailingGlyphs.ts) while the checks
 * stay optically smaller than, say, the unsigned warning triangle. That padding
 * is what lets one shared baseline nudge align the whole group. Re-exporting
 * these without the padding will silently break that alignment.
 *
 * Intrinsic pixel sizes (left-anchored, same check glyph size in both):
 *   single: 61 x 64 (checks 61 x 44)   double: 82 x 64 (checks 82 x 43)
 */

export const RECEIPT_CHECK_SINGLE_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAD0AAABACAYAAACp3n/2AAADo0lEQVR42u2a24tNURzHP3tmjJnBDEqhpDx58kCRW+Q2MWmI3IrGiBo1I/EPeJRHL1JSZgyD0Gg0TUhIQvIHeCKXXBJGmMvZHqxf/dqdvfeaM+e2t/Wr3dmtc9n7uz6/y9q/s8CZM2fOnDlz5sxZaa0yhZo8oALwgQVAEzAfyACf0g5yH/DFiPeB90BLGglXmfMWQ9YHhszhA7+ARWkkvBf4bUSPKNIivKMqJYQrjcC9wDlgghGoc1aFeW1Ii2CAPcZ9fWBUEfYN9WHz2ph00eKpuyIE+0awD5wBqtMQw7tNDPsqeelD4vqCcvFEE94B/LQgfNEQrjAhkdiytFMRHo0g3KWEekl26W3Aj4A4nbRk7DIwUa3SEkt4e0wMi0tfMqXLSzrhrcB3C5e+Yggn1qWFcDMwaJG0rgI1SXVpTbhZxXA2wTJ2TdXhRBNuAr6FJC1N+AZQNxbC8kF9lIPgzTGEZRKum6RlTTjsQxUlFrwR+GpBuBeYnEsMe8AW4CRwAlioYsorgeBNloRv5hrDtcDpwI8OAu1FJi5Ja4PqeIxECO4DJuV6j3vUQ/ZoYGaPKQJeEQg3xtRhcelb4xEM0GlWNqOBEiCrneMFdnUhvF4RjipLt8crOEy0Hxg7UqDuqRBeG+PSQrgfqM9H2LWqH85kES5jR/Ps6tkERxHuzwdhncjORsyyJt6eJ+IieDXw0YLwHWBqvr2tEjivLp6JEN4xTuIieE0MYZmEAUU4bzlFugkTTEslSriMHc5x1kXwSuCDBeF7wLRClU4RXm0Sm75wNuIZoC0gxFbwKuCzBeG7wJRCrxU8dXNdMTEu522WxOX95cA7i4XHfWB6sRZH8rBRA3RbEB8BDsYQl/EVKmlFLTy04Mpitmbkgt2WxA+FCJebXqYIR5WlB4WMYZts7pnn054Y4dKIaw0IF8FLgLcWSesRMKPUfyHrGO+xzOoHzHekP7WUf3+RhgkWwg9LSTjsmbrOtGLiiA8D+813FgOvLQg/AWaW2yYBEV6jhA9HxPgQcAp4ZVGWHhczS+cqvNa0ZmySW5zgp+VIOEz4ZNOxsFnAhAl+Ug5Ja6zJrVYJz0bcj0haz4BZ5erSceWs3nQwwohnS1rPgNlJ3dmkY7w3opxpws+TSDhsPd1gWjjZGhGyueUlMCcte9d0He9TZIdVrL9QhFOzWU/v2ukMuPYAMLfcBHt5FJ4x5+uAecAb0wT4E3jfmTNnzpw5c+bM2X9vfwELiTrmywWDIwAAAABJRU5ErkJggg==';

export const RECEIPT_CHECK_DOUBLE_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFIAAABACAYAAACJMiALAAAFoElEQVR42u2b+4tVVRTHP+ee28PSssnKqSwrItMeJJZFD8nIoqioKJQkjAp7gL/1Wz/1F0QY9EQqVIgmTOllI1pN0/gYGU0jopeElWWYYxaNnXv74a5Ni8N5rHNnrnPPZS+43Ln3wjp7f/dn7bX2Y8CbN2/evHnz5s2bN2/evLWfVeR9FvAi8DHwPHClfB+M0u9sYDnwqbzP6EQRq/I+B9gL1NXrZ2B+TBSrhfK+EDgQ87sXmNuJJM4R0erAv0ANGJHPWwuKGKjBeUD81YEj4veIfN7UaSReAfyoRHTU1IAIOARMKRDimsTDCX7r4rfeSSTOViRGsc46IQ8CkwxCahIXKqJrKX5/7xQSLwP2pBBTVyH4nJFGR+L9isQowa971vIyixiqcP4po7NOxB7geBGxYhic+4C/M/w6SlcDE8su4iXADxkkuu/WABMMNIZKxCwS3XdvAseWXcTLVYmTFc7vACcYyh5H4j3AnwYSe2RwgibKqbYRcRbwvYHEtUYSnYj3An+lJBbt9y1FYlBWES/NCWdH4rsqQ1tIvAsYzvA7oqaJE8tKomvwTOA7QxZdp0i0iHi3IjHLb48isVLWEmcm8G2MuiQSPwBOMnTWEX4H8IeB8LVCImUm8eIcEnU4FyHxTiOJa4Djyk7ihcDXBhLXAycXIPF2RWLeNDGxqIhBm5E4Q5GYFXbvGztbVSIeMpQ461TpFBZpuBY0GOfsfAHwlaHE+aggibcZSXxPDU5QhMIKcIYso8aLUNfZi4BvDCRqEUOD31tyRBxRIk5qZk5cIHt1w8B+4JlxSPOus+cDXxpI7FUiWortW3NEjNQ00VR2vkbNF/q1WmWq4CiJqBNLFokbga4Cc+LNstWVV2xbE1airYw9QO8orwKOaTGZzu95RhI3GOvEqoo2y5z44WjrxAF5QC1l9Fe3cF1ZVeG821DifML/O9yhwe9NwG8GwnuBU0YLzCrDg96IJaWxJHG6EjGLxI3GsNPhfMBA4vpm6sQku0r23mo5Yq4UMseiNHI0nQvsNJD4GXBagRLnRuBX4+B0jSUgi2JzZFqHXlMiBi0mUYfz5ALhPN9IYq+xdCrcsUU0ttajnPXs65KAglGcD58FDGWQ6DrbD5xegMR5wD6DiJvGmsR4QxbnkOl+W9EEmRUVzrsMJPYVTCzzchLLSIKIIbRuk2Ax8I86akzr6AppSFDgVO5MYNAwd31ekMQbckiM1DTR1eqFRqAa9qASLCtEXlUNCnI6e44xsQzIUtVK4rXALwYS+1TCCmmx6YPxJapzSQfj7reXRcykOdN97jaSOGAk0bXxepWdswb8qJCYReYSGdFaTkNfUWIGCYll0EDioIQ+asoI1d9xEa/GdorYbyS85WI+rIjMKo1eSAjnqcA2AzGbYyQGKclKh7MlO/cBp46XiEnz20NCZpTT8JdUZ7tFoLwSZ7tQS4y+Ko3rctfFtvbmknxRKmmamNoOIsbJfDQ2R2bdr5ku23J5YbclFnaBusszINt6h0XsBTQuSu0ziNjfLiSmkfmIiBDllBmW3ZYh4OyEcJ6idsb166AxnLdINLTlQZUmc6miMonMmuG0L55YdBJZqsqWKGEPIGtne7MK5yq0/22Hx6RzaWRmrYp2ANMSiHH7nk/H9kTrOQMXqdu43WU5MtW14uM5HUwicUgK86S5q6oO7GvqenGWXyf2tljCKoXpMH9C1ZhpnXbE7EwhMcn327G72ll+B8tEYhaZTyoxoxQSd8lRQh4xLuFMpnFrIo14Tfi0spGYReay2Fyol5BfqHCuFDgengA8q+iL+92uElaFDrBQzZnDMXJ20ziPKUqMXtk8lRDWQ7Id1zYkhmN4/rJVXu7fMHok7PfI77UmfAZyzLBD2rqfxiXPZbK6CeV53rx58+bNmzdv3rx58+bNW7vYf1iU2U5yE6mDAAAAAElFTkSuQmCC';

/** width / height of each source asset — multiply by render height for width. */
export const RECEIPT_CHECK_SINGLE_ASPECT = 61 / 64;
export const RECEIPT_CHECK_DOUBLE_ASPECT = 82 / 64;
