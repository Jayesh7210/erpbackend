const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { logAudit } = require('../services/audit');
const { getProductWithMeta } = require('../services/productMeta');
const { runtimeCommissions, findCommission } = require('../services/commissionService');
const {
  superAdminGeneralLimiter,
  superAdminSensitiveLimiter,
  superAdminAnalyticsLimiter,
  storeAdminGeneralLimiter,
  salesmanGeneralLimiter,
  salesmanOnboardingLimiter
} = require('../services/rateLimiter');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Helper to build workforce referral tree
async function buildWorkforceTree() {
  let users = [];
  let sales = [];
  try {
    const { data: uData } = await supabase.from('users').select('*');
    if (uData) users = uData;
    const { data: sData } = await supabase.from('sales').select('salesman_id, quantity');
    if (sData) sales = sData;
  } catch (_) {}

  const commissions = runtimeCommissions;

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
router.get('/api/referrals/tree', superAdminAnalyticsLimiter, async (req, res) => {
  const tree = await buildWorkforceTree();
  return res.json(tree);
});

// Get all workforce referral commissions (Ledger - Protected by General Admin Rate Limiter)
router.get('/api/referrals', superAdminGeneralLimiter, async (req, res) => {
  let commissions = [...runtimeCommissions];
  try {
    const { data: dbComms } = await supabase.from('workforce_commissions').select('*');
    if (dbComms && dbComms.length > 0) {
      commissions = dbComms;
    }
  } catch (_) {}

  const enriched = commissions.map(c => ({
    ...c,
    referrer_name: c.referrer_name || 'Referrer',
    referred_name: c.seller_name || 'Salesman'
  }));
  return res.json(enriched);
});

// Process / approve referral payout (Protected by Sensitive Admin Rate Limiter)
router.post('/api/referrals/:id/payout', superAdminSensitiveLimiter, async (req, res) => {
  const { id } = req.params;
  const { admin_id, admin_name } = req.body;

  const comm = findCommission(c => c.id === id);
  if (!comm) {
    try {
      const { data, error } = await supabase.from('workforce_commissions').update({ status: 'paid' }).eq('id', id).select().single();
      if (!error && data) {
        return res.json({ message: 'Payout marked as paid', referral: data });
      }
    } catch (_) {}
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
  let user = null;
  let todaySales = [];

  try {
    // 1. Fetch user details & quota rules
    const { data: dbUser } = await supabase
      .from('users')
      .select('id, name, email, is_on_duty, role, parent_id, warehouse_id, min_sales_quota, is_quota_condition_active')
      .eq('id', salesman_id)
      .maybeSingle();
    if (dbUser) user = dbUser;

    // 2. Fetch today's sales for this salesman
    const { data: dbSales } = await supabase
      .from('sales')
      .select('*')
      .eq('salesman_id', salesman_id);
    if (dbSales && dbSales.length > 0) {
      todaySales = dbSales;
    }
  } catch (e) {
    console.warn('salesman earnings Supabase query warning:', e.message);
  }

  const soldBottlesToday = todaySales.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
  let todayCashCollected = 0;
  let todayOnlineCollected = 0;
  todaySales.forEach(s => {
    const amt = Number(s.amount) || 0;
    const pm = (s.payment_method || '').toLowerCase();
    if (pm === 'online' || pm === 'upi' || pm === 'card' || pm === 'bank' || pm === 'netbanking') {
      todayOnlineCollected += amt;
    } else {
      todayCashCollected += amt;
    }
  });
  const totalSalesRevenueToday = todayCashCollected + todayOnlineCollected;

  // Dynamic direct sale commissions from products sold
  let directCommissionEarned = 0;
  for (const s of todaySales) {
    const prod = await getProductWithMeta(s.product_id);
    const rate = Number(prod?.salesman_commission) || 50.0;
    directCommissionEarned += (Number(s.quantity) || 0) * rate;
  }

  // Dynamic referral commissions from direct downline referrals (Strictly 1-Level)
  let downlineBottles = 0;
  let unlockedReferralEarned = 0;
  let quotaPendingReferralEarned = 0;

  try {
    // Find all downline users referred by this salesman
    const { data: downlineUsers } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('referrer_id', salesman_id);

    const downlineUserIds = (downlineUsers || []).map(u => u.id);

    // Also include approved user_creation_requests
    const { data: approvedReqs } = await supabase
      .from('user_creation_requests')
      .select('id, email, name')
      .eq('requested_by', salesman_id)
      .eq('status', 'approved');

    (approvedReqs || []).forEach(r => {
      if (r.id && UUID_REGEX.test(r.id) && !downlineUserIds.includes(r.id)) {
        downlineUserIds.push(r.id);
      }
    });

    const isQuotaActive = Boolean(user?.is_quota_condition_active);
    const minQuota = Number(user?.min_sales_quota) || 0;
    const isQualified = !isQuotaActive || minQuota === 0 || soldBottlesToday >= minQuota;

    if (downlineUserIds.length > 0) {
      const { data: downlineSales } = await supabase
        .from('sales')
        .select('quantity, product_id')
        .in('salesman_id', downlineUserIds);

      for (const ds of (downlineSales || [])) {
        const q = Number(ds.quantity) || 0;
        downlineBottles += q;
        const p = await getProductWithMeta(ds.product_id);
        const refRate = Number(p?.referral_commission) || 10.0;
        const bonus = q * refRate;
        if (isQualified) {
          unlockedReferralEarned += bonus;
        } else {
          quotaPendingReferralEarned += bonus;
        }
      }
    }
  } catch (err) {
    console.warn('Downline earnings calculation warning:', err.message);
  }

  const totalEarned = directCommissionEarned + unlockedReferralEarned;

  return res.json({
    salesman_id,
    salesman_name: user ? user.name : 'Salesman',
    is_on_duty: user ? (user.is_on_duty ?? true) : true,
    sold_bottles_today: soldBottlesToday,
    cash_collected_today: todayCashCollected,
    online_collected_today: todayOnlineCollected,
    total_sales_revenue_today: totalSalesRevenueToday,
    commission_earned: directCommissionEarned,
    downline_bottles_sold: downlineBottles,
    referral_earned: unlockedReferralEarned,
    unlocked_referral_earned: unlockedReferralEarned,
    quota_pending_referral_earned: quotaPendingReferralEarned,
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
  let list = [];

  try {
    // 1. Fetch user creation requests submitted by this salesman
    const { data: dbRequests } = await supabase
      .from('user_creation_requests')
      .select('*')
      .eq('requested_by', salesman_id);

    // 2. Fetch users directly registered or approved with referrer_id = salesman_id
    const { data: dbUsers } = await supabase
      .from('users')
      .select('id, name, email, phone, status, kyc_status, aadhaar_doc, created_at')
      .eq('referrer_id', salesman_id);

    const userMap = new Map();
    (dbUsers || []).forEach(u => {
      userMap.set(u.id, u);
      if (u.email) userMap.set(u.email.toLowerCase(), u);
      if (u.name) userMap.set(u.name.toLowerCase(), u);
    });

    const processedEmails = new Set();

    for (const r of (dbRequests || [])) {
      const email = (r.email || '').toLowerCase();
      if (email) processedEmails.add(email);
      const linkedUser = userMap.get(r.id) || (email ? userMap.get(email) : null) || (r.name ? userMap.get(r.name.toLowerCase()) : null);

      list.push({
        id: r.id,
        user_id: linkedUser ? linkedUser.id : (UUID_REGEX.test(r.id) ? r.id : null),
        referrer_id: salesman_id,
        referred_salesman_id: linkedUser ? linkedUser.id : r.id,
        full_name: r.name,
        phone: r.phone || (linkedUser ? linkedUser.phone : '') || '',
        status: (linkedUser || r.status === 'approved') ? 'Active' : (r.status === 'rejected' ? 'Rejected' : 'Pending Approval'),
        kyc_doc: r.kyc_doc || (linkedUser ? linkedUser.aadhaar_doc : '') || '',
        kyc_status: (linkedUser || r.status === 'approved') ? 'Verified' : 'Pending Review',
        created_at: r.created_at
      });
    }

    // Add any users with referrer_id that were not in requests
    for (const u of (dbUsers || [])) {
      if (u.email && processedEmails.has(u.email.toLowerCase())) continue;
      list.push({
        id: u.id,
        user_id: u.id,
        referrer_id: salesman_id,
        referred_salesman_id: u.id,
        full_name: u.name,
        phone: u.phone || '',
        status: 'Active',
        kyc_doc: u.aadhaar_doc || '',
        kyc_status: u.kyc_status || 'Verified',
        created_at: u.created_at
      });
    }

    // Calculate bottles_sold and earned for each referral
    const userIdsToQuery = list.map(ref => ref.user_id || ref.referred_salesman_id).filter(id => id && UUID_REGEX.test(id));

    let salesByUser = {};
    let earnedByUser = {};

    if (userIdsToQuery.length > 0) {
      const { data: salesData } = await supabase
        .from('sales')
        .select('salesman_id, quantity, product_id')
        .in('salesman_id', userIdsToQuery);

      for (const s of (salesData || [])) {
        const q = Number(s.quantity) || 0;
        salesByUser[s.salesman_id] = (salesByUser[s.salesman_id] || 0) + q;
        const p = await getProductWithMeta(s.product_id);
        const refRate = Number(p?.referral_commission) || 10.0;
        earnedByUser[s.salesman_id] = (earnedByUser[s.salesman_id] || 0) + (q * refRate);
      }
    }

    // Referrer qualification status
    const { data: refUser } = await supabase.from('users').select('min_sales_quota, is_quota_condition_active').eq('id', salesman_id).maybeSingle();
    const { data: mySales } = await supabase.from('sales').select('quantity').eq('salesman_id', salesman_id);
    const mySalesToday = (mySales || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
    const isQuotaActive = Boolean(refUser?.is_quota_condition_active);
    const minQuota = Number(refUser?.min_sales_quota) || 0;
    const isQualified = !isQuotaActive || minQuota === 0 || mySalesToday >= minQuota;

    const enriched = list.map(ref => {
      const uid = ref.user_id || ref.referred_salesman_id;
      const bSold = salesByUser[uid] || 0;
      const rawEarned = earnedByUser[uid] || 0;

      return {
        ...ref,
        bottles_sold: bSold,
        earned: isQualified ? rawEarned : 0,
        pending_earned: isQualified ? 0 : rawEarned
      };
    });

    return res.json(enriched);
  } catch (e) {
    console.warn('salesman referrals Supabase fetch warning:', e.message);
    return res.json([]);
  }
});

router.post('/api/salesman/referrals', salesmanOnboardingLimiter, async (req, res) => {
  const { referrer_id, full_name, phone, email, kyc_doc, doc_type } = req.body;
  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Full name and phone number are required' });
  }

  const generatedEmail = (email && email.trim().length > 0)
    ? email.trim().toLowerCase()
    : `${full_name.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Math.floor(100+Math.random()*900)}@erp.com`;
  const newReqId = `req_${Date.now()}`;

  // Dynamically resolve referrer's warehouse_id and parent_id
  let resolvedWarehouseId = null;
  let resolvedParentId = null;

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

    if (!resolvedWarehouseId || !UUID_REGEX.test(String(resolvedWarehouseId))) {
      const { data: firstWh } = await supabase.from('warehouses').select('id').limit(1).maybeSingle();
      if (firstWh && firstWh.id) resolvedWarehouseId = firstWh.id;
    }

    if (resolvedParentId && !UUID_REGEX.test(String(resolvedParentId))) {
      resolvedParentId = null;
    }
    if (!resolvedParentId && referrer_id && UUID_REGEX.test(referrer_id)) {
      resolvedParentId = referrer_id;
    }
  } catch (_) {}

  const newReferral = {
    id: `sm_ref_${Date.now()}`,
    referrer_id: referrer_id || null,
    referred_salesman_id: newReqId,
    full_name,
    phone,
    email: generatedEmail,
    doc_type: doc_type || 'Aadhaar Card',
    status: 'Pending Approval',
    earned: 0,
    bottles_sold: 0,
    kyc_doc: kyc_doc || '',
    kyc_status: 'Pending Review',
    created_at: new Date().toISOString()
  };

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
      newReferral.referred_salesman_id = dbReq.id;
    }
  } catch (e) {
    console.warn('user_creation_requests Supabase sync notice:', e.message);
  }

  await logAudit(referrer_id || 'system', 'Salesman', 'SUBMIT_REFERRAL', 'user_creation_requests', newReferral.referred_salesman_id, `Submitted referral request for ${full_name} (${phone}) awaiting Super Admin approval`);
  return res.status(201).json(newReferral);
});

// Store Admin Earnings Breakdown (Dynamic commissions from stock transfers to FSMs - Protected by Store Admin General Limiter)
router.get('/api/store-admin/earnings/:user_id', storeAdminGeneralLimiter, async (req, res) => {
  const { user_id } = req.params;
  let todayEarned = 0;
  let totalDispatched = 0;
  let storeComms = [];

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

  if (storeComms.length === 0 && todayEarned === 0) {
    const mockComms = runtimeCommissions.filter(c => c.user_id === user_id && c.role === 'store_admin');
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
