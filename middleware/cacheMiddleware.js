/**
 * shared-utils/middleware/cacheMiddleware.js
 * ───────────────────────────────────────────
 * Enterprise response caching middleware for Express routes.
 *
 * Guarantees:
 *  • Explicit scope: 'public' vs 'user'
 *  • User-scoped caching NEVER executes before authentication (requires req.user)
 *  • User-scoped caching NEVER falls back to URL-only keys
 *  • Non-200 responses and mutations are NEVER cached
 */

const { createCacheService } = require('../utils/cacheService');

/**
 * Creates response caching middleware.
 * @param {Object} options
 * @param {'public'|'user'} [options.scope='public'] - Cache scope
 * @param {number} [options.ttl=60] - TTL in seconds
 * @param {string} [options.serviceName='service'] - Service name for key prefixing
 * @param {import('../utils/cacheService').CacheService} [options.cacheService] - Existing CacheService
 * @param {string} [options.redisUrl] - Custom Redis URL
 * @param {Function} [options.getUserId] - Custom extractor for userId from req
 * @param {Function} [options.keyGenerator] - Custom key generator from req
 * @returns {import('express').RequestHandler}
 */
const cacheMiddleware = (options = {}) => {
  const {
    scope = 'public',
    ttl = 60,
    serviceName = 'service',
    redisUrl = process.env.REDIS_URL,
    getUserId = null,
    keyGenerator = null,
  } = options;

  const cache = options.cacheService || createCacheService({
    serviceName: `${serviceName}:HttpCache`,
    redisUrl,
    defaultTtl: ttl,
  });

  return async (req, res, next) => {
    // Only cache GET and HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    if (!cache.isReady()) {
      return next();
    }

    let userId = null;
    if (scope === 'user') {
      userId = req.user?.id || req.user?.userId || (getUserId ? getUserId(req) : null);
      // ── CRITICAL: If unauthenticated on a user-scoped route, NEVER cache ──
      if (!userId || userId === 'SYSTEM') {
        console.warn(`[${serviceName}:CacheMiddleware] Bypassing cache: missing authenticated userId for user-scoped route '${req.originalUrl}'.`);
        return next();
      }
    }

    const subKey = keyGenerator ? keyGenerator(req) : req.originalUrl;
    const cacheKey = cache.buildKey({
      scope,
      userId,
      key: subKey,
    });

    if (!cacheKey) {
      return next();
    }

    try {
      const cached = await cache.get(cacheKey, { expectedUserId: scope === 'user' ? userId : undefined });
      if (cached !== null) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        console.log(`[CACHE] service=${serviceName} scope=${scope} userId=${userId || 'public'} route=${req.originalUrl} key=${cacheKey} hit=true`);
        return res.json(cached);
      }

      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      console.log(`[CACHE] service=${serviceName} scope=${scope} userId=${userId || 'public'} route=${req.originalUrl} key=${cacheKey} hit=false`);

      // Intercept res.json to capture response body
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Restore original function
        res.json = originalJson;

        // Only cache 200 OK responses
        if (res.statusCode >= 200 && res.statusCode < 300 && body !== undefined && body !== null) {
          cache.set(cacheKey, body, ttl, { scope, userId }).catch((err) => {
            console.warn(`[${serviceName}:CacheMiddleware] Background set failed:`, err.message);
          });
        }

        return originalJson(body);
      };

      next();
    } catch (err) {
      console.warn(`[${serviceName}:CacheMiddleware] Error in cache lookup:`, err.message);
      next();
    }
  };
};

module.exports = cacheMiddleware;
