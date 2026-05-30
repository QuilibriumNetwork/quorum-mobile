/**
 * Video upload service for Farcaster casts.
 *
 * Three steps:
 *   1. POST /v1/prepare-video-upload → `{ videoId, uploadUrl, headers, metadata }`.
 *   2. TUS resumable upload of the video bytes to `uploadUrl`.
 *   3. Poll /v1/uploaded-video?videoId=… until state === "ready".
 *
 * Returns the embed URL (the `sourceUrl` from the polled state) which
 * the composer hands to the cast submit path as a plain URL embed —
 * the protocol-level cast carries it as `{ url: sourceUrl }`.
 *
 * Requires `tus-js-client` to be installed:
 *   yarn add tus-js-client
 */

import { Upload } from 'tus-js-client';

const FARCASTER_BASE_URL = 'https://client.farcaster.xyz';
const VIDEO_POLL_INTERVAL_MS = 1000;
const VIDEO_POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface PrepareResponse {
  result: {
    videoId: string;
    uploadUrl: string;
    headers: Record<string, string>;
    metadata: Record<string, string>;
  };
}

interface UploadedVideoStateResponse {
  result: {
    video: {
      state: 'preparing' | 'processing' | 'ready' | 'failed';
      embed?: {
        sourceUrl?: string;
        thumbnailUrl?: string;
        width?: number;
        height?: number;
      };
    };
  };
}

export interface UploadVideoResult {
  /** The embed URL — what gets stored on the cast's URL embed list. */
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

async function prepareVideoUpload(
  token: string,
  videoSizeBytes: number,
): Promise<PrepareResponse['result']> {
  const res = await fetch(`${FARCASTER_BASE_URL}/v1/prepare-video-upload`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      origin: 'https://farcaster.xyz',
      referer: 'https://farcaster.xyz/',
    },
    body: JSON.stringify({ videoSizeBytes, supportsDynamicUpload: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`prepare-video-upload ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as PrepareResponse;
  return json.result;
}

async function pollVideoReady(
  token: string,
  videoId: string,
): Promise<UploadedVideoStateResponse['result']['video']> {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > VIDEO_POLL_TIMEOUT_MS) {
      throw new Error('Video processing timed out');
    }
    const res = await fetch(
      `${FARCASTER_BASE_URL}/v1/uploaded-video?videoId=${encodeURIComponent(videoId)}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          origin: 'https://farcaster.xyz',
          referer: 'https://farcaster.xyz/',
        },
      },
    );
    if (res.ok) {
      const json = (await res.json()) as UploadedVideoStateResponse;
      const v = json.result.video;
      if (v.state === 'ready' && v.embed?.sourceUrl) return v;
      if (v.state === 'failed') throw new Error('Video processing failed');
    }
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
  }
}

/**
 * Upload a local video file, wait for processing, return the embed URL.
 * The caller must hold a valid farcaster.xyz bearer token — the upload
 * endpoints require auth.
 */
export async function uploadVideoForCast(
  token: string,
  localUri: string,
): Promise<UploadVideoResult> {
  // Read the file into a blob so tus-js-client can chunk it. RN's
  // `fetch(localUri).blob()` works for both `file://` and content URIs.
  const res = await fetch(localUri);
  const blob = await res.blob();
  const size = blob.size;
  if (size === 0) throw new Error('Empty video file');

  const prep = await prepareVideoUpload(token, size);

  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(blob, {
      endpoint: prep.uploadUrl,
      headers: prep.headers,
      metadata: {
        filetype: (blob as Blob & { type?: string }).type ?? 'video/mp4',
        name: 'cast-video',
        ...prep.metadata,
      },
      // 10 MB — large enough that small clips upload in one request,
      // small enough that retries on flaky networks don't lose much
      // progress.
      chunkSize: 10 * 1024 * 1024,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      onError: (err) => reject(err),
      onSuccess: () => resolve(),
    });
    upload.start();
  });

  const ready = await pollVideoReady(token, prep.videoId);
  return {
    url: ready.embed!.sourceUrl!,
    thumbnailUrl: ready.embed!.thumbnailUrl,
    width: ready.embed!.width,
    height: ready.embed!.height,
  };
}
