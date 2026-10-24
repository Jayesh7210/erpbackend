const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { state } = require('../data/state');
const { storeAdminGeneralLimiter, storeAdminTransactionLimiter } = require('../services/rateLimiter');

const runtimeCustomers = [];

// Customers & Distributors Directory (Protected by General Store Admin Limiter)
router.get('/api/customers', storeAdminGeneralLimiter, async (req, res) => {
  const { customer_type, salesman_id } = req.query;
  if (state.isSupabaseConfigured) {
    try {
      let query = supabase.from('customers').select('*');
      if (customer_type && customer_type !== 'all') {
        query = query.eq('customer_type', customer_type);
      }
      if (salesman_id && salesman_id !== 'all') {
        query = query.eq('created_by', salesman_id);
      }
      const { data, error } = await query.order('created_at', { ascending: false });
      if (!error && data) return res.json(data);
    } catch (err) {
      console.warn('customers fetch notice:', err.message);
    }
  }
  let list = [...runtimeCustomers];
  if (customer_type && customer_type !== 'all') {
    list = list.filter(c => c.customer_type === customer_type);
  }
  if (salesman_id && salesman_id !== 'all') {
    list = list.filter(c => c.created_by === salesman_id);
  }
  return res.json(list);
});

// Register Customer or Distributor (Protected by Transaction Limiter)
router.post('/api/customers', storeAdminTransactionLimiter, async (req, res) => {
  const { name, phone, email, address, customer_type, referral_code, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'Customer name is required' });

  const generatedRef = referral_code || `${name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6)}${Math.floor(100 + Math.random() * 900)}`;

  const customerObj = {
    id: `cust_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    address: address || '',
    customer_type: customer_type || 'retail',
    referral_code: generatedRef,
    created_by: created_by || null,
    created_at: new Date().toISOString()
  };

  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('customers').insert([{
        name,
        phone: phone || '',
        email: email || '',
        address: address || '',
        customer_type: customer_type || 'retail',
        referral_code: generatedRef,
        created_by: created_by || null
      }]).select().single();
      if (!error && data) {
        return res.status(201).json(data);
      }
    } catch (err) {
      console.warn('customers insert error:', err.message);
    }
  }

  runtimeCustomers.unshift(customerObj);
  return res.status(201).json(customerObj);
});

module.exports = router;
