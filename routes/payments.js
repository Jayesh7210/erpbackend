const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { superAdminAnalyticsLimiter, superAdminSensitiveLimiter } = require('../services/rateLimiter');

const manualPayments = [];

// Payments & Transactions History (Super Admin - Protected by Analytics Limiter)
router.get('/api/payments', superAdminAnalyticsLimiter, async (req, res) => {
  const { type, method, status, search, start_date, end_date } = req.query;

  const allPayments = [...manualPayments];

  // Harvest from live Supabase tables if configured
  if (state.isSupabaseConfigured) {
    try {
      const [{ data: dbSales }, { data: dbSettlements }, { data: dbUsers }, { data: dbProducts }, { data: dbCustomers }] = await Promise.all([
        supabase.from('sales').select('*').order('created_at', { ascending: false }),
        supabase.from('settlements').select('*').order('created_at', { ascending: false }),
        supabase.from('users').select('id, name, phone, role'),
        supabase.from('products').select('id, name'),
        supabase.from('customers').select('id, name, phone')
      ]);

      const userMap = new Map((dbUsers || []).map(u => [u.id, u]));
      const prodMap = new Map((dbProducts || []).map(p => [p.id, p]));
      const custMap = new Map((dbCustomers || []).map(c => [c.id, c]));

      (dbSales || []).forEach(s => {
        if (!allPayments.some(p => p.reference_id === s.id)) {
          const prod = prodMap.get(s.product_id);
          const cust = custMap.get(s.customer_id);
          const user = userMap.get(s.salesman_id);
          allPayments.push({
            id: `pay_${s.id}`,
            payment_no: `PAY-SAL-${s.id.toString().slice(-5).toUpperCase()}`,
            type: 'sale',
            category: s.customer_type === 'distributor' ? 'Wholesale Bulk Sale' : 'Retail Customer Sale',
            amount: parseFloat(s.amount) || 0,
            payment_method: s.payment_method || 'online',
            status: 'completed',
            payer_name: cust?.name || s.customer_name || 'Walk-in Customer',
            payer_phone: cust?.phone || s.customer_phone || '',
            payer_type: s.customer_type || 'retail',
            collector_name: user?.name || 'Staff Member',
            collector_role: user?.role || 'salesman',
            item_description: `${s.quantity}x ${prod?.name || 'Bottles'}`,
            reference_id: s.id,
            notes: s.referral_code ? `Referral code used: ${s.referral_code}` : 'Order payment received',
            created_at: s.created_at || new Date().toISOString()
          });
        }
      });

      (dbSettlements || []).forEach(stl => {
        if (!allPayments.some(p => p.reference_id === stl.id)) {
          const u = userMap.get(stl.salesman_id);
          allPayments.push({
            id: `pay_${stl.id}`,
            payment_no: `PAY-STL-${stl.id.toString().slice(-5).toUpperCase()}`,
            type: 'settlement',
            category: 'Daily Cash Settlement',
            amount: parseFloat(stl.cash_collected || stl.sold_amount || 0),
            payment_method: 'cash',
            status: (stl.status === 'settled' || stl.status === 'tally_zero') ? 'completed' : 'pending',
            payer_name: u ? `${u.name} (Salesman)` : (stl.salesman_name || 'Salesman Deposit'),
            payer_phone: u?.phone || '',
            payer_type: 'salesman',
            collector_name: stl.fsm_name || 'Field Sales Manager / Depot',
            collector_role: 'manager',
            item_description: `Evening Cash Handover (${stl.bottles_sold || 0} btls sold)`,
            reference_id: stl.id,
            notes: `Difference: ₹${stl.difference || 0}`,
            created_at: stl.created_at || new Date().toISOString()
          });
        }
      });
    } catch (e) {
      console.warn('Supabase payments query notice:', e.message);
    }
  }

  // Apply filters
  let filtered = [...allPayments];
  if (type && type !== 'all') {
    filtered = filtered.filter(p => p.type === type);
  }
  if (method && method !== 'all') {
    filtered = filtered.filter(p => p.payment_method === method);
  }
  if (status && status !== 'all') {
    filtered = filtered.filter(p => p.status === status);
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(p =>
      (p.payer_name && p.payer_name.toLowerCase().includes(q)) ||
      (p.payment_no && p.payment_no.toLowerCase().includes(q)) ||
      (p.collector_name && p.collector_name.toLowerCase().includes(q)) ||
      (p.item_description && p.item_description.toLowerCase().includes(q)) ||
      (p.notes && p.notes.toLowerCase().includes(q))
    );
  }
  if (start_date) {
    filtered = filtered.filter(p => new Date(p.created_at) >= new Date(start_date));
  }
  if (end_date) {
    filtered = filtered.filter(p => new Date(p.created_at) <= new Date(end_date));
  }

  // Sort descending by created_at
  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Compute metrics
  const totalVolume = filtered.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const totalCollected = filtered.filter(p => p.type !== 'referral_payout').reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const onlineTotal = filtered.filter(p => p.payment_method === 'online' || p.payment_method === 'upi').reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const cashTotal = filtered.filter(p => p.payment_method === 'cash').reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const payoutsTotal = filtered.filter(p => p.type === 'referral_payout').reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  return res.json({
    summary: {
      total_volume: totalVolume,
      total_collected: totalCollected,
      online_total: onlineTotal,
      cash_total: cashTotal,
      payouts_total: payoutsTotal,
      count: filtered.length
    },
    payments: filtered
  });
});

// Record Manual Payment Entry (Super Admin - Protected by Sensitive Limiter)
router.post('/api/payments', superAdminSensitiveLimiter, async (req, res) => {
  const {
    payer_name,
    payer_phone,
    amount,
    payment_method,
    category,
    item_description,
    collector_name,
    notes,
    admin_id,
    admin_name
  } = req.body;

  if (!payer_name || !amount || !payment_method) {
    return res.status(400).json({ error: 'payer_name, amount, and payment_method are required' });
  }

  const newPay = {
    id: `pay_${Date.now()}`,
    payment_no: `PAY-MAN-${Math.floor(10000 + Math.random() * 90000)}`,
    type: 'sale',
    category: category || 'Direct Payment Adjustment',
    amount: parseFloat(amount),
    payment_method,
    status: 'completed',
    payer_name,
    payer_phone: payer_phone || '',
    payer_type: 'retail',
    collector_name: collector_name || admin_name || 'Super Admin',
    collector_role: 'super_admin',
    item_description: item_description || 'Payment receipt adjustment',
    reference_id: `rec_${Date.now()}`,
    notes: notes || 'Manually logged by Super Admin',
    created_at: new Date().toISOString()
  };

  manualPayments.unshift(newPay);

  await logAudit(admin_id, admin_name || 'Super Admin', 'CREATE_PAYMENT', 'payments', newPay.id, `Logged payment of ₹${amount} from ${payer_name} via ${payment_method}`);
  return res.status(201).json(newPay);
});

module.exports = router;
