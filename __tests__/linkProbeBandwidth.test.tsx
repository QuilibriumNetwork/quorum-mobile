/**
 * A link in the feed costs the bytes the probe reads, once a day.
 *
 * ## The regression this pins
 *
 * The feed probes each link in a cast: is it a snap, what are its OpenGraph
 * tags, does its site publish a mini-app manifest. React Native's global
 * `fetch` (whatwg-fetch) has no body stream and resolves only once the whole
 * body has arrived, so the probe's 64 KB cap never applied: every page was
 * downloaded whole, and a link to a video downloaded the video until the
 * five-second timeout, because the content type was checked after the body.
 * The manifest was fetched once per link rather than once per site, and an SPA
 * answers that path with its whole index page. Nothing survived a relaunch,
 * so every link was probed again on every launch. Measured: about 110 KB per
 * x.com link.
 *
 * ## What is asserted
 *
 * - A response that isn't a page is aborted on its headers; none of its body
 *   is read.
 * - A page is read up to the cap, then the stream is cancelled and the
 *   request aborted.
 * - iOS asks for only that range; Android doesn't (OkHttp drops gzip when it
 *   does), and neither sends cookies.
 * - Two links on one site cost one manifest request, through the hook too; an
 *   HTML answer to the manifest path isn't read.
 * - After a relaunch, a link or site answered last session costs no request;
 *   a failure of the moment (offline, a 5xx) is asked again.
 * - Answers expire after a day.
 */
import React from 'react';
import { Platform } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetLinkProbes, fetchUrlMetadata, getCachedLinkProbe, probeLink } from '@/hooks/useOgMetadata';
import { __resetMiniappManifests, fetchMiniappManifest, useMiniappManifest } from '@/hooks/useMiniappManifest';

const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

// The cache's MMKV store, as a map this test can look into.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    createMMKV: () => ({
      getString: (k: string) => store.get(k),
      set: (k: string, v: string) => void store.set(k, v),
      remove: (k: string) => store.delete(k),
      getAllKeys: () => [...store.keys()],
      clearAll: () => store.clear(),
    }),
  };
});
const disk: Map<string, string> = jest.requireMock('react-native-mmkv').__store;

const CAP = 64 * 1024;
const DAY = 24 * 60 * 60 * 1000;

const HEAD = `<!doctype html><html><head>
  <meta property="og:title" content="A long page" />
  <meta property="og:image" content="https://example.invalid/card.png" />
</head><body>`;

/** A streamed response that counts how much of its body was pulled. */
function streamed(contentType: string, body: string, status = 200, chunkSize = 16 * 1024) {
  const bytes = new TextEncoder().encode(body);
  let delivered = 0;
  let bodyTouched = false;
  const cancel = jest.fn(async () => {});
  const reader = {
    read: async () => {
      if (delivered >= bytes.length) return { done: true, value: undefined };
      const value = bytes.subarray(delivered, delivered + chunkSize);
      delivered += value.length;
      return { done: false, value };
    },
    cancel,
  };
  const text = jest.fn(async () => body);
  const json = jest.fn(async () => JSON.parse(body));
  const res = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    get body() {
      bodyTouched = true;
      return { getReader: () => reader };
    },
    text,
    json,
  };
  return {
    res,
    cancel,
    wholeBodyRead: () => text.mock.calls.length + json.mock.calls.length > 0,
    delivered: () => delivered,
    bodyTouched: () => bodyTouched,
  };
}

function init(call: number): { headers: Record<string, string>; signal: AbortSignal; credentials?: string } {
  return mockFetch.mock.calls[call][1];
}

/** What survives a relaunch: the disk, not the memory. */
function relaunch(): void {
  __resetLinkProbes({ keepPersisted: true });
  __resetMiniappManifests({ keepPersisted: true });
}

beforeEach(() => {
  __resetLinkProbes();
  __resetMiniappManifests();
  disk.clear();
  mockFetch.mockReset();
  jest.restoreAllMocks();
});

describe('link probe', () => {
  it('aborts a response that is not a page without reading its body', async () => {
    const video = streamed('video/mp4', 'x'.repeat(5 * 1024 * 1024));
    mockFetch.mockResolvedValue(video.res);

    expect(await probeLink('https://cdn.invalid/clip.mp4')).toEqual({ isSnap: false, metadata: null });

    expect(video.bodyTouched()).toBe(false);
    expect(video.wholeBodyRead()).toBe(false);
    expect(video.delivered()).toBe(0);
    expect(init(0).signal.aborted).toBe(true);
  });

  it('recognises a snap from its content type alone', async () => {
    const snap = streamed('application/vnd.farcaster.snap+json', '{"version":"1"}');
    mockFetch.mockResolvedValue(snap.res);

    expect(await probeLink('https://snap.invalid/')).toEqual({ isSnap: true, metadata: null });
    expect(snap.bodyTouched()).toBe(false);
  });

  it('reads a page only up to the cap, then cancels and aborts', async () => {
    const page = streamed('text/html; charset=utf-8', HEAD + 'y'.repeat(400 * 1024));
    mockFetch.mockResolvedValue(page.res);

    const metadata = await fetchUrlMetadata('https://example.invalid/article');

    expect(metadata).toMatchObject({ title: 'A long page', image: 'https://example.invalid/card.png' });
    expect(page.delivered()).toBeLessThanOrEqual(CAP);
    expect(page.wholeBodyRead()).toBe(false);
    expect(page.cancel).toHaveBeenCalled();
    expect(init(0).signal.aborted).toBe(true);
  });

  it('asks for only the capped range on iOS, never on Android, and sends no cookies', async () => {
    mockFetch.mockImplementation(async () => streamed('text/html', HEAD).res);

    jest.replaceProperty(Platform, 'OS', 'ios');
    await probeLink('https://a.invalid/');
    jest.replaceProperty(Platform, 'OS', 'android');
    await probeLink('https://b.invalid/');

    expect(init(0).headers.range).toBe(`bytes=0-${CAP - 1}`);
    expect(init(1).headers.range).toBeUndefined();
    expect(init(0).credentials).toBe('omit');
    expect(init(1).credentials).toBe('omit');
    // The snap-first accept header and browser UA are unchanged.
    expect(init(1).headers.accept.startsWith('application/vnd.farcaster.snap+json,text/html')).toBe(true);
    expect(init(1).headers['user-agent']).toMatch(/Safari/);
  });

  it('answers from disk after a relaunch, without a request', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.endsWith('.mp4') ? streamed('video/mp4', 'v').res : streamed('text/html', HEAD).res,
    );
    await probeLink('https://example.invalid/kept');
    await probeLink('https://example.invalid/clip.mp4');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    relaunch();

    // Synchronously, as the snap detector asks on first render.
    expect(getCachedLinkProbe('https://example.invalid/kept')?.metadata?.title).toBe('A long page');
    expect(await fetchUrlMetadata('https://example.invalid/kept')).toMatchObject({ title: 'A long page' });
    // "Not a page" is an answer too, and is kept.
    expect(await probeLink('https://example.invalid/clip.mp4')).toEqual({ isSnap: false, metadata: null });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('asks again after a relaunch when the last answer was a failure of the moment', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    mockFetch.mockResolvedValueOnce(streamed('text/html', 'busy', 503).res);
    await probeLink('https://a.invalid/');
    await probeLink('https://b.invalid/');
    // Within the session the failure is still answered from memory.
    await probeLink('https://a.invalid/');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    relaunch();
    mockFetch.mockImplementation(async () => streamed('text/html', HEAD).res);
    expect((await probeLink('https://a.invalid/')).metadata?.title).toBe('A long page');
    expect((await probeLink('https://b.invalid/')).metadata?.title).toBe('A long page');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('forgets an answer after a day', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    mockFetch.mockImplementation(async () => streamed('text/html', HEAD).res);
    await probeLink('https://example.invalid/');

    clock.mockReturnValue(now + DAY + 1);
    relaunch();
    await probeLink('https://example.invalid/');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('mini-app manifest', () => {
  const MANIFEST = JSON.stringify({ miniapp: { name: 'App', iconUrl: 'https://app.invalid/icon.png' } });

  it('costs one request for two links on one site', async () => {
    mockFetch.mockImplementation(async () => streamed('application/json', MANIFEST).res);

    const [a, b] = await Promise.all([
      fetchMiniappManifest('https://app.invalid/one'),
      fetchMiniappManifest('https://app.invalid/two?ref=feed'),
    ]);
    await fetchMiniappManifest('https://app.invalid/three');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://app.invalid/.well-known/farcaster.json');
    expect(a).toMatchObject({ origin: 'https://app.invalid', name: 'App', homeUrl: 'https://app.invalid' });
    expect(b).toEqual(a);
  });

  it('shares one answer between cells showing links to one site', async () => {
    mockFetch.mockImplementation(async () => streamed('application/json', MANIFEST).res);
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const one = renderHook(() => useMiniappManifest('https://app.invalid/one'), { wrapper });
    const two = renderHook(() => useMiniappManifest('https://app.invalid/two'), { wrapper });
    await waitFor(() => expect(one.result.current.data?.name).toBe('App'));
    await waitFor(() => expect(two.result.current.data?.name).toBe('App'));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().findAll({ queryKey: ['farcaster-miniapp-manifest'] })).toHaveLength(1);
    // Unmounted before clearing, so no day-long gc timer outlives the test.
    one.unmount();
    two.unmount();
    client.clear();
  });

  it('does not read an HTML answer, and remembers the site has no manifest', async () => {
    const spa = streamed('text/html; charset=utf-8', '<html>' + 'z'.repeat(80 * 1024));
    mockFetch.mockResolvedValue(spa.res);

    expect(await fetchMiniappManifest('https://spa.invalid/post/1')).toBeNull();
    expect(spa.bodyTouched()).toBe(false);
    expect(init(0).signal.aborted).toBe(true);

    relaunch();
    expect(await fetchMiniappManifest('https://spa.invalid/post/2')).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads a manifest only up to the cap', async () => {
    const huge = streamed('application/json', `{"miniapp":{"name":"${'n'.repeat(200 * 1024)}"}}`);
    mockFetch.mockResolvedValue(huge.res);

    expect(await fetchMiniappManifest('https://big.invalid/')).toBeNull();
    expect(huge.delivered()).toBeLessThanOrEqual(CAP);
    expect(huge.wholeBodyRead()).toBe(false);
    expect(init(0).signal.aborted).toBe(true);
  });

  it('asks again after a relaunch when the site could not be reached', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchMiniappManifest('https://app.invalid/')).toBeNull();

    relaunch();
    mockFetch.mockImplementation(async () => streamed('application/json', MANIFEST).res);
    expect(await fetchMiniappManifest('https://app.invalid/')).toMatchObject({ name: 'App' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
