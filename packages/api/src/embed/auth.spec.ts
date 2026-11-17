import crypto from 'crypto';
import { Keyv } from 'keyv';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { EmbedAuthErrorCode } from 'librechat-data-provider';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { TEmbedConfig } from 'librechat-data-provider';
import { createEmbedAuth, EMBED_HANDOFF_COOKIE, EMBED_SESSION_COOKIE } from './auth';

const SECRET = 'embed-refresh-secret';
const CALLBACK_URL = 'https://chat.example.com/embed/callback';

type TestUser = { _id: string; email: string; password?: string; totpSecret?: string };
type TestSession = { id: string; userId: string; refreshToken: string; expiration: Date };

const makeVerifier = () => crypto.randomBytes(32).toString('base64url');
const challengeFor = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('hex');

function createSessionStore() {
  const sessions = new Map<string, TestSession>();
  const sign = (session: TestSession) =>
    jwt.sign({ id: session.userId, sessionId: session.id }, SECRET, {
      expiresIn: Math.floor((session.expiration.getTime() - Date.now()) / 1000),
      jwtid: crypto.randomUUID(),
    });
  return {
    sessions,
    store: {
      createSession: async (userId: string, { expiresIn }: { expiresIn: number }) => {
        const session: TestSession = {
          id: crypto.randomUUID(),
          userId,
          refreshToken: '',
          expiration: new Date(Date.now() + expiresIn),
        };
        session.refreshToken = sign(session);
        sessions.set(session.id, session);
        return { refreshToken: session.refreshToken };
      },
      findSession: async ({ userId, refreshToken }: { userId: string; refreshToken: string }) =>
        [...sessions.values()].find(
          (s) => s.userId === userId && s.refreshToken === refreshToken,
        ) ?? null,
      rotateRefreshToken: async (session: TestSession) => {
        session.refreshToken = sign(session);
        return session.refreshToken;
      },
      deleteSession: async ({ refreshToken }: { refreshToken: string }) => {
        for (const [id, s] of sessions) {
          if (s.refreshToken === refreshToken) {
            sessions.delete(id);
          }
        }
      },
    },
  };
}

function setup(overrides: Partial<TEmbedConfig> = {}) {
  /* Raw, as the config loader hands it over: schema defaults are not applied yet. */
  const config: Partial<TEmbedConfig> = {
    enabled: true,
    frameAncestors: ['https://lookerstudio.google.com'],
    ...overrides,
  };
  const cache = new Keyv();
  const users = new Map<string, TestUser>([
    ['user-1', { _id: 'user-1', email: 'a@example.com', password: 'hash', totpSecret: 'totp' }],
  ]);
  const { sessions, store } = createSessionStore();
  const auth = createEmbedAuth<TestUser, TestSession>({
    config,
    cache,
    sessions: store,
    getUserById: async (id) => users.get(id) ?? null,
    generateToken: async (user) => `access-${user._id}`,
    refreshTokenSecret: SECRET,
    accessTokenExpiryMs: 15 * 60 * 1000,
    callbackUrl: CALLBACK_URL,
  });

  const authenticate = jest.fn(
    (state: string): RequestHandler =>
      (_req, res) => {
        res.redirect(`https://accounts.example.com/auth?state=${state}`);
      },
  );

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const pairs = (req.headers.cookie ?? '').split(';').map((part) => part.trim().split('='));
    Object.assign(req, { cookies: Object.fromEntries(pairs.filter(([name]) => name)) });
    next();
  });
  app.get('/api/embed/oauth/openid', auth.createLoginRoute(authenticate));
  /* Stands in for the OpenID callback after passport authenticated the user. */
  app.get('/oauth/openid/callback', async (req, res) => {
    Object.assign(req, { user: users.get(String(req.query.user)) });
    if (!(await auth.completeLogin(req, res))) {
      res.status(200).send('normal login');
    }
  });
  app.post('/api/embed/auth/exchange', auth.exchange);
  app.post('/api/embed/auth/refresh', auth.refresh);
  app.post('/api/embed/auth/logout', auth.logout);

  return { app, auth, cache, sessions, authenticate };
}

const getCookie = (res: request.Response, name: string): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line;
};

const cookieValue = (line: string | undefined) => line?.split(';')[0].split('=')[1] ?? '';

/** Runs the popup half of the flow and returns the handoff cookie the browser would hold. */
async function signInPopup(app: express.Express, verifier: string, user = 'user-1') {
  const start = await request(app)
    .get('/api/embed/oauth/openid')
    .query({ code_challenge: challengeFor(verifier) })
    .expect(302);
  const state = new URL(start.headers.location).searchParams.get('state') ?? '';
  const callback = await request(app).get('/oauth/openid/callback').query({ state, user });
  return { callback, handoff: cookieValue(getCookie(callback, EMBED_HANDOFF_COOKIE)) };
}

describe('createEmbedAuth', () => {
  it('signs the frame in after the popup completes, with a partitioned session cookie', async () => {
    const { app } = setup();
    const verifier = makeVerifier();
    const { callback, handoff } = await signInPopup(app, verifier);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(CALLBACK_URL);
    const handoffCookie = getCookie(callback, EMBED_HANDOFF_COOKIE) ?? '';
    expect(handoffCookie).toMatch(/HttpOnly/);
    expect(handoffCookie).toMatch(/SameSite=None/);
    expect(handoffCookie).not.toMatch(/Partitioned/);

    const exchanged = await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_HANDOFF_COOKIE}=${handoff}`)
      .send({ code_verifier: verifier })
      .expect(200);

    expect(exchanged.body.token).toBe('access-user-1');
    expect(exchanged.body.user).toEqual({ _id: 'user-1', email: 'a@example.com' });
    const sessionCookie = getCookie(exchanged, EMBED_SESSION_COOKIE) ?? '';
    expect(sessionCookie).toMatch(/Partitioned/);
    expect(sessionCookie).toMatch(/SameSite=None/);
    expect(sessionCookie).toMatch(/Path=\/api\/embed\/auth/);
    /* The default session length applies even though the raw config omitted it. */
    const expires = new Date(/Expires=([^;]+)/.exec(sessionCookie)?.[1] ?? '').getTime();
    expect(expires - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });

  it('keeps answering pending until the handoff exists, and never redeems it twice', async () => {
    const { app } = setup();
    const verifier = makeVerifier();

    const early = await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .send({ code_verifier: verifier })
      .expect(202);
    expect(early.body).toEqual({ code: EmbedAuthErrorCode.HANDOFF_PENDING });

    const { handoff } = await signInPopup(app, verifier);
    const exchange = () =>
      request(app)
        .post('/api/embed/auth/exchange')
        .set('X-Vantage-Embed', '1')
        .set('Cookie', `${EMBED_HANDOFF_COOKIE}=${handoff}`)
        .send({ code_verifier: verifier });

    await exchange().expect(200);
    const replay = await exchange().expect(202);
    expect(replay.body.code).toBe(EmbedAuthErrorCode.HANDOFF_PENDING);
  });

  it('does not hand a session to a frame that lacks the original verifier', async () => {
    const { app } = setup();
    const victimVerifier = makeVerifier();
    const { handoff } = await signInPopup(app, victimVerifier);

    /* An attacker who started the login, or another frame, holds a different verifier. */
    const attempt = await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_HANDOFF_COOKIE}=${handoff}`)
      .send({ code_verifier: makeVerifier() })
      .expect(202);
    expect(getCookie(attempt, EMBED_SESSION_COOKIE)).toBeUndefined();

    /* The handoff is left for the frame it belongs to. */
    await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_HANDOFF_COOKIE}=${handoff}`)
      .send({ code_verifier: victimVerifier })
      .expect(200);
  });

  it('leaves logins that did not start from the embed popup to the normal handler', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/oauth/openid/callback')
      .query({ state: crypto.randomBytes(32).toString('hex'), user: 'user-1' })
      .expect(200);
    expect(res.text).toBe('normal login');
    expect(getCookie(res, EMBED_HANDOFF_COOKIE)).toBeUndefined();
  });

  it('ends an expired embed sign-in on the embed page instead of a normal app login', async () => {
    const { app } = setup();
    const res = await request(app)
      .get('/oauth/openid/callback')
      .query({ state: `embed_${crypto.randomBytes(32).toString('hex')}`, user: 'user-1' })
      .expect(302);
    expect(res.headers.location).toBe(
      `${CALLBACK_URL}?error=${EmbedAuthErrorCode.HANDOFF_INVALID}`,
    );
    expect(getCookie(res, EMBED_HANDOFF_COOKIE)).toBeUndefined();
  });

  it('rejects a malformed challenge without starting the provider sign-in', async () => {
    const { app, authenticate } = setup();
    const res = await request(app)
      .get('/api/embed/oauth/openid')
      .query({ code_challenge: 'not-a-challenge' })
      .expect(302);
    expect(res.headers.location).toBe(
      `${CALLBACK_URL}?error=${EmbedAuthErrorCode.INVALID_REQUEST}`,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('strips the challenge from the URL the OpenID strategy sees', async () => {
    const { app, authenticate } = setup();
    let seenUrl = '';
    authenticate.mockImplementationOnce(
      (): RequestHandler => (req, res) => {
        seenUrl = req.originalUrl;
        res.sendStatus(204);
      },
    );
    await request(app)
      .get('/api/embed/oauth/openid')
      .query({ code_challenge: challengeFor(makeVerifier()) })
      .expect(204);
    expect(seenUrl).toBe('/api/embed/oauth/openid');
  });

  it('refuses every endpoint when embedding is disabled', async () => {
    const { app } = setup({ enabled: false });
    const start = await request(app)
      .get('/api/embed/oauth/openid')
      .query({ code_challenge: challengeFor(makeVerifier()) })
      .expect(302);
    expect(start.headers.location).toContain(EmbedAuthErrorCode.DISABLED);
    await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .send({ code_verifier: makeVerifier() })
      .expect(404);
    await request(app).post('/api/embed/auth/refresh').set('X-Vantage-Embed', '1').expect(404);
  });

  it('requires the embed request header on auth endpoints', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/api/embed/auth/exchange')
      .send({ code_verifier: makeVerifier() })
      .expect(400);
    expect(res.body).toEqual({ code: EmbedAuthErrorCode.INVALID_REQUEST });
    await request(app).post('/api/embed/auth/refresh').expect(400);
  });

  it('refreshes with rotation, rejects the old token, and logs out', async () => {
    const { app, sessions } = setup();
    const verifier = makeVerifier();
    const { handoff } = await signInPopup(app, verifier);
    const exchanged = await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_HANDOFF_COOKIE}=${handoff}`)
      .send({ code_verifier: verifier })
      .expect(200);
    const first = cookieValue(getCookie(exchanged, EMBED_SESSION_COOKIE));

    const refreshed = await request(app)
      .post('/api/embed/auth/refresh')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_SESSION_COOKIE}=${first}`)
      .expect(200);
    expect(refreshed.body.token).toBe('access-user-1');
    expect(refreshed.body.user.password).toBeUndefined();
    const second = cookieValue(getCookie(refreshed, EMBED_SESSION_COOKIE));
    expect(second).not.toBe(first);

    const stale = await request(app)
      .post('/api/embed/auth/refresh')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_SESSION_COOKIE}=${first}`)
      .expect(403);
    expect(stale.body).toEqual({ code: EmbedAuthErrorCode.SESSION_INVALID });

    await request(app)
      .post('/api/embed/auth/logout')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_SESSION_COOKIE}=${second}`)
      .expect(204);
    expect(sessions.size).toBe(0);
  });

  it('answers a signed-out refresh with an empty body and a forged token with 403', async () => {
    const { app } = setup();
    const signedOut = await request(app)
      .post('/api/embed/auth/refresh')
      .set('X-Vantage-Embed', '1')
      .expect(200);
    expect(signedOut.body).toEqual({});

    const forged = jwt.sign({ id: 'user-1' }, 'wrong-secret');
    await request(app)
      .post('/api/embed/auth/refresh')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_SESSION_COOKIE}=${forged}`)
      .expect(403);
  });

  it('lets an operational failure reach the request boundary instead of answering pending', async () => {
    const { app, cache } = setup();
    jest.spyOn(cache, 'get').mockRejectedValueOnce(new Error('cache down'));
    const errors: unknown[] = [];
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      errors.push(err);
      res.sendStatus(500);
    });
    await request(app)
      .post('/api/embed/auth/exchange')
      .set('X-Vantage-Embed', '1')
      .set('Cookie', `${EMBED_HANDOFF_COOKIE}=${'a'.repeat(64)}`)
      .send({ code_verifier: makeVerifier() })
      .expect(500);
    expect(errors).toHaveLength(1);
  });
});
