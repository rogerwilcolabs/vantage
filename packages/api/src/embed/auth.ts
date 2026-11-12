import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { EMBED_REQUEST_HEADER, EmbedAuthErrorCode } from 'librechat-data-provider';
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import type { TEmbedConfig } from 'librechat-data-provider';
import type { Keyv } from 'keyv';
import { verifyCodeChallenge, stripCodeChallenge } from '../auth/exchange';
import { consumeCacheEntry } from '../cache/consume';
import { resolveEmbedConfig } from './frame';

/** Embed session cookie: partitioned, so it only exists inside the site that frames the view. */
export const EMBED_SESSION_COOKIE = 'embed_session';
/** Set by the sign-in popup (a top-level page) and read once by the frame that opened it. */
export const EMBED_HANDOFF_COOKIE = 'embed_handoff';

const COOKIE_PATH = '/api/embed/auth';
const STATE_TTL_MS = 10 * 60 * 1000;
const HEX_64 = /^[a-f0-9]{64}$/;
/** Marks the OAuth state of a sign-in started from the embed popup. */
const EMBED_STATE_PREFIX = 'embed_';
const EMBED_STATE_PATTERN = /^embed_[a-f0-9]{64}$/;
/** RFC 7636 verifier alphabet and length. */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const SENSITIVE_USER_FIELDS = ['password', '__v', 'totpSecret', 'backupCodes', 'federatedTokens'];

export type EmbedResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: EmbedAuthErrorCode } };

type HandoffEntry = { userId: string; challenge: string };

type CookieRequest = Request & { cookies?: Record<string, string | undefined> };

/** Storage for embed sessions. The session type stays opaque so no storage engine leaks in. */
export interface EmbedSessionStore<TSession extends { expiration: Date }> {
  createSession: (
    userId: string,
    options: { expiresIn: number },
  ) => Promise<{ refreshToken: string }>;
  /** A live session for this user holding this refresh token, or `null` when there is none. */
  findSession: (params: { userId: string; refreshToken: string }) => Promise<TSession | null>;
  /** Rotates the session's refresh token and persists it. */
  rotateRefreshToken: (session: TSession) => Promise<string>;
  deleteSession: (params: { refreshToken: string }) => Promise<unknown>;
}

export interface EmbedAuthDeps<
  TUser extends { _id: unknown },
  TSession extends { expiration: Date },
> {
  /** The `embed` block from `librechat.yaml`; omitted fields take the schema defaults. */
  config: Partial<TEmbedConfig> | undefined;
  /** One-time state and handoff entries; must support atomic consumption (memory or Redis). */
  cache: Keyv;
  sessions: EmbedSessionStore<TSession>;
  getUserById: (userId: string) => Promise<TUser | null>;
  generateToken: (user: TUser, expiresIn: number) => Promise<string>;
  /** Secret the session's refresh tokens are signed with (`JWT_REFRESH_SECRET`). */
  refreshTokenSecret: string;
  accessTokenExpiryMs: number;
  /** Where the sign-in popup lands after the identity provider redirects back. */
  callbackUrl: string;
}

export interface EmbedAuth {
  /** Records the frame's PKCE challenge under a fresh OAuth state. */
  beginLogin: (codeChallenge: unknown) => Promise<EmbedResult<string>>;
  /** Route that starts the provider sign-in for the popup. */
  createLoginRoute: (authenticate: (state: string) => RequestHandler) => RequestHandler;
  /** `true` when the OpenID callback belonged to the embed popup and has been answered. */
  completeLogin: (req: Request, res: Response) => Promise<boolean>;
  exchange: (req: Request, res: Response) => Promise<void>;
  refresh: (req: Request, res: Response) => Promise<void>;
  logout: (req: Request, res: Response) => Promise<void>;
}

const stateKey = (state: string) => `state:${state}`;
const handoffKey = (code: string) => `handoff:${code}`;

const baseCookie: CookieOptions = {
  httpOnly: true,
  /* SameSite=None requires Secure; browsers also accept Secure cookies on http://localhost. */
  secure: true,
  sameSite: 'none',
  path: COOKIE_PATH,
};

const sessionCookie: CookieOptions = { ...baseCookie, partitioned: true };

function sanitizeUser(user: object): Record<string, unknown> {
  const withToObject = user as { toObject?: () => Record<string, unknown> };
  const source =
    typeof withToObject.toObject === 'function'
      ? withToObject.toObject()
      : { ...(user as Record<string, unknown>) };
  for (const field of SENSITIVE_USER_FIELDS) {
    delete source[field];
  }
  return source;
}

const sendCode = (res: Response, status: number, code: EmbedAuthErrorCode): void => {
  res.status(status).json({ code });
};

const readCookie = (req: Request, name: string): string | undefined =>
  (req as CookieRequest).cookies?.[name];

/**
 * Whether an OAuth callback belongs to a sign-in started from the embed popup. The prefix is
 * readable without the cache, so even a failed or expired embed sign-in can be answered on the
 * embed's own page rather than the full app's login screen.
 */
export const isEmbedOAuthState = (state: unknown): state is string =>
  typeof state === 'string' && EMBED_STATE_PATTERN.test(state);

const hasEmbedHeader = (req: Request): boolean => req.get(EMBED_REQUEST_HEADER) === '1';

/** The user id of a validly signed, unexpired refresh token, or `null`. */
function verifyRefreshToken(token: string, secret: string): string | null {
  try {
    const payload = jwt.verify(token, secret);
    const id = typeof payload === 'object' ? (payload as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Sign-in for the embed view. The identity provider's pages cut the popup's link to the frame
 * that opened it (Google sends `Cross-Origin-Opener-Policy: same-origin`), so the popup cannot
 * post a code back. Instead it leaves a short-lived handoff cookie in the browser, and the frame
 * redeems it with the PKCE verifier only it holds. A phished popup link therefore signs the
 * victim's browser in, never the attacker's.
 */
export function createEmbedAuth<
  TUser extends { _id: unknown },
  TSession extends { expiration: Date },
>(deps: EmbedAuthDeps<TUser, TSession>): EmbedAuth {
  const { cache, sessions } = deps;
  const config = resolveEmbedConfig(deps.config);

  const setSessionCookie = (res: Response, refreshToken: string, expires: Date) =>
    res.cookie(EMBED_SESSION_COOKIE, refreshToken, { ...sessionCookie, expires });

  const clearSessionCookie = (res: Response) =>
    res.clearCookie(EMBED_SESSION_COOKIE, sessionCookie);

  const clearHandoffCookie = (res: Response) => res.clearCookie(EMBED_HANDOFF_COOKIE, baseCookie);

  async function respondWithSession(res: Response, user: TUser): Promise<void> {
    const token = await deps.generateToken(user, deps.accessTokenExpiryMs);
    res.status(200).json({ token, user: sanitizeUser(user) });
  }

  /** Records the frame's PKCE challenge under a fresh OAuth state. */
  async function beginLogin(codeChallenge: unknown): Promise<EmbedResult<string>> {
    if (!config.enabled) {
      return { ok: false, error: { code: EmbedAuthErrorCode.DISABLED } };
    }
    if (typeof codeChallenge !== 'string' || !HEX_64.test(codeChallenge)) {
      return { ok: false, error: { code: EmbedAuthErrorCode.INVALID_REQUEST } };
    }
    const state = `${EMBED_STATE_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    await cache.set(stateKey(state), codeChallenge, STATE_TTL_MS);
    return { ok: true, value: state };
  }

  /**
   * Starts the identity provider sign-in for the popup. `authenticate` is the app's OpenID
   * strategy bound to the given state, so the provider returns to the normal OpenID callback.
   */
  function createLoginRoute(authenticate: (state: string) => RequestHandler): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      const result = await beginLogin(req.query.code_challenge);
      if (!result.ok) {
        const url = new URL(deps.callbackUrl);
        url.searchParams.set('error', result.error.code);
        res.redirect(url.toString());
        return;
      }
      /* openid-client treats any query string as a callback, so the challenge must go. */
      stripCodeChallenge(req);
      return authenticate(result.value)(req, res, next);
    };
  }

  /**
   * Called from the OpenID callback once the user is authenticated and allowed. Returns `true`
   * when this login came from the embed popup and the response has been sent.
   */
  async function completeLogin(req: Request, res: Response): Promise<boolean> {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (!isEmbedOAuthState(state)) {
      return false;
    }
    /* An embed sign-in never falls through to the full app's cookies and redirect: an expired
     * or unknown state, or embedding switched off since the popup opened, ends on the embed page. */
    const fail = (code: EmbedAuthErrorCode) => {
      const url = new URL(deps.callbackUrl);
      url.searchParams.set('error', code);
      res.redirect(url.toString());
      return true;
    };
    if (!config.enabled) {
      return fail(EmbedAuthErrorCode.DISABLED);
    }
    const challenge = await consumeCacheEntry<string>(cache, stateKey(state));
    const user = req.user as { _id?: unknown } | undefined;
    if (!challenge || user?._id == null) {
      return fail(EmbedAuthErrorCode.HANDOFF_INVALID);
    }

    const code = crypto.randomBytes(32).toString('hex');
    const entry: HandoffEntry = { userId: String(user._id), challenge };
    await cache.set(handoffKey(code), entry, config.handoffTtlMs);
    res.cookie(EMBED_HANDOFF_COOKIE, code, { ...baseCookie, maxAge: config.handoffTtlMs });
    res.redirect(deps.callbackUrl);
    return true;
  }

  /**
   * Redeems the handoff for an embed session. Answers `202 { code: HANDOFF_PENDING }` until a
   * handoff matching this frame's verifier exists, so the frame can poll while the popup runs.
   * A handoff for a different verifier is left alone: it belongs to another frame's sign-in.
   */
  async function exchange(req: Request, res: Response): Promise<void> {
    if (!config.enabled) {
      return sendCode(res, 404, EmbedAuthErrorCode.DISABLED);
    }
    const verifier = (req.body as { code_verifier?: unknown } | undefined)?.code_verifier;
    if (!hasEmbedHeader(req) || typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) {
      return sendCode(res, 400, EmbedAuthErrorCode.INVALID_REQUEST);
    }

    const code = readCookie(req, EMBED_HANDOFF_COOKIE);
    if (!code || !HEX_64.test(code)) {
      return sendCode(res, 202, EmbedAuthErrorCode.HANDOFF_PENDING);
    }
    const entry = await cache.get<HandoffEntry>(handoffKey(code));
    if (!entry) {
      clearHandoffCookie(res);
      return sendCode(res, 202, EmbedAuthErrorCode.HANDOFF_PENDING);
    }
    if (!verifyCodeChallenge(verifier, entry.challenge)) {
      return sendCode(res, 202, EmbedAuthErrorCode.HANDOFF_PENDING);
    }
    const redeemed = await consumeCacheEntry<HandoffEntry>(cache, handoffKey(code));
    clearHandoffCookie(res);
    if (!redeemed) {
      return sendCode(res, 202, EmbedAuthErrorCode.HANDOFF_PENDING);
    }

    const user = await deps.getUserById(redeemed.userId);
    if (!user) {
      return sendCode(res, 401, EmbedAuthErrorCode.SESSION_INVALID);
    }
    const { refreshToken } = await sessions.createSession(redeemed.userId, {
      expiresIn: config.sessionExpiryMs,
    });
    setSessionCookie(res, refreshToken, new Date(Date.now() + config.sessionExpiryMs));
    return respondWithSession(res, user);
  }

  /** Issues a fresh access token from the embed session cookie, rotating the refresh token. */
  async function refresh(req: Request, res: Response): Promise<void> {
    if (!config.enabled) {
      return sendCode(res, 404, EmbedAuthErrorCode.DISABLED);
    }
    if (!hasEmbedHeader(req)) {
      return sendCode(res, 400, EmbedAuthErrorCode.INVALID_REQUEST);
    }
    const refreshToken = readCookie(req, EMBED_SESSION_COOKIE);
    /* No session yet is the normal signed-out state, answered like the main refresh endpoint. */
    if (!refreshToken) {
      res.status(200).json({});
      return;
    }

    const userId = verifyRefreshToken(refreshToken, deps.refreshTokenSecret);
    const session = userId ? await sessions.findSession({ userId, refreshToken }) : null;
    const user = userId && session ? await deps.getUserById(userId) : null;
    if (!session || !user) {
      clearSessionCookie(res);
      return sendCode(res, 403, EmbedAuthErrorCode.SESSION_INVALID);
    }

    const rotated = await sessions.rotateRefreshToken(session);
    setSessionCookie(res, rotated, session.expiration);
    return respondWithSession(res, user);
  }

  async function logout(req: Request, res: Response): Promise<void> {
    if (!hasEmbedHeader(req)) {
      return sendCode(res, 400, EmbedAuthErrorCode.INVALID_REQUEST);
    }
    const refreshToken = readCookie(req, EMBED_SESSION_COOKIE);
    if (refreshToken) {
      await sessions.deleteSession({ refreshToken });
    }
    clearSessionCookie(res);
    res.status(204).end();
  }

  return { beginLogin, createLoginRoute, completeLogin, exchange, refresh, logout };
}
