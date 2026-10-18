const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');

// View audit logs
router.get('/api/audit-logs', async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.json(mockDb.audit_logs);
  }
});

// Executive Summary for Dashboard
router.get('/api/reports/summary', async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data: sales } = await supabase.from('sales').select('amount, quantity, created_at');
      const { data: users } = await supabase.from('users').select('id');
      const { data: products } = await supabase.from('products').select('id');
      const { data: warehouses } = await supabase.from('warehouses').select('id');
      const { data: referrals } = await supabase.from('referrals').select('status, bonus_amount');
      const { data: stocks } = await supabase.from('stocks').select('quantity, product_id');
      const { data: settlements } = await supabase.from('settlements').select('*');

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
  } else {
    const totalRevenue = (mockDb.sales || []).reduce((acc, s) => acc + (parseFloat(s.amount) || 0), 0);
    const pendingReferralPayouts = (mockDb.referrals || []).filter(r => r.status === 'pending').reduce((acc, r) => acc + (parseFloat(r.bonus_amount) || 0), 0);

    const totalStock = (mockDb.stocks || []).reduce((acc, s) => acc + (parseInt(s.quantity) || 0), 0);

    const todayStr = new Date().toISOString().slice(0, 10);
    const todaySales = (mockDb.sales || []).filter(s => s.created_at && new Date(s.created_at).toISOString().slice(0, 10) === todayStr);
    const todaySalesAmount = todaySales.reduce((acc, s) => acc + (parseFloat(s.amount) || 0), 0);
    const todaySalesBottles = todaySales.reduce((acc, s) => acc + (parseInt(s.quantity) || 0), 0);
    const todaySalesCount = todaySales.length;

    const pendingSettlements = (mockDb.settlements || []).filter(s => s.status !== 'tally_zero' && s.status !== 'settled');
    const pendingSettlementCount = pendingSettlements.length;
    const pendingSettlementAmount = pendingSettlements.reduce((acc, s) => acc + (parseFloat(s.difference) || 0), 0);

    return res.json({
      totalRevenue,
      userCount: (mockDb.users || []).length,
      productCount: (mockDb.products || []).length,
      warehouseCount: (mockDb.warehouses || []).length,
      pendingReferralPayouts,
      totalStock,
      todaySalesAmount,
      todaySalesBottles,
      todaySalesCount,
      pendingSettlementCount,
      pendingSettlementAmount
    });
  }
});

module.exports = router;
