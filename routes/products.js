const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { productMeta, saveProductMeta } = require('../services/productMeta');

// List Products
router.get('/api/products', async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('products').select('*');
      if (error) throw error;
      const enriched = data.map(p => {
        const meta = productMeta[p.id] || productMeta[p.sku] || {};
        return {
          ...p,
          is_active: meta.is_active !== undefined ? meta.is_active : (p.is_active !== undefined ? p.is_active : true),
          category: meta.category || p.category || 'General',
          base_price: meta.base_price !== undefined ? meta.base_price : (p.base_price || 0.0),
          min_stock_alert: meta.min_stock_alert !== undefined ? meta.min_stock_alert : (p.min_stock_alert || 20),
          image_url: meta.image_url || p.image_url || null,
          store_admin_commission: meta.store_admin_commission !== undefined ? meta.store_admin_commission : (p.store_admin_commission !== undefined ? parseFloat(p.store_admin_commission) : 0.0),
          fsm_commission: meta.fsm_commission !== undefined ? meta.fsm_commission : (p.fsm_commission !== undefined ? parseFloat(p.fsm_commission) : 0.0),
          salesman_commission: meta.salesman_commission !== undefined ? meta.salesman_commission : (p.salesman_commission !== undefined ? parseFloat(p.salesman_commission) : 0.0),
          referral_commission: meta.referral_commission !== undefined ? meta.referral_commission : (p.referral_commission !== undefined ? parseFloat(p.referral_commission) : 0.0)
        };
      });
      return res.json(enriched);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.json(mockDb.products.map(p => {
      const meta = productMeta[p.id] || productMeta[p.sku] || {};
      return {
        ...p,
        is_active: p.is_active !== undefined ? p.is_active : (meta.is_active !== undefined ? meta.is_active : true),
        category: meta.category || p.category || 'General',
        base_price: meta.base_price !== undefined ? meta.base_price : (p.base_price || 0.0),
        min_stock_alert: meta.min_stock_alert !== undefined ? meta.min_stock_alert : (p.min_stock_alert || 20),
        store_admin_commission: meta.store_admin_commission !== undefined ? meta.store_admin_commission : (p.store_admin_commission !== undefined ? p.store_admin_commission : 0.0),
        fsm_commission: meta.fsm_commission !== undefined ? meta.fsm_commission : (p.fsm_commission !== undefined ? p.fsm_commission : 0.0),
        salesman_commission: meta.salesman_commission !== undefined ? meta.salesman_commission : (p.salesman_commission !== undefined ? p.salesman_commission : 0.0),
        referral_commission: meta.referral_commission !== undefined ? meta.referral_commission : (p.referral_commission !== undefined ? p.referral_commission : 0.0)
      };
    }));
  }
});

// Add Product (Super Admin)
router.post('/api/products', async (req, res) => {
  const {
    name, sku, unit, category, base_price, min_stock_alert, image_url, is_active,
    store_admin_commission, fsm_commission, salesman_commission, referral_commission,
    admin_id, admin_name
  } = req.body;
  if (!name || !sku) return res.status(400).json({ error: 'Name and SKU are required' });

  const activeVal = is_active !== undefined ? is_active : true;
  const storeAdminComm = store_admin_commission !== undefined ? parseFloat(store_admin_commission) : 0.0;
  const fsmComm = fsm_commission !== undefined ? parseFloat(fsm_commission) : 0.0;
  const salesmanComm = salesman_commission !== undefined ? parseFloat(salesman_commission) : 0.0;
  const referralComm = referral_commission !== undefined ? parseFloat(referral_commission) : 0.0;

  if (state.isSupabaseConfigured) {
    try {
      let data = null;
      const fullPayload = {
        name,
        sku,
        unit: unit || 'pcs',
        category: category || 'General',
        base_price: base_price ? parseFloat(base_price) : 0.0,
        min_stock_alert: min_stock_alert ? parseInt(min_stock_alert) : 20,
        image_url: image_url || null,
        store_admin_commission: storeAdminComm,
        fsm_commission: fsmComm,
        salesman_commission: salesmanComm,
        referral_commission: referralComm
      };

      const { data: fullData, error: fullErr } = await supabase.from('products').insert([fullPayload]).select().single();
      if (!fullErr && fullData) {
        data = fullData;
      } else {
        const { data: coreData, error: coreErr } = await supabase.from('products').insert([{
          name,
          sku,
          unit: unit || 'pcs'
        }]).select().single();
        if (coreErr) throw coreErr;
        data = coreData;
      }

      productMeta[data.id] = {
        is_active: activeVal,
        category: category || 'General',
        base_price: base_price ? parseFloat(base_price) : 0.0,
        min_stock_alert: min_stock_alert ? parseInt(min_stock_alert) : 20,
        image_url: image_url || null,
        store_admin_commission: storeAdminComm,
        fsm_commission: fsmComm,
        salesman_commission: salesmanComm,
        referral_commission: referralComm
      };
      saveProductMeta();

      await logAudit(admin_id, admin_name, 'CREATE_PRODUCT', 'products', data.id, `Created product ${name} (SKU: ${sku}, Available: ${activeVal})`);
      return res.status(201).json({
        ...data,
        ...productMeta[data.id]
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const newProduct = {
      id: `p_${Date.now()}`,
      name,
      sku,
      unit: unit || 'pcs',
      category: category || 'General',
      base_price: base_price ? parseFloat(base_price) : 0.0,
      min_stock_alert: min_stock_alert ? parseInt(min_stock_alert) : 20,
      image_url: image_url || null,
      is_active: activeVal,
      store_admin_commission: storeAdminComm,
      fsm_commission: fsmComm,
      salesman_commission: salesmanComm,
      referral_commission: referralComm,
      created_at: new Date()
    };
    mockDb.products.push(newProduct);
    productMeta[newProduct.id] = {
      is_active: activeVal,
      category: newProduct.category,
      base_price: newProduct.base_price,
      min_stock_alert: newProduct.min_stock_alert,
      store_admin_commission: storeAdminComm,
      fsm_commission: fsmComm,
      salesman_commission: salesmanComm,
      referral_commission: referralComm
    };
    saveProductMeta();
    await logAudit(admin_id, admin_name, 'CREATE_PRODUCT', 'products', newProduct.id, `Created product ${name} (SKU: ${sku})`);
    return res.status(201).json(newProduct);
  }
});

// Update Product (Super Admin)
router.put('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name, sku, unit, category, base_price, min_stock_alert, image_url, is_active,
    store_admin_commission, fsm_commission, salesman_commission, referral_commission,
    admin_id, admin_name
  } = req.body;

  if (state.isSupabaseConfigured) {
    try {
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (sku !== undefined) updateData.sku = sku;
      if (unit !== undefined) updateData.unit = unit;
      if (category !== undefined) updateData.category = category;
      if (base_price !== undefined) updateData.base_price = parseFloat(base_price);
      if (min_stock_alert !== undefined) updateData.min_stock_alert = parseInt(min_stock_alert);
      if (image_url !== undefined) updateData.image_url = image_url;
      if (store_admin_commission !== undefined) updateData.store_admin_commission = parseFloat(store_admin_commission);
      if (fsm_commission !== undefined) updateData.fsm_commission = parseFloat(fsm_commission);
      if (salesman_commission !== undefined) updateData.salesman_commission = parseFloat(salesman_commission);
      if (referral_commission !== undefined) updateData.referral_commission = parseFloat(referral_commission);

      let dbProduct = { id };
      if (Object.keys(updateData).length > 0) {
        const { data, error } = await supabase.from('products').update(updateData).eq('id', id).select().single();
        if (!error && data) {
          dbProduct = data;
        } else {
          const coreUpdate = {};
          if (name !== undefined) coreUpdate.name = name;
          if (sku !== undefined) coreUpdate.sku = sku;
          if (unit !== undefined) coreUpdate.unit = unit;
          if (Object.keys(coreUpdate).length > 0) {
            const { data: coreData } = await supabase.from('products').update(coreUpdate).eq('id', id).select().single();
            if (coreData) dbProduct = coreData;
          }
        }
      } else {
        const { data } = await supabase.from('products').select('*').eq('id', id).single();
        if (data) dbProduct = data;
      }

      productMeta[id] = productMeta[id] || {};
      if (is_active !== undefined) productMeta[id].is_active = is_active;
      if (category !== undefined) productMeta[id].category = category;
      if (base_price !== undefined) productMeta[id].base_price = parseFloat(base_price);
      if (min_stock_alert !== undefined) productMeta[id].min_stock_alert = parseInt(min_stock_alert);
      if (image_url !== undefined) productMeta[id].image_url = image_url;
      if (store_admin_commission !== undefined) productMeta[id].store_admin_commission = parseFloat(store_admin_commission);
      if (fsm_commission !== undefined) productMeta[id].fsm_commission = parseFloat(fsm_commission);
      if (salesman_commission !== undefined) productMeta[id].salesman_commission = parseFloat(salesman_commission);
      if (referral_commission !== undefined) productMeta[id].referral_commission = parseFloat(referral_commission);
      saveProductMeta();

      await logAudit(admin_id, admin_name, 'UPDATE_PRODUCT', 'products', id, `Updated product ${dbProduct.name || id} (Available: ${productMeta[id].is_active})`);
      return res.json({
        ...dbProduct,
        ...productMeta[id]
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const prod = mockDb.products.find(p => p.id === id);
    if (!prod) return res.status(404).json({ error: 'Product not found' });

    if (name !== undefined) prod.name = name;
    if (sku !== undefined) prod.sku = sku;
    if (unit !== undefined) prod.unit = unit;
    if (category !== undefined) prod.category = category;
    if (base_price !== undefined) prod.base_price = parseFloat(base_price);
    if (min_stock_alert !== undefined) prod.min_stock_alert = parseInt(min_stock_alert);
    if (image_url !== undefined) prod.image_url = image_url;
    if (is_active !== undefined) prod.is_active = is_active;
    if (store_admin_commission !== undefined) prod.store_admin_commission = parseFloat(store_admin_commission);
    if (fsm_commission !== undefined) prod.fsm_commission = parseFloat(fsm_commission);
    if (salesman_commission !== undefined) prod.salesman_commission = parseFloat(salesman_commission);
    if (referral_commission !== undefined) prod.referral_commission = parseFloat(referral_commission);

    productMeta[id] = productMeta[id] || {};
    if (is_active !== undefined) productMeta[id].is_active = is_active;
    if (category !== undefined) productMeta[id].category = category;
    if (base_price !== undefined) productMeta[id].base_price = parseFloat(base_price);
    if (min_stock_alert !== undefined) productMeta[id].min_stock_alert = parseInt(min_stock_alert);
    if (image_url !== undefined) productMeta[id].image_url = image_url;
    if (store_admin_commission !== undefined) productMeta[id].store_admin_commission = parseFloat(store_admin_commission);
    if (fsm_commission !== undefined) productMeta[id].fsm_commission = parseFloat(fsm_commission);
    if (salesman_commission !== undefined) productMeta[id].salesman_commission = parseFloat(salesman_commission);
    if (referral_commission !== undefined) productMeta[id].referral_commission = parseFloat(referral_commission);
    saveProductMeta();

    await logAudit(admin_id, admin_name, 'UPDATE_PRODUCT', 'products', id, `Updated product ${prod.name}`);
    return res.json({
      ...prod,
      ...productMeta[id]
    });
  }
});

// Delete Product (Super Admin)
router.delete('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { admin_id, admin_name } = req.query;

  if (state.isSupabaseConfigured) {
    try {
      const { data: prod } = await supabase.from('products').select('name').eq('id', id).single();
      
      // Clean up child dependencies to prevent foreign key violations
      try {
        await supabase.from('stocks').delete().eq('product_id', id);
        await supabase.from('product_prices').delete().eq('product_id', id);
      } catch (depErr) {
        console.warn('Could not clean dependencies for product:', depErr.message);
      }

      const { error } = await supabase.from('products').delete().eq('id', id);
      if (error) throw error;

      delete productMeta[id];
      saveProductMeta();

      await logAudit(admin_id, admin_name, 'DELETE_PRODUCT', 'products', id, `Deleted product ${prod?.name || id}`);
      return res.json({ message: 'Product deleted successfully', id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const idx = mockDb.products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Product not found' });
    const deleted = mockDb.products.splice(idx, 1)[0];
    delete productMeta[id];
    saveProductMeta();
    await logAudit(admin_id, admin_name, 'DELETE_PRODUCT', 'products', id, `Deleted product ${deleted.name}`);
    return res.json({ message: 'Product deleted successfully', id });
  }
});

// Get all product prices (Super Admin)
router.get('/api/products/prices', async (req, res) => {
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('product_prices').select('*, product:products(name, sku)');
      if (error) throw error;
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const list = mockDb.prices.map(p => {
      const product = mockDb.products.find(pr => pr.id === p.product_id);
      return { ...p, product };
    });
    return res.json(list);
  }
});

// Configure or update price for a product and role (Super Admin)
router.post('/api/products/prices', async (req, res) => {
  const { product_id, role, price, discount_percentage, admin_id, admin_name } = req.body;
  if (!product_id || !role || price === undefined) {
    return res.status(400).json({ error: 'product_id, role, and price are required' });
  }

  const discount = discount_percentage !== undefined ? parseFloat(discount_percentage) : 0;
  const priceVal = parseFloat(price);

  if (state.isSupabaseConfigured) {
    try {
      const { data: existing } = await supabase.from('product_prices')
        .select('*')
        .eq('product_id', product_id)
        .eq('role', role)
        .maybeSingle();

      let result;
      if (existing) {
        const { data, error } = await supabase.from('product_prices')
          .update({ price: priceVal, discount_percentage: discount })
          .eq('id', existing.id)
          .select()
          .single();
        if (error) throw error;
        result = data;
      } else {
        const { data, error } = await supabase.from('product_prices')
          .insert([{ product_id, role, price: priceVal, discount_percentage: discount }])
          .select()
          .single();
        if (error) throw error;
        result = data;
      }

      await logAudit(admin_id, admin_name, 'UPDATE_PRICE', 'product_prices', result.id, `Set price for product ${product_id} (${role}) to ₹${priceVal} with ${discount}% discount`);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    let existing = mockDb.prices.find(p => p.product_id === product_id && p.role === role);
    if (existing) {
      existing.price = priceVal;
      existing.discount_percentage = discount;
    } else {
      existing = { product_id, role, price: priceVal, discount_percentage: discount };
      mockDb.prices.push(existing);
    }

    await logAudit(admin_id, admin_name, 'UPDATE_PRICE', 'product_prices', null, `Set price for product ${product_id} (${role}) to ₹${priceVal} with ${discount}% discount`);
    return res.json(existing);
  }
});

module.exports = router;
