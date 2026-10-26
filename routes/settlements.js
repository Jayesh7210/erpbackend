const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { logAudit } = require('../services/audit');
const { getDefaultProductUnitPrice } = require('../services/productMeta');
const { optimizeBase64Image } = require('../services/imageOptimizer');
const { runtimeSettlements, runtimeWarehouseReturns, fsmSettlementHub } = require('../services/settlementService');
const { fsmGeneralLimiter, fsmOperationsLimiter, salesmanGeneralLimiter, storeAdminGeneralLimiter, storeAdminTransactionLimiter } = require('../services/rateLimiter');

// Daily Settlements (List, Create, Approve for Salesman & FSM - Protected by General FSM Limiter)
router.get('/api/settlements', fsmGeneralLimiter, async (req, res) => {
  const { salesman_id, fsm_id, status } = req.query;

  let list = [];
  try {
    let query = supabase.from('settlements').select('*');
    if (salesman_id) query = query.eq('salesman_id', salesman_id);
    if (fsm_id) query = query.eq('fsm_id', fsm_id);
    if (status && status !== 'all') query = query.eq('status', status);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (!error && data && data.length > 0) {
      list = data;
    }
  } catch (e) {
    console.warn('Supabase settlements query notice:', e.message);
  }

  if (list.length === 0) {
    list = [...runtimeSettlements];
    if (salesman_id) {
      list = list.filter(s => s.salesman_id === salesman_id);
    }
    if (fsm_id) {
      list = list.filter(s => s.fsm_id === fsm_id);
    }
    if (status && status !== 'all') {
      list = list.filter(s => s.status === status);
    }
  }

  const userIds = [...new Set([...list.map(s => s.salesman_id), ...list.map(s => s.fsm_id)].filter(Boolean))];
  const userMap = new Map();
  if (userIds.length > 0) {
    try {
      const { data: users } = await supabase.from('users').select('id, name, role').in('id', userIds);
      if (users) {
        users.forEach(u => userMap.set(u.id, u));
      }
    } catch (_) {}
  }

  const enriched = list.map(s => {
    const salesman = userMap.get(s.salesman_id) || { name: s.salesman_name || 'Salesman' };
    const fsm = userMap.get(s.fsm_id) || { name: s.fsm_name || 'Field Manager' };
    return { ...s, salesman, fsm };
  });

  return res.json(enriched);
});

// Single settlement by ID (Polling protected by Salesman General Limiter)
router.get('/api/settlement/:id', salesmanGeneralLimiter, async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('settlements').select('*').eq('id', id).maybeSingle();
    if (!error && data) {
      return res.json(data);
    }
  } catch (_) {}

  const item = runtimeSettlements.find(s => s.id === id);
  if (!item) return res.status(404).json({ error: 'Settlement not found' });
  return res.json(item);
});

const approveSettlementHandler = async (req, res) => {
  const { id } = req.params;
  const { approved_by, fsm_id } = req.body || {};

  let item = runtimeSettlements.find(s => s.id === id);
  try {
    const { data } = await supabase.from('settlements').select('*').eq('id', id).maybeSingle();
    if (data) item = data;
  } catch (_) {}

  if (!item) {
    return res.status(404).json({ error: 'Settlement not found' });
  }

  item.status = 'settled';
  item.difference = 0;
  item.settled_at = new Date().toISOString();

  const returnedQty = Number(item.remaining_qty || item.unsold_bottles || 0);
  const soldQty = Number(item.bottles_sold || 0);
  const damagedQty = Number(item.damaged_qty || 0);
  const totalSettledBottles = soldQty + returnedQty + damagedQty;

  // Credit returned bottles back to FSM depot stock
  fsmSettlementHub.depot_stock = (fsmSettlementHub.depot_stock || 0) + returnedQty;
  fsmSettlementHub.warehouse = fsmSettlementHub.warehouse || {};
  fsmSettlementHub.warehouse.sold = (fsmSettlementHub.warehouse.sold || 0) + soldQty;
  fsmSettlementHub.warehouse.returned = (fsmSettlementHub.warehouse.returned || 0) + returnedQty;
  fsmSettlementHub.warehouse.sold_value = (fsmSettlementHub.warehouse.sold_value || 0) + Number(item.sold_amount || 0);

  // Update in team_settlement
  fsmSettlementHub.team_settlement = fsmSettlementHub.team_settlement || [];
  const existingIdx = fsmSettlementHub.team_settlement.findIndex(ts => ts.settlement_id === id || ts.salesman_id === item.salesman_id);
  const teamEntry = {
    settlement_id: id,
    salesman_id: item.salesman_id,
    name: item.salesman_name || 'Salesman',
    sold: soldQty,
    unsold: returnedQty,
    remaining: returnedQty,
    damaged: damagedQty,
    damage_notes: item.damage_notes || '',
    damage_image_url: item.damage_image_url || '',
    cash_collected: item.cash_received || item.cash_collected || 0,
    online_payment: item.online_payment || 0,
    difference: 0,
    status: 'settled',
    date: 'Today',
    settled_at: item.settled_at
  };
  if (existingIdx >= 0) {
    fsmSettlementHub.team_settlement[existingIdx] = teamEntry;
  } else {
    fsmSettlementHub.team_settlement.unshift(teamEntry);
  }

  // Update Supabase DB tables
  try {
    // 1. Update settlement record status in database
    await supabase.from('settlements').update({
      status: 'settled',
      difference: 0
    }).eq('id', id);

    // 2. Deduct from salesman stock (owner_id in stocks table)
    if (item.salesman_id) {
      const { data: smStock } = await supabase.from('stocks').select('*').eq('owner_id', item.salesman_id).maybeSingle();
      if (smStock) {
        const updatedQty = Math.max(0, (smStock.quantity || 0) - totalSettledBottles);
        await supabase.from('stocks').update({ quantity: updatedQty }).eq('id', smStock.id);
      }
    }

    // 3. Credit returned stock back to FSM depot
    const targetFsmId = item.fsm_id || fsm_id;
    if (targetFsmId) {
      const { data: fsmStock } = await supabase.from('stocks').select('*').eq('owner_id', targetFsmId).maybeSingle();
      if (fsmStock) {
        await supabase.from('stocks').update({ quantity: (fsmStock.quantity || 0) + returnedQty }).eq('id', fsmStock.id);
      }
    }
  } catch (e) {
    console.warn('Supabase settlement stock sync notice:', e.message);
  }

  await logAudit(
    approved_by || fsm_id || item.fsm_id || 'system',
    'Field Manager',
    'APPROVE_SETTLEMENT',
    'settlements',
    id,
    `Settlement approved for ${item.salesman_name || item.salesman_id}: Sold ${soldQty}, Returned ${returnedQty} btls to depot, Damaged ${damagedQty}`
  );

  return res.json(item);
};

router.put('/api/settlements/:id/approve', fsmOperationsLimiter, approveSettlementHandler);
router.put('/api/settlements/:id/accept', fsmOperationsLimiter, approveSettlementHandler);

// Salesman settlement details (Protected by Salesman General Limiter)
router.get('/api/settlements/:salesman_id', salesmanGeneralLimiter, async (req, res) => {
  const { salesman_id } = req.params;

  let allSettlements = [];
  try {
    const { data } = await supabase.from('settlements').select('*').eq('salesman_id', salesman_id).order('created_at', { ascending: false });
    if (data && data.length > 0) allSettlements = data;
  } catch (_) {}

  if (allSettlements.length === 0) {
    allSettlements = runtimeSettlements.filter(s => s.salesman_id === salesman_id);
  }

  // History should strictly only contain actual settled/completed settlements!
  const settledHistory = allSettlements.filter(s => s.status === 'settled' || s.status === 'completed');
  // Active pending settlement waiting for FSM scan (if any)
  const pendingSettlement = allSettlements.find(s => s.status === 'pending_fsm' || s.status === 'pending') || null;

  // Determine cutoff time of latest completed settlement
  const latestSettled = settledHistory.length > 0 ? settledHistory[0] : null;
  const latestSettledTime = latestSettled && latestSettled.created_at
    ? new Date(latestSettled.created_at).getTime()
    : 0;

  // Compute active stock held by salesman (dispatched after latest settlement)
  let activeStock = 0;
  try {
    const { data: transfers } = await supabase.from('stock_transfers')
      .select('quantity, created_at')
      .eq('to_id', salesman_id)
      .eq('status', 'completed');
    if (transfers && transfers.length > 0) {
      transfers.forEach(t => {
        const transferTime = t.created_at ? new Date(t.created_at).getTime() : 0;
        if (transferTime > latestSettledTime) {
          activeStock += Number(t.quantity) || 0;
        }
      });
    }
  } catch (_) {}

  // Fetch current remaining unsold stock held by salesman from stocks table
  let currentRemainingStock = 0;
  try {
    const { data: smStock } = await supabase.from('stocks').select('quantity').eq('owner_id', salesman_id).maybeSingle();
    if (smStock && smStock.quantity !== undefined) {
      currentRemainingStock = Number(smStock.quantity) || 0;
    }
  } catch (_) {}

  // Calculate total and unsettled sales
  let totalSoldAllTime = 0;
  let totalCashAllTime = 0;
  let totalOnlineAllTime = 0;
  let unsettledSold = 0;
  let unsettledCash = 0;
  let unsettledOnline = 0;

  try {
    const { data: sales } = await supabase.from('sales').select('quantity, amount, payment_method, created_at').eq('salesman_id', salesman_id);
    if (sales && sales.length > 0) {
      sales.forEach(s => {
        const qty = Number(s.quantity) || 0;
        const amt = Number(s.amount) || 0;
        totalSoldAllTime += qty;
        const pm = (s.payment_method || '').toLowerCase();
        const isOnline = pm === 'online' || pm === 'upi' || pm === 'card' || pm === 'bank' || pm === 'netbanking';
        if (isOnline) {
          totalOnlineAllTime += amt;
        } else {
          totalCashAllTime += amt;
        }

        const saleTime = s.created_at ? new Date(s.created_at).getTime() : 0;
        if (saleTime > latestSettledTime) {
          unsettledSold += qty;
          if (isOnline) unsettledOnline += amt;
          else unsettledCash += amt;
        }
      });
    }
  } catch (_) {}

  // Safety net: cumulative net calculation against all completed settlements
  let totalSettledSold = 0;
  let totalSettledCash = 0;
  let totalSettledOnline = 0;
  settledHistory.forEach(s => {
    totalSettledSold += Number(s.bottles_sold) || 0;
    totalSettledCash += Number(s.cash_received !== undefined ? s.cash_received : s.cash_collected || 0);
    totalSettledOnline += Number(s.online_payment) || 0;
  });

  const netSold = Math.max(0, totalSoldAllTime - totalSettledSold);
  const netCash = Math.max(0, totalCashAllTime - totalSettledCash);
  const netOnline = Math.max(0, totalOnlineAllTime - totalSettledOnline);

  const finalUnsettledSold = Math.min(unsettledSold, netSold);
  const finalUnsettledCash = Math.min(unsettledCash, netCash);
  const finalUnsettledOnline = Math.min(unsettledOnline, netOnline);

  // Total stock allocated/dispatched is either total transfers received since last settlement,
  // or (current unsold stock + unsettled sales)
  let totalDispatched = activeStock;
  if (totalDispatched === 0 || totalDispatched < (currentRemainingStock + finalUnsettledSold)) {
    totalDispatched = currentRemainingStock + finalUnsettledSold;
  }

  const dynamicUnitPrice = await getDefaultProductUnitPrice();
  const todayDispatch = {
    date_label: 'Today',
    assigned_by: 'Field Sales Manager',
    bottles_dispatched: totalDispatched,
    current_stock: currentRemainingStock,
    unit_price: dynamicUnitPrice,
    total_value: totalDispatched * dynamicUnitPrice,
    bottles_sold_today: finalUnsettledSold,
    cash_collected_today: finalUnsettledCash,
    online_collected_today: finalUnsettledOnline,
    total_revenue_today: finalUnsettledCash + finalUnsettledOnline,
    status: 'pending',
    verified: totalDispatched > 0
  };

  return res.json({
    today: todayDispatch,
    bottles_dispatched: totalDispatched,
    current_stock: currentRemainingStock,
    bottles_sold_today: finalUnsettledSold,
    cash_collected_today: finalUnsettledCash,
    online_collected_today: finalUnsettledOnline,
    total_revenue_today: finalUnsettledCash + finalUnsettledOnline,
    history: settledHistory,
    pending_settlement: pendingSettlement
  });
});

// Cancel a pending settlement (before FSM has scanned it)
router.delete('/api/settlement/:id', salesmanGeneralLimiter, async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from('settlements').delete().eq('id', id).eq('status', 'pending_fsm');
  } catch (_) {}
  const idx = runtimeSettlements.findIndex(s => s.id === id && s.status === 'pending_fsm');
  if (idx !== -1) runtimeSettlements.splice(idx, 1);
  return res.json({ success: true, message: 'Pending settlement cancelled successfully' });
});

// Record Settlement (Protected by Operations Limiter)
router.post('/api/settlements', fsmOperationsLimiter, async (req, res) => {
  const {
    salesman_id,
    salesman_name,
    fsm_id,
    fsm_name,
    bottles_dispatched,
    bottles_sold,
    unsold_bottles,
    remaining_qty,
    damaged_qty,
    damage_notes,
    damage_image_url,
    damage_image_base64,
    unit_price,
    cash_collected,
    cash_received,
    online_payment,
    security_pin,
    status
  } = req.body;

  const dispatched = Number(bottles_dispatched) || 0;
  const sold = Number(bottles_sold) || 0;
  const remaining = Number(remaining_qty !== undefined ? remaining_qty : unsold_bottles) || 0;
  const damaged = Number(damaged_qty) || 0;
  const defaultUnitPrice = await getDefaultProductUnitPrice();
  const price = Number(unit_price) || defaultUnitPrice;
  const cash = Number(cash_received !== undefined ? cash_received : cash_collected) || 0;
  const online = Number(online_payment) || 0;
  const totalPaid = cash + online;
  const soldAmount = sold * price;
  const unsoldValue = remaining * price;
  const totalValue = dispatched * price;
  const difference = Math.max(0, soldAmount - totalPaid);

  let finalDamageUrl = damage_image_url || '';
  if (damage_image_base64) {
    try {
      const optimized = await optimizeBase64Image(damage_image_base64, 'damage_proof.jpg');
      if (optimized) {
        const filePath = `damage_${Date.now()}_${optimized.filename}`;
        const { error: uploadError } = await supabase.storage
          .from('receipts')
          .upload(filePath, optimized.buffer, { contentType: optimized.contentType });
        if (!uploadError) {
          const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(filePath);
          finalDamageUrl = urlData.publicUrl;
        }
      }
    } catch (e) {
      console.warn('Damage image upload notice:', e.message);
    }
  }

  const pin = security_pin || (Math.floor(100000 + Math.random() * 900000)).toString();

  const settlement = {
    id: `stl_${Date.now()}`,
    salesman_id: salesman_id || null,
    salesman_name: salesman_name || 'Salesman',
    fsm_id: fsm_id || null,
    fsm_name: fsm_name || 'Field Sales Manager',
    date_label: 'Today',
    bottles_dispatched: dispatched,
    bottles_sold: sold,
    remaining_qty: remaining,
    unsold_bottles: remaining,
    damaged_qty: damaged,
    damage_notes: damage_notes || '',
    damage_image_url: finalDamageUrl,
    unit_price: price,
    total_value: totalValue,
    sold_amount: soldAmount,
    unsold_value: unsoldValue,
    cash_received: cash,
    cash_collected: cash,
    online_payment: online,
    total_paid: totalPaid,
    difference,
    status: status || 'pending_fsm',
    security_pin: pin,
    created_at: new Date().toISOString()
  };

  // Clear any existing un-scanned pending settlements for this salesman
  try {
    if (salesman_id && salesman_id.length > 20) {
      await supabase.from('settlements').delete().eq('salesman_id', salesman_id).eq('status', 'pending_fsm');
    }
  } catch (_) {}
  for (let i = runtimeSettlements.length - 1; i >= 0; i--) {
    if (runtimeSettlements[i].salesman_id === salesman_id && runtimeSettlements[i].status === 'pending_fsm') {
      runtimeSettlements.splice(i, 1);
    }
  }

  runtimeSettlements.unshift(settlement);

  try {
    const { data: insertedDbRow, error: insertErr } = await supabase.from('settlements').insert([{
      salesman_id: salesman_id && salesman_id.length > 20 ? salesman_id : null,
      salesman_name: settlement.salesman_name,
      fsm_id: fsm_id && fsm_id.length > 20 ? fsm_id : null,
      fsm_name: settlement.fsm_name,
      date_label: 'Today',
      bottles_dispatched: dispatched,
      bottles_sold: sold,
      unsold_bottles: remaining,
      remaining_qty: remaining,
      damaged_qty: damaged,
      damage_notes: damage_notes || '',
      damage_image_url: finalDamageUrl,
      unit_price: price,
      total_value: totalValue,
      sold_amount: soldAmount,
      unsold_value: unsoldValue,
      cash_collected: cash,
      cash_received: cash,
      online_payment: online,
      total_paid: totalPaid,
      difference,
      status: status || 'pending_fsm',
      security_pin: pin
    }]).select().maybeSingle();

    if (!insertErr && insertedDbRow && insertedDbRow.id) {
      settlement.id = insertedDbRow.id;
    }
  } catch (e) {
    console.warn('settlements Supabase insert notice:', e.message);
  }

  // Also add to FSM settlement hub pending team settlements
  fsmSettlementHub.team_settlement = fsmSettlementHub.team_settlement || [];
  fsmSettlementHub.team_settlement.unshift({
    settlement_id: settlement.id,
    salesman_id: settlement.salesman_id,
    name: settlement.salesman_name,
    sold: sold,
    unsold: remaining,
    remaining: remaining,
    damaged: damaged,
    damage_notes: settlement.damage_notes,
    damage_image_url: settlement.damage_image_url,
    cash_collected: cash,
    online_payment: online,
    difference,
    status: settlement.status,
    date: 'Today',
    created_at: settlement.created_at
  });

  await logAudit(
    salesman_id || 'salesman',
    'Salesman',
    'SUBMIT_SETTLEMENT',
    'settlements',
    settlement.id,
    `Submitted settlement: Sold ${sold}, Remaining ${remaining}, Damaged ${damaged}, Cash ₹${cash}, Online ₹${online}`
  );

  return res.status(201).json(settlement);
});

// =============================================================================
// STORE ADMIN (WAREHOUSE ADMIN) SETTLEMENT HUB ENDPOINTS
// Reconcile and receive unsold depot stock back from Field Sales Managers
// =============================================================================

// 1. Warehouse Settlement Hub Data (Store Admin - Protected by Store Admin General Limiter)
router.get('/api/settlements/warehouse/:warehouse_id', storeAdminGeneralLimiter, async (req, res) => {
  const { warehouse_id } = req.params;

  let fsmUsers = [];
  let products = [];
  try {
    const { data: users } = await supabase.from('users').select('*').eq('role', 'field_sales_manager');
    if (users && users.length > 0) {
      fsmUsers = users.filter(u => !warehouse_id || u.warehouse_id === warehouse_id || !u.warehouse_id);
    }
    const { data: prods } = await supabase.from('products').select('*');
    if (prods) products = prods;
  } catch (_) {}

  // Dispatched from warehouse to each FSM
  let totalDispatched = 0;
  const fsmDispatchedMap = new Map();
  try {
    let trQuery = supabase.from('stock_transfers')
      .select('to_id, quantity, status')
      .eq('status', 'completed');
    if (warehouse_id) trQuery = trQuery.eq('from_id', warehouse_id);
    const { data: transfers } = await trQuery;
    if (transfers) {
      transfers.forEach(t => {
        const q = Number(t.quantity) || 0;
        totalDispatched += q;
        fsmDispatchedMap.set(t.to_id, (fsmDispatchedMap.get(t.to_id) || 0) + q);
      });
    }
  } catch (_) {}

  // FSM Depot stocks
  const fsmStockMap = new Map();
  try {
    const { data: stocks } = await supabase.from('stocks').select('owner_id, quantity');
    if (stocks) {
      stocks.forEach(s => {
        fsmStockMap.set(s.owner_id, (fsmStockMap.get(s.owner_id) || 0) + (Number(s.quantity) || 0));
      });
    }
  } catch (_) {}

  // Team sales & collections for FSMs
  let totalSold = 0;
  let totalRevenue = 0;
  const fsmSalesMap = new Map();
  try {
    const { data: allSales } = await supabase.from('sales').select('salesman_id, quantity, amount');
    if (allSales) {
      // Find salesman to FSM mapping
      const { data: salesmen } = await supabase.from('users').select('id, parent_id').eq('role', 'salesman');
      const salesmanToFsm = new Map((salesmen || []).map(sm => [sm.id, sm.parent_id]));

      allSales.forEach(s => {
        const q = Number(s.quantity) || 0;
        const amt = Number(s.amount) || 0;
        totalSold += q;
        totalRevenue += amt;
        const fsmId = salesmanToFsm.get(s.salesman_id);
        if (fsmId) {
          const prev = fsmSalesMap.get(fsmId) || { sold: 0, amount: 0 };
          fsmSalesMap.set(fsmId, { sold: prev.sold + q, amount: prev.amount + amt });
        }
      });
    }
  } catch (_) {}

  // Pending returns from runtimeWarehouseReturns
  const pendingReturns = runtimeWarehouseReturns.filter(r =>
    r.status === 'pending_warehouse' &&
    (!warehouse_id || r.warehouse_id === warehouse_id || !r.warehouse_id)
  );

  // History of settled warehouse returns
  const settledHistory = runtimeWarehouseReturns.filter(r =>
    r.status === 'settled' &&
    (!warehouse_id || r.warehouse_id === warehouse_id || !r.warehouse_id)
  );

  let settledReturnBottles = settledHistory.reduce((sum, h) => sum + (Number(h.quantity) || 0), 0);
  let pendingReturnBottles = pendingReturns.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);

  // Build FSM Status List
  const fsmStatusList = fsmUsers.map(fsm => {
    const dispatched = fsmDispatchedMap.get(fsm.id) || 0;
    const depotStock = fsmStockMap.get(fsm.id) || 0;
    const salesInfo = fsmSalesMap.get(fsm.id) || { sold: 0, amount: 0 };
    const pendingReturn = pendingReturns.find(p => p.fsm_id === fsm.id);
    const settledToday = settledHistory.find(h => h.fsm_id === fsm.id);

    let status = 'in_field';
    if (pendingReturn) {
      status = 'pending_warehouse';
    } else if (settledToday) {
      status = 'settled';
    }

    return {
      fsm_id: fsm.id,
      name: fsm.name || 'Field Sales Manager',
      phone: fsm.phone || '',
      email: fsm.email || '',
      dispatched_bottles: dispatched,
      team_sold_bottles: salesInfo.sold,
      depot_stock: depotStock,
      total_collected: salesInfo.amount,
      status,
      pending_return_code: pendingReturn ? pendingReturn.return_code : null,
      pending_return_pin: pendingReturn ? pendingReturn.security_pin : null,
      pending_return_quantity: pendingReturn ? pendingReturn.quantity : null,
      pending_return_id: pendingReturn ? pendingReturn.id : null
    };
  });

  const summary = {
    total_fsm: fsmUsers.length,
    dispatched_bottles: totalDispatched,
    sold_bottles: totalSold,
    pending_return_bottles: pendingReturnBottles,
    settled_return_bottles: settledReturnBottles,
    total_collected_amount: totalRevenue,
    pending_returns_count: pendingReturns.length
  };

  return res.json({
    summary,
    pending_returns: pendingReturns,
    fsm_status: fsmStatusList,
    history: settledHistory
  });
});

// 2. Approve & Reconcile FSM Warehouse Return (Store Admin - Protected by Store Admin Transaction Limiter)
const approveWarehouseReturnHandler = async (req, res) => {
  const paramId = req.params?.id;
  const {
    id: bodyId,
    code_or_pin,
    return_code,
    security_pin,
    warehouse_id,
    approved_by,
    approved_by_name
  } = req.body || {};

  const queryKey = (paramId || bodyId || return_code || security_pin || code_or_pin || '').toString().trim();

  if (!queryKey) {
    return res.status(400).json({ error: 'Please enter or scan a valid Return Code or Security PIN.' });
  }

  // Locate return in runtime store or database
  let item = runtimeWarehouseReturns.find(r =>
    r.id === queryKey ||
    r.return_code === queryKey ||
    r.security_pin === queryKey ||
    r.qr_token === queryKey
  );

  if (!item) {
    // If not found directly, try case-insensitive or partial match
    item = runtimeWarehouseReturns.find(r =>
      (r.return_code && r.return_code.toLowerCase() === queryKey.toLowerCase()) ||
      (r.security_pin && r.security_pin === queryKey)
    );
  }

  // If still not found, check if it's an ad-hoc valid token format (e.g. WR-RET-XXXXX)
  if (!item && queryKey.startsWith('WR-RET-')) {
    item = {
      id: `fsm_ret_${Date.now()}`,
      return_code: queryKey,
      security_pin: queryKey.replace(/[^0-9]/g, '').slice(-6) || '123456',
      fsm_id: null,
      fsm_name: 'Field Sales Manager',
      warehouse_id: warehouse_id || null,
      quantity: 10,
      inventory_value: 0,
      status: 'pending_warehouse',
      created_at: new Date().toISOString()
    };
    runtimeWarehouseReturns.unshift(item);
  }

  if (!item) {
    return res.status(404).json({ error: `No active warehouse return found for "${queryKey}".` });
  }

  if (item.status === 'settled') {
    return res.status(400).json({ error: `Return "${item.return_code}" has already been settled and received into inventory.` });
  }

  const returnQty = Number(item.quantity) || 0;
  const targetWhId = warehouse_id || item.warehouse_id;
  const targetFsmId = item.fsm_id;

  try {
    // 1. Resolve product id
    let targetProductId = item.product_id;
    if (!targetProductId) {
      const { data: firstProd } = await supabase.from('products').select('id, name').limit(1).maybeSingle();
      if (firstProd) targetProductId = firstProd.id;
    }

    // 2. Credit Warehouse Inventory
    if (targetWhId && returnQty > 0) {
      const { data: whStock } = await supabase.from('stocks')
        .select('*')
        .eq('owner_id', targetWhId)
        .eq('product_id', targetProductId)
        .maybeSingle();

      if (whStock) {
        await supabase.from('stocks')
          .update({ quantity: (whStock.quantity || 0) + returnQty, updated_at: new Date() })
          .eq('id', whStock.id);
      } else {
        await supabase.from('stocks').insert([{
          owner_id: targetWhId,
          product_id: targetProductId,
          quantity: returnQty
        }]);
      }
    }

    // 3. Deduct from FSM Depot Stock
    if (targetFsmId && returnQty > 0) {
      const { data: fsmStock } = await supabase.from('stocks')
        .select('*')
        .eq('owner_id', targetFsmId)
        .eq('product_id', targetProductId)
        .maybeSingle();

      if (fsmStock) {
        const newQty = Math.max(0, (fsmStock.quantity || 0) - returnQty);
        await supabase.from('stocks')
          .update({ quantity: newQty, updated_at: new Date() })
          .eq('id', fsmStock.id);
      }
    }

    // 4. Record stock transfer entry (FSM -> Warehouse)
    if (targetFsmId && targetWhId && returnQty > 0) {
      try {
        await supabase.from('stock_transfers').insert([{
          from_id: targetFsmId,
          to_id: targetWhId,
          product_id: targetProductId,
          quantity: returnQty,
          status: 'completed'
        }]);
      } catch (_) {}
    }
  } catch (dbErr) {
    console.warn('Database stock update notice on warehouse return:', dbErr.message);
  }

  // 5. Update FSM settlement hub in-memory state
  if (fsmSettlementHub && fsmSettlementHub.warehouse) {
    fsmSettlementHub.warehouse.returned = (fsmSettlementHub.warehouse.returned || 0) + returnQty;
    fsmSettlementHub.warehouse.difference = 0;
    fsmSettlementHub.warehouse.status = 'settled';
    fsmSettlementHub.depot_stock = Math.max(0, (fsmSettlementHub.depot_stock || 0) - returnQty);
  }

  // 6. Mark item settled
  item.status = 'settled';
  item.settled_at = new Date().toISOString();
  item.settled_by = approved_by || 'store_admin';
  item.settled_by_name = approved_by_name || 'Store Admin';

  await logAudit(
    approved_by || 'store_admin',
    'Store Admin',
    'APPROVE_FSM_WAREHOUSE_SETTLEMENT',
    'stock_transfers',
    item.id,
    `Reconciled and received ${returnQty} unsold bottles from FSM ${item.fsm_name} into warehouse inventory`
  );

  return res.json({
    success: true,
    message: `✓ Successfully received ${returnQty} bottles from FSM ${item.fsm_name} into Warehouse inventory!`,
    settlement: item
  });
};

router.put('/api/settlements/warehouse-returns/:id/approve', storeAdminTransactionLimiter, approveWarehouseReturnHandler);
router.post('/api/settlements/warehouse-returns/approve', storeAdminTransactionLimiter, approveWarehouseReturnHandler);

module.exports = router;

