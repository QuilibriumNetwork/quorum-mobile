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
 *     enough — we never parse the body.
 *
 * Cached aggressively (gcTime: Infinity) since page metadata changes
 * rarely and a miss for a 404/empty page is itself a useful cache.
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

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

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata | null> {
  let domain: string | undefined;
  try {
    domain = new URL(url).hostname;
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      // A real browser UA — many CDNs short-circuit bot UAs with empty
      // pages, which kills the OG enrichment we're trying to extract.
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);

  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !contentType.includes('html')) return null;

  // Stream the response only up to MAX_HTML_BYTES — saves time + memory
  // on long pages. RN's `Response.text()` reads the whole body, so we
  // read manually via the reader when possible. Fall back to text() on
  // platforms where ReadableStream isn't exposed.
  let html = '';
  try {
    const reader = (res.body as any)?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytes += value.length;
      }
      try { reader.cancel(); } catch { /* ignore */ }
    } else {
      const full = await res.text();
      html = full.slice(0, MAX_HTML_BYTES);
    }
  } catch {
    return null;
  }

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
    url,
    domain,
    title,
    description,
    image,
    siteName,
    miniapp,
  };
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
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  } satisfies UseQueryOptions<UrlMetadata | null, Error>);
}
