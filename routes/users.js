const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { logAudit } = require('../services/audit');
const { unlockAccount } = require('../services/authService');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter, salesmanDutyLimiter } = require('../services/rateLimiter');

const enrichUser = (u) => ({
  ...u,
  phone: u.phone || '',
  password: u.password || '',
  requires_password_setup: u.requires_password_setup === true,
  aadhaar_number: u.aadhaar_number || '',
  aadhaar_doc: u.aadhaar_doc || '',
  kyc_status: u.kyc_status || (u.aadhaar_doc ? 'Verified' : 'Pending')
});

// List all workforce users (Protected by General Admin Rate Limiter)
router.get('/api/users', superAdminGeneralLimiter, async (req, res) => {
  const { role, status, search } = req.query;

  try {
    let query = supabase.from('users').select('*, warehouse:warehouses(name), parent:users!parent_id(name)');
    if (role && role !== 'all') query = query.eq('role', role);
    if (status && status !== 'all') query = query.eq('status', status);
    if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) {
      // Fallback without joins if relation fails
      let fallbackQuery = supabase.from('users').select('*');
      if (role && role !== 'all') fallbackQuery = fallbackQuery.eq('role', role);
      if (status && status !== 'all') fallbackQuery = fallbackQuery.eq('status', status);
      if (search) fallbackQuery = fallbackQuery.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
      const { data: fbData, error: fbErr } = await fallbackQuery;
      if (fbErr) throw fbErr;
      return res.json((fbData || []).map(enrichUser));
    }
    const enriched = (data || []).map(enrichUser);
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Alias for backwards compatibility (Protected by General Admin Rate Limiter)
router.get('/api/workforce', superAdminGeneralLimiter, async (req, res) => {
  return res.redirect(307, '/api/users');
});

// Create user directly (Protected by Sensitive Admin Rate Limiter)
router.post('/api/users', superAdminSensitiveLimiter, async (req, res) => {
  const { name, email, phone, role, warehouse_id, parent_id, password, aadhaar_number, aadhaar_doc, admin_id, admin_name } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'Name, email, and role are required' });
  }

  const assignedPassword = (password || '').trim() || (role === 'store_admin' ? 'store123' : role === 'field_sales_manager' ? 'fsm123' : 'sales123');
  const aadhNumber = (aadhaar_number || '').trim();
  const aadhDoc = (aadhaar_doc || '').trim();

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
      try {
        const refCode = `${name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6)}${Math.floor(100 + Math.random() * 900)}`;
        await supabase.from('customers').insert([{
          name, phone, email, customer_type: role === 'distributor' ? 'distributor' : 'retail', referral_code: refCode, created_by: insertedData.id
        }]);
      } catch (_) {}
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
});

// Super Admin reset or update password for any worker (Protected by Sensitive Admin Rate Limiter)
router.post('/api/users/:id/reset-password', superAdminSensitiveLimiter, async (req, res) => {
  const { id } = req.params;
  const { password, admin_id, admin_name } = req.body;
  if (!password || password.trim().length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  try {
    const { data: user, error } = await supabase.from('users')
      .update({ password: password.trim() })
      .eq('id', id)
      .select()
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    unlockAccount(user);
    await logAudit(admin_id, admin_name, 'RESET_PASSWORD', 'users', id, `Super Admin updated password for ${user.name} (${user.email})`);
    return res.json({ success: true, message: `Password for ${user.name} has been updated.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Update user details (Protected by General Admin Rate Limiter)
router.put('/api/users/:id', superAdminGeneralLimiter, async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, role, warehouse_id, parent_id, status, password, aadhaar_number, aadhaar_doc, admin_id, admin_name } = req.body;

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
});

// Delete user account (Protected by Sensitive Admin Rate Limiter)
router.delete('/api/users/:id', superAdminSensitiveLimiter, async (req, res) => {
  const { id } = req.params;
  const { admin_id, admin_name } = req.query;

  try {
    const { data: user } = await supabase.from('users').select('name').eq('id', id).single();
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;

    await logAudit(admin_id, admin_name, 'DELETE_USER', 'users', id, `Deleted user ${user?.name || id}`);
    return res.json({ message: 'User deleted successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Salesman Duty Status Toggle (Protected by Salesman Duty Limiter)
router.put('/api/users/:id/duty', salesmanDutyLimiter, async (req, res) => {
  const { id } = req.params;
  const { is_on_duty } = req.body;

  try {
    const { data: user, error: fetchErr } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (fetchErr || !user) return res.status(404).json({ error: 'User not found' });

    const onDuty = Boolean(is_on_duty);
    try {
      await supabase.from('users').update({ is_on_duty: onDuty }).eq('id', id);
    } catch (_) {}

    await logAudit(id, user.name, 'TOGGLE_DUTY', 'users', id, `Salesman is now ${onDuty ? 'ON DUTY' : 'OFF DUTY'}`);
    return res.json({ success: true, is_on_duty: onDuty });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
