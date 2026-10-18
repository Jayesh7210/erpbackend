const { supabaseAdmin: supabase } = require('../db');

const state = {
  isSupabaseConfigured: false
};

async function initSupabase() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    try {
      const { data, error } = await supabase.from('users').select('id').limit(1);
      if (!error) {
        state.isSupabaseConfigured = true;
        console.log('✅ Connected to live Supabase database successfully.');
        supabase.storage.createBucket('receipts', { public: true }).then(({ error: bError }) => {
          if (bError && !bError.message.includes('already exists')) {
            console.warn('Notice on receipts storage bucket:', bError.message);
          } else {
            console.log('Supabase "receipts" bucket ready.');
          }
        }).catch(bErr => console.warn('Supabase storage unavailable:', bErr.message));
        return;
      } else {
        console.warn(`⚠️ Supabase returned an error (${error.message}). Operating in standalone in-memory mode.`);
      }
    } catch (err) {
      console.warn(`⚠️ Supabase unreachable (${err.message}). Operating in standalone in-memory mode.`);
    }
  } else {
    console.log('ℹ️ Supabase environment variables not set. Operating in standalone in-memory mode.');
  }
}

module.exports = {
  state,
  initSupabase
};
