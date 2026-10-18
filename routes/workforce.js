const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');

// Add user onboarding request (Store Admin / FSM initiating addition)
router.post('/api/workforce/request', async (req, res) => {
  const { name, email, phone, role, warehouse_id, parent_id, requested_by, password, aadhaar_number, kyc_doc } = req.body;
  if (!name || !email || !role || !requested_by) {
    return res.status(400).json({ error: 'Name, email, role, and requested_by are required' });
  }

  const initialPassword = password || '';
  const aadhNumber = (aadhaar_number || '').trim();
  const aadhDoc = (kyc_doc || '').trim();

  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('user_creation_requests').insert([{
        name, email, role, warehouse_id, parent_id, requested_by, status: 'pending'
      }]).select().single();
      if (error) throw error;
      return res.status(201).json({ message: 'Request submitted successfully', request: { ...data, phone, password: initialPassword, aadhaar_number: aadhNumber, kyc_doc: aadhDoc } });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const newRequest = {
      id: `req_${Date.now()}`,
      name, email, phone: phone || '', role, warehouse_id, parent_id, requested_by,
      password: initialPassword, aadhaar_number: aadhNumber, kyc_doc: aadhDoc,
      status: 'pending', created_at: new Date()
    };
    mockDb.userRequests.push(newRequest);
    return res.status(201).json({ message: 'Request submitted successfully', request: newRequest });
  }
});

// View pending workforce requests (Super Admin)
router.get('/api/workforce/requests', async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      let requests = [];
      const { data, error } = await supabase.from('user_creation_requests')
        .select('*, requested_by:users!user_creation_requests_requested_by_fkey(name)')
        .eq('status', 'pending');
      if (!error && data && data.length > 0) {
        requests = data;
      } else {
        const { data: simpleData } = await supabase.from('user_creation_requests').select('*').eq('status', 'pending');
        if (simpleData && simpleData.length > 0) {
          requests = simpleData;
        } else {
          requests = (mockDb.userRequests || []).filter(r => r.status === 'pending');
        }
      }

      const enriched = requests.map(r => ({
        ...r,
        phone: r.phone || '',
        password: r.password || '',
        aadhaar_number: r.aadhaar_number || '',
        kyc_doc: r.kyc_doc || ''
      }));
      return res.json(enriched);
    } catch (err) {
      console.warn('user_creation_requests query exception:', err.message);
      const pending = (mockDb.userRequests || []).filter(r => r.status === 'pending');
      return res.json(pending);
    }
  } else {
    const pending = (mockDb.userRequests || []).filter(r => r.status === 'pending');
    return res.json(pending);
  }
});

// Approve workforce request (Super Admin)
router.post('/api/workforce/approve', async (req, res) => {
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
  const reqIndex = (mockDb.userRequests || []).findIndex(r => r.id === request_id);
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
      mockDb.users.push(newUser);
      const ref = (mockDb.salesmanReferrals || []).find(sr => sr.phone === r.phone || sr.referred_salesman_id === r.id);
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
