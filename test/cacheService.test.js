const assert = require('assert');
const { CacheService, createCacheService } = require('../utils/cacheService');
const cacheMiddleware = require('../middleware/cacheMiddleware');

// Mock Redis Client for testing
class MockRedis {
  constructor() {
    this.store = new Map();
    this.status = 'ready';
    this.deletedKeys = [];
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async set(key, val) {
    this.store.set(key, val);
    return 'OK';
  }

  async setex(key, ttl, val) {
    this.store.set(key, val);
    return 'OK';
  }

  async del(...keys) {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
      this.deletedKeys.push(k);
    }
    return count;
  }

  async scan(cursor, matchKeyword, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const matched = [];
    for (const key of this.store.keys()) {
      if (regex.test(key)) matched.push(key);
    }
    return ['0', matched];
  }
}

async function runTests() {
  console.log('🧪 Starting CacheService and CacheMiddleware Test Suite...\n');
  const mockRedis = new MockRedis();
  const cache = createCacheService({
    serviceName: 'test-service',
    redisClient: mockRedis,
    defaultTtl: 300,
  });

  // Test 1: Public Key Generation
  const pubKey = cache.buildKey({ scope: 'public', key: 'catalog/sessions' });
  assert.strictEqual(pubKey, 'test-service:public:catalog/sessions');
  console.log('✅ Test 1 Passed: Public cache key correctly generated.');

  // Test 2: User-Scoped Key Generation
  const userKey = cache.buildKey({ scope: 'user', userId: 'usr-12345', key: 'profile' });
  assert.strictEqual(userKey, 'test-service:user:usr-12345:profile');
  console.log('✅ Test 2 Passed: User-scoped cache key correctly generated.');

  // Test 3: User-Scoped Key Rejection on Missing/Empty UserId
  const invalidUserKey = cache.buildKey({ scope: 'user', userId: null, key: 'profile' });
  assert.strictEqual(invalidUserKey, null);
  console.log('✅ Test 3 Passed: User-scoped key generation rejected when userId is missing.');

  // Test 4: Set and Get User-Scoped Data
  const studentA = { userId: 'usr-12345', name: 'Student A', department: 'Computer Science' };
  await cache.set(userKey, studentA, 300, { scope: 'user', userId: 'usr-12345' });
  const retrievedA = await cache.get(userKey, { expectedUserId: 'usr-12345' });
  assert.deepStrictEqual(retrievedA, studentA);
  console.log('✅ Test 4 Passed: User-scoped data saved and retrieved successfully.');

  // Test 5: Phase 9 Ownership Defense (Contamination Detection & Eviction)
  // Simulate an injected key or collision where student A's key contains Student B's data
  const contaminatedKey = 'test-service:user:usr-attacker:stolen-profile';
  const victimData = { userId: 'usr-victim', name: 'Victim Student', gpa: 4.0 };
  await mockRedis.set(contaminatedKey, JSON.stringify(victimData));

  // Request with expectedUserId = 'usr-attacker'
  const result = await cache.get(contaminatedKey, { expectedUserId: 'usr-attacker' });
  assert.strictEqual(result, null, 'Expected cache miss when ownership verification fails');
  assert.ok(mockRedis.deletedKeys.includes(contaminatedKey), 'Expected contaminated key to be evicted from Redis');
  console.log('✅ Test 5 Passed: Phase 9 Defense successfully evicted contaminated cross-user cache entry.');

  // Test 6: Middleware User Scope Enforcement
  let nextCalled = false;
  const mockReqUnauth = {
    method: 'GET',
    originalUrl: '/api/profile',
    user: null, // Unauthenticated
  };
  const mockRes = {
    setHeader: () => {},
    json: () => {},
  };
  const mw = cacheMiddleware({
    scope: 'user',
    serviceName: 'test',
    cacheService: cache,
  });

  await mw(mockReqUnauth, mockRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Middleware must call next() and bypass caching when unauthenticated');
  console.log('✅ Test 6 Passed: Cache middleware bypassed unauthenticated user on user-scoped route.');

  console.log('\n🎉 ALL CACHE TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
