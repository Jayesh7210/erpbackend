const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter, salesmanOnboardingLimiter } = require('../services/rateLimiter');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveWarehouseAndParent(whId, parentId, requestedBy) {
  let finalWhId = null;
  let finalParentId = null;

  if (state.isSupabaseConfigured) {
    try {
      // 1. Resolve Warehouse
      if (whId && UUID_REGEX.test(String(whId))) {
        const { data: wh } = await supabase.from('warehouses').select('id').eq('id', whId).maybeSingle();
        if (wh && wh.id) finalWhId = wh.id;
      }
      if (!finalWhId) {
        // Fallback to first existing warehouse in Supabase
        const { data: firstWh } = await supabase.from('warehouses').select('id').limit(1).maybeSingle();
        if (firstWh && firstWh.id) finalWhId = firstWh.id;
      }

      // 2. Resolve Parent
      if (parentId && UUID_REGEX.test(String(parentId))) {
        const { data: pUser } = await supabase.from('users').select('id').eq('id', parentId).maybeSingle();
        if (pUser && pUser.id) finalParentId = pUser.id;
      }
      if (!finalParentId && requestedBy && UUID_REGEX.test(String(requestedBy))) {
        const { data: reqUser } = await supabase.from('users').select('id').eq('id', requestedBy).maybeSingle();
        if (reqUser && reqUser.id) finalParentId = reqUser.id;
      }
      if (!finalParentId) {
        // If still null, try finding an active field_sales_manager
        const { data: fsmUser } = await supabase.from('users').select('id').eq('role', 'field_sales_manager').limit(1).maybeSingle();
        if (fsmUser && fsmUser.id) finalParentId = fsmUser.id;
      }
    } catch (e) {
      console.warn('resolveWarehouseAndParent warning:', e.message);
    }
  }

  return { warehouse_id: finalWhId, parent_id: finalParentId };
}

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

  const { warehouse_id: resolvedWh, parent_id: resolvedParent } = await resolveWarehouseAndParent(
    warehouse_id,
    parent_id,
    requested_by
  );

  const newRequest = {
    id: newReqId,
    name,
    email: email.trim().toLowerCase(),
    phone: phone || '',
    role,
    warehouse_id: resolvedWh || warehouse_id || null,
    parent_id: resolvedParent || parent_id || null,
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
        email: email.trim().toLowerCase(),
        role,
        warehouse_id: resolvedWh,
        parent_id: resolvedParent,
        requested_by: requested_by && UUID_REGEX.test(requested_by) ? requested_by : null,
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
  let targetUser = null;
  const isUuid = UUID_REGEX.test(String(request_id));

  // 1. Locate request in Supabase if UUID
  let requestData = null;
  if (state.isSupabaseConfigured && isUuid) {
    try {
      const { data } = await supabase.from('user_creation_requests')
        .select('*')
        .eq('id', request_id)
        .maybeSingle();
      if (data) requestData = data;
    } catch (_) {}
  }

  // 2. Locate request in mockDb
  const mIndex = (mockDb.userRequests || []).findIndex(r => String(r.id) === String(request_id));
  const mReq = mIndex !== -1 ? mockDb.userRequests[mIndex] : null;

  // 3. Fallback search by email / phone if not found by exact ID
  let reqObj = requestData || mReq;
  if (!reqObj) {
    const foundInMock = (mockDb.userRequests || []).find(r => r.email === request_id || r.phone === request_id);
    if (foundInMock) reqObj = foundInMock;
  }

  if (!reqObj && state.isSupabaseConfigured) {
    try {
      const { data } = await supabase.from('user_creation_requests')
        .select('*')
        .or(`email.eq.${request_id},phone.eq.${request_id}`)
        .limit(1)
        .maybeSingle();
      if (data) reqObj = data;
    } catch (_) {}
  }

  if (!reqObj) {
    return res.status(404).json({ error: 'Request not found' });
  }

  // 4. If approving, provision user in Supabase and local store
  if (approve) {
    const { warehouse_id, parent_id } = await resolveWarehouseAndParent(
      reqObj.warehouse_id,
      reqObj.parent_id,
      reqObj.requested_by
    );

    const userEmail = (reqObj.email || '').trim().toLowerCase();
    const userName = (reqObj.name || '').trim();
    const userRole = reqObj.role || 'salesman';
    const userPhone = reqObj.phone || '';
    const userPassword = reqObj.password || 'sales123';
    const aadhaarNo = reqObj.aadhaar_number || 'Not Provided';
    const aadhaarDoc = reqObj.kyc_doc || reqObj.aadhaar_doc || 'Aadhaar_Document.pdf';

    if (state.isSupabaseConfigured) {
      try {
        // Check if user already exists
        const { data: existingUser } = await supabase.from('users').select('*').eq('email', userEmail).maybeSingle();
        if (existingUser) {
          const { data: updUser } = await supabase.from('users').update({
            status: 'approved',
            role: userRole,
            warehouse_id: warehouse_id || existingUser.warehouse_id,
            parent_id: parent_id || existingUser.parent_id,
            phone: userPhone || existingUser.phone,
            password: userPassword || existingUser.password,
            requires_password_setup: true
          }).eq('id', existingUser.id).select().single();
          targetUser = updUser || existingUser;
        } else {
          const userPayload = {
            name: userName,
            email: userEmail,
            role: userRole,
            warehouse_id: warehouse_id,
            parent_id: parent_id,
            status: 'approved',
            requires_password_setup: true,
            phone: userPhone,
            password: userPassword,
            aadhaar_number: aadhaarNo,
            aadhaar_doc: aadhaarDoc,
            kyc_status: 'Verified'
          };
          const { data: insUser, error: insErr } = await supabase.from('users').insert([userPayload]).select().single();
          if (insErr) {
            console.warn('Retrying user insert with minimal columns:', insErr.message);
            const { data: minUser } = await supabase.from('users').insert([{
              name: userName,
              email: userEmail,
              role: userRole,
              warehouse_id: warehouse_id,
              parent_id: parent_id,
              status: 'approved'
            }]).select().single();
            targetUser = minUser;
          } else {
            targetUser = insUser;
          }
        }
      } catch (dbErr) {
        console.warn('Supabase user creation notice:', dbErr.message);
      }
    }

    // Always maintain in mockDb.users for immediate in-memory availability
    const newMockUser = {
      id: targetUser?.id || `u_${Date.now()}`,
      name: userName,
      email: userEmail,
      phone: userPhone,
      role: userRole,
      warehouse_id: warehouse_id || 'w1',
      parent_id: parent_id,
      status: 'approved',
      password: userPassword,
      aadhaar_number: aadhaarNo,
      aadhaar_doc: aadhaarDoc,
      kyc_status: 'Verified',
      requires_password_setup: true
    };
    if (!mockDb.users) mockDb.users = [];
    const existingIdx = mockDb.users.findIndex(u => u.email === userEmail || u.id === newMockUser.id);
    if (existingIdx !== -1) {
      mockDb.users[existingIdx] = { ...mockDb.users[existingIdx], ...newMockUser };
    } else {
      mockDb.users.push(newMockUser);
    }

    // Update salesman referrals in mockDb
    const ref = (mockDb.salesmanReferrals || []).find(sr =>
      sr.phone === userPhone ||
      String(sr.referred_salesman_id) === String(request_id) ||
      sr.full_name === userName
    );
    if (ref) {
      ref.status = 'Active';
      ref.kyc_status = 'Verified';
      ref.referred_salesman_id = newMockUser.id;
    }
  }

  // 5. Update request status in Supabase
  if (state.isSupabaseConfigured) {
    try {
      if (isUuid) {
        await supabase.from('user_creation_requests').update({ status }).eq('id', request_id);
      } else if (reqObj.email) {
        await supabase.from('user_creation_requests').update({ status }).eq('email', reqObj.email);
      }
    } catch (_) {}
  }

  // 6. Update request status in mockDb
  if (mIndex !== -1) {
    mockDb.userRequests[mIndex].status = status;
  }
  (mockDb.userRequests || []).forEach(r => {
    if (String(r.id) === String(request_id) || (reqObj.email && r.email === reqObj.email)) {
      r.status = status;
    }
  });

  return res.json({
    message: `Request successfully ${status}`,
    user: targetUser || null
  });
});

module.exports = router;
