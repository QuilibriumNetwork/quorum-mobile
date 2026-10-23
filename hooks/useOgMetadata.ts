/**
 * useOgMetadata — fetch a URL's HTML and parse its <head> for OpenGraph
 * (and Twitter card) metadata plus any `fc:miniapp` / `fc:frame` meta
 * tags. Used to enrich bare URLs from hypersnap (which doesn't run
 * server-side OG scraping) so they render as proper link previews +
 * miniapp launch cards.
 *
 * Why parse HTML in JS instead of using a service:
 *   - No third-party dependency / API key.
 *   - React Native's `fetch` doesn't enforce CORS so we get the raw
 *     bytes directly.
 *   - The metadata sits in the <head>; the first few KB of any page is
 *     enough — only the first MAX_HTML_BYTES are downloaded.
 *
 * Cached aggressively, a day on disk (see `probeStore`), since page metadata
 * changes rarely and a miss for a 404/empty page is itself a useful cache.
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { fetchCapped, isTransientStatus, type CappedResponse } from '@/services/farcaster/cappedFetch';
import { createPersistedTtlCache } from '@/services/offline/persistedTtlCache';

export interface ParsedFrameMeta {
  name?: string;
  iconUrl?: string;
  imageUrl?: string;
  homeUrl?: string;
  buttonTitle?: string;
  splashImageUrl?: string;
  splashBackgroundColor?: string;
}

export interface UrlMetadata {
  url: string;
  /** Domain part for display; not authoritative — caller may already have
   *  a better source. */
  domain?: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** Inline miniapp metadata when the page advertises one via
   *  `<meta name="fc:miniapp">` or the legacy `fc:frame`. */
  miniapp?: ParsedFrameMeta;
}

const FETCH_TIMEOUT_MS = 5_000;
/** Most heads finish well under 8 KB; anything past 64 KB is body content
 *  we don't care about. */
const MAX_HTML_BYTES = 64 * 1024;

/** Strip a handful of common HTML entities out of the captured attribute
 *  values — enough to make titles like "Yoink &amp; Run" read correctly. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&apos;/gi, "'");
}

/**
 * Pull a single meta tag's `content` value by property/name key. Tries
 * both orderings (`property` before `content` and vice versa) since
 * authoring conventions vary. Captures up to the next quote character so
 * embedded JSON-stringified `content` payloads (used by miniapp meta)
 * survive intact when the JSON itself uses the *other* quote style.
 */
function getMeta(head: string, key: string): string | undefined {
  // Allow either `property=` or `name=` — both are used in the wild.
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(
    `<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${escapedKey}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const m1 = head.match(re1);
  if (m1) return decodeEntities(m1[1]);
  const re2 = new RegExp(
    `<meta\\b[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escapedKey}["']`,
    'i',
  );
  const m2 = head.match(re2);
  return m2 ? decodeEntities(m2[1]) : undefined;
}

function getTitleTag(head: string): string | undefined {
  const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  return decodeEntities(m[1].trim());
}

function parseMiniappMeta(head: string): ParsedFrameMeta | undefined {
  // fc:miniapp is the v2 spec. fc:frame is the older v1 spec; for
  // visual purposes the schemas overlap enough to share the renderer.
  const raw = getMeta(head, 'fc:miniapp') ?? getMeta(head, 'fc:frame');
  if (!raw) return undefined;
  // Attribute is JSON-stringified; the meta value lost its own outer
  // quotes by the time getMeta returned. Some publishers embed
  // single-quoted JSON within double-quoted content (or vice versa).
  // Try as-is first; fall through if parsing fails.
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== 'object') return undefined;
  // The v1 spec wraps `button.action.url` for the home/launch target;
  // v2 spec uses `homeUrl` directly. Accept either so we don't miss the
  // launch action.
  const homeUrl =
    json.homeUrl ?? json.button?.action?.url ?? json.action?.url ?? undefined;
  return {
    name: json.name,
    iconUrl: json.iconUrl,
    imageUrl: json.imageUrl,
    homeUrl,
    buttonTitle: json.buttonTitle ?? json.button?.title,
    splashImageUrl: json.splashImageUrl,
    splashBackgroundColor: json.splashBackgroundColor,
  };
}

/** Snap responses carry this media type; servers that don't serve snaps
 *  answer the same request with their page. */
const SNAP_MEDIA_TYPE = 'application/vnd.farcaster.snap+json';

/** What one GET of a link told us: whether it is a snap and, for a web page,
 *  its parsed metadata. */
export interface LinkProbe {
  isSnap: boolean;
  metadata: UrlMetadata | null;
}

const NOT_A_PAGE: LinkProbe = { isSnap: false, metadata: null };

/**
 * Finished probes, kept a day across launches so a feed that paints from its
 * cache doesn't download every link in it again. A page's tags and whether a
 * link is a snap rarely change within a day. Bounded, oldest first out.
 */
const probeStore = createPersistedTtlCache<LinkProbe>({
  prefix: 'link-probe:v1:',
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 300,
});

/** Probes that failed for reasons of the moment (offline, timed out, a 5xx),
 *  answered for this session only, so being offline at launch isn't
 *  remembered for a day. Bounded, oldest first out. */
const FAILED_PROBES_MAX = 300;
const failedProbes = new Map<string, LinkProbe>();
const probesInFlight = new Map<string, Promise<LinkProbe>>();

function rememberFailedProbe(url: string, probe: LinkProbe): void {
  failedProbes.delete(url);
  failedProbes.set(url, probe);
  if (failedProbes.size > FAILED_PROBES_MAX) {
    const oldest = failedProbes.keys().next().value;
    if (oldest !== undefined) failedProbes.delete(oldest);
  }
}

/** A finished probe for this URL, if one is cached (in memory or on disk). */
export function getCachedLinkProbe(url: string): LinkProbe | undefined {
  return probeStore.get(url) ?? failedProbes.get(url);
}

/**
 * Fetch a link once and answer both questions the feed asks of it: is it a
 * snap, and what is its OpenGraph / inline mini-app metadata. Snap detection
 * and the link preview used to GET the same page separately. The request asks
 * for a snap first and a page otherwise, the header the Farcaster client
 * sends. Concurrent callers share one request; results are cached, failures
 * too.
 */
export function probeLink(url: string): Promise<LinkProbe> {
  const cached = getCachedLinkProbe(url);
  if (cached) return Promise.resolve(cached);
  const inFlight = probesInFlight.get(url);
  if (inFlight) return inFlight;
  const request = fetchLinkProbe(url)
    .catch((): ProbeOutcome => ({ probe: NOT_A_PAGE, lasting: false }))
    .then(({ probe, lasting }) => {
      if (lasting) probeStore.set(url, probe);
      else rememberFailedProbe(url, probe);
      probesInFlight.delete(url);
      return probe;
    });
  probesInFlight.set(url, request);
  return request;
}

/** A probe, and whether it says something about the link (keep it a day)
 *  or only about the moment it was made (keep it this session). */
interface ProbeOutcome {
  probe: LinkProbe;
  lasting: boolean;
}

async function fetchLinkProbe(url: string): Promise<ProbeOutcome> {
  let domain: string | undefined;
  try {
    domain = new URL(url).hostname;
  } catch {
    return { probe: NOT_A_PAGE, lasting: false };
  }

  let res: CappedResponse;
  try {
    res = await fetchCapped(url, {
      // A real browser UA — many CDNs short-circuit bot UAs with empty
      // pages, which kills the OG enrichment we're trying to extract.
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        accept: `${SNAP_MEDIA_TYPE},text/html,application/xhtml+xml,*/*`,
      },
      maxBytes: MAX_HTML_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      // Decided from the headers alone: a snap is known by its content type,
      // and anything but a page (a video, a PDF) has no <head> to read, so
      // none of its body is downloaded.
      wantsBody: ({ ok, contentType }) =>
        ok && !contentType.includes(SNAP_MEDIA_TYPE) && (!contentType || contentType.includes('html')),
    });
  } catch {
    return { probe: NOT_A_PAGE, lasting: false };
  }

  if (res.contentType.includes(SNAP_MEDIA_TYPE)) return { probe: { isSnap: true, metadata: null }, lasting: true };
  if (!res.ok) return { probe: NOT_A_PAGE, lasting: !isTransientStatus(res.status) };
  if (res.contentType && !res.contentType.includes('html')) return { probe: NOT_A_PAGE, lasting: true };
  if (res.bodyFailed && !res.text) return { probe: NOT_A_PAGE, lasting: false };
  const html = res.text;

  // Restrict pattern matching to the <head> when present — bodies often
  // contain comment-form og:* tags that don't apply to the page itself.
  const headMatch = html.match(/<head\b[\s\S]*?<\/head>/i);
  const head = headMatch ? headMatch[0] : html;

  const title =
    getMeta(head, 'og:title') ??
    getMeta(head, 'twitter:title') ??
    getTitleTag(head);
  const description =
    getMeta(head, 'og:description') ?? getMeta(head, 'twitter:description');
  const image =
    getMeta(head, 'og:image') ?? getMeta(head, 'twitter:image');
  const siteName = getMeta(head, 'og:site_name');
  const miniapp = parseMiniappMeta(head);

  return {
    probe: {
      isSnap: false,
      metadata: {
        url,
        domain,
        title,
        description,
        image,
        siteName,
        miniapp,
      },
    },
    // A page cut short by an error or the timeout may have lost tags past
    // the cut: good enough for now, not worth keeping.
    lasting: !res.bodyFailed,
  };
}

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  return (await probeLink(url)).metadata;
}

/** Test reset. `keepPersisted` forgets only what a relaunch forgets. */
export function __resetLinkProbes(options: { keepPersisted?: boolean } = {}): void {
  if (options.keepPersisted) probeStore.forgetInMemory();
  else probeStore.clear();
  failedProbes.clear();
  probesInFlight.clear();
}

export function useOgMetadata(
  url: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? true) && Boolean(url);
  return useQuery({
    queryKey: ['og-metadata', url],
    queryFn: () => fetchUrlMetadata(url as string),
    enabled,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  } satisfies UseQueryOptions<UrlMetadata | null, Error>);
}
