/**
 * A link in the feed is downloaded once, whatever asks about it.
 *
 * ## The regression this pins
 *
 * Snap detection GETs the link to read its content type, and the link preview
 * GETs it again to parse its OpenGraph tags. React Native's `fetch` downloads
 * the whole body before it resolves, so every plain link was downloaded twice,
 * and the two requests for the same URL weren't shared between cells.
 *
 * ## What is asserted
 *
 * - Snap detection and the metadata share one request, also when asked at once.
 * - That request asks for a snap first, then a page.
 * - A snap response is recognised; a page's metadata is parsed from the same body.
 * - Failures are answered (and cached) as "not a snap, no metadata".
 */
import { fetchUrlMetadata, getCachedLinkProbe, probeLink, __resetLinkProbes } from '@/hooks/useOgMetadata';
import { isSnapUrl } from '@/components/SocialFeed/content/SnapEmbed';

jest.mock('@quilibrium/quorum-shared', () => ({ logger: { debug: jest.fn(), warn: jest.fn() } }));

const PAGE = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Yoink &amp; Run" />
  <meta property="og:image" content="https://example.invalid/card.png" />
</head><body>…</body></html>`;

function response(contentType: string, body: string, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

// The probe streams through `expo/fetch`, not the global `fetch`.
const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
// Its answers are kept on disk; an in-memory MMKV stands in.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    createMMKV: () => ({
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => void store.set(k, v),
      remove: (k: string) => store.delete(k),
      getAllKeys: () => [...store.keys()],
      clearAll: () => store.clear(),
    }),
  };
});

beforeEach(() => {
  __resetLinkProbes();
  mockFetch.mockReset();
});

it('answers snap detection and the metadata from one request', async () => {
  mockFetch.mockResolvedValue(response('text/html; charset=utf-8', PAGE));

  const [isSnap, metadata] = await Promise.all([
    isSnapUrl('https://example.invalid/post'),
    fetchUrlMetadata('https://example.invalid/post'),
  ]);
  await fetchUrlMetadata('https://example.invalid/post');

  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(isSnap).toBe(false);
  expect(metadata).toMatchObject({
    domain: 'example.invalid',
    title: 'Yoink & Run',
    image: 'https://example.invalid/card.png',
  });
  const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
  expect(headers.accept.startsWith('application/vnd.farcaster.snap+json,text/html')).toBe(true);
});

it('recognises a snap and caches the answer', async () => {
  mockFetch.mockResolvedValue(response('application/vnd.farcaster.snap+json', '{"version":"1"}'));

  expect(await isSnapUrl('https://snap.invalid/')).toBe(true);
  expect(await fetchUrlMetadata('https://snap.invalid/')).toBeNull();
  expect(getCachedLinkProbe('https://snap.invalid/')).toEqual({ isSnap: true, metadata: null });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it('treats a failed or non-page response as a plain link, once', async () => {
  mockFetch.mockRejectedValueOnce(new Error('offline'));
  mockFetch.mockResolvedValueOnce(response('image/png', ''));
  mockFetch.mockResolvedValueOnce(response('text/html', PAGE, 404));

  for (const url of ['https://a.invalid/', 'https://b.invalid/x.png', 'https://c.invalid/gone']) {
    expect(await probeLink(url)).toEqual({ isSnap: false, metadata: null });
    expect(await probeLink(url)).toEqual({ isSnap: false, metadata: null });
  }
  expect(mockFetch).toHaveBeenCalledTimes(3);
});
