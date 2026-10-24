const express = require('express');
const router = express.Router();
const { supabaseAdmin: supabase } = require('../db');
const { logAudit } = require('../services/audit');
const { getProductWithMeta } = require('../services/productMeta');
const { optimizeBase64Image } = require('../services/imageOptimizer');
const { runtimeCommissions, addCommission } = require('../services/commissionService');
const {
  superAdminGeneralLimiter,
  superAdminSensitiveLimiter,
  superAdminAnalyticsLimiter,
  storeAdminGeneralLimiter,
  storeAdminIntakeLimiter,
  storeAdminTransactionLimiter,
  fsmOperationsLimiter
} = require('../services/rateLimiter');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Runtime cache for intakes if table does not exist in schema
const runtimeIntakes = [];

// Helper function to credit dynamic per-product commissions on completed stock transfers
async function processTransferCommission(transfer) {
  if (!transfer || !transfer.quantity || transfer.status !== 'completed') return;
  const alreadyCredited = runtimeCommissions.some(c => c.transfer_id === transfer.id);
  if (alreadyCredited) return;

  let senderUser = null;
  let recipientUser = null;
  try {
    const { data: users } = await supabase.from('users').select('id, name, role').in('id', [transfer.from_id, transfer.to_id]);
    if (users) {
      senderUser = users.find(u => u.id === transfer.from_id);
      recipientUser = users.find(u => u.id === transfer.to_id);
    }
  } catch (_) {}

  const product = getProductWithMeta(transfer.product_id);
  if (!product) return;

  const isSenderStoreAdmin = senderUser && senderUser.role === 'store_admin';
  const isRecipientFsm = recipientUser && recipientUser.role === 'field_sales_manager';
  const isSenderFsm = senderUser && senderUser.role === 'field_sales_manager';
  const isRecipientSalesman = recipientUser && recipientUser.role === 'salesman';

  // 1. Store Admin -> FSM: Store Admin earns product.store_admin_commission
  if (isSenderStoreAdmin && isRecipientFsm) {
    const rate = Number(product.store_admin_commission) || 0.0;
    const amount = transfer.quantity * rate;
    if (amount > 0) {
      addCommission({
        id: `sa_comm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
        role: 'store_admin',
        type: 'store_admin_dispatch',
        user_id: transfer.from_id,
        user_name: senderUser?.name || 'Store Admin',
        recipient_id: transfer.to_id,
        recipient_name: recipientUser?.name || 'Field Sales Manager',
        transfer_id: transfer.id,
        product_id: transfer.product_id,
        product_name: product.name,
        quantity: transfer.quantity,
        rate_per_unit: rate,
        commission_amount: amount,
        status: 'unlocked',
        created_at: new Date().toISOString()
      });
    }
  }

  // 2. FSM -> Salesman: FSM earns product.fsm_commission
  if (isSenderFsm && isRecipientSalesman) {
    const rate = Number(product.fsm_commission) || 0.0;
    const amount = transfer.quantity * rate;
    if (amount > 0) {
      addCommission({
        id: `fsm_comm_${Date.now()}_${Math.floor(100 + Math.random() * 900)}`,
        role: 'field_sales_manager',
        type: 'fsm_allocation',
        user_id: transfer.from_id,
        user_name: senderUser?.name || 'Field Sales Manager',
        recipient_id: transfer.to_id,
        recipient_name: recipientUser?.name || 'Salesman',
        transfer_id: transfer.id,
        product_id: transfer.product_id,
        product_name: product.name,
        quantity: transfer.quantity,
        rate_per_unit: rate,
        commission_amount: amount,
        status: 'unlocked',
        created_at: new Date().toISOString()
      });
    }
  }
}

// In-Memory Idempotency Cache for Stock Operations (prevents double submissions / retry duplicates)
const recentStockOpsCache = new Map();
const cleanupStockOpsTimer = setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [k, v] of recentStockOpsCache.entries()) {
    if (v.timestamp < cutoff) recentStockOpsCache.delete(k);
  }
}, 60000);
if (cleanupStockOpsTimer.unref) cleanupStockOpsTimer.unref();

function getStockOpKey(prefix, body, req) {
  if (body.idempotency_key) return prefix + ":key:" + body.idempotency_key;
  const headerKey = req.headers["x-idempotency-key"];
  if (headerKey) return prefix + ":key:" + headerKey;
  const user = body.received_by || body.requested_by || "anon";
  return prefix + ":fp:" + body.warehouse_id + ":" + body.product_id + ":" + body.quantity + ":" + (body.batch_number || "") + ":" + user;
}

// Submit Stock Inward Request (Store Admin - Protected by Store Admin Intake Rate Limiter)
router.post("/api/stock/inward", storeAdminIntakeLimiter, async (req, res) => {
  const { warehouse_id, product_id, quantity, receipt_base64, receipt_filename, requested_by, batch_number, supplier, date_received } = req.body;
  if (!warehouse_id || !product_id || !quantity) {
    return res.status(400).json({ error: "warehouse_id, product_id, and quantity are required" });
  }

  // Idempotency check: prevent duplicate inward requests within 60 seconds
  const opKey = getStockOpKey("inward", req.body, req);
  const cached = recentStockOpsCache.get(opKey);
  if (cached && (Date.now() - cached.timestamp) < 60000) {
    return res.status(200).json({ ...cached.result, _duplicate_prevented: true });
  }

  let finalReceiptUrl = null;

  try {
    if (receipt_base64 && receipt_filename) {
      const optimized = await optimizeBase64Image(receipt_base64, receipt_filename);
      if (optimized) {
        const filePath = "inward_" + Date.now() + "_" + optimized.filename;
        const { error: uploadError } = await supabase.storage
          .from("receipts")
          .upload(filePath, optimized.buffer, {
            contentType: optimized.contentType,
            upsert: true
          });

        if (!uploadError) {
          const { data: urlData } = supabase.storage.from("receipts").getPublicUrl(filePath);
          finalReceiptUrl = urlData.publicUrl;
        }
      }
    }

    // Resolve warehouse_id
    let resolvedWhId = warehouse_id;
    if (!UUID_REGEX.test(String(warehouse_id))) {
      const { data: wh } = await supabase.from('warehouses').select('id').or(`name.ilike.%${warehouse_id}%`).limit(1).maybeSingle();
      if (wh && wh.id) {
        resolvedWhId = wh.id;
      } else {
        const { data: firstWh } = await supabase.from('warehouses').select('id').limit(1).maybeSingle();
        if (firstWh && firstWh.id) resolvedWhId = firstWh.id;
      }
    }

    // Resolve product_id
    let resolvedProdId = product_id;
    if (!UUID_REGEX.test(String(product_id))) {
      const { data: prod } = await supabase.from('products').select('id').or(`sku.eq.${product_id},name.ilike.%${product_id}%`).limit(1).maybeSingle();
      if (prod && prod.id) {
        resolvedProdId = prod.id;
      } else {
        const { data: firstProd } = await supabase.from('products').select('id').limit(1).maybeSingle();
        if (firstProd && firstProd.id) resolvedProdId = firstProd.id;
      }
    }

    // Resolve requested_by (ensure valid UUID or null)
    let resolvedRequestedBy = null;
    if (requested_by && UUID_REGEX.test(String(requested_by))) {
      resolvedRequestedBy = requested_by;
    }

    const basicPayload = {
      warehouse_id: resolvedWhId,
      product_id: resolvedProdId,
      quantity: parseInt(quantity),
      receipt_url: finalReceiptUrl,
      requested_by: resolvedRequestedBy,
      status: "pending"
    };

    const { data: createdData, error: insertError } = await supabase
      .from("stock_inward_requests")
      .insert([basicPayload])
      .select()
      .single();

    if (insertError) {
      console.error("stock_inward_requests insert error:", insertError.message);
      return res.status(500).json({ error: insertError.message });
    }

    // Try to enrich with joined relational data
    let enrichedData = null;
    try {
      const { data: relData } = await supabase
        .from("stock_inward_requests")
        .select('*, requested_by_user:users!stock_inward_requests_requested_by_fkey(name), warehouse:warehouses(name), product:products(name, sku, unit)')
        .eq('id', createdData.id)
        .maybeSingle();
      enrichedData = relData;
    } catch (_) {}

    const resultRow = enrichedData || createdData;
    const responsePayload = {
      ...resultRow,
      requested_by: resultRow.requested_by_user || (resultRow.requested_by ? { name: 'Store Admin' } : null),
      batch_number: batch_number || '',
      supplier: supplier || '',
      date_received: date_received || ''
    };

    recentStockOpsCache.set(opKey, { timestamp: Date.now(), result: responsePayload });
    await logAudit(resolvedRequestedBy || 'store_admin', "Store Admin", "SUBMIT_INWARD_REQUEST", "stock_inward_requests", responsePayload.id, "Submitted inward request for " + quantity + " units awaiting Super Admin approval");
    return res.status(201).json(responsePayload);
  } catch (err) {
    console.error("Stock inward error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// List Stock Inward Requests (Protected by General Admin Rate Limiter)
router.get('/api/stock/inward-requests', superAdminGeneralLimiter, async (req, res) => {
  const { status } = req.query;
  const targetStatus = (status || 'pending').toLowerCase();
  try {
    let query = supabase.from('stock_inward_requests')
      .select('*, requested_by_user:users!stock_inward_requests_requested_by_fkey(name), warehouse:warehouses(name), product:products(name, sku, unit)');
    if (targetStatus !== 'all') {
      query = query.eq('status', targetStatus);
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    if (!error && data) {
      const enriched = data.map(r => ({
        ...r,
        requested_by: r.requested_by_user || (r.requested_by ? { name: 'Store Admin' } : null)
      }));
      return res.json(enriched);
    }

    // Fallback without joins
    let simpleQuery = supabase.from('stock_inward_requests').select('*');
    if (targetStatus !== 'all') {
      simpleQuery = simpleQuery.eq('status', targetStatus);
    }
    const { data: simpleData, error: simpleErr } = await simpleQuery.order('created_at', { ascending: false });
    if (simpleErr) throw simpleErr;
    return res.json(simpleData || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Approve Stock Inward Request (Super Admin - Protected by Sensitive Admin Rate Limiter)
router.post("/api/stock/inward-approve", superAdminSensitiveLimiter, async (req, res) => {
  const { request_id, approve, approved_by } = req.body;
  if (!request_id) return res.status(400).json({ error: "Request ID is required" });

  const status = approve ? "approved" : "rejected";
  const finalApprovedBy = (approved_by && UUID_REGEX.test(String(approved_by))) ? approved_by : null;

  try {
    const updatePayload = { status, updated_at: new Date() };
    if (finalApprovedBy) updatePayload.approved_by = finalApprovedBy;

    const { data: requestData, error: reqErr } = await supabase.from("stock_inward_requests")
      .update(updatePayload)
      .eq("id", request_id)
      .select()
      .single();
    if (reqErr) throw reqErr;

    if (approve && requestData) {
      const prodId = requestData.product_id;
      const whId = requestData.warehouse_id;
      const qty = requestData.quantity;

      const { data: currentStock, error: stockFetchErr } = await supabase.from("stocks")
        .select("*")
        .eq("owner_id", whId)
        .eq("product_id", prodId)
        .maybeSingle();

      if (stockFetchErr) throw stockFetchErr;

      if (currentStock) {
        await supabase.from("stocks")
          .update({ quantity: currentStock.quantity + qty, updated_at: new Date() })
          .eq("id", currentStock.id);
      } else {
        await supabase.from("stocks").insert([{
          owner_id: whId,
          product_id: prodId,
          quantity: qty
        }]);
      }

      // Record an intake ledger entry if table exists
      try {
        await supabase.from("stock_intakes").insert([{
          warehouse_id: whId,
          product_id: prodId,
          quantity: qty,
          batch_number: requestData.batch_number || ("BATCH-" + Date.now().toString().slice(-6)),
          supplier: requestData.supplier || "Approved Supplier Consignment",
          date_received: requestData.date_received || new Date().toISOString().split("T")[0],
          receipt_url: requestData.receipt_url || "mock_receipt.png",
          received_by: approved_by
        }]);
      } catch (_) {}
    }

    await logAudit(approved_by, "Super Admin", "APPROVE_STOCK_INWARD", "stock_inward_requests", request_id, "Inward request " + status + " for " + (requestData?.quantity || "") + " units");
    return res.json({ message: "Stock inward successfully " + status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Stock Intake (Direct intake with batch, supplier, date received - Protected by Intake Rate Limiter)
router.post("/api/stock/intake", storeAdminIntakeLimiter, async (req, res) => {
  const { warehouse_id, product_id, quantity, batch_number, supplier, date_received, receipt_base64, receipt_filename, received_by } = req.body;
  if (!warehouse_id || !product_id || !quantity) {
    return res.status(400).json({ error: "warehouse_id, product_id, and quantity are required" });
  }

  // Idempotency check: prevent duplicate stock intake within 60 seconds
  const opKey = getStockOpKey("intake", req.body, req);
  const cached = recentStockOpsCache.get(opKey);
  if (cached && (Date.now() - cached.timestamp) < 60000) {
    return res.status(200).json({ ...cached.result, _duplicate_prevented: true });
  }

  const intakeQty = parseInt(quantity);
  let finalReceiptUrl = "mock_receipt.png";

  try {
    if (receipt_base64 && receipt_filename) {
      const optimized = await optimizeBase64Image(receipt_base64, receipt_filename);
      if (optimized) {
        const filePath = "intake_" + Date.now() + "_" + optimized.filename;
        const { error: uploadError } = await supabase.storage.from("receipts").upload(filePath, optimized.buffer, {
          contentType: optimized.contentType,
          upsert: true
        });
        if (!uploadError) {
          const { data: urlData } = supabase.storage.from("receipts").getPublicUrl(filePath);
          finalReceiptUrl = urlData.publicUrl;
        }
      }
    }

    let intakeData = {
      id: "intake_" + Date.now(),
      warehouse_id,
      product_id,
      quantity: intakeQty,
      batch_number: batch_number || ("BATCH-" + Date.now().toString().slice(-6)),
      supplier: supplier || "Direct Supplier",
      date_received: date_received || new Date().toISOString().split("T")[0],
      receipt_url: finalReceiptUrl,
      received_by: received_by || null,
      created_at: new Date()
    };

    try {
      const { data: dbIntake, error: intakeErr } = await supabase.from("stock_intakes").insert([{
        warehouse_id,
        product_id,
        quantity: intakeQty,
        batch_number: batch_number || ("BATCH-" + Date.now().toString().slice(-6)),
        supplier: supplier || "Direct Supplier",
        date_received: date_received || new Date().toISOString().split("T")[0],
        receipt_url: finalReceiptUrl,
        received_by: received_by || null
      }]).select().single();
      if (!intakeErr && dbIntake) intakeData = dbIntake;
    } catch (_) {}

    runtimeIntakes.unshift(intakeData);

    const { data: currentStock, error: stockFetchErr } = await supabase.from("stocks")
      .select("*")
      .eq("owner_id", warehouse_id)
      .eq("product_id", product_id)
      .maybeSingle();

    if (stockFetchErr) {
      console.warn("Stock fetch error in Supabase:", stockFetchErr.message);
    }

    if (currentStock) {
      await supabase.from("stocks")
        .update({ quantity: currentStock.quantity + intakeQty, updated_at: new Date() })
        .eq("id", currentStock.id);
    } else {
      await supabase.from("stocks").insert([{
        owner_id: warehouse_id,
        product_id,
        quantity: intakeQty
      }]);
    }

    recentStockOpsCache.set(opKey, { timestamp: Date.now(), result: intakeData });
    await logAudit(received_by, "Store / Super Admin", "STOCK_INTAKE", "stocks", product_id, "Stock intake of " + intakeQty + " units (Batch: " + (batch_number || "N/A") + ", Supplier: " + (supplier || "N/A") + ")");
    return res.status(201).json(intakeData);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// List Stock Intakes (Store Admin - Protected by Store Admin General Limiter)
router.get('/api/stock/intakes', storeAdminGeneralLimiter, async (req, res) => {
  const { warehouse_id } = req.query;
  try {
    let query = supabase.from('stock_intakes').select('*, product:products(name, sku, unit), receiver:users(name)');
    if (warehouse_id) query = query.eq('warehouse_id', warehouse_id);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (!error && data) return res.json(data);
  } catch (_) {}

  let list = runtimeIntakes;
  if (warehouse_id) list = list.filter(i => i.warehouse_id === warehouse_id);
  return res.json(list);
});

// Transfer stock (Store Admin -> FSM, FSM -> Salesman - Protected by Transaction Limiter)
router.post('/api/stock/transfer', storeAdminTransactionLimiter, async (req, res) => {
  let { from_id, to_id, product_id, quantity, status = 'completed' } = req.body;
  if (!from_id || !to_id || !product_id || !quantity) {
    return res.status(400).json({ error: 'from_id, to_id, product_id, and quantity are required' });
  }

  const transferQty = parseInt(quantity);
  const transferStatus = status === 'pending' ? 'pending' : 'completed';

  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product_id);
    if (!isUuid) {
      const { data: firstProd } = await supabase.from('products').select('id').limit(1);
      if (firstProd && firstProd.length > 0) {
        product_id = firstProd[0].id;
      }
    }
    const { data: recipientUser } = await supabase.from('users').select('*').eq('id', to_id).maybeSingle();
    const { data: senderUser } = await supabase.from('users').select('*').eq('id', from_id).maybeSingle();
    const { data: warehouse } = await supabase.from('warehouses').select('id').eq('id', from_id).maybeSingle();

    // Restriction 1: Salesman cannot transfer or distribute stock to anyone
    if (senderUser && senderUser.role === 'salesman') {
      return res.status(403).json({ error: 'Salesmen cannot transfer or distribute stock. Stock can only be sold directly to customers.' });
    }

    // Restriction 2: Salesman can only receive stock from their assigned Field Sales Manager
    if (recipientUser && recipientUser.role === 'salesman') {
      if (!senderUser || senderUser.role !== 'field_sales_manager' || recipientUser.parent_id !== from_id) {
        return res.status(403).json({ error: 'Salesmen can only receive stock from their assigned Field Sales Manager.' });
      }
    }

    // Restriction 3: Store Admin cannot transfer directly to Salesman
    if (recipientUser && recipientUser.role === 'salesman') {
      if (warehouse || (senderUser && senderUser.role === 'store_admin')) {
        return res.status(403).json({ error: 'Store Admin cannot transfer stock directly to a Salesman. Transfers must be made to Field Sales Managers.' });
      }
    }

    // Restriction 4: FSM can only distribute stock to salesmen under their supervision
    if (senderUser && senderUser.role === 'field_sales_manager') {
      if (!recipientUser || recipientUser.role !== 'salesman' || (recipientUser.parent_id && recipientUser.parent_id !== from_id)) {
        return res.status(403).json({ error: 'Field Sales Managers can only distribute stock to Salesmen under their direct supervision.' });
      }
    }

    // Fetch sender stock
    let { data: senderStock, error: sendErr } = await supabase.from('stocks')
      .select('*')
      .eq('owner_id', from_id)
      .eq('product_id', product_id)
      .maybeSingle();
    
    if (sendErr || !senderStock) {
      return res.status(400).json({ error: 'Insufficient stock at source: No stock found' });
    } else if (senderStock.quantity < transferQty) {
      return res.status(400).json({ error: `Insufficient stock at source (Available: ${senderStock.quantity}, Requested: ${transferQty})` });
    }

    // Deduct from sender
    await supabase.from('stocks')
      .update({ quantity: senderStock.quantity - transferQty })
      .eq('id', senderStock.id);

    // Increment / Create for receiver only if transfer is completed immediately
    if (transferStatus === 'completed') {
      const { data: rcvrStock } = await supabase.from('stocks')
        .select('*')
        .eq('owner_id', to_id)
        .eq('product_id', product_id)
        .maybeSingle();

      if (rcvrStock) {
        await supabase.from('stocks')
          .update({ quantity: rcvrStock.quantity + transferQty })
          .eq('id', rcvrStock.id);
      } else {
        await supabase.from('stocks').insert([{
          owner_id: to_id,
          product_id,
          quantity: transferQty
        }]);
      }
    }

    // Log transfer
    const { data: transferData, error: trErr } = await supabase.from('stock_transfers').insert([{
      from_id, to_id, product_id, quantity: transferQty, status: transferStatus
    }]).select().single();
    if (trErr) throw trErr;

    if (transferStatus === 'completed') {
      processTransferCommission(transferData);
    }

    return res.json({ message: 'Stock transfer recorded successfully', transfer: transferData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Accept/Confirm Receipt of Stock Transfer (FSM accepts incoming stock from Store Admin or Salesman accepts from FSM - Protected by Operations Limiter)
router.put('/api/stock/transfers/:id/accept', fsmOperationsLimiter, async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  try {
    const { data: transfer, error: fetchErr } = await supabase.from('stock_transfers')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr || !transfer) return res.status(404).json({ error: 'Transfer not found' });

    if (transfer.status === 'completed') {
      return res.status(400).json({ error: 'Transfer has already been accepted' });
    }

    if (user_id && transfer.to_id !== user_id) {
      return res.status(403).json({ error: 'You are not authorized to accept this transfer' });
    }

    const { data: updatedTr, error: updateErr } = await supabase.from('stock_transfers')
      .update({ status: 'completed' })
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    const { data: currentStock } = await supabase.from('stocks')
      .select('*')
      .eq('owner_id', transfer.to_id)
      .eq('product_id', transfer.product_id)
      .maybeSingle();

    if (currentStock) {
      await supabase.from('stocks')
        .update({ quantity: currentStock.quantity + transfer.quantity })
        .eq('id', currentStock.id);
    } else {
      await supabase.from('stocks').insert([{
        owner_id: transfer.to_id,
        product_id: transfer.product_id,
        quantity: transfer.quantity
      }]);
    }

    const { data: recipientUser } = await supabase.from('users').select('*').eq('id', user_id || transfer.to_id).maybeSingle();
    const isSalesman = recipientUser?.role === 'salesman';
    const actorRole = isSalesman ? 'Salesman' : 'Field Sales Manager';

    await logAudit(user_id || transfer.to_id, actorRole, 'ACCEPT_STOCK_TRANSFER', 'stock_transfers', id, `Confirmed receipt of ${transfer.quantity} units`);
    processTransferCommission(updatedTr || transfer);
    return res.json({ message: 'Transfer accepted successfully. Stock added to inventory.', transfer: updatedTr });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Recall Stock (Reverse Allocation from supervised Salesman back to FSM - Protected by Operations Limiter)
router.post('/api/stock/recall', fsmOperationsLimiter, async (req, res) => {
  const { fsm_id, salesman_id, product_id, quantity, reason } = req.body;
  if (!fsm_id || !salesman_id || !product_id || !quantity) {
    return res.status(400).json({ error: 'fsm_id, salesman_id, product_id, and quantity are required' });
  }

  const recallQty = parseInt(quantity);

  try {
    const { data: salesman } = await supabase.from('users').select('*').eq('id', salesman_id).single();
    if (!salesman || salesman.parent_id !== fsm_id) {
      return res.status(403).json({ error: 'Cannot recall stock from a salesman not under your supervision.' });
    }

    // Check salesman stock
    const { data: smStock, error: smErr } = await supabase.from('stocks')
      .select('*')
      .eq('owner_id', salesman_id)
      .eq('product_id', product_id)
      .maybeSingle();

    if (smErr || !smStock || smStock.quantity < recallQty) {
      return res.status(400).json({ error: `Salesman does not have enough stock to recall (Available: ${smStock?.quantity || 0})` });
    }

    // Deduct from salesman
    await supabase.from('stocks')
      .update({ quantity: smStock.quantity - recallQty })
      .eq('id', smStock.id);

    // Add back to FSM depot stock
    const { data: fsmStock } = await supabase.from('stocks')
      .select('*')
      .eq('owner_id', fsm_id)
      .eq('product_id', product_id)
      .maybeSingle();

    if (fsmStock) {
      await supabase.from('stocks')
        .update({ quantity: fsmStock.quantity + recallQty })
        .eq('id', fsmStock.id);
    } else {
      await supabase.from('stocks').insert([{
        owner_id: fsm_id,
        product_id,
        quantity: recallQty
      }]);
    }

    // Record recall transfer
    await supabase.from('stock_transfers').insert([{
      from_id: salesman_id,
      to_id: fsm_id,
      product_id,
      quantity: recallQty,
      status: 'completed'
    }]);

    await logAudit(fsm_id, 'Field Sales Manager', 'RECALL_STOCK', 'stocks', salesman_id, `Recalled ${recallQty} units from salesman ${salesman.name}. Reason: ${reason || 'N/A'}`);
    return res.json({ message: 'Stock recalled successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get global stock view for all warehouses and team members (Super Admin - Protected by Analytics Rate Limiter)
router.get('/api/stock/global', superAdminAnalyticsLimiter, async (req, res) => {
  try {
    const { data, error } = await supabase.from('stocks').select('*, product:products(name, sku, unit)');
    if (error) throw error;

    const { data: users } = await supabase.from('users').select('id, name, role');
    const { data: warehouses } = await supabase.from('warehouses').select('id, name');

    const userMap = new Map((users || []).map(u => [u.id, u]));
    const whMap = new Map((warehouses || []).map(w => [w.id, w]));

    const resolved = (data || []).map(s => {
      let ownerName = 'Unknown';
      let ownerType = 'unknown';
      if (whMap.has(s.owner_id)) {
        ownerName = whMap.get(s.owner_id).name;
        ownerType = 'warehouse';
      } else if (userMap.has(s.owner_id)) {
        const u = userMap.get(s.owner_id);
        ownerName = `${u.name} (${u.role.replaceAll('_', ' ').toUpperCase()})`;
        ownerType = u.role;
      }
      return {
        ...s,
        owner_name: ownerName,
        owner_type: ownerType
      };
    });

    return res.json(resolved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Full Stock Transfers History (Super Admin & Store Admin & FSM - Protected by General Admin Rate Limiter)
router.get('/api/stock/transfers', superAdminGeneralLimiter, async (req, res) => {
  const { from_id, to_id, status, user_id, id } = req.query;

  try {
    let query = supabase.from('stock_transfers')
      .select('*, product:products(name, sku, unit)');
    if (id) query = query.eq('id', id);
    if (from_id) query = query.eq('from_id', from_id);
    if (to_id) query = query.eq('to_id', to_id);
    if (status && status !== 'all') query = query.eq('status', status);
    if (user_id) query = query.or(`from_id.eq.${user_id},to_id.eq.${user_id}`);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    const { data: users } = await supabase.from('users').select('id, name');
    const { data: warehouses } = await supabase.from('warehouses').select('id, name');
    const nameMap = new Map([
      ...(users || []).map(u => [u.id, u.name]),
      ...(warehouses || []).map(w => [w.id, w.name])
    ]);

    const resolved = (data || []).map(t => {
      let pinHash = 0;
      const idStr = String(t.id);
      for (let i = 0; i < idStr.length; i++) {
        pinHash = ((pinHash << 5) - pinHash) + idStr.charCodeAt(i);
        pinHash |= 0;
      }
      const security_pin = (Math.abs(pinHash) % 900000 + 100000).toString();
      return {
        ...t,
        security_pin,
        from_name: nameMap.get(t.from_id) || 'Unknown Source',
        to_name: nameMap.get(t.to_id) || 'Unknown Destination'
      };
    });

    return res.json(resolved);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Single Transfer Lookup by ID
router.get('/api/stock/transfers/:id', superAdminGeneralLimiter, async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('stock_transfers')
      .select('*, product:products(name, sku, unit)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Transfer not found' });

    let from_name = 'Warehouse';
    let to_name = 'Staff';
    const { data: senderUser } = await supabase.from('users').select('name').eq('id', data.from_id).maybeSingle();
    const { data: senderWh } = await supabase.from('warehouses').select('name').eq('id', data.from_id).maybeSingle();
    const { data: rcvrUser } = await supabase.from('users').select('name').eq('id', data.to_id).maybeSingle();

    from_name = senderUser?.name || senderWh?.name || 'Warehouse';
    to_name = rcvrUser?.name || 'Recipient';

    let pinHash = 0;
    const idStr = String(data.id);
    for (let i = 0; i < idStr.length; i++) {
      pinHash = ((pinHash << 5) - pinHash) + idStr.charCodeAt(i);
      pinHash |= 0;
    }
    const security_pin = (Math.abs(pinHash) % 900000 + 100000).toString();

    return res.json({
      ...data,
      security_pin,
      from_name,
      to_name
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Low-Stock Alerts across warehouses or specific warehouse (Protected by General Admin Rate Limiter)
router.get('/api/stock/alerts', superAdminGeneralLimiter, async (req, res) => {
  const { warehouse_id, owner_id } = req.query;
  const targetOwner = warehouse_id || owner_id;

  try {
    const { data: products, error: pErr } = await supabase.from('products').select('*');
    if (pErr) throw pErr;
    let stockQuery = supabase.from('stocks').select('*');
    if (targetOwner) stockQuery = stockQuery.eq('owner_id', targetOwner);
    const { data: stocks, error: sErr } = await stockQuery;
    if (sErr) throw sErr;

    const alerts = [];
    for (const prod of (products || [])) {
      const totalQty = (stocks || [])
        .filter(s => s.product_id === prod.id)
        .reduce((sum, s) => sum + s.quantity, 0);
      const threshold = prod.min_stock_alert || 20;
      if (totalQty < threshold) {
        alerts.push({
          product: prod,
          total_quantity: totalQty,
          threshold,
          deficit: threshold - totalQty
        });
      }
    }
    return res.json(alerts);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get stock levels for a specific owner (warehouse or user - Protected by Store Admin General Limiter)
router.get('/api/stock/:owner_id', storeAdminGeneralLimiter, async (req, res) => {
  const { owner_id } = req.params;

  try {
    const { data, error } = await supabase.from('stocks').select('*, product:products(name, sku, unit)').eq('owner_id', owner_id);
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
