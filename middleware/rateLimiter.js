const { createRedisClient } = require('../utils/redisClient');

/**
 * Distributed Tiered Rate Limiter Middleware
 * 
 * Protects microservices from abuse by enforcing request limits stored in Redis.
 * Supports different limits for unauthenticated (public) vs authenticated users.
 * 
 * @param {Object} options
 * @param {string} options.serviceName - Unique name for the service (used in Redis keys)
 * @param {number} [options.publicMax=150] - Max requests for unauthenticated users
 * @param {number} [options.publicWindowMs=900000] - Window duration for public users (default 15m)
 * @param {number} [options.authMax=3000] - Max requests for authenticated users
 * @param {number} [options.authWindowMs=900000] - Window duration for auth users (default 15m)
 * @param {string} [options.redisUrl] - Custom Redis URL (optional)
 * @param {import('ioredis').Redis} [options.redisClient] - Existing Redis client to reuse (avoids opening a new connection)
 */
const createRateLimiter = ({ 
    serviceName, 
    publicMax = 150, 
    publicWindowMs = 15 * 60 * 1000,
    authMax = 3000,
    authWindowMs = 15 * 60 * 1000,
    redisUrl = process.env.REDIS_URL,
    redisClient = null  // Optional: pass an existing client to avoid a new connection
}) => {
    // Reuse provided client, or create a dedicated one for this rate limiter
    const redis = redisClient || createRedisClient({ url: redisUrl, serviceName: `${serviceName}:RateLimiter` });

    return async (req, res, next) => {
        // Skip instantly if Redis is not connected — fail open to ensure availability.
        // With enableOfflineQueue: false, commands would throw immediately anyway,
        // but this guard prevents even attempting them.
        if (!redis || redis.status !== 'ready') {
            return next();
        }

        const isAuth = !!req.user && req.user.id !== 'SYSTEM';
        const isSystem = req.user?.id === 'SYSTEM';

        // Service-to-service communication via SYSTEM_API_KEY is exempt from rate limiting
        if (isSystem) return next();

        const tier = isAuth ? 'auth' : 'public';
        const limit = isAuth ? authMax : publicMax;
        const windowSec = (isAuth ? authWindowMs : publicWindowMs) / 1000;
        
        // Use user ID if authenticated, else use IP address
        const identifier = isAuth ? req.user.id : (req.ip || req.headers['x-forwarded-for'] || 'anonymous');
        const key = `ratelimit:${serviceName}:${tier}:${identifier}`;

        try {
            // Single Lua script: INCR + EXPIRE + TTL in one round-trip (was 2 calls)
            const rateLimitScript = `
                local current = redis.call('INCR', KEYS[1])
                if current == 1 then
                    redis.call('EXPIRE', KEYS[1], ARGV[1])
                end
                local ttl = redis.call('TTL', KEYS[1])
                return {current, ttl}
            `;

            const [current, ttl] = await redis.eval(rateLimitScript, 1, key, windowSec);
            const remaining = limit - current;
            
            // Standard Rate Limit Headers
            res.setHeader('X-RateLimit-Limit', limit);
            res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
            res.setHeader('X-RateLimit-Tier', tier);
            
            // X-RateLimit-Reset: Unix timestamp in seconds when the window resets
            const resetTimestamp = Math.floor(Date.now() / 1000) + (ttl > 0 ? ttl : 0);
            res.setHeader('X-RateLimit-Reset', resetTimestamp);

            if (current > limit) {
                console.warn(`[${serviceName}] Rate Limit Exceeded for ${tier} user: ${identifier}`);
                return res.status(429).json({
                    success: false,
                    message: "Too many requests. Please try again later.",
                    error: "RateLimitExceeded",
                    retryAfter: windowSec,
                    tier
                });
            }

            next();
        } catch (error) {
            // Fail open — Redis error should never block a legitimate request
            next();
        }
    };
};

module.exports = createRateLimiter;
