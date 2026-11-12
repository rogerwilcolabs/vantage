const express = require('express');
const passport = require('passport');
const { getEmbedAuth } = require('~/server/services/EmbedAuth');
const { loginLimiter } = require('~/server/middleware');

const router = express.Router();

const withEmbedAuth = (handler) => async (req, res, next) =>
  (await getEmbedAuth())[handler](req, res, next);

router.get('/oauth/openid', loginLimiter, async (req, res, next) => {
  const embedAuth = await getEmbedAuth();
  const authenticate = (state) => passport.authenticate('openid', { session: false, state });
  return embedAuth.createLoginRoute(authenticate)(req, res, next);
});

router.post('/auth/exchange', withEmbedAuth('exchange'));
router.post('/auth/refresh', withEmbedAuth('refresh'));
router.post('/auth/logout', withEmbedAuth('logout'));

module.exports = router;
