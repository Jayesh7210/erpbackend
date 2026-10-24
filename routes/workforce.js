const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter, salesmanOnboardingLimiter } = require('../services/rateLimiter');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveWarehouseAndParent(whId, parentId, requestedBy) {
  let finalWhId = null;
  let finalParentId = null;

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

  const { warehouse_id: resolvedWh, parent_id: resolvedParent } = await resolveWarehouseAndParent(
    warehouse_id,
    parent_id,
    requested_by
  );

  try {
    const payload = {
      name,
      email: email.trim().toLowerCase(),
      role,
      warehouse_id: resolvedWh,
      parent_id: resolvedParent,
      requested_by: requested_by && UUID_REGEX.test(requested_by) ? requested_by : null,
      status: 'pending'
    };

    const { data, error } = await supabase.from('user_creation_requests').insert([payload]).select().single();
    if (error) {
      console.warn('user_creation_requests insert error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const createdRequest = {
      ...data,
      phone: phone || '',
      password: initialPassword,
      aadhaar_number: aadhNumber,
      kyc_doc: aadhDoc
    };

    return res.status(201).json({ message: 'Request submitted successfully', request: createdRequest });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// View pending workforce requests (Super Admin - Protected by General Admin Rate Limiter)
router.get('/api/workforce/requests', superAdminGeneralLimiter, async (req, res) => {
  try {
    let dbRequests = [];
    // First try with foreign key join for requested_by
    const { data, error } = await supabase.from('user_creation_requests')
      .select('*, requested_by_user:users!user_creation_requests_requested_by_fkey(name)')
      .eq('status', 'pending');

    if (!error && Array.isArray(data)) {
      dbRequests = data.map(r => ({
        ...r,
        requested_by_name: r.requested_by_user?.name || null
      }));
    } else {
      // Fallback without join
      const { data: simpleData, error: simpleErr } = await supabase.from('user_creation_requests')
        .select('*')
        .eq('status', 'pending');
      if (simpleErr) throw simpleErr;
      dbRequests = simpleData || [];
    }

    // Enrich requests with supervisor user info if requested_by is an ID
    const reqUserIds = [...new Set(dbRequests.map(r => r.requested_by).filter(id => id && UUID_REGEX.test(id)))];
    let userMap = {};
    if (reqUserIds.length > 0) {
      const { data: usersData } = await supabase.from('users').select('id, name, role').in('id', reqUserIds);
      if (usersData) {
        usersData.forEach(u => { userMap[u.id] = u; });
      }
    }

    const enriched = dbRequests.map(r => {
      let requestedByObj = null;
      let requestedByName = r.requested_by_name || null;

      if (r.requested_by && typeof r.requested_by === 'object' && r.requested_by.name) {
        requestedByName = r.requested_by.name;
        requestedByObj = r.requested_by;
      } else if (r.requested_by) {
        const reqId = String(r.requested_by);
        const found = userMap[reqId];
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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Approve workforce request (Super Admin - Protected by Sensitive Admin Rate Limiter)
router.post('/api/workforce/approve', superAdminSensitiveLimiter, async (req, res) => {
  const { request_id, approve } = req.body;
  if (!request_id) return res.status(400).json({ error: 'Request ID is required' });

  const status = approve ? 'approved' : 'rejected';
  let targetUser = null;
  const isUuid = UUID_REGEX.test(String(request_id));

  try {
    let reqObj = null;
    if (isUuid) {
      const { data } = await supabase.from('user_creation_requests')
        .select('*')
        .eq('id', request_id)
        .maybeSingle();
      if (data) reqObj = data;
    }

    if (!reqObj) {
      const { data } = await supabase.from('user_creation_requests')
        .select('*')
        .or(`email.eq.${request_id},phone.eq.${request_id}`)
        .limit(1)
        .maybeSingle();
      if (data) reqObj = data;
    }

    if (!reqObj) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // If approving, provision user in Supabase
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
          const { data: minUser, error: minErr } = await supabase.from('users').insert([{
            name: userName,
            email: userEmail,
            role: userRole,
            warehouse_id: warehouse_id,
            parent_id: parent_id,
            status: 'approved'
          }]).select().single();
          if (minErr) throw minErr;
          targetUser = minUser;
        } else {
          targetUser = insUser;
        }
      }
    }

    // Update request status in Supabase
    if (isUuid) {
      await supabase.from('user_creation_requests').update({ status }).eq('id', request_id);
    } else if (reqObj.id) {
      await supabase.from('user_creation_requests').update({ status }).eq('id', reqObj.id);
    } else if (reqObj.email) {
      await supabase.from('user_creation_requests').update({ status }).eq('email', reqObj.email);
    }

    return res.json({
      message: `Request successfully ${status}`,
      user: targetUser || null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
