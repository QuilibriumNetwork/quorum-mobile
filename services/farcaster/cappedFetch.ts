/**
 * cappedFetch — GET a URL and read at most the first `maxBytes` of its body,
 * for the feed's link probes (snap detection, OpenGraph tags, mini-app
 * manifests).
 *
 * React Native's global `fetch` is whatwg-fetch over XMLHttpRequest: it
 * resolves only once the whole body has arrived and has no body stream. A probe
 * that wanted a page's <head> downloaded the whole page, and a link to a video
 * downloaded the video until the timeout cut it off, because the content type
 * could only be checked after the download. `expo/fetch` resolves when the
 * headers arrive and streams the body, so the content type decides whether any
 * of the body is read, and reading stops at the cap.
 */

import { Platform } from 'react-native';

type ExpoFetch = typeof import('expo/fetch').fetch;

let expoFetch: ExpoFetch | undefined;

/** `expo/fetch` is loaded on first use, not at import. Loading it defines its
 *  response class on top of a native module, which throws wherever that module
 *  is missing (jest), and every screen that renders the feed imports this. */
function loadFetch(): ExpoFetch {
  if (!expoFetch) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoFetch = (require('expo/fetch') as typeof import('expo/fetch')).fetch;
  }
  return expoFetch;
}

/** What the headers said, before any of the body is read. */
export interface ResponseHead {
  status: number;
  ok: boolean;
  /** Empty when the server sent none. */
  contentType: string;
}

export interface CappedResponse extends ResponseHead {
  /** The body as text, at most `maxBytes` of it. Empty when not read. */
  text: string;
  /** Reading stopped on an error or the timeout, so `text` is whatever had
   *  arrived by then. Not set when reading stopped at the cap. */
  bodyFailed: boolean;
}

export interface CappedFetchOptions {
  headers: Record<string, string>;
  maxBytes: number;
  /** Covers the whole exchange, headers and body. */
  timeoutMs: number;
  /** Whether the body is worth reading, given the headers. When it isn't, the
   *  request is aborted without reading any of it. */
  wantsBody: (head: ResponseHead) => boolean;
}

/**
 * Fetch `url` and read at most `maxBytes` of its body. Rejects when no
 * response arrives (offline, refused, timed out before the headers); after
 * that it always resolves, with whatever body it read.
 *
 * Cookies are never sent or stored: these are requests to whatever sites the
 * feed links to, and none of them needs to know who is looking.
 */
export async function fetchCapped(url: string, options: CappedFetchOptions): Promise<CappedResponse> {
  const { maxBytes, timeoutMs, wantsBody } = options;
  const headers = { ...options.headers };
  // Servers that honour a range send only the part a probe reads. Not on
  // Android: OkHttp stops asking for gzip when a request carries a Range
  // header, and most pages ignore ranges, so the page would arrive
  // uncompressed, several times the bytes the capped read below costs.
  if (Platform.OS === 'ios') headers.range = `bytes=0-${maxBytes - 1}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let finished = false;
  try {
    const res = await loadFetch()(url, {
      method: 'GET',
      headers,
      credentials: 'omit',
      signal: controller.signal,
    });
    const head: ResponseHead = {
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get('content-type') ?? '',
    };
    if (!wantsBody(head)) return { ...head, text: '', bodyFailed: false };

    const reader = res.body?.getReader();
    if (!reader) {
      finished = true;
      return { ...head, text: '', bodyFailed: false };
    }
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let bodyFailed = false;
    try {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        const chunk = value.length > maxBytes - bytes ? value.subarray(0, maxBytes - bytes) : value;
        text += decoder.decode(chunk, { stream: true });
        bytes += chunk.length;
      }
    } catch {
      bodyFailed = true;
    }
    if (!finished) reader.cancel().catch(() => {});
    return { ...head, text, bodyFailed };
  } finally {
    clearTimeout(timer);
    // Cancelling the reader only stops delivery to JS; on iOS the download
    // carries on underneath it. Aborting cancels the request itself.
    if (!finished) controller.abort();
  }
}

/** Statuses that say "try again later" rather than anything about the URL:
 *  not worth remembering past this session. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
