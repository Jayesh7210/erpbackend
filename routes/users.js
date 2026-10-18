const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { unlockAccount } = require('../services/authService');

// List all workforce users (Directly from database with Passwords, Phone, and Aadhaar info for Super Admin)
router.get('/api/users', async (req, res) => {
  const { role, status, search } = req.query;

  const enrichUser = (u) => ({
    ...u,
    phone: u.phone || '',
    password: u.password || '',
    requires_password_setup: u.requires_password_setup === true,
    aadhaar_number: u.aadhaar_number || '',
    aadhaar_doc: u.aadhaar_doc || '',
    kyc_status: u.kyc_status || (u.aadhaar_doc ? 'Verified' : 'Pending')
  });

  if (state.isSupabaseConfigured) {
    try {
      let query = supabase.from('users').select('*, warehouse:warehouses(name), parent:users!parent_id(name)');
      if (role && role !== 'all') query = query.eq('role', role);
      if (status && status !== 'all') query = query.eq('status', status);
      if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

      const { data, error } = await query;
      if (error) throw error;
      const enriched = (data || []).map(enrichUser);
      return res.json(enriched);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    let result = [...mockDb.users];
    if (role && role !== 'all') result = result.filter(u => u.role === role);
    if (status && status !== 'all') result = result.filter(u => u.status === status);
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(u => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s) || (u.phone && u.phone.includes(s)));
    }

    const resolved = result.map(u => {
      const wh = mockDb.warehouses.find(w => w.id === u.warehouse_id);
      const parent = mockDb.users.find(p => p.id === u.parent_id);
      const base = {
        ...u,
        warehouse: wh ? { name: wh.name } : null,
        parent: parent ? { name: parent.name } : null
      };
      return enrichUser(base);
    });
    return res.json(resolved);
  }
});

// Alias for backwards compatibility
router.get('/api/workforce', async (req, res) => {
  return res.redirect(307, '/api/users');
});

// Create user directly (Super Admin - saves Password & Aadhaar card in database)
router.post('/api/users', async (req, res) => {
  const { name, email, phone, role, warehouse_id, parent_id, password, aadhaar_number, aadhaar_doc, admin_id, admin_name } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'Name, email, and role are required' });
  }

  const assignedPassword = (password || '').trim() || (role === 'store_admin' ? 'store123' : role === 'field_sales_manager' ? 'fsm123' : 'sales123');
  const aadhNumber = (aadhaar_number || '').trim();
  const aadhDoc = (aadhaar_doc || '').trim();

  if (state.isSupabaseConfigured) {
    try {
      const userPayload = {
        name,
        email,
        role,
        warehouse_id: warehouse_id || null,
        parent_id: parent_id || null,
        status: 'approved'
      };
      if (phone) userPayload.phone = phone;
      if (assignedPassword) userPayload.password = assignedPassword;
      if (aadhNumber) userPayload.aadhaar_number = aadhNumber;
      if (aadhDoc) userPayload.aadhaar_doc = aadhDoc;

      let insertedData = null;
      try {
        const { data, error } = await supabase.from('users').insert([userPayload]).select().single();
        if (error) throw error;
        insertedData = data;
      } catch (_) {
        const { data, error: fbErr } = await supabase.from('users').insert([{
          name, email, role, warehouse_id: warehouse_id || null, parent_id: parent_id || null, status: 'approved'
        }]).select().single();
        if (fbErr) throw fbErr;
        insertedData = data;
      }

      if (role === 'customer' || role === 'distributor') {
        const refCode = `${name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6)}${Math.floor(100 + Math.random() * 900)}`;
        await supabase.from('customers').insert([{
          name, phone, email, customer_type: role === 'distributor' ? 'distributor' : 'retail', referral_code: refCode, created_by: insertedData.id
        }]);
      }

      await logAudit(admin_id, admin_name, 'CREATE_USER', 'users', insertedData.id, `Created ${role} account for ${name} (${email})`);
      return res.status(201).json({
        ...insertedData,
        phone: phone || '',
        password: assignedPassword,
        aadhaar_number: aadhNumber,
        aadhaar_doc: aadhDoc
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const newUser = {
      id: `u_${Date.now()}`,
      name,
      email,
      phone: phone || '',
      role,
      warehouse_id: warehouse_id || null,
      parent_id: parent_id || null,
      status: 'approved',
      password: assignedPassword,
      aadhaar_number: aadhNumber,
      aadhaar_doc: aadhDoc,
      created_at: new Date()
    };
    mockDb.users.push(newUser);

    if (role === 'customer' || role === 'distributor') {
      const refCode = `${name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6)}${Math.floor(100 + Math.random() * 900)}`;
      mockDb.customers.push({
        id: `c_${Date.now()}`,
        name,
        phone: phone || '',
        email,
        customer_type: role === 'distributor' ? 'distributor' : 'retail',
        referral_code: refCode,
        referred_by: null,
        created_by: newUser.id
      });
    }

    await logAudit(admin_id, admin_name, 'CREATE_USER', 'users', newUser.id, `Created ${role} account for ${name} (${email})`);
    return res.status(201).json(newUser);
  }
});

// Super Admin reset or update password for any worker (persisted directly in database)
router.post('/api/users/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { password, admin_id, admin_name } = req.body;
  if (!password || password.trim().length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  let user = null;
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('users')
        .update({ password: password.trim() })
        .eq('id', id)
        .select()
        .single();
      if (!error && data) user = data;
    } catch (_) {}
  }
  if (!user) {
    user = mockDb.users.find(u => u.id === id);
    if (user) user.password = password.trim();
  }
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  unlockAccount(user);
  await logAudit(admin_id, admin_name, 'RESET_PASSWORD', 'users', id, `Super Admin updated password for ${user.name} (${user.email})`);
  return res.json({ success: true, message: `Password for ${user.name} has been updated to "${password.trim()}".` });
});

// Update user details (Super Admin - persisted in database)
router.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role, warehouse_id, parent_id, status, password, aadhaar_number, aadhaar_doc, admin_id, admin_name } = req.body;

  if (state.isSupabaseConfigured) {
    try {
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (email !== undefined) updateData.email = email;
      if (phone !== undefined) updateData.phone = phone;
      if (role !== undefined) updateData.role = role;
      if (warehouse_id !== undefined) updateData.warehouse_id = warehouse_id;
      if (parent_id !== undefined) updateData.parent_id = parent_id;
      if (status !== undefined) updateData.status = status;
      if (password !== undefined && password.trim().length > 0) updateData.password = password.trim();
      if (aadhaar_number !== undefined) updateData.aadhaar_number = aadhaar_number;
      if (aadhaar_doc !== undefined) updateData.aadhaar_doc = aadhaar_doc;

      const { data, error } = await supabase.from('users')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;

      await logAudit(admin_id, admin_name, 'UPDATE_USER', 'users', id, `Updated user ${data.name}: ${JSON.stringify(updateData)}`);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const userIndex = mockDb.users.findIndex(u => u.id === id);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
    
    const user = mockDb.users[userIndex];
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (role !== undefined) user.role = role;
    if (warehouse_id !== undefined) user.warehouse_id = warehouse_id;
    if (parent_id !== undefined) user.parent_id = parent_id;
    if (status !== undefined) user.status = status;
    if (password !== undefined && password.trim().length > 0) user.password = password.trim();
    if (aadhaar_number !== undefined) user.aadhaar_number = aadhaar_number;
    if (aadhaar_doc !== undefined) user.aadhaar_doc = aadhaar_doc;

    await logAudit(admin_id, admin_name, 'UPDATE_USER', 'users', id, `Updated user ${user.name} details`);
    return res.json(user);
  }
});

// Delete user account (Super Admin)
router.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { admin_id, admin_name } = req.query;

  if (state.isSupabaseConfigured) {
    try {
      const { data: user } = await supabase.from('users').select('name').eq('id', id).single();
      const { error } = await supabase.from('users').delete().eq('id', id);
      if (error) throw error;

      await logAudit(admin_id, admin_name, 'DELETE_USER', 'users', id, `Deleted user ${user?.name || id}`);
      return res.json({ message: 'User deleted successfully' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const idx = mockDb.users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const deleted = mockDb.users.splice(idx, 1)[0];
    await logAudit(admin_id, admin_name, 'DELETE_USER', 'users', id, `Deleted user ${deleted.name}`);
    return res.json({ message: 'User deleted successfully' });
  }
});

// Salesman Duty Status Toggle
router.put('/api/users/:id/duty', async (req, res) => {
  const { id } = req.params;
  const { is_on_duty } = req.body;
  const user = mockDb.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.is_on_duty = Boolean(is_on_duty);
  await logAudit(id, user.name, 'TOGGLE_DUTY', 'users', id, `Salesman is now ${user.is_on_duty ? 'ON DUTY' : 'OFF DUTY'}`);
  return res.json({ success: true, is_on_duty: user.is_on_duty });
});

module.exports = router;
