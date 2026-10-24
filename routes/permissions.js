const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { superAdminGeneralLimiter, superAdminSensitiveLimiter } = require('../services/rateLimiter');

const runtimePermissions = [
  { id: 'perm_1', role: 'store_admin', permission_key: 'add_stock', is_allowed: true },
  { id: 'perm_2', role: 'store_admin', permission_key: 'transfer_fsm', is_allowed: true },
  { id: 'perm_3', role: 'store_admin', permission_key: 'direct_sale', is_allowed: true },
  { id: 'perm_4', role: 'store_admin', permission_key: 'bulk_sale_distributor', is_allowed: true },
  { id: 'perm_5', role: 'field_sales_manager', permission_key: 'receive_stock', is_allowed: true },
  { id: 'perm_6', role: 'field_sales_manager', permission_key: 'transfer_salesman', is_allowed: true },
  { id: 'perm_7', role: 'field_sales_manager', permission_key: 'direct_sale', is_allowed: true },
  { id: 'perm_8', role: 'salesman', permission_key: 'view_assigned_stock', is_allowed: true },
  { id: 'perm_9', role: 'salesman', permission_key: 'sell_to_customer', is_allowed: true },
  { id: 'perm_10', role: 'salesman', permission_key: 'onboard_customer', is_allowed: true }
];

// Get all role permissions (Protected by General Admin Rate Limiter)
router.get('/api/permissions', superAdminGeneralLimiter, async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('roles_permissions').select('*');
      if (!error && data && data.length > 0) {
        return res.json(data);
      }
    } catch (_) {}
  }
  return res.json(runtimePermissions);
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
    } catch (_) {}
  }

  let perm = runtimePermissions.find(p => p.role === role && p.permission_key === permission_key);
  if (perm) {
    perm.is_allowed = Boolean(is_allowed);
  } else {
    perm = { id: `perm_${Date.now()}`, role, permission_key, is_allowed: Boolean(is_allowed) };
    runtimePermissions.push(perm);
  }

  await logAudit(admin_id, admin_name, 'UPDATE_PERMISSION', 'roles_permissions', result ? result.id : perm.id, `Permission [${permission_key}] for ${role} set to ${is_allowed}`);
  return res.json(result || perm);
});

module.exports = router;
