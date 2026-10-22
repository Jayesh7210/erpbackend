const fs = require('fs');
const path = require('path');
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');

// Product metadata cache (persisted locally for availability, pricing & alerts)
const PRODUCT_META_FILE = path.join(__dirname, '..', 'product_meta.json');
let productMeta = {};

try {
  if (fs.existsSync(PRODUCT_META_FILE)) {
    productMeta = JSON.parse(fs.readFileSync(PRODUCT_META_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('Could not read product_meta.json:', e.message);
}

function saveProductMeta() {
  try {
    fs.writeFileSync(PRODUCT_META_FILE, JSON.stringify(productMeta, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not write product_meta.json:', e.message);
  }
}

function getProductWithMeta(productId) {
  if (!productId) return null;
  const prod = (mockDb.products || []).find(p => p.id === productId);
  if (!prod) return null;
  const meta = productMeta[prod.id] || productMeta[prod.sku] || {};
  return {
    ...prod,
    base_price: meta.base_price !== undefined ? meta.base_price : (prod.base_price || 0.0),
    store_admin_commission: meta.store_admin_commission !== undefined ? meta.store_admin_commission : (prod.store_admin_commission !== undefined ? prod.store_admin_commission : 0.0),
    fsm_commission: meta.fsm_commission !== undefined ? meta.fsm_commission : (prod.fsm_commission !== undefined ? prod.fsm_commission : 0.0),
    salesman_commission: meta.salesman_commission !== undefined ? meta.salesman_commission : (prod.salesman_commission !== undefined ? prod.salesman_commission : 0.0),
    referral_commission: meta.referral_commission !== undefined ? meta.referral_commission : (prod.referral_commission !== undefined ? prod.referral_commission : 0.0),
    initial_stock_quota: meta.initial_stock_quota !== undefined ? meta.initial_stock_quota : (prod.initial_stock_quota !== undefined ? prod.initial_stock_quota : 0),
    commission_slabs: meta.commission_slabs || prod.commission_slabs || []
  };
}

async function getDefaultProductUnitPrice() {
  if (state.isSupabaseConfigured) {
    try {
      const { data } = await supabase.from('products').select('id, sku, base_price').limit(1);
      if (data && data.length > 0) {
        const p = data[0];
        const meta = productMeta[p.id] || productMeta[p.sku] || {};
        const price = meta.base_price !== undefined ? meta.base_price : (p.base_price || 0.0);
        if (price > 0) return Number(price);
      }
    } catch (e) {
      console.warn('Error fetching default product price from supabase:', e.message);
    }
  }
  const first = mockDb.products?.[0];
  if (first) {
    const meta = productMeta[first.id] || productMeta[first.sku] || {};
    const price = meta.base_price !== undefined ? meta.base_price : (first.base_price || 0.0);
    if (price > 0) return Number(price);
  }
  return 0.0;
}

module.exports = {
  productMeta,
  saveProductMeta,
  getProductWithMeta,
  getDefaultProductUnitPrice
};
