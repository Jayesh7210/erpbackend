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
    { id: 'c3456789-de23-45ff-67ff-8901abcdef23', name: 'FSM Alpha', email: 'fsm@erp.com', phone: '+91 98765 10002', role: 'field_sales_manager', status: 'approved', warehouse_id: 'w1', parent_id: 'b2345678-cd12-34ef-56df-7890abcdef12', is_on_duty: true, password: 'fsm123', aadhaar_number: '7823 4512 9031', aadhaar_doc: 'Aadhaar_FSM_Alpha.pdf', kyc_status: 'Verified', requires_password_setup: false }
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
  userRequests: [
    {
      id: 'req_seed_101',
      name: 'Rajesh Sharma',
      email: 'salesman.rajesh.sharma@erp.internal',
      phone: '+91 98765 43210',
      role: 'salesman',
      warehouse_id: 'w1',
      parent_id: 'c3456789-de23-45ff-67ff-8901abcdef23',
      requested_by: 'd4567890-ef34-56ff-78ff-9012abcdef34',
      status: 'pending',
      requires_password_setup: true,
      password: 'Sales#2026Password',
      aadhaar_number: '5489 1234 8901',
      kyc_doc: '',
      created_at: new Date(Date.now() - 3600000 * 4).toISOString()
    },
    {
      id: 'req_seed_102',
      name: 'Amit Kulkarni',
      email: 'fsm.amit.kulkarni@erp.internal',
      phone: '+91 98765 43215',
      role: 'field_sales_manager',
      warehouse_id: 'w2',
      parent_id: 'b2345678-cd12-34ef-56df-7890abcdef12',
      requested_by: 'b2345678-cd12-34ef-56df-7890abcdef12',
      status: 'pending',
      requires_password_setup: true,
      password: 'Fsm#2026Password',
      aadhaar_number: '6321 9845 1024',
      kyc_doc: '',
      created_at: new Date(Date.now() - 3600000 * 2).toISOString()
    }
  ],
  products: [
    { id: 'p1', name: 'Premium 20L Water Jar', sku: 'WTR-20L', unit: 'jar', category: 'Beverages', base_price: 300, min_stock_alert: 25, store_admin_commission: 5.0, fsm_commission: 10.0, salesman_commission: 50.0, referral_commission: 10.0, initial_stock_quota: 100, commission_slabs: [{ from_qty: 101, to_qty: 110, added_commission: 5.0, label: 'Tier 1 (+₹5)' }, { from_qty: 111, to_qty: 130, added_commission: 10.0, label: 'Tier 2 (+₹10)' }] },
    { id: 'p2', name: '1L Mineral Water Box (12 Bottles)', sku: 'WTR-1L-BOX', unit: 'box', category: 'Beverages', base_price: 240, min_stock_alert: 15, store_admin_commission: 4.0, fsm_commission: 8.0, salesman_commission: 40.0, referral_commission: 8.0, initial_stock_quota: 100, commission_slabs: [{ from_qty: 101, to_qty: 110, added_commission: 4.0, label: 'Tier 1 (+₹4)' }, { from_qty: 111, to_qty: 130, added_commission: 8.0, label: 'Tier 2 (+₹8)' }] },
    { id: 'p3', name: '500ml Bottled Water Pack (24 Bottles)', sku: 'WTR-500ML', unit: 'pack', category: 'Beverages', base_price: 360, min_stock_alert: 30, store_admin_commission: 6.0, fsm_commission: 12.0, salesman_commission: 60.0, referral_commission: 12.0, initial_stock_quota: 100, commission_slabs: [{ from_qty: 101, to_qty: 110, added_commission: 6.0, label: 'Tier 1 (+₹6)' }, { from_qty: 111, to_qty: 130, added_commission: 12.0, label: 'Tier 2 (+₹12)' }] }
  ],
  prices: [],
  stocks: [
    { owner_id: 'w1', product_id: 'p1', quantity: 100 },
    { owner_id: 'c3456789-de23-45ff-67ff-8901abcdef23', product_id: 'p1', quantity: 40 }
  ],
  intakes: [],
  inwardRequests: [],
  transfers: [],
  sales: [],
  workforceCommissions: [],
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
  payments: [],
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
