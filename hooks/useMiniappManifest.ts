/**
 * useMiniappManifest — probe a URL's host for a Farcaster miniapp
 * manifest at `<origin>/.well-known/farcaster.json` and parse out the
 * launch metadata (name, icon, splash, button title).
 *
 * Hypersnap-sourced embeds arrive as bare URLs without OG enrichment,
 * so the renderer has no way to tell a miniapp link from a generic
 * webpage. The manifest probe gives us a direct, host-level signal:
 * if it's present, the link is a miniapp and we can render the
 * frame-style card.
 *
 * Caveat: many miniapps don't self-host the manifest (it's discovered
 * via farcaster.xyz's directory). This hook only catches self-hosted
 * manifests; an indirection through farcaster.xyz is still needed for
 * the rest.
 *
 * The manifest belongs to the origin, not the link, so answers are cached per
 * origin: ten links to one site cost one request, and a site without a
 * manifest (often an SPA that answers the path with its whole index page) is
 * asked once. Answers, found or not, are kept a day across launches since the
 * manifest changes rarely and a miss is itself a useful cache.
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { fetchCapped, isTransientStatus, type CappedResponse } from '@/services/farcaster/cappedFetch';
import { createPersistedTtlCache } from '@/services/offline/persistedTtlCache';

export interface MiniappManifest {
  /** Domain origin the manifest was fetched from. */
  origin: string;
  name: string;
  iconUrl: string;
  /** URL the launch button targets. Falls back to origin when the
   *  manifest omits it. */
  homeUrl: string;
  imageUrl?: string;
  buttonTitle?: string;
  splashImageUrl?: string;
  splashBackgroundColor?: string;
}

interface RawManifest {
  miniapp?: RawFrame;
  frame?: RawFrame;
}
interface RawFrame {
  version?: string;
  name?: string;
  iconUrl?: string;
  homeUrl?: string;
  imageUrl?: string;
  buttonTitle?: string;
  splashImageUrl?: string;
  splashBackgroundColor?: string;
}

const FETCH_TIMEOUT_MS = 5_000;
/** Manifests are a few hundred bytes of JSON. Anything near this is not one,
 *  and its body is not downloaded past it. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Answers per origin, `null` for "no manifest", kept a day across launches.
 *  Bounded, oldest first out. */
const manifestStore = createPersistedTtlCache<MiniappManifest | null>({
  prefix: 'miniapp-manifest:v1:',
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 200,
});
const manifestsInFlight = new Map<string, Promise<MiniappManifest | null>>();

/** The origin a manifest would be served from; null for anything not on the
 *  web (whose `origin` is the string "null"). */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Some hosts serve HTML on 404-as-200 (SPA index.html); only JSON, or a
 *  server too plain to say, is worth reading. */
function mayBeJson(contentType: string): boolean {
  return !contentType || contentType.includes('json') || contentType.includes('text/plain');
}

/**
 * The miniapp manifest of `url`'s origin, or null when it publishes none.
 * Concurrent callers for one origin share one request.
 */
export function fetchMiniappManifest(url: string): Promise<MiniappManifest | null> {
  const origin = originOf(url);
  if (!origin) return Promise.resolve(null);
  const cached = manifestStore.get(origin);
  if (cached !== undefined) return Promise.resolve(cached);
  const inFlight = manifestsInFlight.get(origin);
  if (inFlight) return inFlight;
  const request = fetchOriginManifest(origin)
    .catch(() => ({ manifest: null, lasting: false }))
    .then(({ manifest, lasting }) => {
      // Failures of the moment (offline, timed out, a 5xx) aren't kept; the
      // query's own cache answers them for this session.
      if (lasting) manifestStore.set(origin, manifest);
      manifestsInFlight.delete(origin);
      return manifest;
    });
  manifestsInFlight.set(origin, request);
  return request;
}

async function fetchOriginManifest(
  origin: string,
): Promise<{ manifest: MiniappManifest | null; lasting: boolean }> {
  let res: CappedResponse;
  try {
    res = await fetchCapped(`${origin}/.well-known/farcaster.json`, {
      headers: { accept: 'application/json' },
      maxBytes: MAX_MANIFEST_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      wantsBody: ({ ok, contentType }) => ok && mayBeJson(contentType),
    });
  } catch {
    return { manifest: null, lasting: false };
  }
  if (!res.ok) return { manifest: null, lasting: !isTransientStatus(res.status) };
  if (!mayBeJson(res.contentType)) return { manifest: null, lasting: true };
  if (res.bodyFailed) return { manifest: null, lasting: false };
  return { manifest: parseManifest(origin, res.text), lasting: true };
}

function parseManifest(origin: string, text: string): MiniappManifest | null {
  let body: RawManifest;
  try {
    // A body cut off at the cap doesn't parse, and is rejected here.
    body = JSON.parse(text) as RawManifest;
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;

  const frame = body.miniapp ?? body.frame;
  if (!frame || !frame.name) return null;
  // `homeUrl` is required by the spec but missing in some real-world
  // manifests; fall back to the origin so the launch action still has
  // somewhere to send the user.
  const homeUrl = frame.homeUrl ?? origin;
  if (!frame.iconUrl) return null;

  return {
    origin,
    name: frame.name,
    iconUrl: frame.iconUrl,
    homeUrl,
    imageUrl: frame.imageUrl,
    buttonTitle: frame.buttonTitle ?? 'Open',
    splashImageUrl: frame.splashImageUrl,
    splashBackgroundColor: frame.splashBackgroundColor,
  };
}

/** Test reset. `keepPersisted` forgets only what a relaunch forgets. */
export function __resetMiniappManifests(options: { keepPersisted?: boolean } = {}): void {
  if (options.keepPersisted) manifestStore.forgetInMemory();
  else manifestStore.clear();
  manifestsInFlight.clear();
}

export function useMiniappManifest(
  url: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? true) && Boolean(url);
  // Keyed by origin, so every link to one site shares one answer. A URL with
  // no origin keys itself and answers null.
  const origin = url ? originOf(url) : null;
  return useQuery({
    queryKey: ['farcaster-miniapp-manifest', origin ?? url],
    queryFn: () => fetchMiniappManifest(url as string),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
    // Kept a day like the link metadata; an unbounded gcTime let every link
    // ever seen pile up in the query cache (and the persisted copy).
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  } satisfies UseQueryOptions<MiniappManifest | null, Error>);
}
