const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');

// Customers & Distributors Directory
router.get('/api/customers', async (req, res) => {
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
      console.warn('customers fetch notice, using in-memory directory:', err.message);
    }
  }

  let list = mockDb.customers || [];
  if (customer_type && customer_type !== 'all') {
    list = list.filter(c => c.customer_type === customer_type);
  }
  if (salesman_id && salesman_id !== 'all') {
    const soldCustomerIds = (mockDb.sales || [])
      .filter(s => s.salesman_id === salesman_id)
      .map(s => s.customer_id)
      .filter(Boolean);
    list = list.filter(c => c.created_by === salesman_id || soldCustomerIds.includes(c.id));
  }
  return res.json(list);
});

router.post('/api/customers', async (req, res) => {
  const { name, phone, email, address, customer_type, referral_code, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'Customer name is required' });

  const generatedRef = referral_code || `${name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6)}${Math.floor(100 + Math.random() * 900)}`;

  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('customers').insert([{
        name, phone: phone || '', email: email || '', address: address || '', customer_type: customer_type || 'retail', referral_code: generatedRef, created_by: created_by || null
      }]).select().single();
      if (!error && data) {
        return res.status(201).json(data);
      }
    } catch (err) {
      console.warn('customers insert notice, falling back to in-memory store:', err.message);
    }
  }

  const newCust = {
    id: `c_${Date.now()}`,
    name,
    phone: phone || '',
    email: email || '',
    address: address || '',
    customer_type: customer_type || 'retail',
    referral_code: generatedRef,
    referred_by: null,
    created_by: created_by || null,
    created_at: new Date()
  };
  if (!mockDb.customers) mockDb.customers = [];
  mockDb.customers.unshift(newCust);
  return res.status(201).json(newCust);
});

module.exports = router;
