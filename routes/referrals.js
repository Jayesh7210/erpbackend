const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { getProductWithMeta } = require('../services/productMeta');
const {
  superAdminGeneralLimiter,
  superAdminSensitiveLimiter,
  superAdminAnalyticsLimiter,
  storeAdminGeneralLimiter,
  salesmanGeneralLimiter,
  salesmanOnboardingLimiter
} = require('../services/rateLimiter');

// Helper to build workforce referral tree
function buildWorkforceTree() {
  const users = [...(mockDb.users || [])];
  const sales = [...(mockDb.sales || [])];
  const commissions = [...(mockDb.workforceCommissions || [])];

  // Calculate sold bottles today per user
  const salesByUser = {};
  sales.forEach(s => {
    if (s.salesman_id) {
      salesByUser[s.salesman_id] = (salesByUser[s.salesman_id] || 0) + (Number(s.quantity) || 0);
    }
  });

  // Calculate commissions per referrer
  const unlockedByUser = {};
  const pendingByUser = {};
  commissions.forEach(c => {
    if (c.status === 'unlocked' || c.status === 'paid') {
      unlockedByUser[c.referrer_id] = (unlockedByUser[c.referrer_id] || 0) + (Number(c.commission_amount) || 0);
    } else if (c.status === 'quota_pending' || c.status === 'pending') {
      pendingByUser[c.referrer_id] = (pendingByUser[c.referrer_id] || 0) + (Number(c.commission_amount) || 0);
    }
  });

  // Build node object for a user
  function formatNode(u) {
    const bottlesSold = salesByUser[u.id] || 0;
    const unlocked = unlockedByUser[u.id] || 0;
    const pending = pendingByUser[u.id] || 0;

    const directRefUsers = users.filter(usr => usr.referrer_id === u.id);

    return {
      id: u.id,
      name: u.name,
      role: u.role,
      email: u.email,
      referrer_id: u.referrer_id || null,
      bottles_sold_today: bottlesSold,
      is_qualified: true,
      unlocked_commission: unlocked,
      pending_commission: pending,
      downline_count: directRefUsers.length,
      children: directRefUsers.map(child => formatNode(child))
    };
  }

  // Find root salesmen (salesmen that are not referred by any other salesman)
  const rootSalesmen = users.filter(u => u.role === 'salesman' && !u.referrer_id);

  // If no root salesman found, return all salesmen that have referrals or sales
  const treeNodes = rootSalesmen.length > 0 ? rootSalesmen.map(formatNode) : users.filter(u => u.role === 'salesman').slice(0, 1).map(formatNode);

  return {
    tree: treeNodes,
    total_salesmen: users.filter(u => u.role === 'salesman').length
  };
}

// Get full workforce referral tree (Protected by Analytics Rate Limiter)
router.get('/api/referrals/tree', superAdminAnalyticsLimiter, (req, res) => {
  return res.json(buildWorkforceTree());
});

// Get all workforce referral commissions (Ledger - Protected by General Admin Rate Limiter)
router.get('/api/referrals', superAdminGeneralLimiter, async (req, res) => {
  const commissions = mockDb.workforceCommissions || [];
  const enriched = commissions.map(c => {
    return {
      ...c,
      referrer_name: c.referrer_name || ((mockDb.users || []).find(u => u.id === c.referrer_id)?.name) || 'Referrer',
      referred_name: c.seller_name || ((mockDb.users || []).find(u => u.id === c.seller_id)?.name) || 'Salesman'
    };
  });
  return res.json(enriched);
});

// Process / approve referral payout (Protected by Sensitive Admin Rate Limiter)
router.post('/api/referrals/:id/payout', superAdminSensitiveLimiter, async (req, res) => {
  const { id } = req.params;
  const { admin_id, admin_name } = req.body;

  const comm = (mockDb.workforceCommissions || []).find(c => c.id === id);
  if (!comm) {
    // Check fallback referrals
    const legacy = (mockDb.referrals || []).find(r => r.id === id);
    if (legacy) {
      legacy.status = 'paid';
      legacy.paid_at = new Date();
      return res.json({ message: 'Payout marked as paid', referral: legacy });
    }
    return res.status(404).json({ error: 'Referral commission record not found' });
  }

  comm.status = 'paid';
  comm.paid_at = new Date().toISOString();

  await logAudit(
    admin_id || 'u1',
    admin_name || 'Super Admin',
    'REFERRAL_PAYOUT',
    'workforce_commissions',
    id,
    `Disbursed referral commission payout of ₹${comm.commission_amount} to ${comm.referrer_name}`
  );

  return res.json({ message: 'Payout marked as paid', referral: comm });
});

// Salesman Today's Earnings Breakdown (Protected by Salesman General Limiter)
router.get('/api/salesman/earnings/:salesman_id', salesmanGeneralLimiter, async (req, res) => {
  const { salesman_id } = req.params;
  let user = (mockDb.users || []).find(u => u.id === salesman_id);
  let todaySales = (mockDb.sales || []).filter(s => s.salesman_id === salesman_id);
  let myReferralComms = (mockDb.workforceCommissions || []).filter(c => c.referrer_id === salesman_id && c.type === 'referral_bonus');

  if (state.isSupabaseConfigured) {
    try {
      // 1. Fetch user duty & details
      const { data: dbUser } = await supabase
        .from('users')
        .select('id, name, email, is_on_duty, role, parent_id, warehouse_id')
        .eq('id', salesman_id)
        .maybeSingle();
      if (dbUser) {
        user = { ...user, ...dbUser };
      }

      // 2. Fetch sales from Supabase
      const { data: dbSales } = await supabase
        .from('sales')
        .select('*')
        .eq('salesman_id', salesman_id);
      if (dbSales && dbSales.length > 0) {
        todaySales = dbSales;
      }

      // 3. Fetch workforce commissions for referrals
      const { data: dbComms } = await supabase
        .from('workforce_commissions')
        .select('*')
        .eq('referrer_id', salesman_id)
        .eq('type', 'referral_bonus');
      if (dbComms && dbComms.length > 0) {
        myReferralComms = dbComms;
      }
    } catch (e) {
      console.warn('salesman earnings Supabase query warning:', e.message);
    }
  }

  const soldBottlesToday = todaySales.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);

  // Dynamic direct sale commissions from products sold
  let directCommissionEarned = 0;
  todaySales.forEach(s => {
    const prod = getProductWithMeta(s.product_id);
    const rate = Number(prod?.salesman_commission) || 0.0;
    directCommissionEarned += (Number(s.quantity) || 0) * rate;
  });

  // Dynamic referral commissions from direct downline referrals (Strictly 1-Level)
  const downlineBottles = myReferralComms.reduce((sum, c) => sum + (Number(c.bottles_sold) || 0), 0);
  const unlockedReferralEarned = myReferralComms
    .filter(c => c.status === 'unlocked' || c.status === 'paid')
    .reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
  const totalEarned = directCommissionEarned + unlockedReferralEarned;

  return res.json({
    salesman_id,
    salesman_name: user ? user.name : 'Salesman',
    is_on_duty: user ? (user.is_on_duty ?? true) : true,
    sold_bottles_today: soldBottlesToday,
    commission_earned: directCommissionEarned,
    downline_bottles_sold: downlineBottles,
    referral_earned: unlockedReferralEarned,
    referral_bottles: downlineBottles,
    total_earned: totalEarned,
    monthly_earnings: totalEarned,
    monthly_bottles_sold: soldBottlesToday,
    min_sales_quota: (user && user.min_sales_quota !== undefined) ? Number(user.min_sales_quota) : 0,
    is_quota_condition_active: (user && user.is_quota_condition_active !== undefined) ? Boolean(user.is_quota_condition_active) : false,
    is_qualified: (user && user.min_sales_quota) ? (soldBottlesToday >= user.min_sales_quota) : true
  });
});

// Salesman Referrals (Get & Submit - Protected by Salesman Limiters)
router.get('/api/salesman/referrals/:salesman_id', salesmanGeneralLimiter, async (req, res) => {
  const { salesman_id } = req.params;
  let list = (mockDb.salesmanReferrals || []).filter(r => r.referrer_id === salesman_id);

  if (state.isSupabaseConfigured) {
    try {
      const { data: dbRequests } = await supabase
        .from('user_creation_requests')
        .select('*')
        .eq('requested_by', salesman_id);

      if (dbRequests && dbRequests.length > 0) {
        const dbMapped = dbRequests.map(r => ({
          id: r.id,
          referrer_id: salesman_id,
          referred_salesman_id: r.id,
          full_name: r.name,
          phone: r.phone || '',
          status: r.status === 'approved' ? 'Active' : (r.status === 'rejected' ? 'Rejected' : 'Pending Approval'),
          earned: 0,
          bottles_sold: 0,
          kyc_doc: r.kyc_doc || '',
          kyc_status: r.status === 'approved' ? 'Verified' : 'Pending Review',
          created_at: r.created_at
        }));

        const existingIds = new Set(list.map(x => x.id || x.referred_salesman_id));
        for (const item of dbMapped) {
          if (!existingIds.has(item.id) && !existingIds.has(item.referred_salesman_id)) {
            list.push(item);
          }
        }
      }
    } catch (e) {
      console.warn('salesman referrals Supabase fetch warning:', e.message);
    }
  }

  const enriched = list.map(ref => {
    const comms = (mockDb.workforceCommissions || []).filter(
      c => c.referrer_id === salesman_id && (c.seller_id === ref.referred_salesman_id || c.seller_name === ref.full_name)
    );
    const bottlesSold = comms.reduce((sum, c) => sum + (Number(c.bottles_sold) || 0), 0);
    const commEarned = comms
      .filter(c => c.status === 'unlocked' || c.status === 'paid')
      .reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
    const pendingComm = comms
      .filter(c => c.status === 'quota_pending')
      .reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);

    return {
      ...ref,
      bottles_sold: bottlesSold > 0 ? bottlesSold : (ref.bottles_sold || 0),
      earned: commEarned > 0 ? commEarned : (ref.earned || 0),
      pending_earned: pendingComm
    };
  });
  return res.json(enriched);
});

router.post('/api/salesman/referrals', salesmanOnboardingLimiter, async (req, res) => {
  const { referrer_id, full_name, phone, kyc_doc } = req.body;
  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Full name and phone number are required' });
  }

  const generatedEmail = `${full_name.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Math.floor(100+Math.random()*900)}@erp.com`;
  const newReqId = `req_${Date.now()}`;

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Dynamically resolve referrer's warehouse_id and parent_id
  let resolvedWarehouseId = null;
  let resolvedParentId = null;

  const referrerUser = (mockDb.users || []).find(u => u.id === referrer_id);
  if (referrerUser) {
    resolvedWarehouseId = referrerUser.warehouse_id || null;
    resolvedParentId = referrerUser.parent_id || null;
  }

  if (state.isSupabaseConfigured) {
    try {
      if (referrer_id && UUID_REGEX.test(referrer_id)) {
        const { data: dbUser } = await supabase
          .from('users')
          .select('warehouse_id, parent_id')
          .eq('id', referrer_id)
          .maybeSingle();
        if (dbUser) {
          if (dbUser.warehouse_id) resolvedWarehouseId = dbUser.warehouse_id;
          if (dbUser.parent_id) resolvedParentId = dbUser.parent_id;
        }
      }

      // Ensure warehouse_id is a valid UUID
      if (!resolvedWarehouseId || !UUID_REGEX.test(String(resolvedWarehouseId))) {
        const { data: firstWh } = await supabase.from('warehouses').select('id').limit(1).maybeSingle();
        if (firstWh && firstWh.id) resolvedWarehouseId = firstWh.id;
      }

      // Ensure parent_id is a valid UUID
      if (resolvedParentId && !UUID_REGEX.test(String(resolvedParentId))) {
        resolvedParentId = null;
      }
      if (!resolvedParentId && referrer_id && UUID_REGEX.test(referrer_id)) {
        resolvedParentId = referrer_id;
      }
    } catch (_) {}
  }

  // 1. Create Onboarding Request in Super Admin's Approval Queue
  const newReq = {
    id: newReqId,
    name: full_name,
    email: generatedEmail,
    phone,
    role: 'salesman',
    warehouse_id: resolvedWarehouseId,
    parent_id: resolvedParentId,
    requested_by: referrer_id || null,
    status: 'pending',
    requires_password_setup: true,
    aadhaar_number: '',
    kyc_doc: kyc_doc || '',
    created_at: new Date().toISOString()
  };

  // 2. Track in salesman's referrals list
  const newReferral = {
    id: `sm_ref_${Date.now()}`,
    referrer_id: referrer_id || null,
    referred_salesman_id: newReqId,
    full_name,
    phone,
    status: 'Pending Approval',
    earned: 0,
    bottles_sold: 0,
    kyc_doc: kyc_doc || '',
    kyc_status: 'Pending Review',
    created_at: new Date().toISOString()
  };

  if (state.isSupabaseConfigured) {
    try {
      const { data: dbReq } = await supabase.from('user_creation_requests').insert([{
        name: full_name,
        email: generatedEmail,
        role: 'salesman',
        warehouse_id: resolvedWarehouseId,
        parent_id: resolvedParentId,
        requested_by: referrer_id && UUID_REGEX.test(referrer_id) ? referrer_id : null,
        status: 'pending'
      }]).select().single();
      if (dbReq && dbReq.id) {
        newReq.id = dbReq.id;
        newReferral.referred_salesman_id = dbReq.id;
      }
    } catch (e) {
      console.warn('user_creation_requests Supabase sync notice:', e.message);
    }
  }

  if (!mockDb.userRequests) mockDb.userRequests = [];
  mockDb.userRequests.unshift(newReq);

  if (!mockDb.salesmanReferrals) mockDb.salesmanReferrals = [];
  mockDb.salesmanReferrals.unshift(newReferral);

  await logAudit(referrer_id || 'system', 'Salesman', 'SUBMIT_REFERRAL', 'user_creation_requests', newReqId, `Submitted referral request for ${full_name} (${phone}) awaiting Super Admin approval`);
  return res.status(201).json(newReferral);
});

// Store Admin Earnings Breakdown (Dynamic commissions from stock transfers to FSMs - Protected by Store Admin General Limiter)
router.get('/api/store-admin/earnings/:user_id', storeAdminGeneralLimiter, async (req, res) => {
  const { user_id } = req.params;
  let todayEarned = 0;
  let totalDispatched = 0;
  let storeComms = [];

  if (state.isSupabaseConfigured) {
    try {
      const { data: dbUser } = await supabase.from('users').select('warehouse_id').eq('id', user_id).maybeSingle();
      const warehouseId = dbUser?.warehouse_id;

      // 1. Fetch direct workforce commissions
      const query = warehouseId
        ? supabase.from('workforce_commissions').select('*').or(`user_id.eq.${user_id},user_id.eq.${warehouseId}`)
        : supabase.from('workforce_commissions').select('*').eq('user_id', user_id);
      const { data: comms } = await query;

      if (comms && comms.length > 0) {
        storeComms = comms;
        todayEarned = comms.reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
        totalDispatched = comms.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
      } else if (warehouseId) {
        // Dynamic calculation from completed stock transfers from this warehouse
        const { data: trs } = await supabase
          .from('stock_transfers')
          .select('*, product:products(*)')
          .or(`from_id.eq.${warehouseId},from_id.eq.${user_id}`)
          .eq('status', 'completed');
        if (trs && trs.length > 0) {
          trs.forEach(t => {
            const q = Number(t.quantity) || 0;
            const rate = Number(t.product?.store_admin_commission) || 0.0;
            totalDispatched += q;
            todayEarned += q * rate;
          });
        }
      }
    } catch (e) {
      console.warn('Store admin earnings Supabase error:', e.message);
    }
  }

  if (storeComms.length === 0 && todayEarned === 0) {
    const mockComms = (mockDb.workforceCommissions || []).filter(c => c.user_id === user_id && c.role === 'store_admin');
    todayEarned = mockComms.reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
    totalDispatched = mockComms.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
    storeComms = mockComms;
  }

  return res.json({
    store_admin_id: user_id,
    today_earned: todayEarned,
    units_dispatched: totalDispatched,
    commissions: storeComms
  });
});

module.exports = router;
