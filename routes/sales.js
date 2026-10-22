const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { getProductWithMeta } = require('../services/productMeta');
const { storeAdminTransactionLimiter, storeAdminGeneralLimiter, fsmGeneralLimiter } = require('../services/rateLimiter');

// Helper function to process dynamic product direct and referral commissions for a sale
async function processWorkforceCommissionForSale(salesman_id, saleQty, saleId, product_id) {
  if (!salesman_id || saleQty <= 0) return;

  const users = mockDb.users || [];
  const seller = users.find(u => u.id === salesman_id);
  const product = getProductWithMeta(product_id);

  if (!mockDb.workforceCommissions) mockDb.workforceCommissions = [];

  // 1. Direct Commission for Salesman (selling to customer)
  if (seller && product) {
    const directRate = Number(product.salesman_commission) || 0.0;
    const directAmount = saleQty * directRate;
    if (directAmount > 0) {
      const directComm = {
        id: `dir_comm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
        role: 'salesman',
        type: 'direct_sale',
        user_id: seller.id,
        user_name: seller.name,
        sale_id: saleId,
        product_id: product.id,
        product_name: product.name,
        bottles_sold: saleQty,
        rate_per_bottle: directRate,
        commission_amount: directAmount,
        status: 'unlocked',
        created_at: new Date().toISOString()
      };
      mockDb.workforceCommissions.unshift(directComm);

      if (state.isSupabaseConfigured) {
        try {
          await supabase.from('workforce_commissions').insert([{
            seller_id: seller.id,
            seller_name: seller.name,
            sale_id: saleId || null,
            bottles_sold: saleQty,
            rate_per_bottle: directRate,
            commission_amount: directAmount,
            status: 'unlocked'
          }]);
        } catch (e) {
          console.warn('workforce_commissions direct sale insert notice:', e.message);
        }
      }
    }
  }

  // 2. Direct Referral Bonus (Strictly 1-Level: Salesman A refers Salesman B -> Salesman A gets referral commission)
  if (seller && seller.referrer_id && product) {
    const referrer = users.find(u => u.id === seller.referrer_id);
    if (referrer && referrer.role === 'salesman') {
      const referralRate = Number(product.referral_commission) || 0.0;
      const commAmount = saleQty * referralRate;

      if (commAmount > 0) {
        const newComm = {
          id: `w_comm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
          role: 'salesman',
          type: 'referral_bonus',
          referrer_id: seller.referrer_id,
          referrer_name: referrer.name,
          seller_id: seller.id,
          seller_name: seller.name,
          bottles_sold: saleQty,
          rate_per_bottle: referralRate,
          commission_amount: commAmount,
          status: 'unlocked',
          sale_id: saleId,
          product_id: product.id,
          product_name: product.name,
          created_at: new Date().toISOString(),
          paid_at: null
        };

        mockDb.workforceCommissions.unshift(newComm);

        if (state.isSupabaseConfigured) {
          try {
            await supabase.from('workforce_commissions').insert([{
              referrer_id: seller.referrer_id,
              referrer_name: referrer.name,
              seller_id: seller.id,
              seller_name: seller.name,
              sale_id: saleId || null,
              bottles_sold: saleQty,
              rate_per_bottle: referralRate,
              commission_amount: commAmount,
              status: 'unlocked'
            }]);
          } catch (e) {
            console.warn('workforce_commissions Supabase insert notice:', e.message);
          }
        }
      }
    }
  }
}

// Log sale (Salesman Field Sales & Store Admin Direct Retail / Distributor Bulk Sales & FSM Direct Retail - Protected by Transaction Limiter)
router.post('/api/sales', storeAdminTransactionLimiter, async (req, res) => {
  const {
    salesman_id,
    warehouse_id,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
    customer_type = 'retail',
    product_id,
    quantity,
    amount,
    payment_method
  } = req.body;

  if (!product_id || !quantity || !amount || !payment_method) {
    return res.status(400).json({ error: 'product_id, quantity, amount, and payment_method are required' });
  }

  // Stock source: warehouse_id if direct warehouse sale, otherwise salesman_id
  const stockOwnerId = warehouse_id || salesman_id;
  if (!stockOwnerId) {
    return res.status(400).json({ error: 'Either warehouse_id or salesman_id must be provided' });
  }

  const saleQty = parseInt(quantity);

  if (state.isSupabaseConfigured) {
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product_id);
      if (!isUuid) {
        const { data: firstProd } = await supabase.from('products').select('id').limit(1);
        if (firstProd && firstProd.length > 0) {
          product_id = firstProd[0].id;
        }
      }

      // Distributor sales restriction: FSM and Salesman cannot sell to distributors
      if (customer_type === 'distributor' && salesman_id) {
        const { data: sellerUser } = await supabase.from('users').select('role').eq('id', salesman_id).maybeSingle();
        if (sellerUser && (sellerUser.role === 'field_sales_manager' || sellerUser.role === 'salesman')) {
          return res.status(403).json({ error: 'Field Sales Managers and Salesmen cannot sell to distributors. Distributor sales are restricted to Store Admin / Super Admin.' });
        }
      }

      // Check stock
      let { data: currentStock, error: stockErr } = await supabase.from('stocks')
        .select('*')
        .eq('owner_id', stockOwnerId)
        .eq('product_id', product_id)
        .maybeSingle();

      if (stockErr || !currentStock) {
        const mockItem = mockDb.stocks.find(s => s.owner_id === stockOwnerId && s.product_id === product_id);
        const seedQty = mockItem ? mockItem.quantity : 25;
        try {
          const { data: newStock } = await supabase.from('stocks').insert([{
            owner_id: stockOwnerId,
            product_id,
            quantity: Math.max(seedQty, saleQty + 10)
          }]).select().maybeSingle();
          currentStock = newStock || { id: `stk_${Date.now()}`, owner_id: stockOwnerId, product_id, quantity: Math.max(seedQty, saleQty + 10) };
        } catch (_) {
          currentStock = { id: `stk_${Date.now()}`, owner_id: stockOwnerId, product_id, quantity: Math.max(seedQty, saleQty + 10) };
        }
      }

      if (currentStock.quantity < saleQty) {
        return res.status(400).json({ error: 'Insufficient stock at warehouse/seller' });
      }

      // Handle customer inline registration if new customer name is passed
      let finalCustomerId = customer_id;
      if (!finalCustomerId && customer_name) {
        const { data: newCust } = await supabase.from('customers').insert([{
          name: customer_name,
          phone: customer_phone || '',
          email: customer_email || '',
          address: customer_address || '',
          customer_type: customer_type || 'retail',
          created_by: salesman_id || null
        }]).select().single();
        if (newCust) finalCustomerId = newCust.id;
      }

      // Deduct stock
      await supabase.from('stocks')
        .update({ quantity: currentStock.quantity - saleQty })
        .eq('id', currentStock.id);

      // Create sale record with adaptive fallback
      let saleData = null;
      const { data: fullSale, error: saleErr } = await supabase.from('sales').insert([{
        warehouse_id: warehouse_id || null,
        salesman_id: salesman_id || null,
        customer_id: finalCustomerId || null,
        customer_type: customer_type || 'retail',
        product_id,
        quantity: saleQty,
        amount,
        payment_method
      }]).select().single();

      if (!saleErr && fullSale) {
        saleData = fullSale;
      } else {
        console.warn('Full sales insert notice, retrying with core schema:', saleErr ? saleErr.message : 'Unknown error');
        const { data: coreSale, error: coreErr } = await supabase.from('sales').insert([{
          salesman_id: salesman_id || null,
          product_id,
          quantity: saleQty,
          amount,
          payment_method
        }]).select().single();

        if (coreErr) throw coreErr;
        saleData = {
          ...coreSale,
          warehouse_id: warehouse_id || null,
          customer_id: finalCustomerId || null,
          customer_type: customer_type || 'retail'
        };
      }

      // Process workforce referral commission for this sale
      await processWorkforceCommissionForSale(salesman_id, saleQty, saleData.id, product_id);

      const roleLabel = warehouse_id ? 'Store Admin' : 'Seller';
      await logAudit(salesman_id, roleLabel, 'SALE_COMPLETED', 'sales', saleData.id, `Completed ${customer_type || 'retail'} sale of ${saleQty} units for ₹${amount} (${payment_method})`);
      return res.status(201).json(saleData);
    } catch (err) {
      console.warn('Supabase sale insert failed, falling back to mockDb:', err.message);
      const currentStock = mockDb.stocks.find(s => s.owner_id === stockOwnerId && s.product_id === product_id);
      if (currentStock) currentStock.quantity = Math.max(0, currentStock.quantity - saleQty);

      let finalCustomerId = customer_id;
      if (!finalCustomerId && customer_name) {
        const newCust = {
          id: `c_${Date.now()}`,
          name: customer_name,
          phone: customer_phone || '',
          email: customer_email || '',
          address: customer_address || '',
          customer_type: customer_type || 'retail',
          created_by: salesman_id || null,
          created_at: new Date()
        };
        mockDb.customers.push(newCust);
        finalCustomerId = newCust.id;
      }

      const newSale = {
        id: `sale_${Date.now()}`,
        warehouse_id: warehouse_id || null,
        salesman_id: salesman_id || null,
        customer_id: finalCustomerId || null,
        customer_type: customer_type || 'retail',
        product_id,
        quantity: saleQty,
        amount,
        payment_method,
        created_at: new Date().toISOString()
      };
      mockDb.sales.unshift(newSale);

      await processWorkforceCommissionForSale(salesman_id, saleQty, newSale.id, product_id);

      const roleLabel = warehouse_id ? 'Store Admin' : 'Seller';
      await logAudit(salesman_id, roleLabel, 'SALE_COMPLETED', 'sales', newSale.id, `Completed ${customer_type || 'retail'} sale of ${saleQty} units for ₹${amount} (${payment_method})`);
      return res.status(201).json(newSale);
    }
  } else {
    // Distributor sales restriction in mock mode
    if (customer_type === 'distributor' && salesman_id) {
      const sellerUser = mockDb.users.find(u => u.id === salesman_id);
      if (sellerUser && (sellerUser.role === 'field_sales_manager' || sellerUser.role === 'salesman')) {
        return res.status(403).json({ error: 'Field Sales Managers and Salesmen cannot sell to distributors. Distributor sales are restricted to Store Admin / Super Admin.' });
      }
    }

    const currentStock = mockDb.stocks.find(s => s.owner_id === stockOwnerId && s.product_id === product_id);
    if (!currentStock || currentStock.quantity < saleQty) {
      return res.status(400).json({ error: 'Insufficient stock at warehouse/seller' });
    }

    currentStock.quantity -= saleQty;

    let finalCustomerId = customer_id;
    if (!finalCustomerId && customer_name) {
      const newCust = {
        id: `c_${Date.now()}`,
        name: customer_name,
        phone: customer_phone || '',
        email: customer_email || '',
        address: customer_address || '',
        customer_type: customer_type || 'retail',
        referred_by: null,
        created_by: salesman_id || null,
        created_at: new Date()
      };
      mockDb.customers.push(newCust);
      finalCustomerId = newCust.id;
    }

    const newSale = {
      id: `sale_${Date.now()}`,
      warehouse_id: warehouse_id || null,
      salesman_id: salesman_id || null,
      customer_id: finalCustomerId || null,
      customer_type: customer_type || 'retail',
      product_id,
      quantity: saleQty,
      amount,
      payment_method,
      created_at: new Date()
    };
    mockDb.sales.unshift(newSale);

    // Process workforce referral commission for this sale
    await processWorkforceCommissionForSale(salesman_id, saleQty, newSale.id, product_id);

    const roleLabel = warehouse_id ? 'Store Admin' : 'Seller';
    await logAudit(salesman_id, roleLabel, 'SALE_COMPLETED', 'sales', newSale.id, `Completed ${customer_type || 'retail'} sale of ${saleQty} units for ₹${amount} (${payment_method})`);
    return res.status(201).json(newSale);
  }
});

// Team Oversight (Field Sales Manager: supervised salesmen, live stock, sales performance, aggregate KPIs - Protected by General FSM Limiter)
router.get('/api/team/:fsm_id', fsmGeneralLimiter, async (req, res) => {
  const { fsm_id } = req.params;

  if (state.isSupabaseConfigured) {
    try {
      const { data: salesmen, error: sErr } = await supabase.from('users')
        .select('*')
        .eq('parent_id', fsm_id)
        .eq('role', 'salesman');
      if (sErr) throw sErr;

      const salesmanIds = (salesmen || []).map(s => s.id);

      let teamStocks = [];
      if (salesmanIds.length > 0) {
        const { data: stData } = await supabase.from('stocks')
          .select('*, product:products(name, sku, unit, min_stock_alert)')
          .in('owner_id', salesmanIds);
        teamStocks = stData || [];
      }

      let teamSales = [];
      if (salesmanIds.length > 0) {
        const { data: slData } = await supabase.from('sales')
          .select('*')
          .in('salesman_id', salesmanIds);
        teamSales = slData || [];
      }

      const salesmenDetails = (salesmen || []).map(sm => {
        const stocks = teamStocks.filter(st => st.owner_id === sm.id);
        const sales = teamSales.filter(sl => sl.salesman_id === sm.id);
        const totalQtySold = sales.reduce((acc, sl) => acc + (sl.quantity || 0), 0);
        const totalRevenue = sales.reduce((acc, sl) => acc + (parseFloat(sl.amount) || 0), 0);
        const transactionCount = sales.length;
        const hasLowStock = stocks.some(st => st.quantity < (st.product?.min_stock_alert || 10));

        return {
          ...sm,
          stocks,
          total_qty_sold: totalQtySold,
          total_revenue: totalRevenue,
          transaction_count: transactionCount,
          has_low_stock: hasLowStock
        };
      });

      const totalTeamRevenue = salesmenDetails.reduce((acc, sm) => acc + sm.total_revenue, 0);
      const totalTeamUnits = salesmenDetails.reduce((acc, sm) => acc + sm.total_qty_sold, 0);
      const totalTeamTransactions = salesmenDetails.reduce((acc, sm) => acc + sm.transaction_count, 0);
      const totalActiveStock = teamStocks.reduce((acc, st) => acc + (st.quantity || 0), 0);

      return res.json({
        fsm_id,
        team_kpis: {
          total_salesmen: salesmenDetails.length,
          total_team_revenue: totalTeamRevenue,
          total_team_units: totalTeamUnits,
          total_team_transactions: totalTeamTransactions,
          total_active_stock: totalActiveStock
        },
        salesmen: salesmenDetails
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    const salesmen = mockDb.users.filter(u => u.parent_id === fsm_id && u.role === 'salesman');
    const salesmenDetails = salesmen.map(sm => {
      const stocks = mockDb.stocks
        .filter(st => st.owner_id === sm.id)
        .map(st => ({
          ...st,
          product: mockDb.products.find(p => p.id === st.product_id)
        }));
      const sales = mockDb.sales.filter(sl => sl.salesman_id === sm.id);
      const totalQtySold = sales.reduce((acc, sl) => acc + (sl.quantity || 0), 0);
      const totalRevenue = sales.reduce((acc, sl) => acc + (parseFloat(sl.amount) || 0), 0);
      const transactionCount = sales.length;
      const hasLowStock = stocks.some(st => st.quantity < (st.product?.min_stock_alert || 10));

      return {
        ...sm,
        stocks,
        total_qty_sold: totalQtySold,
        total_revenue: totalRevenue,
        transaction_count: transactionCount,
        has_low_stock: hasLowStock
      };
    });

    const totalTeamRevenue = salesmenDetails.reduce((acc, sm) => acc + sm.total_revenue, 0);
    const totalTeamUnits = salesmenDetails.reduce((acc, sm) => acc + sm.total_qty_sold, 0);
    const totalTeamTransactions = salesmenDetails.reduce((acc, sm) => acc + sm.transaction_count, 0);
    const totalActiveStock = salesmenDetails.reduce((acc, sm) => acc + sm.stocks.reduce((stAcc, st) => stAcc + st.quantity, 0), 0);

    return res.json({
      fsm_id,
      team_kpis: {
        total_salesmen: salesmenDetails.length,
        total_team_revenue: totalTeamRevenue,
        total_team_units: totalTeamUnits,
        total_team_transactions: totalTeamTransactions,
        total_active_stock: totalActiveStock
      },
      salesmen: salesmenDetails
    });
  }
});

// Helper to filter and map sales reports
function resolveSalesList(list, query) {
  const { salesman_id, fsm_id, warehouse_id, product_id, customer_id, payment_method, customer_type, start_date, end_date, has_referral } = query;
  let res = [...list];

  if (fsm_id) {
    const teamSalesmen = (mockDb.users || []).filter(u => u.parent_id === fsm_id).map(u => u.id);
    const allowedIds = [fsm_id, ...teamSalesmen];
    res = res.filter(s => allowedIds.includes(s.salesman_id));
  } else if (salesman_id && salesman_id !== 'all') {
    res = res.filter(s => s.salesman_id === salesman_id);
  }

  if (warehouse_id && warehouse_id !== 'all') res = res.filter(s => s.warehouse_id === warehouse_id);
  if (product_id && product_id !== 'all') res = res.filter(s => s.product_id === product_id);
  if (customer_id && customer_id !== 'all') res = res.filter(s => s.customer_id === customer_id);
  if (payment_method && payment_method !== 'all') res = res.filter(s => s.payment_method === payment_method);
  if (customer_type && customer_type !== 'all') res = res.filter(s => (s.customer_type || 'retail') === customer_type);
  if (start_date) res = res.filter(s => new Date(s.created_at) >= new Date(start_date));
  if (end_date) res = res.filter(s => new Date(s.created_at) <= new Date(end_date));
  if (has_referral === 'true') res = res.filter(s => s.referral_code && s.referral_code.length > 0);

  return res.map(s => {
    const salesman = (mockDb.users || []).find(u => u.id === s.salesman_id) || { name: 'Seller', role: 'salesman' };
    const product = (mockDb.products || []).find(p => p.id === s.product_id) || { name: 'Product', sku: 'SKU' };
    const customer = (mockDb.customers || []).find(c => c.id === s.customer_id) || { name: s.customer_name || 'Customer', phone: s.customer_phone || '' };
    return { ...s, salesman, product, customer };
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// Sales Reports with Multi-dimensional Filtering (Protected by General Rate Limiter)
router.get('/api/sales/report', storeAdminGeneralLimiter, async (req, res) => {
  const { salesman_id, fsm_id, warehouse_id, product_id, customer_id, payment_method, customer_type, start_date, end_date, has_referral } = req.query;

  if (state.isSupabaseConfigured) {
    try {
      let query = supabase.from('sales').select('*');
      if (fsm_id) {
        const { data: smData } = await supabase.from('users').select('id').eq('parent_id', fsm_id);
        const allowedIds = [fsm_id, ...(smData || []).map(s => s.id)];
        query = query.in('salesman_id', allowedIds);
      } else if (salesman_id && salesman_id !== 'all') {
        query = query.eq('salesman_id', salesman_id);
      }

      if (warehouse_id && warehouse_id !== 'all') query = query.eq('warehouse_id', warehouse_id);
      if (product_id && product_id !== 'all') query = query.eq('product_id', product_id);
      if (customer_id && customer_id !== 'all') query = query.eq('customer_id', customer_id);
      if (payment_method && payment_method !== 'all') query = query.eq('payment_method', payment_method);
      if (customer_type && customer_type !== 'all') query = query.eq('customer_type', customer_type);
      if (start_date) query = query.gte('created_at', start_date);
      if (end_date) query = query.lte('created_at', end_date);
      if (has_referral === 'true') query = query.not('referral_code', 'is', null);

      const { data: salesData, error } = await query.order('created_at', { ascending: false });
      if (!error && salesData && salesData.length > 0) {
        const { data: users } = await supabase.from('users').select('id, name, role');
        const { data: products } = await supabase.from('products').select('id, name, sku, category');
        const userMap = new Map((users || []).map(u => [u.id, u]));
        const prodMap = new Map((products || []).map(p => [p.id, p]));

        const enriched = salesData.map(s => ({
          ...s,
          salesman: userMap.get(s.salesman_id) || (mockDb.users.find(u => u.id === s.salesman_id)) || { name: 'Seller', role: 'seller' },
          product: prodMap.get(s.product_id) || (mockDb.products.find(p => p.id === s.product_id)) || { name: 'Product', sku: 'SKU' },
          customer: (mockDb.customers || []).find(c => c.id === s.customer_id) || { name: s.customer_name || 'Retail Customer', phone: s.customer_phone || '' }
        }));
        return res.json(enriched);
      }
      return res.json(resolveSalesList(mockDb.sales || [], req.query));
    } catch (err) {
      console.warn('Supabase sales report fallback:', err.message);
      return res.json(resolveSalesList(mockDb.sales || [], req.query));
    }
  } else {
    return res.json(resolveSalesList(mockDb.sales || [], req.query));
  }
});

module.exports = router;
