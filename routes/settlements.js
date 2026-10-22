const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { getDefaultProductUnitPrice } = require('../services/productMeta');
const { optimizeBase64Image } = require('../services/imageOptimizer');
const { fsmGeneralLimiter, fsmOperationsLimiter, salesmanGeneralLimiter } = require('../services/rateLimiter');

// Daily Settlements (List, Create, Approve for Salesman & FSM - Protected by General FSM Limiter)
router.get('/api/settlements', fsmGeneralLimiter, async (req, res) => {
  const { salesman_id, fsm_id, status } = req.query;

  let list = [];
  if (state.isSupabaseConfigured) {
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
  }

  if (list.length === 0) {
    list = [...(mockDb.settlements || [])];
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
  if (fsm_id) {
    list = list.filter(s => s.fsm_id === fsm_id);
  }
  if (status && status !== 'all') {
    list = list.filter(s => s.status === status);
  }

  const enriched = list.map(s => {
    const salesman = (mockDb.users || []).find(u => u.id === s.salesman_id) || { name: s.salesman_name || 'Salesman' };
    const fsm = (mockDb.users || []).find(u => u.id === s.fsm_id) || { name: s.fsm_name || 'Field Manager' };
    return { ...s, salesman, fsm };
  });

  return res.json(enriched);
});

// Single settlement by ID (Polling protected by Salesman General Limiter)
router.get('/api/settlement/:id', salesmanGeneralLimiter, async (req, res) => {
  const { id } = req.params;
  if (state.isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('settlements').select('*').eq('id', id).maybeSingle();
      if (!error && data) {
        return res.json(data);
      }
    } catch (_) {}
  }
  const item = (mockDb.settlements || []).find(s => s.id === id);
  if (!item) return res.status(404).json({ error: 'Settlement not found' });
  return res.json(item);
});

const approveSettlementHandler = async (req, res) => {
  const { id } = req.params;
  const { approved_by, fsm_id } = req.body || {};

  let item = (mockDb.settlements || []).find(s => s.id === id);
  if (!item && state.isSupabaseConfigured) {
    try {
      const { data } = await supabase.from('settlements').select('*').eq('id', id).maybeSingle();
      if (data) item = data;
    } catch (_) {}
  }

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
  if (mockDb.fsmSettlementHub) {
    mockDb.fsmSettlementHub.depot_stock = (mockDb.fsmSettlementHub.depot_stock || 0) + returnedQty;
    mockDb.fsmSettlementHub.warehouse = mockDb.fsmSettlementHub.warehouse || {};
    mockDb.fsmSettlementHub.warehouse.sold = (mockDb.fsmSettlementHub.warehouse.sold || 0) + soldQty;
    mockDb.fsmSettlementHub.warehouse.returned = (mockDb.fsmSettlementHub.warehouse.returned || 0) + returnedQty;
    mockDb.fsmSettlementHub.warehouse.sold_value = (mockDb.fsmSettlementHub.warehouse.sold_value || 0) + Number(item.sold_amount || 0);

    // Update in team_settlement
    mockDb.fsmSettlementHub.team_settlement = mockDb.fsmSettlementHub.team_settlement || [];
    const existingIdx = mockDb.fsmSettlementHub.team_settlement.findIndex(ts => ts.settlement_id === id || ts.salesman_id === item.salesman_id);
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
      mockDb.fsmSettlementHub.team_settlement[existingIdx] = teamEntry;
    } else {
      mockDb.fsmSettlementHub.team_settlement.unshift(teamEntry);
    }
  }

  // Deduct settled stock from Salesman's held inventory
  const smUser = (mockDb.users || []).find(u => u.id === item.salesman_id);
  if (smUser) {
    smUser.current_stock = Math.max(0, (smUser.current_stock || 0) - totalSettledBottles);
  }

  // If Supabase is connected, update DB tables
  if (state.isSupabaseConfigured) {
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
  const list = (mockDb.settlements || []).filter(s => s.salesman_id === salesman_id);
  const user = mockDb.users.find(u => u.id === salesman_id);
  const currentStock = user ? (Number(user.current_stock) || 0) : 0;
  const dynamicUnitPrice = await getDefaultProductUnitPrice();
  const todayDispatch = {
    date_label: 'Today',
    assigned_by: 'Field Sales Manager',
    bottles_dispatched: currentStock,
    unit_price: dynamicUnitPrice,
    total_value: currentStock * dynamicUnitPrice,
    status: 'pending',
    verified: currentStock > 0
  };
  return res.json({
    today: todayDispatch,
    history: list
  });
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
  if (damage_image_base64 && state.isSupabaseConfigured) {
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

  if (!mockDb.settlements) mockDb.settlements = [];
  mockDb.settlements.unshift(settlement);

  if (state.isSupabaseConfigured) {
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
  }

  // Also add to FSM settlement hub pending team settlements
  if (mockDb.fsmSettlementHub) {
    mockDb.fsmSettlementHub.team_settlement = mockDb.fsmSettlementHub.team_settlement || [];
    mockDb.fsmSettlementHub.team_settlement.unshift({
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
  }

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
