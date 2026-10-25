const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { logAudit } = require('../services/audit');
const { getDefaultProductUnitPrice } = require('../services/productMeta');
const { optimizeBase64Image } = require('../services/imageOptimizer');
const { runtimeSettlements, fsmSettlementHub } = require('../services/settlementService');
const { fsmGeneralLimiter, fsmOperationsLimiter, salesmanGeneralLimiter } = require('../services/rateLimiter');

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

  // Cross-check with explicit stocks table if present
  try {
    const { data: smStock } = await supabase.from('stocks').select('quantity').eq('owner_id', salesman_id).maybeSingle();
    if (smStock && smStock.quantity !== undefined) {
      const explicitQty = Number(smStock.quantity) || 0;
      if (explicitQty === 0 && latestSettled) {
        activeStock = 0;
      } else if (explicitQty > 0) {
        activeStock = explicitQty;
      }
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

  const dynamicUnitPrice = await getDefaultProductUnitPrice();
  const todayDispatch = {
    date_label: 'Today',
    assigned_by: 'Field Sales Manager',
    bottles_dispatched: activeStock,
    unit_price: dynamicUnitPrice,
    total_value: activeStock * dynamicUnitPrice,
    bottles_sold_today: finalUnsettledSold,
    cash_collected_today: finalUnsettledCash,
    online_collected_today: finalUnsettledOnline,
    total_revenue_today: finalUnsettledCash + finalUnsettledOnline,
    status: 'pending',
    verified: activeStock > 0
  };

  return res.json({
    today: todayDispatch,
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

module.exports = router;
