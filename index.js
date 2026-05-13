/**
 * @nbu/shared-utils
 * ─────────────────
 * Central export for all shared utilities.
 * Each microservice imports what it needs:
 *
 *   const { authMiddleware, errorMiddleware, createRedisClient, publishEvent } = require('@nbu/shared-utils');
 */

const authMiddleware  = require('./middleware/authMiddleware');
const errorMiddleware = require('./middleware/errorMiddleware');
const rateLimiter     = require('./middleware/rateLimiter');
const {
    createRedisClient,
    createEventPublisher,
} = require('./utils/redisClient');
const { createQueuePublisher } = require('./utils/queuePublisher');

module.exports = {
    authMiddleware,
    errorMiddleware,
    rateLimiter,
    createRedisClient,
    createEventPublisher,
    createQueuePublisher,
};
