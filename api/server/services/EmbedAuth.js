const { CacheKeys } = require('librechat-data-provider');
const { DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const { math, createEmbedAuth } = require('@librechat/api');
const {
  findSession,
  getUserById,
  createSession,
  deleteSession,
  generateToken,
  generateRefreshToken,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const getLogStores = require('~/cache/getLogStores');

const AUTH_USER_PROJECTION = '-password -__v -totpSecret -backupCodes -federatedTokens';

/** @type {Promise<import('@librechat/api').EmbedAuth> | undefined} */
let embedAuthPromise;

/** The embed sign-in service, built once from the deployment's base config. */
function getEmbedAuth() {
  embedAuthPromise ??= getAppConfig({ baseOnly: true }).then((appConfig) =>
    createEmbedAuth({
      config: appConfig?.embed,
      cache: getLogStores(CacheKeys.EMBED_OAUTH),
      sessions: {
        createSession,
        findSession: (params) => findSession(params, { lean: false }),
        rotateRefreshToken: generateRefreshToken,
        deleteSession,
      },
      getUserById: (userId) => getUserById(userId, AUTH_USER_PROJECTION),
      generateToken,
      refreshTokenSecret: process.env.JWT_REFRESH_SECRET,
      accessTokenExpiryMs: math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY),
      callbackUrl: `${process.env.DOMAIN_CLIENT}/embed/callback`,
    }),
  );
  return embedAuthPromise;
}

module.exports = { getEmbedAuth };
