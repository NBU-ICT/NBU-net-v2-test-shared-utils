/**
 * shared-utils/utils/cacheService.js
 * ────────────────────────────────────
 * Enterprise Cache Service with explicit scope enforcement, service namespacing,
 * and Defense-in-Depth Ownership Verification.
 *
 * Guarantees:
 * 1. User-scoped cache keys MUST include canonical authenticated userId.
 * 2. Never falls back to a shared URL-only key if userId is missing.
 * 3. Validates cached data ownership before returning (detects & evicts cross-user contamination).
 * 4. Safe diagnostics logging (no secrets / tokens).
 */

const { createRedisClient } = require('./redisClient');

class CacheService {
  /**
   * @param {Object} options
   * @param {string} options.serviceName - Unique service identifier (e.g., 'student', 'payment', 'gateway')
   * @param {import('ioredis').Redis} [options.redisClient] - Existing ioredis client
   * @param {string} [options.redisUrl] - Redis connection string (if client not provided)
   * @param {number} [options.defaultTtl=3600] - Default TTL in seconds
   */
  constructor({ serviceName = 'service', redisClient = null, redisUrl = process.env.REDIS_URL, defaultTtl = 3600 } = {}) {
    this.serviceName = serviceName;
    this.defaultTtl = defaultTtl;
    this.redis = redisClient || (redisUrl ? createRedisClient({ url: redisUrl, serviceName: `${serviceName}:CacheService` }) : null);
  }

  /**
   * Check if Redis is ready to accept commands.
   * @returns {boolean}
   */
  isReady() {
    return Boolean(this.redis && this.redis.status === 'ready');
  }

  /**
   * Build an isolated cache key.
   * @param {Object} params
   * @param {'public'|'user'} [params.scope='public'] - Cache scope
   * @param {string} [params.userId] - Canonical User ID (MANDATORY for user scope)
   * @param {string} params.key - Descriptive key or route suffix
   * @param {string} [params.sessionId] - Optional academic session ID
   * @param {string} [params.context] - Optional additional discriminator
   * @returns {string|null} - The canonical cache key or null if validation fails
   */
  buildKey({ scope = 'public', userId, key, sessionId, context }) {
    if (!key) throw new Error(`[${this.serviceName}:Cache] Key name is required.`);

    const cleanKey = String(key).trim().replace(/^\/+/, '');
    const sessionPart = sessionId ? `:session:${sessionId}` : '';
    const contextPart = context ? `:ctx:${context}` : '';

    if (scope === 'user') {
      const cleanUserId = String(userId || '').trim();
      if (!cleanUserId || cleanUserId === 'undefined' || cleanUserId === 'null') {
        console.warn(`[${this.serviceName}:Cache] Refusing to generate user-scoped cache key: missing or invalid userId for key '${cleanKey}'.`);
        return null;
      }
      return `${this.serviceName}:user:${cleanUserId}:${cleanKey}${sessionPart}${contextPart}`;
    }

    return `${this.serviceName}:public:${cleanKey}${sessionPart}${contextPart}`;
  }

  /**
   * Retrieve a cached value with optional defense-in-depth ownership verification.
   * @param {string} key - Cache key
   * @param {Object} [options]
   * @param {string} [options.expectedUserId] - Authenticated user ID to verify ownership against
   * @returns {Promise<any|null>}
   */
  async get(key, { expectedUserId } = {}) {
    if (!this.isReady() || !key) return null;

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const data = JSON.parse(raw);

      // ── Phase 9: Cache Entry Ownership Defense ──────────────────────────────
      if (expectedUserId && data && typeof data === 'object') {
        const cleanExpected = String(expectedUserId).trim();
        const dataUserId = data.userId || data.authUserId || (data.user && data.user.id);

        if (dataUserId && String(dataUserId).trim() !== cleanExpected) {
          console.error(
            `[CACHE_SECURITY_VIOLATION] [${this.serviceName}] Contaminated cache entry detected! ` +
            `Entry belongs to userId='${dataUserId}' but was requested for expectedUserId='${cleanExpected}'. ` +
            `Key: '${key}'. Evicting invalid cache entry immediately.`
          );
          // Evict corrupted entry
          await this.redis.del(key).catch(() => {});
          return null;
        }
      }

      return data;
    } catch (err) {
      console.warn(`[${this.serviceName}:Cache] Get failed for key '${key}':`, err.message);
      return null;
    }
  }

  /**
   * Set a cached value with TTL and scope verification.
   * @param {string} key - Cache key
   * @param {any} value - Serializable data
   * @param {number} [ttlSeconds] - TTL in seconds
   * @param {Object} [options]
   * @param {'public'|'user'} [options.scope='public'] - Cache scope
   * @param {string} [options.userId] - User ID for user-scoped cache
   */
  async set(key, value, ttlSeconds = this.defaultTtl, { scope = 'public', userId } = {}) {
    if (!this.isReady() || !key || value === undefined || value === null) return;

    if (scope === 'user' && (!userId || userId === 'undefined' || userId === 'null')) {
      console.warn(`[${this.serviceName}:Cache] Refusing to set user-scoped cache: missing userId for key '${key}'.`);
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : this.defaultTtl;
      await this.redis.setex(key, ttl, serialized);
    } catch (err) {
      console.warn(`[${this.serviceName}:Cache] Set failed for key '${key}':`, err.message);
    }
  }

  /**
   * Delete one or more keys.
   * @param  {...string} keys
   */
  async del(...keys) {
    if (!this.isReady()) return;
    const validKeys = keys.filter(Boolean);
    if (validKeys.length === 0) return;

    try {
      await this.redis.del(...validKeys);
    } catch (err) {
      console.warn(`[${this.serviceName}:Cache] Del failed:`, err.message);
    }
  }

  /**
   * Scan and delete keys matching a pattern (non-blocking).
   * @param {string} pattern - Redis glob pattern (e.g. 'payment:user:123:*')
   */
  async delPattern(pattern) {
    if (!this.isReady() || !pattern) return;

    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys && keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      console.warn(`[${this.serviceName}:Cache] DelPattern failed for '${pattern}':`, err.message);
    }
  }

  /**
   * Cache-aside helper with ownership defense and safe diagnostics.
   * @param {Object} params
   * @param {string} params.key - Cache key
   * @param {number} [params.ttlSeconds] - TTL in seconds
   * @param {'public'|'user'} [params.scope='public'] - Cache scope
   * @param {string} [params.userId] - Canonical User ID for user-scoped cache
   * @param {Function} params.fetcher - Async function to retrieve live data on cache miss
   * @returns {Promise<any>}
   */
  async getOrSet({ key, ttlSeconds, scope = 'public', userId, fetcher }) {
    if (!key) return fetcher();

    const cached = await this.get(key, { expectedUserId: scope === 'user' ? userId : undefined });
    if (cached !== null) {
      console.log(`[CACHE] service=${this.serviceName} scope=${scope} userId=${userId || 'N/A'} key=${key} hit=true`);
      return cached;
    }

    console.log(`[CACHE] service=${this.serviceName} scope=${scope} userId=${userId || 'N/A'} key=${key} hit=false`);
    const fresh = await fetcher();

    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds || this.defaultTtl, { scope, userId });
    }

    return fresh;
  }
}

/**
 * Factory for creating CacheService instances.
 * @param {Object} opts
 * @returns {CacheService}
 */
const createCacheService = (opts) => new CacheService(opts);

module.exports = {
  CacheService,
  createCacheService,
};
