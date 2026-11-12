import { EMBED_BASE_PATH, embedConfigSchema } from 'librechat-data-provider';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TEmbedConfig } from 'librechat-data-provider';
import type { CspPolicy } from '../security/csp';
import { createCspPolicy } from '../security/csp';

/** The popup's landing page is a top-level window and never needs to be framed. */
const EMBED_CALLBACK_PATH = `${EMBED_BASE_PATH}/callback`;

export interface EmbedFrameLocals {
  /** The shell CSP to send instead of the default one, carrying the embed frame-ancestors. */
  embedCspPolicy?: CspPolicy;
}

export const isFramedEmbedPath = (path: string): boolean =>
  (path === EMBED_BASE_PATH || path.startsWith(`${EMBED_BASE_PATH}/`)) &&
  path !== EMBED_CALLBACK_PATH &&
  !path.startsWith(`${EMBED_CALLBACK_PATH}/`);

/**
 * The embed config with schema defaults applied. The config loader validates `librechat.yaml`
 * but keeps the raw object, so fields the operator left out are absent until resolved here.
 */
export function resolveEmbedConfig(config: Partial<TEmbedConfig> | undefined): TEmbedConfig {
  return embedConfigSchema.parse(config ?? {});
}

/** `'self'` plus the configured origins, deduplicated. */
export function getEmbedFrameAncestors(config: Pick<TEmbedConfig, 'frameAncestors'>): string[] {
  return [...new Set(["'self'", ...config.frameAncestors])];
}

/**
 * Lets the configured sites frame the embed view, and only that view. Every other page keeps
 * `X-Frame-Options` and `frame-ancestors 'self'`. The `frame-ancestors` header is enforced even
 * when the main CSP runs report-only, because removing `X-Frame-Options` would otherwise leave
 * the embed view frameable by any site. When the main CSP is on, the shell swaps in a copy of
 * it whose `frame-ancestors` matches, since two enforced policies would intersect to `'self'`.
 *
 * Returns `null` when embedding is off or no site is allowed to frame it.
 */
export function createEmbedFrameHeaders(
  rawConfig: Partial<TEmbedConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler | null {
  const config = resolveEmbedConfig(rawConfig);
  if (!config.enabled || config.frameAncestors.length === 0) {
    return null;
  }

  const ancestors = getEmbedFrameAncestors(config).join(' ');
  const embedCspPolicy = createCspPolicy({ ...env, CSP_FRAME_ANCESTORS: ancestors });
  const frameAncestorsHeader = `frame-ancestors ${ancestors}`;

  return (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !isFramedEmbedPath(req.path)) {
      return next();
    }
    res.removeHeader('X-Frame-Options');
    /* A framed document is a navigation, which CORP never applies to; drop it so an embedder
     * that enables cross-origin isolation is not refused for a header meant for subresources. */
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.setHeader('Content-Security-Policy', frameAncestorsHeader);
    if (embedCspPolicy) {
      (res.locals as EmbedFrameLocals).embedCspPolicy = embedCspPolicy;
    }
    return next();
  };
}
