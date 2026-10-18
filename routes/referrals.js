const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { getProductWithMeta } = require('../services/productMeta');

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

// Get full workforce referral tree
router.get('/api/referrals/tree', (req, res) => {
  return res.json(buildWorkforceTree());
});

// Get all workforce referral commissions (Ledger)
router.get('/api/referrals', async (req, res) => {
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

// Process / approve referral payout
router.post('/api/referrals/:id/payout', async (req, res) => {
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

// Salesman Today's Earnings Breakdown
router.get('/api/salesman/earnings/:salesman_id', (req, res) => {
  const { salesman_id } = req.params;
  const user = (mockDb.users || []).find(u => u.id === salesman_id);
  const todaySales = (mockDb.sales || []).filter(s => s.salesman_id === salesman_id);
  const soldBottlesToday = todaySales.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);

  // Dynamic direct sale commissions from products sold
  let directCommissionEarned = 0;
  todaySales.forEach(s => {
    const prod = getProductWithMeta(s.product_id);
    const rate = Number(prod?.salesman_commission) || 0.0;
    directCommissionEarned += (Number(s.quantity) || 0) * rate;
  });

  // Dynamic referral commissions from direct downline referrals (Strictly 1-Level)
  const myReferralComms = (mockDb.workforceCommissions || []).filter(c => c.referrer_id === salesman_id && c.type === 'referral_bonus');
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
    monthly_bottles_sold: soldBottlesToday
  });
});

// Salesman Referrals (Get & Submit)
router.get('/api/salesman/referrals/:salesman_id', (req, res) => {
  const { salesman_id } = req.params;
  const list = (mockDb.salesmanReferrals || []).filter(r => r.referrer_id === salesman_id);
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

router.post('/api/salesman/referrals', async (req, res) => {
  const { referrer_id, full_name, phone, kyc_doc } = req.body;
  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Full name and phone number are required' });
  }

  const generatedEmail = `${full_name.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Math.floor(100+Math.random()*900)}@erp.com`;
  const newReqId = `req_${Date.now()}`;

  // 1. Create Onboarding Request in Super Admin's Approval Queue
  const newReq = {
    id: newReqId,
    name: full_name,
    email: generatedEmail,
    phone,
    role: 'salesman',
    warehouse_id: 'w1',
    parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23',
    requested_by: referrer_id || 'd4567890-ef34-56ff-78ff-9012abcdef34',
    status: 'pending',
    requires_password_setup: true,
    aadhaar_number: '',
    kyc_doc: kyc_doc || '',
    created_at: new Date().toISOString()
  };
  mockDb.userRequests.unshift(newReq);

  // 2. Track in salesman's referrals list
  const newReferral = {
    id: `sm_ref_${Date.now()}`,
    referrer_id: referrer_id || 'd4567890-ef34-56ff-78ff-9012abcdef34',
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
  if (!mockDb.salesmanReferrals) mockDb.salesmanReferrals = [];
  mockDb.salesmanReferrals.unshift(newReferral);

  if (state.isSupabaseConfigured) {
    try {
      await supabase.from('user_creation_requests').insert([{
        name: full_name,
        email: generatedEmail,
        role: 'salesman',
        warehouse_id: 'w1',
        parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23',
        requested_by: referrer_id || null,
        status: 'pending'
      }]);
    } catch (e) {
      console.warn('user_creation_requests Supabase sync notice:', e.message);
    }
  }

  await logAudit(referrer_id || 'd4567890-ef34-56ff-78ff-9012abcdef34', 'Salesman', 'SUBMIT_REFERRAL', 'user_creation_requests', newReqId, `Submitted referral request for ${full_name} (${phone}) awaiting Super Admin approval`);
  return res.status(201).json(newReferral);
});

// Store Admin Earnings Breakdown (Dynamic commissions from stock transfers to FSMs)
router.get('/api/store-admin/earnings/:user_id', (req, res) => {
  const { user_id } = req.params;
  const storeComms = (mockDb.workforceCommissions || []).filter(c => c.user_id === user_id && c.role === 'store_admin');
  const todayEarned = storeComms.reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
  const totalDispatched = storeComms.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
  return res.json({
    store_admin_id: user_id,
    today_earned: todayEarned,
    units_dispatched: totalDispatched,
    commissions: storeComms
  });
});

module.exports = router;
