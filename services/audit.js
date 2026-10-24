const { supabaseAdmin: supabase } = require('../db');
const { state } = require('../data/state');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Centralized Audit Logger
async function logAudit(userId, userName, action, entityName, entityId, details) {
  const safeUserId = (userId && UUID_REGEX.test(String(userId))) ? String(userId) : null;
  const isUuidEntity = entityId && UUID_REGEX.test(String(entityId));
  const safeEntityId = isUuidEntity ? String(entityId) : null;

  let detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');
  if (!isUuidEntity && entityId) {
    detailsStr = `[Ref: ${entityId}] ${detailsStr}`;
  }
  if (userName) {
    detailsStr = `[${userName}] ${detailsStr}`;
  }

  const logEntry = {
    user_id: safeUserId,
    action: action || 'UNKNOWN',
    entity_name: entityName || 'general',
    entity_id: safeEntityId,
    details: detailsStr
  };

  if (state.isSupabaseConfigured || (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY))) {
    try {
      const { error } = await supabase.from('audit_logs').insert([logEntry]);
      if (error) {
        console.warn('Failed to insert audit log into Supabase:', error.message);
      }
    } catch (err) {
      console.warn('Audit log exception:', err.message);
    }
  }
  return logEntry;
}

module.exports = {
  logAudit
};

