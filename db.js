require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Fallback to live Supabase project credentials if environment variables are not yet configured on hosting provider
const supabaseUrl = process.env.SUPABASE_URL || 'https://ficltneuoskqjqrkwyuj.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpY2x0bmV1b3NrcWpxcmt3eXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MDc0NjQsImV4cCI6MjEwMjM4MzQ2NH0.QTuni5NZnbTKIKMjhX12JLeIgJObgj-D-LchiN5UA04';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpY2x0bmV1b3NrcWpxcmt3eXVqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NjgwNzQ2NCwiZXhwIjoyMTAyMzgzNDY0fQ.8zp1J7X4xDAiSbjHRCwKV8PPx_UVofMrK3s5mi0ilII';

let supabase = null;
let supabaseAdmin = null;

try {
  if (supabaseUrl && supabaseAnonKey) {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
    supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey);
  }
} catch (err) {
  console.warn('⚠️ Supabase client initialization warning:', err.message);
}

module.exports = {
  supabase,
  supabaseAdmin
};

