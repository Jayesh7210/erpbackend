const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { state } = require('../data/state');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter } = require('../services/rateLimiter');

// Create Warehouse (Protected by Sensitive Admin Rate Limiter)
router.post('/api/warehouses', superAdminSensitiveLimiter, async (req, res) => {
  const { name, location } = req.body;
  if (!name) return res.status(400).json({ error: 'Warehouse name is required' });

  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('warehouses').insert([{ name, location }]).select().single();
      if (error) throw error;
      return res.status(201).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  return res.status(500).json({ error: 'Database is not configured' });
});

// List Warehouses (Protected by General Admin Rate Limiter)
router.get('/api/warehouses', superAdminGeneralLimiter, async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('warehouses').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data || []);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  return res.json([]);
});

// Update Warehouse (Protected by General Admin Rate Limiter)
router.put('/api/warehouses/:id', superAdminGeneralLimiter, async (req, res) => {
  const { id } = req.params;
  const { name, location } = req.body;
  if (!name) return res.status(400).json({ error: 'Warehouse name is required' });

  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from('warehouses')
        .update({ name, location })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  return res.status(500).json({ error: 'Database is not configured' });
});

// Delete Warehouse (Protected by Sensitive Admin Rate Limiter)
router.delete('/api/warehouses/:id', superAdminSensitiveLimiter, async (req, res) => {
  const { id } = req.params;

  if (state.isSupabaseConfigured) {
    try {
      // Unlink users attached to this warehouse
      await supabase.from('users').update({ warehouse_id: null }).eq('warehouse_id', id);
      // Delete stocks associated with this warehouse (owner_id holds warehouse UUID)
      await supabase.from('stocks').delete().eq('owner_id', id);
      // Delete the warehouse itself
      const { error } = await supabase.from('warehouses').delete().eq('id', id);
      if (error) throw error;
      return res.json({ message: 'Warehouse deleted successfully' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  return res.status(500).json({ error: 'Database is not configured' });
});

module.exports = router;
