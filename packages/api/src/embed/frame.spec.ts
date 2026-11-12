import helmet from 'helmet';
import express from 'express';
import request from 'supertest';
import type { Response } from 'express';
import type { EmbedFrameLocals } from './frame';
import { createEmbedFrameHeaders, isFramedEmbedPath } from './frame';

const config = { enabled: true, frameAncestors: ['https://lookerstudio.google.com'] };

function createApp(env: NodeJS.ProcessEnv = {}) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  const frame = createEmbedFrameHeaders(config, env);
  if (frame) {
    app.use(frame);
  }
  app.get('*splat', (_req, res: Response) => {
    const locals = res.locals as EmbedFrameLocals;
    res.json({ hasEmbedPolicy: locals.embedCspPolicy != null });
  });
  return app;
}

describe('createEmbedFrameHeaders', () => {
  it('lets the configured site frame /embed pages with an enforced frame-ancestors', async () => {
    const res = await request(createApp()).get('/embed/c/new').expect(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://lookerstudio.google.com",
    );
  });

  it('keeps every other page unframeable', async () => {
    for (const path of ['/c/new', '/login', '/embedded', '/embed/callback']) {
      const res = await request(createApp()).get(path).expect(200);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toBeUndefined();
    }
  });

  it('hands the shell a full CSP with the embed frame-ancestors when CSP is enabled', async () => {
    const res = await request(createApp({ CSP_ENABLED: 'true' }))
      .get('/embed')
      .expect(200);
    expect(res.body).toEqual({ hasEmbedPolicy: true });
  });

  it('is absent when embedding is disabled or no site may frame it', () => {
    expect(createEmbedFrameHeaders({ enabled: false, frameAncestors: ['https://a.com'] })).toBe(
      null,
    );
    expect(createEmbedFrameHeaders({ enabled: true, frameAncestors: [] })).toBe(null);
  });

  it('matches only the embed view paths', () => {
    expect(isFramedEmbedPath('/embed')).toBe(true);
    expect(isFramedEmbedPath('/embed/c/abc')).toBe(true);
    expect(isFramedEmbedPath('/embed/callback')).toBe(false);
    expect(isFramedEmbedPath('/embedx')).toBe(false);
  });
});
