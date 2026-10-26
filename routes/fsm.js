const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { logAudit } = require('../services/audit');
const { getDefaultProductUnitPrice } = require('../services/productMeta');
const { runtimeCommissions } = require('../services/commissionService');
const { fsmSettlementHub, runtimeWarehouseReturns } = require('../services/settlementService');
const { fsmGeneralLimiter, fsmOperationsLimiter, fsmReminderLimiter } = require('../services/rateLimiter');

// ==========================================
// FIELD MANAGER (FSM) 5-SCREEN REDESIGN ENDPOINTS
// ==========================================

// 1. Manager Dashboard Metrics (Protected by General FSM Limiter)
router.get('/api/fsm/dashboard/:fsm_id', fsmGeneralLimiter, async (req, res) => {
  const fsmId = req.params.fsm_id;
  let supervised = [];
  const salesMap = new Map();
  const smStockMap = new Map();
  let totalStock = 0;
  let totalReceived = 0;

  try {
    // 1. Live stock in FSM's possession
    const { data: stocks } = await supabase.from('stocks').select('quantity').eq('owner_id', fsmId);
    totalStock = (stocks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);

    // 2. Total received from Warehouse
    const { data: completedTrs } = await supabase.from('stock_transfers').select('quantity').eq('to_id', fsmId).eq('status', 'completed');
    totalReceived = (completedTrs || []).reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);

    // 3. Find FSM warehouse_id to also include local team
    const { data: fsmUser } = await supabase.from('users').select('warehouse_id').eq('id', fsmId).maybeSingle();

    const { data: salesmenUsers, error: smErr } = await supabase.from('users').select('*').eq('role', 'salesman');
    if (!smErr && salesmenUsers) {
      supervised = salesmenUsers.filter(u => 
        u.parent_id === fsmId || 
        (fsmUser?.warehouse_id && u.warehouse_id === fsmUser.warehouse_id) ||
        !u.parent_id
      );
    }

    // 4. Query live sales and live team stocks from Supabase
    const smIds = supervised.map(u => u.id);
    if (smIds.length > 0) {
      const { data: salesList } = await supabase.from('sales').select('salesman_id, quantity').in('salesman_id', smIds);
      (salesList || []).forEach(s => {
        salesMap.set(s.salesman_id, (salesMap.get(s.salesman_id) || 0) + (Number(s.quantity) || 0));
      });

      const { data: smStocks } = await supabase.from('stocks').select('owner_id, quantity').in('owner_id', smIds);
      (smStocks || []).forEach(st => {
        smStockMap.set(st.owner_id, (smStockMap.get(st.owner_id) || 0) + (Number(st.quantity) || 0));
      });
    }
  } catch (_) {}

  // Calculate dynamic sales and allocation
  const totalBottlesSold = supervised.reduce((sum, s) => sum + (salesMap.get(s.id) ?? (Number(s.sold_today) || 0)), 0);
  const totalAllocated = supervised.reduce((sum, s) => sum + (smStockMap.get(s.id) ?? (Number(s.current_stock) || 0)), 0);

  // Dynamic FSM commissions from stock allocations to salesmen
  let todayEarned = 0;
  let totalUnitsAllocated = 0;
  try {
    const { data: completedDispatches } = await supabase.from('stock_transfers')
      .select('quantity, product_id')
      .eq('from_id', fsmId)
      .eq('status', 'completed');

    if (completedDispatches && completedDispatches.length > 0) {
      totalUnitsAllocated = completedDispatches.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
      todayEarned = totalUnitsAllocated * 10;
    } else {
      const fsmComms = runtimeCommissions.filter(c => c.user_id === fsmId && c.role === 'field_sales_manager');
      todayEarned = fsmComms.reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
      totalUnitsAllocated = fsmComms.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);
    }
  } catch (_) {}

  // Dynamic top performers from live sales
  const sortedSalesmen = [...supervised].sort((a, b) => {
    const soldA = salesMap.get(a.id) ?? (a.sold_today || 0);
    const soldB = salesMap.get(b.id) ?? (b.sold_today || 0);
    return soldB - soldA;
  });

  const topPerformers = sortedSalesmen.slice(0, 3).map((s, idx) => {
    const bottles = salesMap.get(s.id) ?? (s.sold_today || 0);
    return {
      rank: idx + 1,
      name: s.name,
      bottles,
      has_trophy: idx === 0 && bottles > 0
    };
  });

  return res.json({
    earnings: {
      today_earned: todayEarned,
      bottles_sold: totalBottlesSold,
      units_allocated: totalUnitsAllocated
    },
    team_sales: {
      bottles: totalBottlesSold
    },
    stock_accountability: {
      received: Math.max(totalReceived, totalStock + totalAllocated + totalBottlesSold),
      allocated: totalAllocated,
      sold: totalBottlesSold,
      remaining: totalStock || fsmSettlementHub.depot_stock || 0
    },
    top_performers: topPerformers,
    available_depot_stock: totalStock || fsmSettlementHub.depot_stock || 0
  });
});

// 2. Supervised Team Roster (Protected by General FSM Limiter)
router.get('/api/fsm/team/:fsm_id', fsmGeneralLimiter, async (req, res) => {
  const fsmId = req.params.fsm_id;
  try {
    const { data: fsmUser } = await supabase.from('users').select('warehouse_id').eq('id', fsmId).maybeSingle();
    const { data: users, error } = await supabase.from('users').select('*').eq('role', 'salesman');
    if (!error && users) {
      const supervised = users.filter(u => 
        u.parent_id === fsmId || 
        (fsmUser?.warehouse_id && u.warehouse_id === fsmUser.warehouse_id) ||
        !u.parent_id
      );
      const userIds = supervised.map(u => u.id);
      const stockMap = new Map();
      const salesMap = new Map();

      if (userIds.length > 0) {
        const { data: stocks } = await supabase.from('stocks').select('*').in('owner_id', userIds);
        (stocks || []).forEach(s => {
          stockMap.set(s.owner_id, (stockMap.get(s.owner_id) || 0) + (Number(s.quantity) || 0));
        });

        const { data: salesList } = await supabase.from('sales').select('salesman_id, quantity').in('salesman_id', userIds);
        (salesList || []).forEach(s => {
          salesMap.set(s.salesman_id, (salesMap.get(s.salesman_id) || 0) + (Number(s.quantity) || 0));
        });
      }

      const activeCount = supervised.filter(u => u.is_active !== false).length;
      return res.json({
        summary: {
          active: activeCount,
          offline: supervised.length - activeCount,
          total: supervised.length
        },
        salesmen: supervised.map((u, idx) => ({
          id: u.id,
          name: u.name,
          zone: u.zone || u.location || 'Field Operations',
          code: u.code || `SP-${(idx + 1).toString().padStart(2, '0')}`,
          is_active: u.is_active !== false,
          sold_today: salesMap.get(u.id) ?? (u.sold_today || 0),
          current_stock: stockMap.get(u.id) || u.current_stock || 0
        }))
      });
    }
  } catch (err) {
    console.warn('Supabase fetch team roster error:', err.message);
  }

  return res.json({
    summary: { active: 0, offline: 0, total: 0 },
    salesmen: []
  });
});

// 3. Batch Stock Allocation to Supervised Salesmen (Protected by Operations Limiter)
router.post('/api/fsm/allocate-batch', fsmOperationsLimiter, async (req, res) => {
  const { fsm_id, allocations } = req.body;
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res.status(400).json({ error: 'Allocations array required' });
  }

  const totalAllocated = allocations.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);

  try {
    // Check FSM stock in Supabase
    let { data: fsmStocks } = await supabase.from('stocks').select('*').eq('owner_id', fsm_id);
    let availableQty = (fsmStocks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);

    if (availableQty < totalAllocated && fsmSettlementHub.depot_stock < totalAllocated) {
      return res.status(400).json({ error: `Insufficient depot stock: Requested ${totalAllocated}, Available ${Math.max(availableQty, fsmSettlementHub.depot_stock)}` });
    }

    // Process each allocation per product
    for (const a of allocations) {
      const qty = Number(a.quantity) || 0;
      if (qty <= 0) continue;
      const targetProdId = a.product_id || fsmStocks?.[0]?.product_id;
      if (!targetProdId) continue;

      // Deduct from FSM for this specific product
      const { data: fsmProdStock } = await supabase.from('stocks')
        .select('*')
        .eq('owner_id', fsm_id)
        .eq('product_id', targetProdId)
        .maybeSingle();

      if (fsmProdStock) {
        await supabase.from('stocks')
          .update({ quantity: Math.max(0, fsmProdStock.quantity - qty) })
          .eq('id', fsmProdStock.id);
      }

      // Credit to salesman
      const { data: smStock } = await supabase.from('stocks')
        .select('*')
        .eq('owner_id', a.salesman_id)
        .eq('product_id', targetProdId)
        .maybeSingle();

      if (smStock) {
        await supabase.from('stocks')
          .update({ quantity: smStock.quantity + qty })
          .eq('id', smStock.id);
      } else {
        await supabase.from('stocks').insert([{
          owner_id: a.salesman_id,
          product_id: targetProdId,
          quantity: qty
        }]);
      }

      // Record transfer in stock_transfers
      try {
        await supabase.from('stock_transfers').insert([{
          from_id: fsm_id,
          to_id: a.salesman_id,
          product_id: targetProdId,
          quantity: qty,
          status: 'completed'
        }]);
      } catch (_) {}
    }

    fsmSettlementHub.depot_stock = Math.max(0, fsmSettlementHub.depot_stock - totalAllocated);

    await logAudit(fsm_id || 'system', 'Field Manager', 'ALLOCATE_BATCH_STOCK', 'stock', 'batch', `Allocated ${totalAllocated} units to ${allocations.length} salesmen`);
    return res.json({
      success: true,
      total_allocated: totalAllocated,
      remaining_depot_stock: Math.max(0, availableQty - totalAllocated)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. Candidate Referral Requests (Protected by General FSM Limiter)
router.get('/api/fsm/referral-requests/:fsm_id', fsmGeneralLimiter, async (req, res) => {
  const fsmId = req.params.fsm_id;
  let reqs = [];

  try {
    const { data: dbRequests } = await supabase
      .from('user_creation_requests')
      .select('*')
      .eq('role', 'salesman');

    if (dbRequests && dbRequests.length > 0) {
      reqs = dbRequests.map(r => ({
        id: r.id,
        fsm_id: r.parent_id,
        candidate_name: r.name,
        referred_by: r.requested_by_name || 'Sales Team',
        phone: r.phone || '',
        location: r.location || 'Field',
        status: r.status || 'pending',
        timestamp: r.created_at ? new Date(r.created_at).toLocaleDateString() : 'Recent',
        documents: r.kyc_doc ? [r.kyc_doc] : []
      }));
    }
  } catch (e) {
    console.warn('FSM referral-requests Supabase fetch warning:', e.message);
  }

  const pendingCount = reqs.filter(r => r.status === 'pending').length;
  const inReviewCount = reqs.filter(r => r.status === 'in_review').length;

  if (req.query.filter === 'high_priority') {
    reqs = reqs.filter(r => r.priority === 'high');
  } else if (req.query.filter === 'recent') {
    reqs = reqs.filter(r => r.is_new);
  }

  return res.json({
    summary: {
      pending: pendingCount,
      in_review: inReviewCount
    },
    requests: reqs
  });
});

// 5. Approve or Reject Candidate Referral Request (Protected by Operations Limiter)
router.put('/api/fsm/referral-requests/:id', fsmOperationsLimiter, async (req, res) => {
  const { id } = req.params;
  const { status, action, fsm_id } = req.body;
  const raw = String(status || action || '').trim().toLowerCase();
  const normalized = raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw;
  const validStatuses = ['pending', 'approved', 'rejected'];
  const safeStatus = validStatuses.includes(normalized) ? normalized : (raw.includes('reject') ? 'rejected' : 'approved');

  try {
    const { data: reqData } = await supabase
      .from('user_creation_requests')
      .update({ status: safeStatus })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (safeStatus === 'approved' && reqData) {
      // Automatically provision user account in users table if approving
      const { data: existingUser } = await supabase.from('users').select('id').eq('email', reqData.email).maybeSingle();
      if (!existingUser) {
        await supabase.from('users').insert([{
          name: reqData.name,
          email: reqData.email,
          role: 'salesman',
          warehouse_id: reqData.warehouse_id,
          parent_id: fsm_id || reqData.parent_id,
          status: 'approved',
          requires_password_setup: true,
          phone: reqData.phone || '',
          password: 'sales123'
        }]);
      }
    }
  } catch (_) {}

  await logAudit(fsm_id || 'system', 'Field Manager', 'UPDATE_REFERRAL_REQUEST', 'referral_requests', id, `Referral request marked as ${safeStatus}`);
  return res.json({ id, status: safeStatus });
});

// 6. Settlement Hub Summary (Protected by General FSM Limiter)
router.get('/api/fsm/settlement/:fsm_id', fsmGeneralLimiter, async (req, res) => {
  const { fsm_id } = req.params;
  let pendingSettlements = [];
  let depotStock = 0;
  let totalReceived = 0;
  let totalSold = 0;
  let totalReturned = 0;
  let teamSettlements = [];

  try {
    // 1. Fetch live pending settlements
    const { data: dbSettlements } = await supabase
      .from('settlements')
      .select('*')
      .eq('status', 'pending_fsm');
    if (dbSettlements) {
      pendingSettlements = dbSettlements;
    }

    // 2. Fetch live depot stock
    const { data: stocks } = await supabase.from('stocks').select('quantity').eq('owner_id', fsm_id);
    depotStock = (stocks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);

    // 3. Completed transfers received from warehouse
    const { data: completedTrs } = await supabase.from('stock_transfers').select('quantity').eq('to_id', fsm_id).eq('status', 'completed');
    totalReceived = (completedTrs || []).reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);

    // 4. Completed settlements
    const { data: completedSettlements } = await supabase.from('settlements').select('*').eq('fsm_id', fsm_id).eq('status', 'settled');
    const settledMap = new Map();
    (completedSettlements || []).forEach(s => {
      totalSold += Number(s.bottles_sold) || 0;
      totalReturned += Number(s.remaining_qty) || 0;
      if (s.salesman_id) settledMap.set(s.salesman_id, s);
    });

    // 5. Query supervised salesmen and their live sales & allocations
    const { data: fsmUser } = await supabase.from('users').select('warehouse_id').eq('id', fsm_id).maybeSingle();
    const { data: allSalesmen } = await supabase.from('users').select('*').eq('role', 'salesman');
    const supervised = (allSalesmen || []).filter(u =>
      u.parent_id === fsm_id ||
      (fsmUser?.warehouse_id && u.warehouse_id === fsmUser.warehouse_id) ||
      !u.parent_id
    );

    const smIds = supervised.map(u => u.id);
    const smSalesMap = new Map();
    let liveTeamSold = 0;

    if (smIds.length > 0) {
      const { data: salesList } = await supabase.from('sales').select('salesman_id, quantity, amount').in('salesman_id', smIds);
      (salesList || []).forEach(s => {
        const qty = Number(s.quantity) || 0;
        const amt = Number(s.amount) || 0;
        liveTeamSold += qty;
        const prev = smSalesMap.get(s.salesman_id) || { qty: 0, amount: 0 };
        smSalesMap.set(s.salesman_id, {
          qty: prev.qty + qty,
          amount: prev.amount + amt
        });
      });

      const { data: smStocks } = await supabase.from('stocks').select('owner_id, quantity').in('owner_id', smIds);
      const smStockMap = new Map();
      (smStocks || []).forEach(st => {
        smStockMap.set(st.owner_id, (smStockMap.get(st.owner_id) || 0) + (Number(st.quantity) || 0));
      });

      teamSettlements = supervised.map(sm => {
        const smSales = smSalesMap.get(sm.id) || { qty: 0, amount: 0 };
        const smStock = smStockMap.get(sm.id) || 0;
        const isSettled = settledMap.has(sm.id);
        const hasPendingSettlement = pendingSettlements.some(ps => ps.salesman_id === sm.id);

        return {
          id: sm.id,
          salesman_id: sm.id,
          name: sm.name || 'Salesman',
          phone: sm.phone || '',
          allocated: smStock + smSales.qty,
          current_stock: smStock,
          bottles_sold: smSales.qty,
          pending_amount: smSales.amount,
          status: isSettled ? 'settled' : hasPendingSettlement ? 'pending_review' : 'pending'
        };
      });
    }

    if (totalSold === 0 && liveTeamSold > 0) {
      totalSold = liveTeamSold;
    }
  } catch (err) {
    console.warn('Settlement Hub fetch error:', err.message);
  }

  if (depotStock === 0) {
    depotStock = fsmSettlementHub.depot_stock || 0;
  }

  const defaultUnitPrice = await getDefaultProductUnitPrice();
  const invValue = depotStock * defaultUnitPrice;
  const soldValue = totalSold * defaultUnitPrice;

  return res.json({
    depot_stock: depotStock,
    warehouse: {
      received: Math.max(totalReceived, depotStock + totalSold),
      sold: totalSold,
      returned: totalReturned,
      difference: 0,
      inv_value: invValue,
      sold_value: soldValue,
      status: depotStock > 0 ? 'pending_return' : 'settled'
    },
    team_settlement: teamSettlements.length > 0 ? teamSettlements : (fsmSettlementHub.team_settlement || []),
    pending_settlements: pendingSettlements
  });
});

// 7. Warehouse Return QR Generation (Protected by FSM Reminder & QR Limiter)
router.post('/api/fsm/warehouse-return-qr', fsmReminderLimiter, async (req, res) => {
  const { fsm_id, quantity, warehouse_id } = req.body || {};
  let returnQty = Number(quantity) || 0;

  // Auto-detect available depot stock if returnQty was passed as 0
  if (returnQty <= 0 && fsm_id) {
    try {
      const { data: stks } = await supabase.from('stocks').select('quantity').eq('owner_id', fsm_id);
      returnQty = (stks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
    } catch (_) {}
    if (returnQty <= 0) returnQty = fsmSettlementHub.depot_stock || 0;
  }

  let fsmName = 'Field Sales Manager';
  let targetWarehouseId = warehouse_id;

  try {
    if (fsm_id) {
      const { data: u } = await supabase.from('users').select('name, warehouse_id').eq('id', fsm_id).maybeSingle();
      if (u) {
        if (u.name) fsmName = u.name;
        if (!targetWarehouseId && u.warehouse_id) targetWarehouseId = u.warehouse_id;
      }
    }
  } catch (_) {}

  if (!targetWarehouseId) {
    try {
      const { data: firstWh } = await supabase.from('warehouses').select('id').limit(1).maybeSingle();
      if (firstWh) targetWarehouseId = firstWh.id;
    } catch (_) {}
  }

  const token = `WR-RET-${Math.floor(10000 + Math.random() * 90000)}`;
  const securityPin = `${Math.floor(100000 + Math.random() * 900000)}`;
  const defaultUnitPrice = await getDefaultProductUnitPrice();

  // Clear previous pending return records for this FSM
  if (fsm_id) {
    for (let i = runtimeWarehouseReturns.length - 1; i >= 0; i--) {
      if (runtimeWarehouseReturns[i].fsm_id === fsm_id && runtimeWarehouseReturns[i].status === 'pending_warehouse') {
        runtimeWarehouseReturns.splice(i, 1);
      }
    }
  }

  const returnRecord = {
    id: `fsm_ret_${Date.now()}`,
    qr_token: token,
    return_code: token,
    security_pin: securityPin,
    fsm_id: fsm_id || null,
    fsm_name: fsmName,
    warehouse_id: targetWarehouseId || null,
    quantity: returnQty,
    inventory_value: returnQty * defaultUnitPrice,
    status: 'pending_warehouse',
    qr_payload: JSON.stringify({
      type: 'FSM_WAREHOUSE_RETURN',
      return_code: token,
      security_pin: securityPin,
      fsm_id: fsm_id || null,
      fsm_name: fsmName,
      quantity: returnQty,
      warehouse_id: targetWarehouseId
    }),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_at: new Date().toISOString()
  };

  runtimeWarehouseReturns.unshift(returnRecord);

  if (fsmSettlementHub && fsmSettlementHub.warehouse) {
    fsmSettlementHub.warehouse.status = 'pending_warehouse';
  }

  await logAudit(fsm_id || 'system', 'Field Manager', 'GENERATE_RETURN_QR', 'settlements', token, `Generated warehouse return QR ${token} (PIN: ${securityPin}) for ${returnQty} bottles`);
  return res.json(returnRecord);
});


// 8. Settlement Reminder to Pending Salesman (Protected by FSM Reminder Limiter)
router.post('/api/fsm/settlement-remind/:salesman_id', fsmReminderLimiter, async (req, res) => {
  const { salesman_id } = req.params;
  const { fsm_id } = req.body || {};
  await logAudit(fsm_id || 'system', 'Field Manager', 'SEND_SETTLEMENT_REMINDER', 'users', salesman_id, `Settlement reminder sent to salesman ${salesman_id}`);
  return res.json({ success: true, message: `Reminder successfully sent to ${salesman_id}` });
});

module.exports = router;
