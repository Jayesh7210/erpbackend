const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter } = require('../services/rateLimiter');

// Get all role permissions (Protected by General Admin Rate Limiter)
router.get('/api/permissions', superAdminGeneralLimiter, async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('roles_permissions').select('*');
      if (!error && data && data.length > 0) {
        return res.json(data);
      }
    } catch (err) {
      console.warn('roles_permissions fetch notice, falling back to defaults:', err.message);
    }
  }
  return res.json(mockDb.roles_permissions);
});

// Update role permission toggle (Protected by Sensitive Admin Rate Limiter)
router.put('/api/permissions', superAdminSensitiveLimiter, async (req, res) => {
  const { role, permission_key, is_allowed, admin_id, admin_name } = req.body;
  if (!role || !permission_key || is_allowed === undefined) {
    return res.status(400).json({ error: 'role, permission_key, and is_allowed are required' });
  }

  let result = null;
  if (state.isSupabaseConfigured) {
    try {
      const { data: existing } = await supabase.from('roles_permissions')
        .select('*')
        .eq('role', role)
        .eq('permission_key', permission_key)
        .maybeSingle();

      if (existing) {
        const { data, error } = await supabase.from('roles_permissions')
          .update({ is_allowed })
          .eq('id', existing.id)
          .select()
          .single();
        if (!error && data) result = data;
      } else {
        const { data, error } = await supabase.from('roles_permissions')
          .insert([{ role, permission_key, is_allowed }])
          .select()
          .single();
        if (!error && data) result = data;
      }
    } catch (err) {
      console.warn('roles_permissions update notice, using in-memory state:', err.message);
    }
  }

  let perm = mockDb.roles_permissions.find(p => p.role === role && p.permission_key === permission_key);
  if (perm) {
    perm.is_allowed = Boolean(is_allowed);
  } else {
    perm = { role, permission_key, is_allowed: Boolean(is_allowed) };
    mockDb.roles_permissions.push(perm);
  }

  await logAudit(admin_id, admin_name, 'UPDATE_PERMISSION', 'roles_permissions', result ? result.id : null, `Permission [${permission_key}] for ${role} set to ${is_allowed}`);
  return res.json(result || perm);
});

module.exports = router;
