/**
 * shouldOpenExternally — which chat links leave the app entirely.
 *
 * The negatives matter more than the positives here. A false positive hands a
 * stranger's URL straight to `Linking.openURL`, so the lookalike-host and
 * scheme cases below are the point of this file, not padding.
 */

import { shouldOpenExternally } from '@/utils/linkRouting';

describe('shouldOpenExternally — YouTube URLs must hand off', () => {
  it.each([
    // Playable content, every URL form.
    ['watch', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['watch, no www', 'https://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['watch on mobile host', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['watch with playlist', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij'],
    ['short link', 'https://youtu.be/dQw4w9WgXcQ'],
    ['short link with playlist', 'https://youtu.be/dQw4w9WgXcQ?list=PLabcdefghij'],
    ['shorts', 'https://www.youtube.com/shorts/dQw4w9WgXcQ'],
    ['embed', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['live', 'https://www.youtube.com/live/dQw4w9WgXcQ'],
    ['legacy /v/', 'https://www.youtube.com/v/dQw4w9WgXcQ'],
    ['playlist', 'https://www.youtube.com/playlist?list=PLabcdefghij'],
    ['nocookie embed', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['plain http', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['extra query params', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=share'],

    // Pages with nothing playable. These hand off TOO, and that is the point:
    // the in-app WebView has no YouTube session, so it gets the "confirm you're
    // not a bot" wall on these just like on a video. The browser and the
    // YouTube app both have the session.
    ['the bare homepage', 'https://www.youtube.com'],
    ['the bare homepage, no www', 'https://youtube.com'],
    ['the bare homepage with a slash', 'https://youtube.com/'],
    ['a channel handle page', 'https://www.youtube.com/@someuser'],
    ['a /channel/ page', 'https://www.youtube.com/channel/UCabcdefghijklmnop'],
    ['a /c/ vanity page', 'https://www.youtube.com/c/SomeChannel'],
    ['search results', 'https://www.youtube.com/results?search_query=cats'],
    ['watch with no video id', 'https://www.youtube.com/watch'],
    ['the subscriptions feed', 'https://www.youtube.com/feed/subscriptions'],

    // Other YouTube subdomains resolve to their own apps or the browser; either
    // is better than a session-less WebView.
    ['YouTube Music', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['YouTube Studio', 'https://studio.youtube.com/channel/UCabcdefghijklmnop'],
  ])('%s', (_label, url) => {
    expect(shouldOpenExternally(url)).toBe(true);
  });
});

describe('shouldOpenExternally — must NOT hand off', () => {
  it.each([
    // Ordinary links. These are the common case and belong in the in-app browser.
    ['a normal article', 'https://example.com/some/article'],
    ['a bare domain', 'https://example.com'],
    ['another video site', 'https://vimeo.com/123456789'],

    // Host confusion. A URL that merely CONTAINS "youtube.com" is not YouTube.
    // These are the cases that would hand a stranger's URL to the OS.
    ['youtube.com in a query param', 'https://example.com/go?u=https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['youtube.com in the path', 'https://example.com/youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a lookalike prefix host', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ'],
    ['a lookalike without the dot', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ'],
    ['a subdomain-attack host', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
    ['youtube.com as a userinfo trick', 'https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ'],
    ['youtu.be as a suffix of another host', 'https://notyoutu.be/dQw4w9WgXcQ'],

    // Scheme confusion. The host test looks only at the authority, so without
    // the scheme guard every one of these would be handed to the OS.
    ['an ftp URL with a youtube authority', 'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a javascript: URL', 'javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a custom app scheme', 'myapp://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a file URL', 'file://www.youtube.com/watch?v=dQw4w9WgXcQ'],

    // Junk input.
    ['not a URL at all', 'youtube.com/watch?v=dQw4w9WgXcQ'],
    ['empty string', ''],
  ])('%s', (_label, url) => {
    expect(shouldOpenExternally(url)).toBe(false);
  });

  it('handles null and undefined without throwing', () => {
    expect(shouldOpenExternally(null)).toBe(false);
    expect(shouldOpenExternally(undefined)).toBe(false);
  });
});
