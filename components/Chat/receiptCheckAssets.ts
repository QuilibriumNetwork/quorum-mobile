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
 * Intrinsic pixel sizes (left-anchored, same check glyph size in both):
 *   single: 89 x 64   double: 120 x 64
 */

export const RECEIPT_CHECK_SINGLE_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFkAAABACAYAAABx0tv8AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAAYpJREFUeAHt3NFNw0AQhOEpgRJcAiWkFDqADnAHoQNPJ5RACZRACWCLrECQRD77drNnzyfts29/OXmxZUBq6E4jDh7HeR/n8zQf4wxQ8Gqe8RP370zhO8gq1wLbvEIWmxPY5g5SrCTwNAdIkdLAilxoSWD9XRRYGniAzLI08Bt0F8+iwM4U2JkCO1NgZwrsTIGdKbAzBXamwM4U2JkCO1NgZwrsTIGdKbCzlIEP+H5hYxinR9vPqFIGPl646ID2fjZNBQ65eGUpA3cZDlFJysCTp0yHWSFt4EmPhIcqlDrwpOROzhg6feDJPRo45AVNBDYvaC90U4EN0c6hmwxsiPyHbzqwIfIusYnAhsi3zKYCGyLPUpsMbIjbL7fpwIa43ZK7CGyI+GV3FdgQcUvvMrAh/JffdWBD+EVQ4F+I+jEU+AyiXhQFvoJYH0eBZyCWRzpCgWcjlsVS4EKEAocgFDgEocAhCAUOQShwCEKBQxAKHIJQ4BCEAocgFDjEA/5/37KHArvooO9ZSi1fGbSY8Lt2I/cAAAAASUVORK5CYII=';

export const RECEIPT_CHECK_DOUBLE_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABACAYAAADRTbMSAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAAlpJREFUeAHt3eGR0kAYh/HHDujAlHAdeCXQgW8H2sFRgh2AFWgHaAXaQexAO9DshMwwyJFks+9uWP7PzPuBmRuW29/BkZlAQFXdG9SSNt287+bpdPtbN9+7+UWerq3/GZWksKm/u/l7MW03W/z7cGP9J9SiXsM9n2f8ehlZOzy2BhXVFNwwR3wawx3mE2p2U3GH2ZC2qbjDs1jNaC5umIZ0zcEdRk0sBjflMzgGt0VNKhb3SJpicMPsUaPF4qZ6FxuL26J30aMtwU1xHCpcx4RbccKtOOFWnHArTrgVJ9yKE27FCbfihFtxwq044VaccCtOuBUn3IoT7pU21PGXI9yLnulPMzlfbM99Ygv3ou3Iovd0prxwL2oY35BUv7x3wr3SR/JuglfCfaUv5N+M1An3RgfKbEqqhDvSjnKbszThTigc95bcpNiEOyMj7sGWQhZuRMZ9IAt3Qca6kYWbIGOdyMJNmLEuZOE6ZKwDWbiOGWWRhZshowyycDNm5EUWboGMPMjCLZjhiyzcFWT4IAt3RRlpkYW7wow0yJ64G/pvZd3Tn9iw438Q4d7IWIbsiXvrvl9OPyPcCRnxyF64zYT7PkY+7pYH/MSBEbdZHrihg9P6LQ/8cRJjHbgQ98og3AkZ5XFxWF+4ZxllcUNtwvWFeyWjHG5ol2h94d7IKIMbCse/LcJ1z8iPO9QQjyzcGRn5cYeabn4gXPeM/LhD4eX6gHDdM/LjnrdDuO5tuf5/Mdd51TseDLfExSkb+q+LeHe6/ZP+gop/yFND/2ry9nQ7XEzya8b1lUrXP3TIA69oT6/4AAAAAElFTkSuQmCC';

/** width / height of each source asset — multiply by render height for width. */
export const RECEIPT_CHECK_SINGLE_ASPECT = 89 / 64;
export const RECEIPT_CHECK_DOUBLE_ASPECT = 120 / 64;
