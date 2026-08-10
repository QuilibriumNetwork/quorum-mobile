/**
 * Link routing — decides whether a URL should leave the app entirely instead of
 * opening in the in-app browser.
 *
 * Deliberately pure (no React, no react-native): the predicate is the part worth
 * unit-testing, and keeping `Linking` out of here means the tests exercise the
 * real decision rather than a mock. The act of opening lives in `useOpenLink`.
 *
 * Only YouTube hands off today. There is no curated domain list: every extra
 * domain is a judgement call users disagree about, so the bar for adding one is
 * "the native app is unambiguously better", not "the site has an app".
 */

/** Schemes we are willing to hand to the OS from a chat link. */
const HANDOFF_SCHEMES = new Set(['http:', 'https:']);

/** Registrable domains that mean "this is YouTube". */
const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'];

/**
 * True when `host` is one of the YouTube domains, or a subdomain of one
 * (`www.`, `m.`, `music.`, `studio.`).
 *
 * The leading dot in the suffix test is what makes this safe. `evilyoutube.com`
 * ends with `youtube.com` but not with `.youtube.com`, and
 * `youtube.com.evil.example` ends with neither — both are correctly rejected.
 */
function isYouTubeHost(host: string): boolean {
  const h = host.toLowerCase();
  return YOUTUBE_DOMAINS.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

/**
 * True when the URL should be handed to the OS (which resolves it to the owning
 * native app via Universal Links / Android App Links, falling back to the
 * default browser) rather than loaded in the in-app browser.
 */
export function shouldOpenExternally(url: string | undefined | null): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Scheme check first, and it is not a formality. The host test below looks
  // only at the authority, so `ftp://youtube.com/watch?v=x` — or any custom
  // scheme with a youtube.com authority — would otherwise match and be handed
  // straight to `Linking.openURL`. Chat URLs come from strangers; pin the
  // scheme before anything else looks at the string.
  if (!HANDOFF_SCHEMES.has(parsed.protocol)) return false;

  // Any YouTube URL, not just a playable video.
  //
  // This started out narrower — watch/shorts/playlist only, on the assumption
  // that channel and search pages were fine in the in-app browser. They are
  // not: testing showed the bare homepage hits the same "confirm you're not a
  // bot" wall. The reason generalises, which is why the rule does too — the
  // wall is there because our WebView carries no YouTube session, and no
  // YouTube page is better off without one. The browser and the YouTube app
  // both have that session.
  return isYouTubeHost(parsed.hostname);
}
