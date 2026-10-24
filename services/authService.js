const { supabaseAdmin: supabase } = require('../db');
const { state } = require('../data/state');

function getDefaultPasswordForRole(role) {
  switch (role) {
    case 'super_admin': return 'admin123';
    case 'store_admin': return 'store123';
    case 'field_sales_manager': return 'fsm123';
    case 'salesman': return 'sales123';
    default: return '123456';
  }
}

async function findUserByIdentifier(loginId) {
  if (!loginId) return null;
  const isEmail = loginId.includes('@');
  const digits = loginId.replace(/[^0-9]/g, '');

  if (state.isSupabaseConfigured) {
    try {
      if (isEmail) {
        const { data, error } = await supabase.from('users').select('*').ilike('email', loginId).eq('status', 'approved');
        if (!error && data && data.length > 0) return data[0];
      } else if (digits.length >= 10) {
        const { data, error } = await supabase.from('users').select('*').eq('status', 'approved');
        if (!error && data && data.length > 0) {
          const found = data.find(u => {
            const pDigits = (u.phone || '').replace(/[^0-9]/g, '');
            return pDigits.length >= 10 && (pDigits.endsWith(digits) || digits.endsWith(pDigits));
          });
          if (found) return found;
        }
      }
    } catch (err) {
      console.warn('findUserByIdentifier Supabase error:', err.message);
    }
  }

  return null;
}

// ============================================================================
// LOGIN RATE LIMITING & BRUTE-FORCE PROTECTION
// ============================================================================
const loginAttemptsByAccount = new Map(); // key: loginId (lowercase) -> { count, lockedUntil, firstAttempt }
const loginAttemptsByIp = new Map();      // key: clientIp -> { count, resetAt }

const MAX_ACCOUNT_ATTEMPTS = 5;
const ACCOUNT_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes lockout
const IP_BURST_MAX = 20;                   // max attempts per IP
const IP_WINDOW_MS = 15 * 60 * 1000;       // 15-minute window

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

function checkLoginRateLimit(req, res, next) {
  const now = Date.now();
  const clientIp = getClientIp(req);
  const loginId = (req.body.identifier || req.body.email || req.body.phone || '').trim().toLowerCase();

  // 1. IP Burst Throttle
  const ipRec = loginAttemptsByIp.get(clientIp);
  if (ipRec) {
    if (now < ipRec.resetAt) {
      if (ipRec.count >= IP_BURST_MAX) {
        const remainingMinutes = Math.ceil((ipRec.resetAt - now) / 60000);
        res.setHeader('Retry-After', remainingMinutes * 60);
        return res.status(429).json({
          error: `Too many login requests from your network. Please wait ${remainingMinutes} minute(s) before trying again.`,
          retryAfterMinutes: remainingMinutes
        });
      }
    } else {
      loginAttemptsByIp.set(clientIp, { count: 0, resetAt: now + IP_WINDOW_MS });
    }
  } else {
    loginAttemptsByIp.set(clientIp, { count: 0, resetAt: now + IP_WINDOW_MS });
  }

  // 2. Account-Level Lockout
  if (loginId) {
    const accRec = loginAttemptsByAccount.get(loginId);
    if (accRec && accRec.lockedUntil && now < accRec.lockedUntil) {
      const remainingMinutes = Math.ceil((accRec.lockedUntil - now) / 60000);
      res.setHeader('Retry-After', remainingMinutes * 60);
      return res.status(429).json({
        error: `Account temporarily locked due to ${MAX_ACCOUNT_ATTEMPTS} consecutive failed login attempts. Please try again in ${remainingMinutes} minute(s) or contact Super Admin.`,
        retryAfterMinutes: remainingMinutes,
        isLocked: true
      });
    }
  }

  next();
}

function recordFailedLogin(loginId, clientIp) {
  const now = Date.now();

  // 1. Increment IP usage
  const ipRec = loginAttemptsByIp.get(clientIp) || { count: 0, resetAt: now + IP_WINDOW_MS };
  ipRec.count += 1;
  loginAttemptsByIp.set(clientIp, ipRec);

  // 2. Increment Account failed attempts
  if (!loginId) return { count: 1, remaining: MAX_ACCOUNT_ATTEMPTS - 1, locked: false };
  const normalized = loginId.trim().toLowerCase();
  let accRec = loginAttemptsByAccount.get(normalized);

  if (!accRec || (accRec.lockedUntil && now >= accRec.lockedUntil)) {
    accRec = { count: 1, lockedUntil: null, firstAttempt: now };
  } else {
    if (!accRec.lockedUntil && (now - accRec.firstAttempt > ACCOUNT_LOCKOUT_MS)) {
      accRec = { count: 1, lockedUntil: null, firstAttempt: now };
    } else {
      accRec.count += 1;
    }
  }

  if (accRec.count >= MAX_ACCOUNT_ATTEMPTS) {
    accRec.lockedUntil = now + ACCOUNT_LOCKOUT_MS;
    loginAttemptsByAccount.set(normalized, accRec);
    return { count: accRec.count, remaining: 0, locked: true, lockoutMinutes: 15 };
  }

  loginAttemptsByAccount.set(normalized, accRec);
  return {
    count: accRec.count,
    remaining: MAX_ACCOUNT_ATTEMPTS - accRec.count,
    locked: false
  };
}

function recordSuccessfulLogin(loginId, clientIp) {
  if (loginId) {
    loginAttemptsByAccount.delete(loginId.trim().toLowerCase());
  }
}

function unlockAccount(user) {
  if (!user) return;
  if (user.email) loginAttemptsByAccount.delete(user.email.toLowerCase().trim());
  if (user.phone) {
    loginAttemptsByAccount.delete(user.phone.toLowerCase().trim());
    const digits = user.phone.replace(/[^0-9]/g, '');
    if (digits) loginAttemptsByAccount.delete(digits);
  }
}

// Auto cleanup expired lockout records every 10 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttemptsByAccount.entries()) {
    if (val.lockedUntil && now >= val.lockedUntil) {
      loginAttemptsByAccount.delete(key);
    } else if (!val.lockedUntil && (now - val.firstAttempt > ACCOUNT_LOCKOUT_MS)) {
      loginAttemptsByAccount.delete(key);
    }
  }
  for (const [ip, val] of loginAttemptsByIp.entries()) {
    if (now >= val.resetAt) {
      loginAttemptsByIp.delete(ip);
    }
  }
}, 10 * 60 * 1000);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

module.exports = {
  getDefaultPasswordForRole,
  findUserByIdentifier,
  getClientIp,
  checkLoginRateLimit,
  recordFailedLogin,
  recordSuccessfulLogin,
  unlockAccount,
  MAX_ACCOUNT_ATTEMPTS
};
