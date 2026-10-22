/**
 * Production-Grade In-Memory Sliding-Window Rate Limiter for Super Admin & Enterprise APIs
 * Zero external dependencies, fully compatible with Express 5 & reverse proxies (Railway/Nginx)
 */

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 60,
  message = 'Too many requests. Please slow down and try again later.',
  keyPrefix = 'rl',
  keyGenerator = null
} = {}) {
  // Store: key -> array of request timestamps (epoch ms)
  const store = new Map();

  // Periodically clean up stale records to prevent memory growth
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of store.entries()) {
      const valid = timestamps.filter(t => now - t < windowMs);
      if (valid.length === 0) {
        store.delete(key);
      } else {
        store.set(key, valid);
      }
    }
  }, Math.max(windowMs, 30000));
  if (cleanupTimer.unref) cleanupTimer.unref();

  return function rateLimiterMiddleware(req, res, next) {
    const now = Date.now();
    const clientIp = getClientIp(req);
    const identifier = keyGenerator
      ? keyGenerator(req)
      : (req.body?.admin_id || req.query?.admin_id || clientIp);

    const fullKey = `${keyPrefix}:${identifier}`;

    let timestamps = store.get(fullKey) || [];
    // Retain only requests within the sliding window
    timestamps = timestamps.filter(t => now - t < windowMs);

    const currentCount = timestamps.length;
    const remaining = Math.max(0, max - currentCount);
    const oldestTimestamp = timestamps[0] || now;
    const resetSeconds = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

    // Set standard RFC-compatible RateLimit headers
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.max(1, resetSeconds));

    if (currentCount >= max) {
      res.setHeader('Retry-After', Math.max(1, resetSeconds));
      return res.status(429).json({
        error: message,
        retryAfterSeconds: Math.max(1, resetSeconds),
        limit: max,
        remaining: 0,
        statusCode: 429
      });
    }

    timestamps.push(now);
    store.set(fullKey, timestamps);
    next();
  };
}

/**
 * 1. General Super Admin Operations Limiter
 * 120 requests per minute per IP / Admin ID
 * Covers general catalog browsing, warehouse listing, audit logs, and status checks.
 */
const superAdminGeneralLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  keyPrefix: 'sa_gen',
  message: 'Super Admin request rate limit reached (120 req/min). Please pause for a moment before retrying.'
});

/**
 * 2. Sensitive Super Admin Mutations Limiter
 * 30 requests per 15 minutes per IP / Admin ID
 * Covers: password resets, user creation/deletion, role permissions toggle, warehouse creation/deletion, financial payouts.
 */
const superAdminSensitiveLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  keyPrefix: 'sa_sens',
  message: 'Security Rate Limit: Too many sensitive administrative operations. Please wait before attempting further changes.'
});

/**
 * 3. Heavy Global Analytics & Reporting Limiter
 * 60 requests per minute per IP / Admin ID
 * Covers: /api/reports/summary, /api/stock/global, /api/referrals/tree, /api/audit-logs
 */
const superAdminAnalyticsLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyPrefix: 'sa_analytics',
  message: 'Analytics query limit reached. Please wait a few seconds before refreshing dashboard summaries.'
});

/**
 * 4. General Store Admin Operations Limiter
 * 120 requests per minute per IP / User ID
 * Covers: /api/stock/:owner_id, /api/stock/intakes, /api/customers, /api/store-admin/earnings/:user_id, /api/sales/report
 */
const storeAdminGeneralLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  keyPrefix: 'store_gen',
  message: 'Store Admin request rate limit reached (120 req/min). Please pause for a moment before retrying.'
});

/**
 * 5. Store Admin Stock Intake & Inward Limiter
 * 40 requests per 5 minutes per IP / User ID
 * Covers: /api/stock/intake, /api/stock/inward (protects consignment uploads and batch insertions)
 */
const storeAdminIntakeLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 40,
  keyPrefix: 'store_intake',
  message: 'Consignment intake rate limit reached. Please wait before submitting more stock intakes.'
});

/**
 * 6. Store Admin Transaction & Distribution Limiter
 * 60 requests per minute per IP / User ID
 * Covers: /api/stock/transfer, /api/sales, /api/customers
 */
const storeAdminTransactionLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyPrefix: 'store_txn',
  message: 'Transaction rate limit reached. Please wait a moment before recording further sales or transfers.'
});

/**
 * 7. General Field Sales Manager (FSM) Limiter
 * 120 requests per minute per IP / User ID
 * Covers: /api/fsm/dashboard/:fsm_id, /api/fsm/team/:fsm_id, /api/fsm/referral-requests/:fsm_id, /api/fsm/settlement/:fsm_id, /api/settlements
 */
const fsmGeneralLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  keyPrefix: 'fsm_gen',
  message: 'Field Manager request rate limit reached (120 req/min). Please pause for a moment before retrying.'
});

/**
 * 8. FSM Core Operations & Stock Allocations Limiter
 * 60 requests per minute per IP / User ID
 * Covers: /api/stock/transfers/:id/accept, /api/stock/recall, /api/fsm/allocate-batch, /api/settlements/:id/approve, /api/fsm/referral-requests/:id
 */
const fsmOperationsLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyPrefix: 'fsm_ops',
  message: 'Field Operations rate limit reached. Please wait a moment before completing further allocations or approvals.'
});

/**
 * 9. FSM Reminders & QR Limiter
 * 30 requests per 5 minutes per IP / User ID
 * Covers: /api/fsm/settlement-remind/:salesman_id, /api/fsm/warehouse-return-qr
 */
const fsmReminderLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  keyPrefix: 'fsm_remind',
  message: 'Reminder rate limit reached. Please wait before triggering further reminders or return tokens.'
});

/**
 * 10. General Field Salesman Limiter
 * 120 requests per minute per IP / User ID
 * Covers: /api/salesman/earnings/:salesman_id, /api/salesman/referrals/:salesman_id, /api/settlements/:salesman_id, /api/settlement/:id
 */
const salesmanGeneralLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  keyPrefix: 'sm_gen',
  message: 'Salesman request rate limit reached (120 req/min). Please pause for a moment before retrying.'
});

/**
 * 11. Salesman Candidate Referral Onboarding Limiter
 * 40 requests per 5 minutes per IP / User ID
 * Covers: /api/salesman/referrals (submitting candidates with KYC documents)
 */
const salesmanOnboardingLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 40,
  keyPrefix: 'sm_onboard',
  message: 'Referral submission rate limit reached. Please wait before submitting more candidate referrals.'
});

/**
 * 12. Salesman Duty Toggle Limiter
 * 60 requests per 5 minutes per IP / User ID
 * Covers: /api/users/:id/duty
 */
const salesmanDutyLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 60,
  keyPrefix: 'sm_duty',
  message: 'Duty status change rate limit reached. Please wait before toggling your shift status again.'
});

/**
 * 13. Authentication & Account Activation Limiter
 * 30 requests per 5 minutes per IP
 * Covers: /api/auth/check-status, /api/auth/setup-password
 */
const authGeneralLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  keyPrefix: 'auth_gen',
  message: 'Too many authentication attempts. Please pause for a few minutes before retrying.'
});

module.exports = {
  createRateLimiter,
  superAdminGeneralLimiter,
  superAdminSensitiveLimiter,
  superAdminAnalyticsLimiter,
  storeAdminGeneralLimiter,
  storeAdminIntakeLimiter,
  storeAdminTransactionLimiter,
  fsmGeneralLimiter,
  fsmOperationsLimiter,
  fsmReminderLimiter,
  salesmanGeneralLimiter,
  salesmanOnboardingLimiter,
  salesmanDutyLimiter,
  authGeneralLimiter,
  getClientIp
};


