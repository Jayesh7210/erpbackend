const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const {
  getDefaultPasswordForRole,
  findUserByIdentifier,
  getClientIp,
  checkLoginRateLimit,
  recordFailedLogin,
  recordSuccessfulLogin,
  MAX_ACCOUNT_ATTEMPTS
} = require('../services/authService');
const { authGeneralLimiter } = require('../services/rateLimiter');

// Check worker status (For first-time account activation - Protected by Auth Limiter)
router.post('/api/auth/check-status', authGeneralLimiter, async (req, res) => {
  const { identifier } = req.body;
  const loginId = (identifier || '').trim();
  if (!loginId) return res.status(400).json({ error: 'Please enter your mobile number or email.' });

  const isEmail = loginId.includes('@');
  const digits = loginId.replace(/[^0-9]/g, '');

  // 1. Check if user is approved and active
  let matchedUser = await findUserByIdentifier(loginId);

  // 2. If not found in approved users, check if pending in requests queue
  if (!matchedUser) {
    let pendingReq = null;
    if (state.isSupabaseConfigured) {
      try {
        const { data } = await supabase.from('user_creation_requests').select('*').eq('status', 'pending');
        if (data) {
          pendingReq = data.find(r => 
            (isEmail && r.email?.toLowerCase() === loginId.toLowerCase()) ||
            (!isEmail && digits.length >= 10 && (r.phone || '').replace(/[^0-9]/g, '').endsWith(digits))
          );
        }
      } catch (_) {}
    }
    if (!pendingReq) {
      pendingReq = (mockDb.userRequests || []).find(r => 
        r.status === 'pending' && (
          (isEmail && r.email?.toLowerCase() === loginId.toLowerCase()) ||
          (!isEmail && digits.length >= 10 && (r.phone || '').replace(/[^0-9]/g, '').endsWith(digits))
        )
      );
    }

    if (pendingReq) {
      return res.json({
        status: 'pending_approval',
        name: pendingReq.name,
        message: 'Your referral registration has been submitted and is currently awaiting Super Admin approval. Once approved, you can set your password here.'
      });
    }

    return res.status(404).json({
      status: 'not_found',
      error: 'No staff account found with this mobile number or email. Please check with your team or referrer.'
    });
  }

  const needsSetup = matchedUser.requires_password_setup === true;

  return res.json({
    status: needsSetup ? 'ready_for_setup' : 'already_setup',
    requires_password_setup: needsSetup,
    user: {
      id: matchedUser.id,
      name: matchedUser.name,
      email: matchedUser.email,
      phone: matchedUser.phone || '',
      role: matchedUser.role
    }
  });
});

// Setup Initial Password (First-Time Login Activation - Protected by Auth Limiter)
router.post('/api/auth/setup-password', authGeneralLimiter, async (req, res) => {
  const { identifier, password } = req.body;
  const loginId = (identifier || '').trim();
  const newPass = (password || '').trim();

  if (!loginId) return res.status(400).json({ error: 'Mobile number or email is required.' });
  if (!newPass || newPass.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
  }

  const matchedUser = await findUserByIdentifier(loginId);
  if (!matchedUser) {
    return res.status(404).json({ error: 'No approved staff account found for this mobile number or email.' });
  }

  // Update password directly in database
  if (state.isSupabaseConfigured) {
    try {
      await supabase.from('users').update({
        password: newPass,
        requires_password_setup: false
      }).eq('id', matchedUser.id);
    } catch (err) {
      console.warn('Supabase setup-password update error:', err.message);
    }
  }

  // Update in-memory fallback
  const memUser = mockDb.users.find(u => u.id === matchedUser.id || u.email.toLowerCase() === matchedUser.email.toLowerCase());
  if (memUser) {
    memUser.password = newPass;
    memUser.requires_password_setup = false;
  }

  await logAudit(
    matchedUser.id,
    matchedUser.name,
    'FIRST_TIME_PASSWORD_SET',
    'users',
    matchedUser.id,
    `Worker completed first-time password setup`
  );

  const enrichedUser = {
    ...matchedUser,
    password: newPass,
    requires_password_setup: false
  };

  const token = `jwt_${Buffer.from(matchedUser.email).toString('base64')}_${Date.now()}`;
  return res.json({
    message: 'Password created successfully! Welcome aboard.',
    user: enrichedUser,
    token
  });
});

// Login endpoint: Traditional Mobile Number or Email + Password (Protected by Rate Limiter)
router.post('/api/auth/login', checkLoginRateLimit, async (req, res) => {
  const { email, phone, identifier, password } = req.body;
  const loginId = (identifier || email || phone || '').trim();
  const pass = (password || '').trim();
  const clientIp = getClientIp(req);

  if (!loginId) {
    return res.status(400).json({ error: 'Please enter your mobile number or email address.' });
  }

  const isEmail = loginId.includes('@');
  const digits = loginId.replace(/[^0-9]/g, '');

  let matchedUser = await findUserByIdentifier(loginId);

  if (!matchedUser) {
    // Record attempt on unrecognized login ID
    recordFailedLogin(loginId, clientIp);

    // Check if account is still waiting for approval
    let pendingReq = null;
    if (state.isSupabaseConfigured) {
      try {
        const { data } = await supabase.from('user_creation_requests').select('*').eq('status', 'pending');
        if (data) {
          pendingReq = data.find(r => 
            (isEmail && r.email?.toLowerCase() === loginId.toLowerCase()) ||
            (!isEmail && digits.length >= 10 && (r.phone || '').replace(/[^0-9]/g, '').endsWith(digits))
          );
        }
      } catch (_) {}
    }
    if (!pendingReq) {
      pendingReq = (mockDb.userRequests || []).find(r => 
        r.status === 'pending' && (
          (isEmail && r.email?.toLowerCase() === loginId.toLowerCase()) ||
          (!isEmail && digits.length >= 10 && (r.phone || '').replace(/[^0-9]/g, '').endsWith(digits))
        )
      );
    }
    if (pendingReq) {
      return res.status(403).json({
        error: 'Your account registration is still pending Super Admin approval. Please contact Super Admin.'
      });
    }
    return res.status(401).json({ error: 'No active account found with this email or mobile number.' });
  }

  // Check if this account needs first-time password setup
  if (matchedUser.requires_password_setup === true) {
    return res.json({
      requires_password_setup: true,
      message: 'First-time login detected. Please create your secure password to activate your account.',
      user: {
        id: matchedUser.id,
        name: matchedUser.name,
        email: matchedUser.email,
        phone: matchedUser.phone || '',
        role: matchedUser.role,
        requires_password_setup: true
      }
    });
  }

  if (!pass) {
    return res.status(400).json({ error: 'Please enter your password.' });
  }

  // Password from database or fallback default
  const expectedPassword = matchedUser.password || getDefaultPasswordForRole(matchedUser.role);

  if (pass !== expectedPassword) {
    const attemptStatus = recordFailedLogin(loginId, clientIp);

    if (attemptStatus.locked) {
      res.setHeader('Retry-After', attemptStatus.lockoutMinutes * 60);
      return res.status(429).json({
        error: `Account temporarily locked due to ${MAX_ACCOUNT_ATTEMPTS} consecutive failed login attempts. Please try again in ${attemptStatus.lockoutMinutes} minutes or contact Super Admin.`,
        isLocked: true,
        retryAfterMinutes: attemptStatus.lockoutMinutes
      });
    }

    return res.status(401).json({
      error: `Invalid password. ${attemptStatus.remaining} attempt(s) remaining before temporary 15-minute lockout.`,
      remainingAttempts: attemptStatus.remaining
    });
  }

  // Reset rate limiting attempts on successful login
  recordSuccessfulLogin(loginId, clientIp);

  const enrichedUser = {
    ...matchedUser,
    phone: matchedUser.phone || '',
    password: expectedPassword,
    requires_password_setup: false,
    aadhaar_number: matchedUser.aadhaar_number || '',
    aadhaar_doc: matchedUser.aadhaar_doc || '',
    kyc_status: matchedUser.kyc_status || (matchedUser.aadhaar_doc ? 'Verified' : 'Pending')
  };

  const token = `jwt_${Buffer.from(matchedUser.email).toString('base64')}_${Date.now()}`;
  return res.json({ user: enrichedUser, token });
});

module.exports = router;
