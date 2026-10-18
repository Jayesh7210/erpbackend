const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const mockDb = require('../data/mockDb');
const { state } = require('../data/state');
const { logAudit } = require('../services/audit');
const { getDefaultProductUnitPrice } = require('../services/productMeta');

// ==========================================
// FIELD MANAGER (FSM) 5-SCREEN REDESIGN ENDPOINTS
// ==========================================

// 1. Manager Dashboard Metrics
router.get('/api/fsm/dashboard/:fsm_id', async (req, res) => {
  const fsmId = req.params.fsm_id || 'u3';
  let hub = mockDb.fsmSettlementHub || { depot_stock: 0, warehouse: { received: 0, allocated: 0, sold: 0, returned: 0 } };

  if (state.isSupabaseConfigured) {
    try {
      const { data: stocks } = await supabase.from('stocks').select('quantity').eq('owner_id', fsmId);
      const totalStock = (stocks || []).reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
      const { data: completedTrs } = await supabase.from('stock_transfers').select('quantity').eq('to_id', fsmId).eq('status', 'completed');
      const totalReceived = (completedTrs || []).reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);

      hub = {
        depot_stock: totalStock,
        warehouse: {
          received: totalReceived,
          allocated: 0,
          sold: 0,
          returned: 0
        }
      };
    } catch (_) {}
  }
  const supervised = (mockDb.users || []).filter(u => u.parent_id === fsmId && u.role === 'salesman');
  const totalBottlesSold = supervised.reduce((sum, s) => sum + (Number(s.sold_today) || 0), 0);
  const totalAllocated = supervised.reduce((sum, s) => sum + (Number(s.current_stock) || 0), 0);
  
  // Dynamic FSM commissions from stock allocations to salesmen
  const fsmComms = (mockDb.workforceCommissions || []).filter(c => c.user_id === fsmId && c.role === 'field_sales_manager');
  const todayEarned = fsmComms.reduce((sum, c) => sum + (Number(c.commission_amount) || 0), 0);
  const totalUnitsAllocated = fsmComms.reduce((sum, c) => sum + (Number(c.quantity) || 0), 0);

  // Compute top performers dynamically from supervised team
  const sortedSalesmen = [...supervised].sort((a, b) => (b.sold_today || 0) - (a.sold_today || 0));
  const topPerformers = sortedSalesmen.slice(0, 3).map((s, idx) => ({
    rank: idx + 1,
    name: s.name,
    bottles: s.sold_today || 0,
    has_trophy: idx === 0 && (s.sold_today || 0) > 0
  }));

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
      received: hub.warehouse?.received || (hub.depot_stock + totalAllocated),
      allocated: totalAllocated,
      sold: totalBottlesSold,
      remaining: hub.depot_stock || 0
    },
    top_performers: topPerformers,
    available_depot_stock: hub.depot_stock || 0
  });
});

// 2. Supervised Team Roster
router.get('/api/fsm/team/:fsm_id', async (req, res) => {
  const fsmId = req.params.fsm_id || 'u3';
  if (state.isSupabaseConfigured) {
    try {
      const { data: users, error } = await supabase.from('users').select('*').eq('role', 'salesman');
      if (!error && users && users.length > 0) {
        const userIds = users.map(u => u.id);
        const { data: stocks } = await supabase.from('stocks').select('*').in('owner_id', userIds);
        const stockMap = new Map();
        (stocks || []).forEach(s => {
          stockMap.set(s.owner_id, (stockMap.get(s.owner_id) || 0) + (Number(s.quantity) || 0));
        });

        const supervised = users.filter(u => u.parent_id === fsmId || !u.parent_id || u.parent_id === 'c3456789-de23-45ff-67ff-8901abcdef23' || fsmId === 'u3' || fsmId === 'c3456789-de23-45ff-67ff-8901abcdef23');
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
            zone: u.zone || (idx % 2 === 0 ? 'Zone A' : 'Zone B'),
            code: u.code || `SP-${(idx + 1).toString().padStart(2, '0')}`,
            is_active: u.is_active !== false,
            sold_today: u.sold_today || 0,
            current_stock: stockMap.get(u.id) || u.current_stock || 0
          }))
        });
      }
    } catch (err) {
      console.warn('Supabase fetch team roster fallback:', err.message);
    }
  }

  let supervised = (mockDb.users || []).filter(u => (u.parent_id === fsmId || !u.parent_id) && u.role === 'salesman');
  if (supervised.length === 0) {
    supervised = [
      { id: 'd4567890-ef34-56ff-78ff-9012abcdef34', name: 'Salesman John', zone: 'Zone A', code: 'SP-01', is_active: true, sold_today: 7, current_stock: 10, parent_id: fsmId, role: 'salesman' },
      { id: '7481353a-adda-4cb6-889f-d5efe2dc1bd3', name: 'Rajesh Kumar', zone: 'Zone B', code: 'SP-02', is_active: true, sold_today: 4, current_stock: 5, parent_id: fsmId, role: 'salesman' },
      { id: 'u5', name: 'Amit Kumar', zone: 'Zone C', code: 'SP-03', is_active: false, sold_today: 0, current_stock: 0, parent_id: fsmId, role: 'salesman' },
    ];
  }
  const activeCount = supervised.filter(u => u.is_active !== false).length;
  return res.json({
    summary: {
      active: activeCount,
      offline: supervised.length - activeCount,
      total: supervised.length
    },
    salesmen: supervised.map(u => ({
      id: u.id,
      name: u.name,
      zone: u.zone || 'Zone A',
      code: u.code || 'SP-00',
      is_active: u.is_active !== false,
      sold_today: u.sold_today || 0,
      current_stock: u.current_stock || 0
    }))
  });
});

// 3. Batch Stock Allocation to Supervised Salesmen
router.post('/api/fsm/allocate-batch', async (req, res) => {
  const { fsm_id, allocations } = req.body;
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res.status(400).json({ error: 'Allocations array required' });
  }
  const hub = mockDb.fsmSettlementHub || { depot_stock: 0 };
  const totalAllocated = allocations.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
  if (totalAllocated > hub.depot_stock) {
    return res.status(400).json({ error: `Insufficient depot stock: Requested ${totalAllocated}, Available ${hub.depot_stock}` });
  }

  hub.depot_stock -= totalAllocated;
  allocations.forEach(a => {
    const u = mockDb.users.find(usr => usr.id === a.salesman_id);
    if (u) {
      u.current_stock = (u.current_stock || 0) + Number(a.quantity);
    }
  });

  await logAudit(fsm_id || 'u3', 'Field Manager', 'ALLOCATE_BATCH_STOCK', 'stock', 'batch', `Allocated ${totalAllocated} units to ${allocations.length} salesmen`);
  return res.json({
    success: true,
    total_allocated: totalAllocated,
    remaining_depot_stock: hub.depot_stock
  });
});

// 4. Candidate Referral Requests
router.get('/api/fsm/referral-requests/:fsm_id', (req, res) => {
  const fsmId = req.params.fsm_id || 'u3';
  let reqs = (mockDb.referralRequests || []).filter(r => !r.fsm_id || r.fsm_id === fsmId);
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

// 5. Approve or Reject Candidate Referral Request
router.put('/api/fsm/referral-requests/:id', async (req, res) => {
  const { id } = req.params;
  const { status, fsm_id } = req.body;
  const item = (mockDb.referralRequests || []).find(r => r.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Referral request not found' });
  }
  item.status = status || 'approved';
  await logAudit(fsm_id || 'u3', 'Field Manager', 'UPDATE_REFERRAL_REQUEST', 'referral_requests', id, `Referral request marked as ${item.status}`);
  return res.json(item);
});

// 6. Settlement Hub Summary
router.get('/api/fsm/settlement/:fsm_id', (req, res) => {
  const { fsm_id } = req.params;
  const hub = mockDb.fsmSettlementHub || {
    depot_stock: 0,
    warehouse: { received: 0, sold: 0, returned: 0, difference: 0, inv_value: 0, sold_value: 0, status: 'pending_return' },
    team_settlement: []
  };

  const pendingSettlements = (mockDb.settlements || []).filter(
    s => s.status === 'pending_fsm' && (!fsm_id || s.fsm_id === fsm_id || s.fsm_id === 'u3' || s.fsm_id === 'c3456789-de23-45ff-67ff-8901abcdef23')
  );

  return res.json({
    ...hub,
    pending_settlements: pendingSettlements
  });
});

// 7. Warehouse Return QR Generation
router.post('/api/fsm/warehouse-return-qr', async (req, res) => {
  const { fsm_id, quantity } = req.body || {};
  const returnQty = Number(quantity) || 500;
  const token = `WR-RET-${Math.floor(10000 + Math.random() * 90000)}`;
  const defaultUnitPrice = await getDefaultProductUnitPrice();
  const result = {
    qr_token: token,
    fsm_id: fsm_id || 'u3',
    quantity: returnQty,
    inventory_value: returnQty * defaultUnitPrice,
    status: 'authorized',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_at: new Date().toISOString()
  };
  await logAudit(fsm_id || 'u3', 'Field Manager', 'GENERATE_RETURN_QR', 'settlements', token, `Generated return QR for ${returnQty} bottles`);
  return res.json(result);
});

// 8. Settlement Reminder to Pending Salesman
router.post('/api/fsm/settlement-remind/:salesman_id', async (req, res) => {
  const { salesman_id } = req.params;
  const { fsm_id } = req.body || {};
  await logAudit(fsm_id || 'u3', 'Field Manager', 'SEND_SETTLEMENT_REMINDER', 'users', salesman_id, `Settlement reminder sent to salesman ${salesman_id}`);
  return res.json({ success: true, message: `Reminder successfully sent to ${salesman_id}` });
});

module.exports = router;
