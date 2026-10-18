-- Sales & Distribution Management ERP Database Schema

-- 1. Warehouses Table
CREATE TABLE IF NOT EXISTS warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users Table (Staff & Admins)
CREATE TYPE user_role AS ENUM ('super_admin', 'store_admin', 'field_sales_manager', 'salesman', 'customer', 'distributor');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50),
    password TEXT DEFAULT 'sales123',
    aadhaar_number VARCHAR(100) DEFAULT 'Not Provided',
    aadhaar_doc TEXT DEFAULT 'Aadhaar_Document.pdf',
    kyc_status VARCHAR(50) DEFAULT 'Verified',
    requires_password_setup BOOLEAN DEFAULT FALSE,
    role user_role NOT NULL,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    parent_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Reports to
    referrer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_on_duty BOOLEAN DEFAULT TRUE,
    status approval_status DEFAULT 'approved', -- Direct additions by Super Admin default to approved
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Dynamic Roles & Permissions Table (Configurable by Super Admin without code changes)
CREATE TABLE IF NOT EXISTS roles_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role user_role NOT NULL,
    permission_key VARCHAR(100) NOT NULL,
    is_allowed BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role, permission_key)
);

-- 4. Customers Table (Retail & Distributors)
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    customer_type VARCHAR(50) DEFAULT 'retail', -- 'retail' or 'distributor'
    referral_code VARCHAR(50) UNIQUE,
    referred_by UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Products Table
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100) UNIQUE NOT NULL,
    unit VARCHAR(50) DEFAULT 'pcs',
    category VARCHAR(100) DEFAULT 'General',
    image_url TEXT,
    base_price DECIMAL(12, 2) DEFAULT 0.00,
    min_stock_alert INT DEFAULT 20,
    store_admin_commission DECIMAL(12, 2) DEFAULT 0.00,
    fsm_commission DECIMAL(12, 2) DEFAULT 0.00,
    salesman_commission DECIMAL(12, 2) DEFAULT 0.00,
    referral_commission DECIMAL(12, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Product Prices (Tiered/Role/Distributor specific pricing configured by Super Admin)
CREATE TABLE IF NOT EXISTS product_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL, -- 'store_admin', 'field_sales_manager', 'salesman', 'distributor'
    price DECIMAL(12, 2) NOT NULL,
    discount_percentage DECIMAL(5, 2) DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, role)
);

-- 7. Stocks Table (Tracks inventory at any level: warehouse, FSM, or Salesman)
CREATE TABLE IF NOT EXISTS stocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL, -- Can point to warehouse_id (for central warehouse stock) or user_id (for FSM/Salesman stock)
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_id, product_id)
);

-- 8. Stock Inward Requests (Store Admin adding stock, requires Super Admin approval)
CREATE TABLE IF NOT EXISTS stock_inward_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    receipt_url TEXT, -- Document/Receipt verification image
    status approval_status DEFAULT 'pending',
    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8.1 Stock Intakes (Store Admin direct intake with batch, supplier, date received)
CREATE TABLE IF NOT EXISTS stock_intakes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    batch_number VARCHAR(100),
    supplier VARCHAR(255),
    date_received DATE DEFAULT CURRENT_DATE,
    receipt_url TEXT,
    received_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. User Creation Requests (For Store Admin/FSM to add workforce, requires Super Admin approval)
CREATE TABLE IF NOT EXISTS user_creation_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role user_role NOT NULL,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    parent_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status approval_status DEFAULT 'pending',
    requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. Stock Transfers Table (Warehouse -> FSM, FSM -> Salesman)
CREATE TYPE transfer_status AS ENUM ('pending', 'completed', 'cancelled');
CREATE TABLE IF NOT EXISTS stock_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL, -- warehouse_id or user_id
    to_id UUID NOT NULL,   -- user_id (FSM or Salesman)
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    status transfer_status DEFAULT 'completed',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Sales Table (Direct Warehouse Retail, Distributor Bulk, and Salesman Field Sales)
CREATE TYPE payment_mode AS ENUM ('cash', 'online');
CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    salesman_id UUID REFERENCES users(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    customer_type VARCHAR(50) DEFAULT 'retail', -- 'retail' or 'distributor'
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    amount DECIMAL(12, 2) NOT NULL,
    payment_method payment_mode NOT NULL,
    referral_code VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 12. Referral Bonus Rules (Legacy global policy removed; referral commissions are managed per-product on products.referral_commission)
DROP TABLE IF EXISTS referral_rules CASCADE;

-- 13. Referrals Ledger Table (Track chain, qualification, and payouts)
CREATE TYPE referral_status AS ENUM ('pending', 'qualified', 'paid', 'rejected');
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    referred_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    bonus_amount DECIMAL(10, 2) NOT NULL,
    status referral_status DEFAULT 'pending',
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 14. Audit Logs (Full audit trail of all system-wide actions)
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name VARCHAR(255),
    action VARCHAR(255) NOT NULL,
    entity_name VARCHAR(100) NOT NULL,
    entity_id UUID,
    details TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 15. Salesman Candidate Recruitment Requests (FSM review queue)
CREATE TABLE IF NOT EXISTS referral_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_name VARCHAR(255) NOT NULL,
    referred_by VARCHAR(255),
    phone VARCHAR(50),
    location VARCHAR(255),
    documents TEXT[],
    status VARCHAR(50) DEFAULT 'pending',
    priority VARCHAR(50) DEFAULT 'normal',
    is_new BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 16. Salesman Peer Referrals Ledger (Salesman referring other salesmen for bottle commission)
CREATE TABLE IF NOT EXISTS salesman_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'Active',
    earned DECIMAL(10, 2) DEFAULT 0.00,
    bottles_sold INT DEFAULT 0,
    kyc_doc TEXT,
    kyc_status VARCHAR(50) DEFAULT 'Verified',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 17. Daily Salesman Settlements (End of day inventory & cash tally)
CREATE TABLE IF NOT EXISTS settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    salesman_id UUID REFERENCES users(id) ON DELETE CASCADE,
    date_label VARCHAR(100) DEFAULT 'Today',
    bottles_dispatched INT NOT NULL DEFAULT 0,
    bottles_sold INT NOT NULL DEFAULT 0,
    unsold_bottles INT NOT NULL DEFAULT 0,
    unit_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_value DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    sold_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    unsold_value DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    cash_collected DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    difference DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'tally_zero',
    return_qr_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- INITIAL SEED (Zero dummy data, ONLY single Super Admin account & default rules)
-- ============================================================================

-- 1. Single Super Admin account (admin@erp.com / admin123)
INSERT INTO users (id, name, email, phone, role, password, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Super Admin', 'admin@erp.com', '+91 99999 00001', 'super_admin', 'admin123', 'approved')
ON CONFLICT (email) DO UPDATE SET password = 'admin123', phone = '+91 99999 00001';

-- 2. Default Dynamic Roles & Permissions
INSERT INTO roles_permissions (role, permission_key, is_allowed) VALUES
('store_admin', 'add_stock', TRUE),
('store_admin', 'transfer_fsm', TRUE),
('store_admin', 'direct_sale', TRUE),
('store_admin', 'bulk_sale_distributor', TRUE),
('field_sales_manager', 'receive_stock', TRUE),
('field_sales_manager', 'transfer_salesman', TRUE),
('field_sales_manager', 'direct_sale', TRUE),
('salesman', 'view_assigned_stock', TRUE),
('salesman', 'sell_to_customer', TRUE),
('salesman', 'onboard_customer', TRUE)
ON CONFLICT (role, permission_key) DO NOTHING;
