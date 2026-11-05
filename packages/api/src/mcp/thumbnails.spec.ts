import { attachSlideThumbnail } from './thumbnails';
import { formatToolContent } from './parsers';

const URL_OK = 'https://lh3.googleusercontent.com/slide=s800';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const NOTE = 'The slide image could not be loaded';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const urlResult = (contentUrl = URL_OK) =>
  textResult(JSON.stringify({ contentUrl, widthPx: 800, heightPx: 450 }));

function imageResponse(
  overrides: { type?: string; length?: number; ok?: boolean; url?: string } = {},
) {
  const { type = 'image/png; charset=binary', length, ok = true, url = URL_OK } = overrides;
  return {
    ok,
    url,
    headers: new Headers({
      'content-type': type,
      ...(length !== undefined && { 'content-length': String(length) }),
    }),
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
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
