// Mock Data Store for fallback/testing
const mockDb = {
  warehouses: [
    { id: 'w1', name: 'Main Central Warehouse', location: 'Mumbai' },
    { id: 'w2', name: 'Secondary Hub', location: 'Pune' }
  ],
  users: [
    { id: '804969de-a546-4e60-8137-c4d914563536', name: 'Super Admin', email: 'admin@erp.com', phone: '+91 99999 00001', role: 'super_admin', status: 'approved', warehouse_id: null, parent_id: null, is_on_duty: true, password: 'admin123', aadhaar_number: '5489 1234 8901', aadhaar_doc: 'Aadhaar_SuperAdmin.pdf', kyc_status: 'Verified', requires_password_setup: false },
    { id: 'u1', name: 'Super Admin', email: 'admin@erp.com', phone: '+91 99999 00001', role: 'super_admin', status: 'approved', warehouse_id: null, parent_id: null, is_on_duty: true, password: 'admin123', aadhaar_number: '5489 1234 8901', aadhaar_doc: 'Aadhaar_SuperAdmin.pdf', kyc_status: 'Verified', requires_password_setup: false },
    { id: 'b2345678-cd12-34ef-56df-7890abcdef12', name: 'Store Admin One', email: 'store@erp.com', phone: '+91 98765 10001', role: 'store_admin', status: 'approved', warehouse_id: 'w1', parent_id: null, is_on_duty: true, password: 'store123', aadhaar_number: '6321 9845 1024', aadhaar_doc: 'Aadhaar_StoreAdmin_One.pdf', kyc_status: 'Verified', requires_password_setup: false },
    { id: 'c3456789-de23-45ff-67ff-8901abcdef23', name: 'FSM Alpha', email: 'fsm@erp.com', phone: '+91 98765 10002', role: 'field_sales_manager', status: 'approved', warehouse_id: 'w1', parent_id: 'b2345678-cd12-34ef-56df-7890abcdef12', is_on_duty: true, password: 'fsm123', aadhaar_number: '7823 4512 9031', aadhaar_doc: 'Aadhaar_FSM_Alpha.pdf', kyc_status: 'Verified', requires_password_setup: false },
    // Salesman A (First salesman)
    { id: 'd4567890-ef34-56ff-78ff-9012abcdef34', name: 'Salesman John (A)', email: 'sales@erp.com', phone: '+91 98765 20001', role: 'salesman', status: 'approved', warehouse_id: 'w1', parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23', referrer_id: null, is_on_duty: true, password: 'sales123', aadhaar_number: '8921 7845 2314', aadhaar_doc: 'Aadhaar_Salesman_John.pdf', kyc_status: 'Verified', requires_password_setup: false },
    // Salesman B (Referred by A)
    { id: 'b0000000-0000-0000-0000-000000000002', name: 'Salesman Bharat (B)', email: 'sales_b@erp.com', phone: '+91 98765 20002', role: 'salesman', status: 'approved', warehouse_id: 'w1', parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23', referrer_id: 'd4567890-ef34-56ff-78ff-9012abcdef34', is_on_duty: true, password: 'sales123', aadhaar_number: '9012 3456 7812', aadhaar_doc: 'Aadhaar_Bharat.pdf', kyc_status: 'Verified', requires_password_setup: false },
    // Salesman C (Referred by B)
    { id: 'c0000000-0000-0000-0000-000000000003', name: 'Salesman Chirag (C)', email: 'sales_c@erp.com', phone: '+91 98765 20003', role: 'salesman', status: 'approved', warehouse_id: 'w1', parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23', referrer_id: 'b0000000-0000-0000-0000-000000000002', is_on_duty: true, password: 'sales123', aadhaar_number: '3456 7890 1234', aadhaar_doc: 'Aadhaar_Chirag.pdf', kyc_status: 'Verified', requires_password_setup: false },
    // Salesman D (Referred by A)
    { id: 'd0000000-0000-0000-0000-000000000004', name: 'Salesman Deepak (D)', email: 'sales_d@erp.com', phone: '+91 98765 20004', role: 'salesman', status: 'approved', warehouse_id: 'w1', parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23', referrer_id: 'd4567890-ef34-56ff-78ff-9012abcdef34', is_on_duty: true, password: 'sales123', aadhaar_number: '7890 1234 5678', aadhaar_doc: 'Aadhaar_Deepak.pdf', kyc_status: 'Verified', requires_password_setup: false }
  ],
  roles_permissions: [
    { role: 'store_admin', permission_key: 'add_stock', is_allowed: true },
    { role: 'store_admin', permission_key: 'transfer_fsm', is_allowed: true },
    { role: 'store_admin', permission_key: 'direct_sale', is_allowed: true },
    { role: 'store_admin', permission_key: 'bulk_sale_distributor', is_allowed: true },
    { role: 'field_sales_manager', permission_key: 'receive_stock', is_allowed: true },
    { role: 'field_sales_manager', permission_key: 'transfer_salesman', is_allowed: true },
    { role: 'field_sales_manager', permission_key: 'direct_sale', is_allowed: true },
    { role: 'salesman', permission_key: 'view_assigned_stock', is_allowed: true },
    { role: 'salesman', permission_key: 'sell_to_customer', is_allowed: true },
    { role: 'salesman', permission_key: 'onboard_customer', is_allowed: true }
  ],
  customers: [],
  userRequests: [],
  products: [
    { id: 'p1', name: 'Premium 20L Water Jar', sku: 'WTR-20L', unit: 'jar', category: 'Beverages', base_price: 300, min_stock_alert: 25, store_admin_commission: 5.0, fsm_commission: 10.0, salesman_commission: 50.0, referral_commission: 10.0 },
    { id: 'p2', name: '1L Mineral Water Box (12 Bottles)', sku: 'WTR-1L-BOX', unit: 'box', category: 'Beverages', base_price: 240, min_stock_alert: 15, store_admin_commission: 4.0, fsm_commission: 8.0, salesman_commission: 40.0, referral_commission: 8.0 },
    { id: 'p3', name: '500ml Bottled Water Pack (24 Bottles)', sku: 'WTR-500ML', unit: 'pack', category: 'Beverages', base_price: 360, min_stock_alert: 30, store_admin_commission: 6.0, fsm_commission: 12.0, salesman_commission: 60.0, referral_commission: 12.0 }
  ],
  prices: [],
  stocks: [
    { owner_id: 'w1', product_id: 'p1', quantity: 100 },
    { owner_id: 'c3456789-de23-45ff-67ff-8901abcdef23', product_id: 'p1', quantity: 40 }, // FSM Alpha
    { owner_id: 'd4567890-ef34-56ff-78ff-9012abcdef34', product_id: 'p1', quantity: 10 }, // Salesman A
    { owner_id: 'b0000000-0000-0000-0000-000000000002', product_id: 'p1', quantity: 10 }, // Salesman B
    { owner_id: 'c0000000-0000-0000-0000-000000000003', product_id: 'p1', quantity: 10 }, // Salesman C
    { owner_id: 'd0000000-0000-0000-0000-000000000004', product_id: 'p1', quantity: 10 }  // Salesman D
  ],
  intakes: [],
  inwardRequests: [],
  transfers: [],
  sales: [
    // A sold 6 bottles today (Qualifies for condition >= 5 quota)
    { id: 'sale_101', salesman_id: 'd4567890-ef34-56ff-78ff-9012abcdef34', product_id: 'p1', quantity: 6, amount: 1800.00, payment_method: 'online', created_at: new Date(Date.now() - 3600000 * 4).toISOString() },
    // B sold 10 bottles today -> Generates ₹10 commission for A
    { id: 'sale_102', salesman_id: 'b0000000-0000-0000-0000-000000000002', product_id: 'p1', quantity: 10, amount: 3000.00, payment_method: 'cash', created_at: new Date(Date.now() - 3600000 * 3).toISOString() },
    // C sold 10 bottles today -> Generates ₹10 commission for B
    { id: 'sale_103', salesman_id: 'c0000000-0000-0000-0000-000000000003', product_id: 'p1', quantity: 10, amount: 3000.00, payment_method: 'online', created_at: new Date(Date.now() - 3600000 * 2).toISOString() },
    // D sold 10 bottles today -> Generates ₹10 commission for A
    { id: 'sale_104', salesman_id: 'd0000000-0000-0000-0000-000000000004', product_id: 'p1', quantity: 10, amount: 3000.00, payment_method: 'cash', created_at: new Date(Date.now() - 3600000 * 1).toISOString() }
  ],
  workforceCommissions: [
    {
      id: 'w_comm_101',
      referrer_id: 'd4567890-ef34-56ff-78ff-9012abcdef34',
      referrer_name: 'Salesman John (A)',
      seller_id: 'b0000000-0000-0000-0000-000000000002',
      seller_name: 'Salesman Bharat (B)',
      bottles_sold: 10,
      rate_per_bottle: 1.00,
      commission_amount: 10.00,
      status: 'unlocked', // Qualified because John sold 6 bottles >= 5 quota
      created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
      paid_at: null
    },
    {
      id: 'w_comm_102',
      referrer_id: 'b0000000-0000-0000-0000-000000000002',
      referrer_name: 'Salesman Bharat (B)',
      seller_id: 'c0000000-0000-0000-0000-000000000003',
      seller_name: 'Salesman Chirag (C)',
      bottles_sold: 10,
      rate_per_bottle: 1.00,
      commission_amount: 10.00,
      status: 'unlocked', // Qualified because Bharat sold 10 bottles >= 5 quota
      created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      paid_at: null
    },
    {
      id: 'w_comm_103',
      referrer_id: 'd4567890-ef34-56ff-78ff-9012abcdef34',
      referrer_name: 'Salesman John (A)',
      seller_id: 'd0000000-0000-0000-0000-000000000004',
      seller_name: 'Salesman Deepak (D)',
      bottles_sold: 10,
      rate_per_bottle: 1.00,
      commission_amount: 10.00,
      status: 'unlocked', // Qualified because John sold 6 bottles >= 5 quota
      created_at: new Date(Date.now() - 3600000 * 1).toISOString(),
      paid_at: null
    }
  ],
  referrals: [],
  salesmanReferrals: [
    {
      id: 'sm_ref_101',
      referrer_id: 'd4567890-ef34-56ff-78ff-9012abcdef34',
      referred_salesman_id: 'b0000000-0000-0000-0000-000000000002',
      full_name: 'Salesman Bharat (B)',
      phone: '+91 98765 20002',
      status: 'Active',
      earned: 10.00,
      bottles_sold: 10,
      kyc_doc: '',
      kyc_status: 'Verified',
      created_at: new Date(Date.now() - 86400000 * 2).toISOString()
    },
    {
      id: 'sm_ref_102',
      referrer_id: 'd4567890-ef34-56ff-78ff-9012abcdef34',
      referred_salesman_id: 'd0000000-0000-0000-0000-000000000004',
      full_name: 'Salesman Deepak (D)',
      phone: '+91 98765 20004',
      status: 'Active',
      earned: 10.00,
      bottles_sold: 10,
      kyc_doc: 'Pan_card.pdf',
      kyc_status: 'Verified',
      created_at: new Date(Date.now() - 86400000 * 1).toISOString()
    },
    {
      id: 'sm_ref_103',
      referrer_id: 'b0000000-0000-0000-0000-000000000002',
      referred_salesman_id: 'c0000000-0000-0000-0000-000000000003',
      full_name: 'Salesman Chirag (C)',
      phone: '+91 98765 20003',
      status: 'Active',
      earned: 10.00,
      bottles_sold: 10,
      kyc_doc: 'Voter_ID.pdf',
      kyc_status: 'Verified',
      created_at: new Date(Date.now() - 86400000 * 1).toISOString()
    }
  ],
  settlements: [],
  payments: [
    {
      id: 'pay_101',
      payment_no: 'PAY-SAL-00841',
      type: 'sale',
      category: 'Direct Retail Sale',
      amount: 1450.00,
      payment_method: 'online',
      status: 'completed',
      payer_name: 'Metro Daily Mart',
      payer_phone: '+91 98231 44521',
      payer_type: 'retail',
      collector_name: 'Amit Kumar',
      collector_role: 'salesman',
      item_description: '25x 20L Water Jars',
      reference_id: 'sale_00841',
      notes: 'UPI Paid (Ref: UPI-9823481230)',
      created_at: new Date(Date.now() - 3600000 * 2).toISOString()
    },
    {
      id: 'pay_102',
      payment_no: 'PAY-SAL-00842',
      type: 'sale',
      category: 'Bulk Wholesale Sale',
      amount: 8500.00,
      payment_method: 'online',
      status: 'completed',
      payer_name: 'Sunrise Hospitality Group',
      payer_phone: '+91 97654 11234',
      payer_type: 'distributor',
      collector_name: 'Main Central Warehouse',
      collector_role: 'store_admin',
      item_description: '150x 20L Water Jars + 20x 500ml Cases',
      reference_id: 'sale_00842',
      notes: 'NEFT Transfer (Ref: HDFC-4829104)',
      created_at: new Date(Date.now() - 3600000 * 5).toISOString()
    },
    {
      id: 'pay_103',
      payment_no: 'PAY-SAL-00843',
      type: 'sale',
      category: 'Field Cash Sale',
      amount: 680.00,
      payment_method: 'cash',
      status: 'completed',
      payer_name: 'Sharma Sweets & Snacks',
      payer_phone: '+91 91234 56789',
      payer_type: 'retail',
      collector_name: 'Rajesh Sharma',
      collector_role: 'field_sales_manager',
      item_description: '12x 20L Water Jars',
      reference_id: 'sale_00843',
      notes: 'Cash collected on-site',
      created_at: new Date(Date.now() - 3600000 * 8).toISOString()
    },
    {
      id: 'pay_104',
      payment_no: 'PAY-STL-00219',
      type: 'settlement',
      category: 'Daily Cash Settlement',
      amount: 4200.00,
      payment_method: 'cash',
      status: 'completed',
      payer_name: 'Amit Kumar (Salesman)',
      payer_phone: '+91 94000 12345',
      payer_type: 'salesman',
      collector_name: 'Rajesh Sharma (FSM)',
      collector_role: 'field_sales_manager',
      item_description: 'Daily Evening Cash Handover (Zero Diff)',
      reference_id: 'stl_00219',
      notes: 'Reconciled & accepted into depot vault',
      created_at: new Date(Date.now() - 3600000 * 22).toISOString()
    },
    {
      id: 'pay_105',
      payment_no: 'PAY-REF-00054',
      type: 'referral_payout',
      category: 'Referral Bonus Disbursement',
      amount: 150.00,
      payment_method: 'online',
      status: 'completed',
      payer_name: 'Sanap ERP Treasury',
      payer_phone: '',
      payer_type: 'system',
      collector_name: 'Vikram Joshi (Partner)',
      collector_role: 'customer',
      item_description: 'Bonus for referring 3 new retail customers',
      reference_id: 'ref_00054',
      notes: 'Direct Bank Payout Processed',
      created_at: new Date(Date.now() - 3600000 * 28).toISOString()
    }
  ],
  referralRequests: [],
  fsmSettlementHub: {
    depot_stock: 0,
    warehouse: {
      received: 0,
      allocated: 0,
      sold: 0,
      returned: 0,
      difference: 0,
      inv_value: 0,
      sold_value: 0,
      status: 'pending_return'
    },
    team_settlement: []
  },
  audit_logs: []
};

module.exports = mockDb;
