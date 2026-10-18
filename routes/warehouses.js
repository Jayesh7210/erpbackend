const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');

// Create Warehouse (Super Admin)
router.post('/api/warehouses', async (req, res) => {
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
  } else {
    const newWarehouse = { id: `w_${Date.now()}`, name, location, created_at: new Date() };
    mockDb.warehouses.push(newWarehouse);
    return res.status(201).json(newWarehouse);
  }
});

// List Warehouses
router.get('/api/warehouses', async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('warehouses').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.json(mockDb.warehouses);
  }
});

// Update Warehouse
router.put('/api/warehouses/:id', async (req, res) => {
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
  } else {
    const idx = mockDb.warehouses.findIndex(w => w.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Warehouse not found' });
    mockDb.warehouses[idx] = { ...mockDb.warehouses[idx], name, location };
    return res.json(mockDb.warehouses[idx]);
  }
});

// Delete Warehouse
router.delete('/api/warehouses/:id', async (req, res) => {
  const { id } = req.params;

  if (state.isSupabaseConfigured) {
    try {
      // Unlink users attached to this warehouse
      await supabase.from('users').update({ warehouse_id: null }).eq('warehouse_id', id);
      // Delete stocks associated with this warehouse
      await supabase.from('stocks').delete().eq('warehouse_id', id);
      // Delete the warehouse itself
      const { error } = await supabase.from('warehouses').delete().eq('id', id);
      if (error) throw error;
      return res.json({ message: 'Warehouse deleted successfully' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    mockDb.warehouses = mockDb.warehouses.filter(w => w.id !== id);
    return res.json({ message: 'Warehouse deleted successfully' });
  }
});

module.exports = router;
