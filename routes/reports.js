const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { superAdminAnalyticsLimiter } = require('../services/rateLimiter');

// View audit logs (Protected by Analytics Rate Limiter)
router.get('/api/audit-logs', superAdminAnalyticsLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Executive Summary for Dashboard (Protected by Analytics Rate Limiter)
router.get('/api/reports/summary', superAdminAnalyticsLimiter, async (req, res) => {
  try {
    const { data: sales } = await supabase.from('sales').select('amount, quantity, created_at');
    const { data: users } = await supabase.from('users').select('id');
    const { data: products } = await supabase.from('products').select('id');
    const { data: warehouses } = await supabase.from('warehouses').select('id');
    let referrals = [];
    try {
      const { data: refData } = await supabase.from('referrals').select('status, bonus_amount');
      if (refData) referrals = refData;
    } catch (_) {}

    const { data: stocks } = await supabase.from('stocks').select('quantity, product_id');
    let settlements = [];
    try {
      const { data: setlData } = await supabase.from('settlements').select('*');
      if (setlData) settlements = setlData;
    } catch (_) {}

    const totalRevenue = (sales || []).reduce((acc, s) => acc + (parseFloat(s.amount) || 0), 0);
    const pendingReferralPayouts = (referrals || []).filter(r => r.status === 'pending').reduce((acc, r) => acc + (parseFloat(r.bonus_amount) || 0), 0);

    const totalStock = (stocks || []).reduce((acc, s) => acc + (parseInt(s.quantity) || 0), 0);

    const todayStr = new Date().toISOString().slice(0, 10);
    const todaySales = (sales || []).filter(s => s.created_at && new Date(s.created_at).toISOString().slice(0, 10) === todayStr);
    const todaySalesAmount = todaySales.reduce((acc, s) => acc + (parseFloat(s.amount) || 0), 0);
    const todaySalesBottles = todaySales.reduce((acc, s) => acc + (parseInt(s.quantity) || 0), 0);
    const todaySalesCount = todaySales.length;

    const pendingSettlements = (settlements || []).filter(s => s.status !== 'tally_zero' && s.status !== 'settled');
    const pendingSettlementCount = pendingSettlements.length;
    const pendingSettlementAmount = pendingSettlements.reduce((acc, s) => acc + (parseFloat(s.difference) || 0), 0);

    return res.json({
      totalRevenue,
      userCount: users?.length || 0,
      productCount: products?.length || 0,
      warehouseCount: warehouses?.length || 0,
      pendingReferralPayouts,
      totalStock,
      todaySalesAmount,
      todaySalesBottles,
      todaySalesCount,
      pendingSettlementCount,
      pendingSettlementAmount
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
