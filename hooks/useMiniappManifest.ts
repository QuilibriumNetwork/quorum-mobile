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
 * Results cached with `gcTime: Infinity` since the manifest changes
 * rarely and a miss for a non-miniapp URL is itself a useful cache.
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

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

export async function fetchMiniappManifest(url: string): Promise<MiniappManifest | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const manifestUrl = `${origin}/.well-known/farcaster.json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(manifestUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);

  if (!res.ok) return null;
  // Some hosts serve HTML on 404-as-200 (SPA index.html); short-circuit
  // before trying to parse JSON.
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !contentType.includes('json') && !contentType.includes('text/plain')) {
    return null;
  }
  let body: RawManifest;
  try {
    body = (await res.json()) as RawManifest;
  } catch {
    return null;
  }

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

export function useMiniappManifest(
  url: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? true) && Boolean(url);
  return useQuery({
    queryKey: ['farcaster-miniapp-manifest', url],
    queryFn: () => fetchMiniappManifest(url as string),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  } satisfies UseQueryOptions<MiniappManifest | null, Error>);
}
