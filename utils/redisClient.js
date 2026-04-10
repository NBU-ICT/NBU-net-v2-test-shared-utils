/**
 * shared-utils/utils/redisClient.js
 * ───────────────────────────────────
 * Factory functions for creating Redis clients.
 *
 * Why factories instead of singletons?
 *  • Each microservice has its own REDIS_URL and may have a separate EVENT_BUS_REDIS_URL
 *  • A factory lets each service create exactly what it needs, without shared global state
 *  • Graceful degradation: if Redis is unreachable, connections retry automatically
 *
 * Usage:
 *   const { createRedisClient, createEventPublisher } = require('@nbu/shared-utils');
 *
 *   // Basic cache client
 *   const redis = createRedisClient({ url: process.env.REDIS_URL, serviceName: 'admission' });
 *
 *   // Event publisher (uses EVENT_BUS_REDIS_URL if set, else falls back to REDIS_URL)
 *   const { publishEvent, client } = createEventPublisher({ serviceName: 'admission' });
 */

const Redis = require('ioredis');

/**
 * Create a new Redis client with retry logic and event logging.
 * @param {Object} opts
 * @param {string} opts.url           - Redis connection URL
 * @param {string} [opts.serviceName] - Label used in logs (e.g. "admission", "academic")
 * @param {number|null} [opts.maxRetries] - maxRetriesPerRequest (use null for BullMQ)
 * @returns {import('ioredis').Redis}
 */
const createRedisClient = ({ url, serviceName = 'service', maxRetries = 3 }) => {
    if (!url) {
        console.warn(`[${serviceName}] REDIS_URL not set – Redis features disabled.`);
        return null;
    }

    const client = new Redis(url, {
        retryStrategy(times) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        maxRetriesPerRequest: maxRetries,
        lazyConnect: false,
    });

    client.on('connect', () => {
        console.log(`[${serviceName}] Redis connected successfully`);
    });

    client.on('error', (err) => {
        console.warn(`[${serviceName}] Redis connection error:`, err.message);
    });

    return client;
};

/**
 * Create an event publisher with a `publishEvent(channel, message)` helper.
 * Uses EVENT_BUS_REDIS_URL if available, else falls back to REDIS_URL.
 *
 * @param {Object} opts
 * @param {string} [opts.serviceName]       - Label used in logs
 * @param {string} [opts.redisUrl]          - Primary Redis URL (defaults to REDIS_URL env)
 * @param {string} [opts.eventBusRedisUrl]  - Dedicated event bus URL (defaults to EVENT_BUS_REDIS_URL env)
 * @returns {{ publishEvent: Function, client: import('ioredis').Redis }}
 */
const createEventPublisher = ({
    serviceName = 'service',
    redisUrl = process.env.REDIS_URL,
    eventBusRedisUrl = process.env.EVENT_BUS_REDIS_URL,
} = {}) => {
    // Use event bus URL if different from main, else reuse main
    const url = (eventBusRedisUrl && eventBusRedisUrl !== redisUrl)
        ? eventBusRedisUrl
        : redisUrl;

    const label = (eventBusRedisUrl && eventBusRedisUrl !== redisUrl) ? 'EventBus' : 'Main';

    const client = createRedisClient({ url, serviceName: `${serviceName}:${label}` });

    /**
     * Publish a JSON event to a Redis channel.
     * @param {string} channel - Redis pub/sub channel name
     * @param {Object} message - Event payload (will be JSON.stringify'd)
     */
    const publishEvent = async (channel, message) => {
        if (!client) {
            console.warn(`[${serviceName}] Cannot publish – Redis not available`);
            return;
        }
        try {
            const payload = JSON.stringify(message);
            await client.publish(channel, payload);
            console.log(`[${serviceName}] Event published to ${channel}:`, message.type || 'unknown');
        } catch (error) {
            console.error(`[${serviceName}] Failed to publish event to ${channel}:`, error.message);
        }
    };

    return { publishEvent, client };
};

module.exports = {
    createRedisClient,
    createEventPublisher,
};
