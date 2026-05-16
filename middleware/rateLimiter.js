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
 */
const createRateLimiter = ({ 
    serviceName, 
    publicMax = 150, 
    publicWindowMs = 15 * 60 * 1000,
    authMax = 3000,
    authWindowMs = 15 * 60 * 1000,
    redisUrl = process.env.REDIS_URL
}) => {
    const redis = createRedisClient({ url: redisUrl, serviceName: `${serviceName}:RateLimiter` });

    return async (req, res, next) => {
        // If Redis isn't available, we "fail open" to ensure availability,
        // but log a warning as the system is unprotected.
        if (!redis) {
            console.warn(`[${serviceName}] Rate Limiter inactive - Redis unavailable`);
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
            // Atomic increment and expiry using Lua script to prevent memory leaks
            const rateLimitScript = `
                local current = redis.call('INCR', KEYS[1])
                if current == 1 then
                    redis.call('EXPIRE', KEYS[1], ARGV[1])
                end
                return current
            `;

            const current = await redis.eval(rateLimitScript, 1, key, windowSec);
            const ttl = await redis.ttl(key);
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
            console.error(`[${serviceName}] Rate Limiter internal error:`, error.message);
            next();
        }
    };
};

module.exports = createRateLimiter;
