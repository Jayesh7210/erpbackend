const { supabaseAdmin } = require('./db');

async function test() {
  console.log('Testing connection to Supabase...');
  try {
    const { data, error } = await supabaseAdmin.from('users').select('*');
    if (error) {
      console.error('Error fetching users:', error);
    } else {
      console.log('Successfully fetched users:', data);
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  }
}

test();
