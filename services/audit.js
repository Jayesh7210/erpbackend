const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');

// Centralized Audit Logger
async function logAudit(userId, userName, action, entityName, entityId, details) {
  const logEntry = {
    id: `aud_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    user_id: userId || 'u1',
    user_name: userName || 'Super Admin',
    action,
    entity_name: entityName,
    entity_id: entityId || null,
    details: typeof details === 'object' ? JSON.stringify(details) : String(details),
    created_at: new Date()
  };
  mockDb.audit_logs.unshift(logEntry);
  if (state.isSupabaseConfigured) {
    try {
      await supabase.from('audit_logs').insert([{
        user_id: logEntry.user_id,
        user_name: logEntry.user_name,
        action: logEntry.action,
        entity_name: logEntry.entity_name,
        entity_id: logEntry.entity_id,
        details: logEntry.details
      }]);
    } catch (err) {
      console.warn('Failed to insert audit log into Supabase:', err.message);
    }
  }
  return logEntry;
}

module.exports = {
  logAudit
};
