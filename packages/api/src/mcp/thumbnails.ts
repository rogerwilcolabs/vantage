import sharp from 'sharp';
import { logger } from '@librechat/data-schemas';
import { HARD_MAX_TOOL_RESULT_CHARS } from '@librechat/agents';
import type * as t from './types';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getMCPImageDataMaxBytes } from './parsers';

const SLIDES_SERVER_NAME = 'google-slides';
const THUMBNAIL_TOOL_NAME = 'read_slide_page_thumbnail';
/** Google serves `presentations.pages.getThumbnail` images from this host family. */
const THUMBNAIL_HOST_SUFFIX = '.googleusercontent.com';
const THUMBNAIL_FETCH_TIMEOUT_MS = 15_000;
/** Without this the model only has a link it cannot open, and describes the slide from guesswork. */
const THUMBNAIL_UNAVAILABLE_NOTE =
  'The slide image could not be loaded, so you have not seen this slide. Do not describe how it looks.';
/**
 * The agents runtime caps what a tool result may add to the model's input at
 * `HARD_MAX_TOOL_RESULT_CHARS`, base64 included, and silently drops a larger image: the chat
 * still shows it, but the model only gets the link. A photo slide's PNG thumbnail is usually
 * over that, so images are kept to 60% of the cap once base64-encoded, leaving room for the
 * result's text.
 */
const MODEL_IMAGE_MAX_BYTES = Math.floor(((HARD_MAX_TOOL_RESULT_CHARS * 0.6) / 4) * 3);
/** Wide enough for the model to read slide text and spot layout problems. */
const MODEL_IMAGE_MAX_WIDTH = 1280;
const JPEG_QUALITIES = [80, 65, 50, 35];

type ThumbnailResponse = t.MCPToolCallResponse & { structuredContent?: { contentUrl?: unknown } };

interface AttachSlideThumbnailParams {
  serverName: string;
  toolName: string;
  result: t.MCPToolCallResponse;
  fetchImage?: typeof fetch;
}

function readContentUrl(result: NonNullable<ThumbnailResponse>): string | null {
  const structured = result.structuredContent?.contentUrl;
  if (typeof structured === 'string') {
    return structured;
  }
  for (const item of result.content ?? []) {
    if (item.type !== 'text') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (typeof parsed === 'object' && parsed !== null && 'contentUrl' in parsed) {
        return typeof parsed.contentUrl === 'string' ? parsed.contentUrl : null;
      }
    } catch {
      // Text that is not JSON cannot hold the documented response.
    }
  }
  return null;
}

function isThumbnailUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname.endsWith(THUMBNAIL_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * The image as the model can receive it: unchanged when it already fits, otherwise a smaller JPEG.
 * `null` when it cannot be brought under the limit or is not an image `sharp` can read.
 */
async function fitForModel(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (bytes.length <= MODEL_IMAGE_MAX_BYTES) {
    return { bytes, mimeType };
  }
  try {
    const resized = sharp(bytes).resize({ width: MODEL_IMAGE_MAX_WIDTH, withoutEnlargement: true });
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await resized.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
      if (jpeg.length <= MODEL_IMAGE_MAX_BYTES) {
        return { bytes: jpeg, mimeType: 'image/jpeg' };
      }
    }
  } catch (error) {
    logger.warn('[MCP] Slide thumbnail could not be resized', getSafeErrorMetadata(error));
  }
  return null;
}

async function downloadThumbnail(
  url: string,
  fetchImage: typeof fetch,
): Promise<t.ImageContent | null> {
  const maxBytes = getMCPImageDataMaxBytes();
  const response = await fetchImage(url, {
    signal: AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS),
  });
  const mimeType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
  const isImage = response.ok && mimeType.startsWith('image/');
  if (!isImage || !isThumbnailUrl(response.url || url)) {
    return null;
  }
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) {
    return null;
  }
  const fitted = await fitForModel(bytes, mimeType);
  if (!fitted) {
    return null;
  }
  return { type: 'image', mimeType: fitted.mimeType, data: fitted.bytes.toString('base64') };
}

/**
 * The Slides thumbnail tool returns only a link, which a model cannot open. Downloads the image and
 * adds it to the tool result so the agent can look at the slide it just edited. The link stays in
 * the result, and any failure leaves the tool call successful with a note saying the slide wasn't
 * seen. The Slides API documents these links as readable without sign-in for 30 minutes.
 */
export async function attachSlideThumbnail({
  serverName,
  toolName,
  result,
  fetchImage = fetch,
}: AttachSlideThumbnailParams): Promise<t.MCPToolCallResponse> {
  if (serverName !== SLIDES_SERVER_NAME || toolName !== THUMBNAIL_TOOL_NAME || !result) {
    return result;
  }
  if (result.isError) {
    return result;
  }

  const withNote = (reason: string, metadata?: object): t.MCPToolCallResponse => {
    logger.warn(`[MCP][${serverName}] Slide thumbnail not attached: ${reason}`, metadata);
    return {
      ...result,
      content: [...(result.content ?? []), { type: 'text', text: THUMBNAIL_UNAVAILABLE_NOTE }],
    };
  };

  const contentUrl = readContentUrl(result);
  if (!contentUrl) {
    return withNote('no contentUrl in the result');
  }
  if (!isThumbnailUrl(contentUrl)) {
    return withNote('unexpected image host');
  }

  try {
    const image = await downloadThumbnail(contentUrl, fetchImage);
    if (!image) {
      return withNote('the response was not a usable image');
    }
    return { ...result, content: [...(result.content ?? []), image] };
  } catch (error) {
    return withNote('the download failed', getSafeErrorMetadata(error));
  }
}
