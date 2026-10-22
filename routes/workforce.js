const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter, salesmanOnboardingLimiter } = require('../services/rateLimiter');

// Add user onboarding request (Store Admin / FSM initiating addition - Protected by Onboarding Limiter)
router.post('/api/workforce/request', salesmanOnboardingLimiter, async (req, res) => {
  const { name, email, phone, role, warehouse_id, parent_id, requested_by, password, aadhaar_number, kyc_doc } = req.body;
  if (!name || !email || !role || !requested_by) {
    return res.status(400).json({ error: 'Name, email, role, and requested_by are required' });
  }

  const initialPassword = password || '';
  const aadhNumber = (aadhaar_number || '').trim();
  const aadhDoc = (kyc_doc || '').trim();
  const newReqId = `req_${Date.now()}`;

  const newRequest = {
    id: newReqId,
    name,
    email,
    phone: phone || '',
    role,
    warehouse_id: warehouse_id || null,
    parent_id: parent_id || null,
    requested_by,
    password: initialPassword,
    aadhaar_number: aadhNumber,
    kyc_doc: aadhDoc,
    status: 'pending',
    created_at: new Date().toISOString()
  };

  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('user_creation_requests').insert([{
        name,
        email,
        role,
        warehouse_id: warehouse_id || null,
        parent_id: parent_id || null,
        requested_by: requested_by || null,
        status: 'pending'
      }]).select().single();
      if (!error && data && data.id) {
        newRequest.id = data.id;
      }
    } catch (err) {
      console.warn('user_creation_requests insert notice:', err.message);
    }
  }

  // Always keep in mockDb so it's guaranteed visible in Super Admin approval queue
  if (!mockDb.userRequests) mockDb.userRequests = [];
  mockDb.userRequests.unshift(newRequest);

  return res.status(201).json({ message: 'Request submitted successfully', request: newRequest });
});

// View pending workforce requests (Super Admin - Protected by General Admin Rate Limiter)
router.get('/api/workforce/requests', superAdminGeneralLimiter, async (req, res) => {
  let dbRequests = [];

  if (state.isSupabaseConfigured) {
    try {
      // First try with foreign key join for requested_by
      const { data, error } = await supabase.from('user_creation_requests')
        .select('*, requested_by_user:users!user_creation_requests_requested_by_fkey(name)')
        .ilike('status', 'pending');

      if (!error && Array.isArray(data)) {
        dbRequests = data.map(r => ({
          ...r,
          requested_by_name: r.requested_by_user?.name || null
        }));
      } else {
        // Fallback without join
        const { data: simpleData } = await supabase.from('user_creation_requests')
          .select('*')
          .ilike('status', 'pending');
        if (Array.isArray(simpleData)) {
          dbRequests = simpleData;
        }
      }
    } catch (err) {
      console.warn('user_creation_requests query exception:', err.message);
    }
  }

  // Merge Supabase requests and mockDb.userRequests without duplicates
  const combined = [...dbRequests];
  const seenIds = new Set(dbRequests.map(r => String(r.id)));

  for (const mReq of (mockDb.userRequests || [])) {
    const isPending = mReq.status && String(mReq.status).toLowerCase().includes('pending');
    if (isPending) {
      const idStr = String(mReq.id);
      if (!seenIds.has(idStr)) {
        seenIds.add(idStr);
        combined.push(mReq);
      }
    }
  }

  // Enrich all requests with safe requested_by object and requester name
  const enriched = combined.map(r => {
    let requestedByObj = null;
    let requestedByName = r.requested_by_name || null;

    if (r.requested_by && typeof r.requested_by === 'object' && r.requested_by.name) {
      requestedByName = r.requested_by.name;
      requestedByObj = r.requested_by;
    } else if (r.requested_by) {
      const reqId = String(r.requested_by);
      const found = (mockDb.users || []).find(u => String(u.id) === reqId);
      if (found) {
        requestedByName = `${found.name} (${found.role || 'Staff'})`;
        requestedByObj = { id: reqId, name: found.name, role: found.role };
      } else {
        requestedByName = `Supervisor (${reqId.length > 8 ? reqId.substring(0, 8) + '...' : reqId})`;
        requestedByObj = { id: reqId, name: requestedByName };
      }
    }

    return {
      ...r,
      phone: r.phone || '',
      password: r.password || '',
      aadhaar_number: r.aadhaar_number || '',
      kyc_doc: r.kyc_doc || r.aadhaar_doc || '',
      requested_by: requestedByObj,
      requested_by_name: requestedByName || 'Supervisor'
    };
  });

  return res.json(enriched);
});

// Approve workforce request (Super Admin - Protected by Sensitive Admin Rate Limiter)
router.post('/api/workforce/approve', superAdminSensitiveLimiter, async (req, res) => {
  const { request_id, approve } = req.body;
  if (!request_id) return res.status(400).json({ error: 'Request ID is required' });

  const status = approve ? 'approved' : 'rejected';
  let approvedSuccessfully = false;

  if (state.isSupabaseConfigured) {
    try {
      const { data: requestData, error: reqErr } = await supabase.from('user_creation_requests')
        .update({ status })
        .eq('id', request_id)
        .select()
        .single();
      if (!reqErr && requestData) {
        if (approve) {
          const userPayload = {
            name: requestData.name,
            email: requestData.email,
            role: requestData.role,
            warehouse_id: requestData.warehouse_id,
            parent_id: requestData.parent_id,
            status: 'approved',
            requires_password_setup: true
          };
          if (requestData.phone) userPayload.phone = requestData.phone;
          if (requestData.password) userPayload.password = requestData.password;
          if (requestData.aadhaar_number) userPayload.aadhaar_number = requestData.aadhaar_number;
          if (requestData.kyc_doc) userPayload.aadhaar_doc = requestData.kyc_doc;

          try {
            await supabase.from('users').insert([userPayload]);
          } catch (_) {
            await supabase.from('users').insert([{
              name: requestData.name,
              email: requestData.email,
              role: requestData.role,
              warehouse_id: requestData.warehouse_id,
              parent_id: requestData.parent_id,
              status: 'approved'
            }]);
          }
        }
        approvedSuccessfully = true;
      }
    } catch (err) {
      console.warn('Supabase approval note:', err.message);
    }
  }

  // Also update / fallback in local mockDb
  const reqIndex = (mockDb.userRequests || []).findIndex(r => String(r.id) === String(request_id));
  if (reqIndex !== -1) {
    mockDb.userRequests[reqIndex].status = status;
    if (approve) {
      const r = mockDb.userRequests[reqIndex];
      const newUser = {
        id: `u_${Date.now()}`,
        name: r.name,
        email: r.email,
        phone: r.phone || '',
        role: r.role,
        warehouse_id: r.warehouse_id,
        parent_id: r.parent_id,
        status: 'approved',
        password: r.password || '',
        aadhaar_number: r.aadhaar_number || '',
        aadhaar_doc: r.kyc_doc || '',
        requires_password_setup: r.requires_password_setup !== false
      };
      if (!mockDb.users) mockDb.users = [];
      mockDb.users.push(newUser);
      const ref = (mockDb.salesmanReferrals || []).find(sr => sr.phone === r.phone || String(sr.referred_salesman_id) === String(r.id));
      if (ref) {
        ref.status = 'Active';
        ref.kyc_status = 'Verified';
        ref.referred_salesman_id = newUser.id;
      }
    }
    approvedSuccessfully = true;
  }

  if (approvedSuccessfully) {
    return res.json({ message: `Request successfully ${status}` });
  } else {
    return res.status(404).json({ error: 'Request not found' });
  }
});

module.exports = router;
