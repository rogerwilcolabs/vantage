import sharp from 'sharp';
import { projectArtifactPayload } from '@librechat/agents';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { attachSlideThumbnail } from './thumbnails';
import { formatToolContent } from './parsers';

const URL_OK = 'https://lh3.googleusercontent.com/slide=s800';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const NOTE = 'The slide image could not be loaded';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const urlResult = (contentUrl = URL_OK) =>
  textResult(JSON.stringify({ contentUrl, widthPx: 800, heightPx: 450 }));

function imageResponse(
  overrides: { type?: string; length?: number; ok?: boolean; url?: string; body?: Buffer } = {},
) {
  const {
    type = 'image/png; charset=binary',
    length,
    ok = true,
    url = URL_OK,
    body = PNG,
  } = overrides;
  return {
    ok,
    url,
    headers: new Headers({
      'content-type': type,
      ...(length !== undefined && { 'content-length': String(length) }),
    }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

const fetchReturning = (response: Response) =>
  jest.fn(async () => response) as unknown as typeof fetch;

const attach = (
  result: Parameters<typeof attachSlideThumbnail>[0]['result'],
  fetchImage: typeof fetch,
) =>
  attachSlideThumbnail({
    serverName: 'google-slides',
    toolName: 'read_slide_page_thumbnail',
    result,
    fetchImage,
  });

const lastText = (result: Awaited<ReturnType<typeof attachSlideThumbnail>>) => {
  const last = result?.content?.[result.content.length - 1];
  return last?.type === 'text' ? last.text : undefined;
};

describe('attachSlideThumbnail', () => {
  it('adds the image and keeps the link', async () => {
    const result = await attach(urlResult(), fetchReturning(imageResponse()));

    expect(result?.content).toHaveLength(2);
    expect(result?.content?.[0]).toEqual(urlResult().content[0]);
    expect(result?.content?.[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: PNG.toString('base64'),
    });
  });

  it('reads the link from structured content', async () => {
    const fetchImage = fetchReturning(imageResponse());
    const result = await attach(
      { content: [], structuredContent: { contentUrl: URL_OK } } as never,
      fetchImage,
    );

    expect(fetchImage).toHaveBeenCalledWith(URL_OK, expect.any(Object));
    expect(result?.content?.[0]).toMatchObject({ type: 'image' });
  });

  /** Vertex is how a service account reaches Gemini; it used to get the image as base64 text. */
  it.each(['google', 'vertexai'] as const)('reaches %s as an image', async (provider) => {
    const result = await attach(urlResult(), fetchReturning(imageResponse()));

    const [text, artifact] = formatToolContent(result, provider);

    expect(text).toContain(URL_OK);
    expect(artifact?.content?.[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
    });
  });

  it.each([
    ['another server', { serverName: 'data-repo', toolName: 'read_slide_page_thumbnail' }],
    ['another tool', { serverName: 'google-slides', toolName: 'read_presentation' }],
  ])('leaves %s untouched', async (_name, target) => {
    const fetchImage = fetchReturning(imageResponse());
    const original = urlResult();

    const result = await attachSlideThumbnail({ ...target, result: original, fetchImage });

    expect(result).toBe(original);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('leaves a failed tool call untouched', async () => {
    const fetchImage = fetchReturning(imageResponse());
    const original = { ...urlResult(), isError: true };

    expect(await attach(original, fetchImage)).toBe(original);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each([
    ['an http link', 'http://lh3.googleusercontent.com/a'],
    ['another host', 'https://example.com/a.png'],
    ['a look-alike host', 'https://googleusercontent.com.example.com/a.png'],
    ['a look-alike suffix', 'https://evilgoogleusercontent.com/a.png'],
    ['a local address', 'https://169.254.169.254/latest/meta-data'],
    ['not a URL', 'not a url'],
  ])('never downloads %s', async (_name, url) => {
    const fetchImage = fetchReturning(imageResponse({ url }));

    const result = await attach(urlResult(url), fetchImage);

    expect(fetchImage).not.toHaveBeenCalled();
    expect(lastText(result)).toContain(NOTE);
  });

  it.each([
    ['a redirect to another host', imageResponse({ url: 'https://example.com/a.png' })],
    ['a non-image response', imageResponse({ type: 'text/html' })],
    ['an error status', imageResponse({ ok: false })],
    ['an oversized image', imageResponse({ length: 50 * 1024 * 1024 })],
  ])('adds a note instead of an image for %s', async (_name, response) => {
    const result = await attach(urlResult(), fetchReturning(response));

    expect(result?.content?.some((item) => item.type === 'image')).toBe(false);
    expect(lastText(result)).toContain(NOTE);
  });

  it('adds a note when the download fails, keeping the tool call successful', async () => {
    const fetchImage = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await attach(urlResult(), fetchImage);

    expect(result?.isError).toBeUndefined();
    expect(result?.content?.[0]).toEqual(urlResult().content[0]);
    expect(lastText(result)).toContain(NOTE);
  });

  it('adds a note when the result holds no link', async () => {
    const result = await attach(textResult('no json here'), fetchReturning(imageResponse()));

    expect(lastText(result)).toContain(NOTE);
  });
});

/**
 * A 1600x900 slide-sized PNG with photo-like detail, well over what the agents runtime lets a tool
 * result add to the model's input. Real thumbnails of the template's photo slides are this size.
 */
async function photoSlidePng(): Promise<Buffer> {
  const width = 200;
  const height = 113;
  const noise = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    noise[i] = seed % 256;
  }
  return sharp(noise, { raw: { width, height, channels: 3 } })
    .resize(1600, 900, { kernel: 'cubic' })
    .png()
    .toBuffer();
}

type ImageUrlPart = { type: 'image_url'; image_url: { url: string } | string };

const isImageUrlPart = (part: unknown): part is ImageUrlPart =>
  typeof part === 'object' &&
  part !== null &&
  (part as { type?: unknown }).type === 'image_url' &&
  'image_url' in part;

/** What the model receives after the agents runtime folds tool images into its input. */
function imagesSentToModel(
  result: Awaited<ReturnType<typeof attachSlideThumbnail>>,
): ImageUrlPart[] {
  const [text, artifact] = formatToolContent(result, 'google');
  const call = new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name: 'read_slide_page_thumbnail', args: {} }],
  });
  const tool = new ToolMessage({ tool_call_id: 'call-1', content: text, artifact });
  const messages = projectArtifactPayload([new HumanMessage('Check slide 3'), call, tool]);
  const last = messages[messages.length - 1];
  const parts: unknown[] = Array.isArray(last.content) ? last.content : [];
  return parts.filter(isImageUrlPart);
}

const imageUrlOf = (part: ImageUrlPart) =>
  typeof part.image_url === 'string' ? part.image_url : part.image_url.url;

describe('attachSlideThumbnail with photo slides', () => {
  let photoPng: Buffer;

  beforeAll(async () => {
    photoPng = await photoSlidePng();
  });

  it('is a fixture the model would never have received unchanged', () => {
    const unchanged = {
      content: [
        { type: 'image' as const, mimeType: 'image/png', data: photoPng.toString('base64') },
      ],
    };

    expect(photoPng.length).toBeGreaterThan(400_000);
    expect(imagesSentToModel(unchanged)).toHaveLength(0);
  });

  it('shrinks a large thumbnail so the image reaches the model intact', async () => {
    const result = await attach(urlResult(), fetchReturning(imageResponse({ body: photoPng })));

    const image = result?.content?.find((item) => item.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    const jpeg = Buffer.from(image?.type === 'image' ? image.data : '', 'base64');
    const { width, format } = await sharp(jpeg).metadata();
    expect(format).toBe('jpeg');
    expect(width).toBe(1280);

    const sent = imagesSentToModel(result);
    expect(sent).toHaveLength(1);
    expect(imageUrlOf(sent[0])).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  });

  it('adds a note instead of an image when a large download is not a readable image', async () => {
    const garbage = Buffer.alloc(600_000, 1);

    const result = await attach(urlResult(), fetchReturning(imageResponse({ body: garbage })));

    expect(result?.content?.some((item) => item.type === 'image')).toBe(false);
    expect(lastText(result)).toContain(NOTE);
  });
});
