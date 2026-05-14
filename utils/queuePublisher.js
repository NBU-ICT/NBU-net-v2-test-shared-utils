const { Queue } = require('bullmq');
const { createRedisClient } = require('./redisClient');

/**
 * Create a durable job publisher using BullMQ.
 * 
 * Why BullMQ?
 *  • Persistence: Jobs stay in Redis even if the worker service restarts.
 *  • Retries: Automatic exponential backoff for failed emails/notifications.
 *  • Concurrency: Handles thousands of jobs without blocking the main event loop.
 * 
 * Usage:
 *   const { createQueuePublisher } = require('@nbu/shared-utils');
 *   const { addJob } = createQueuePublisher({ serviceName: 'admission' });
 *   
 *   await addJob('EMAIL', { recipient: '...', subject: '...', content: '...' });
 */
const createQueuePublisher = ({ 
    queueName = 'message-queue',
    serviceName = 'service',
    redisUrl = process.env.EVENT_BUS_REDIS_URL || process.env.REDIS_URL 
} = {}) => {
    // BullMQ requires a connection with maxRetriesPerRequest set to null to avoid connection issues during long waits
    const connection = createRedisClient({ 
        url: redisUrl, 
        serviceName: `${serviceName}:QueuePublisher`,
        maxRetries: null 
    });

    if (!connection) {
        return {
            addJob: async () => console.warn(`[${serviceName}] Queue Publisher: Redis URL not set.`),
            queue: null
        };
    }

    const queue = new Queue(queueName, { connection });

    /**
     * Add a job to the queue with standardized retry and cleanup policies.
     * @param {string} type - Job category (e.g., 'EMAIL', 'NOTIFICATION', 'SMS')
     * @param {Object} payload - The data required to process the job
     * @param {Object} [options] - Optional BullMQ job configurations
     */
    const addJob = async (type, payload, options = {}) => {
        try {
            const job = await queue.add(`${serviceName}:${type}`, { type, payload }, {
                removeOnComplete: true, // Keep Redis clean
                removeOnFail: false,     // Keep failed jobs for manual inspection/retry
                attempts: 3,            // Try up to 3 times before moving to failed set
                backoff: {
                    type: 'exponential',
                    delay: 2000,        // Start with 2s wait, then 4s, then 8s...
                },
                ...options
            });
            console.log(`[${serviceName}] Durable job ${job.id} [${type}] added to queue.`);
            return job;
        } catch (error) {
            console.error(`[${serviceName}] Failed to add job to queue:`, error.message);
        }
    };

    return { addJob, queue };
};

module.exports = { createQueuePublisher };
