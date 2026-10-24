-- ============================================================================
-- SUPABASE MIGRATION: PRODUCTION SCHEMA ALIGNMENT & MISSING TABLES
-- ============================================================================
-- Execute this script directly in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/ficltneuoskqjqrkwyuj/sql/new
--
-- All statements are safe & idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- ============================================================================

-- 1. Ensure required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1B. Custom Enums
DO $$ BEGIN
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'distributor';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'customer';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- 2. ALTER EXISTING TABLES WITH MISSING COLUMNS
-- ============================================================================

-- A. Users Table: Add password, phone, KYC/Aadhaar, referral hierarchy, duty status
ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT DEFAULT 'sales123';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhaar_number VARCHAR(100) DEFAULT 'Not Provided';
ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhaar_doc TEXT DEFAULT 'Aadhaar_Document.pdf';
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(50) DEFAULT 'Verified';
ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_password_setup BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_on_duty BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Set default passwords by role
UPDATE users SET password = 'admin123' WHERE role = 'super_admin' AND (password IS NULL OR password = 'sales123');
UPDATE users SET password = 'store123' WHERE role = 'store_admin' AND password IS NULL;
UPDATE users SET password = 'fsm123' WHERE role = 'field_sales_manager' AND password IS NULL;
UPDATE users SET password = 'sales123' WHERE role = 'salesman' AND password IS NULL;

-- B. Products Table: Add pricing, category, alerts, images, and individual commissions
ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price DECIMAL(12, 2) DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'General';
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock_alert INT DEFAULT 20;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS store_admin_commission DECIMAL(12, 2) DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fsm_commission DECIMAL(12, 2) DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS salesman_commission DECIMAL(12, 2) DEFAULT 0.00;
ALTER TABLE products ADD COLUMN IF NOT EXISTS referral_commission DECIMAL(12, 2) DEFAULT 0.00;

-- B2. Product Prices Table: Add discount_percentage
ALTER TABLE product_prices ADD COLUMN IF NOT EXISTS discount_percentage NUMERIC DEFAULT 0;

-- C. Sales Table: Add warehouse, customer link, customer type, referral code
ALTER TABLE sales ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id UUID;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_type VARCHAR(50) DEFAULT 'retail';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);

-- D. Audit Logs Table: Add user_name
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);

-- E. User Creation Requests: Add phone, rejection reason, referrer_id
ALTER TABLE user_creation_requests ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE user_creation_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE user_creation_requests ADD COLUMN IF NOT EXISTS referrer_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- F. Stock Inward Requests: Add truck, driver details, batch, notes, and challan doc
ALTER TABLE stock_inward_requests ADD COLUMN IF NOT EXISTS truck_number VARCHAR(100);
ALTER TABLE stock_inward_requests ADD COLUMN IF NOT EXISTS driver_name VARCHAR(100);
ALTER TABLE stock_inward_requests ADD COLUMN IF NOT EXISTS driver_phone VARCHAR(50);
ALTER TABLE stock_inward_requests ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);
ALTER TABLE stock_inward_requests ADD COLUMN IF NOT EXISTS challan_doc_url TEXT;
ALTER TABLE stock_inward_requests ADD COLUMN IF NOT EXISTS notes TEXT;

-- G. Stock Transfers: Add batch_number
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS batch_number VARCHAR(100);

-- ============================================================================
-- 3. CREATE MISSING TABLES
-- ============================================================================

-- A. Dynamic Roles & Permissions Table
CREATE TABLE IF NOT EXISTS roles_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role VARCHAR(50) NOT NULL,
    permission_key VARCHAR(100) NOT NULL,
    is_allowed BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role, permission_key)
);

-- B. Customers & Distributors Directory
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    address TEXT,
    customer_type VARCHAR(50) DEFAULT 'retail', -- 'retail' or 'distributor'
    referral_code VARCHAR(50) UNIQUE,
    referred_by UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- C. Stock Intakes (Factory / Supplier direct deliveries with batching)
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

-- D. Workforce Referral Policy & Bonus Rules (Legacy global policy removed; referral commissions are managed per-product on products.referral_commission)
DROP TABLE IF EXISTS referral_rules CASCADE;

-- E. Workforce Commissions Ledger (A -> B -> C -> D downline bottle commissions)
CREATE TABLE IF NOT EXISTS workforce_commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
    referrer_name VARCHAR(255),
    seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
    seller_name VARCHAR(255),
    sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    bottles_sold INT NOT NULL DEFAULT 0,
    rate_per_bottle DECIMAL(10, 2) NOT NULL DEFAULT 1.00,
    commission_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'quota_pending', -- 'quota_pending', 'unlocked', 'paid'
    referrer_sales_today INT DEFAULT 0,
    min_quota_required INT DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP WITH TIME ZONE
);

-- F. Salesman Peer Referrals Directory
CREATE TABLE IF NOT EXISTS salesman_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
    referred_salesman_id UUID REFERENCES users(id) ON DELETE SET NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'Active',
    earned DECIMAL(10, 2) DEFAULT 0.00,
    bottles_sold INT DEFAULT 0,
    kyc_doc TEXT,
    kyc_status VARCHAR(50) DEFAULT 'Verified',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- G. Daily Salesman Settlements (End of day inventory & cash reconciliation)
CREATE TABLE IF NOT EXISTS settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    salesman_id UUID REFERENCES users(id) ON DELETE CASCADE,
    salesman_name VARCHAR(255),
    fsm_id UUID REFERENCES users(id) ON DELETE SET NULL,
    fsm_name VARCHAR(255),
    date_label VARCHAR(100) DEFAULT 'Today',
    bottles_dispatched INT NOT NULL DEFAULT 0,
    bottles_sold INT NOT NULL DEFAULT 0,
    unsold_bottles INT NOT NULL DEFAULT 0,
    remaining_qty INT NOT NULL DEFAULT 0,
    damaged_qty INT NOT NULL DEFAULT 0,
    damage_notes TEXT,
    damage_image_url TEXT,
    unit_price DECIMAL(10, 2) NOT NULL DEFAULT 351.00,
    total_value DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    sold_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    unsold_value DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    cash_collected DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    cash_received DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    online_payment DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_paid DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    difference DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'pending_fsm', -- 'pending_fsm', 'settled', 'discrepancy'
    security_pin VARCHAR(20),
    return_qr_verified BOOLEAN DEFAULT FALSE,
    settled_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- H. Customer Referrals Ledger (Optional legacy support)
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    referred_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    sale_id UUID REFERENCES sales(id) ON DELETE SET NULL,
    bonus_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(50) DEFAULT 'pending',
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 4. PERFORMANCE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_sales_salesman ON sales(salesman_id);
CREATE INDEX IF NOT EXISTS idx_sales_warehouse ON sales(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_salesman ON settlements(salesman_id);
CREATE INDEX IF NOT EXISTS idx_settlements_fsm ON settlements(fsm_id);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_to ON stock_transfers(from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_stocks_owner_prod ON stocks(owner_id, product_id);
CREATE INDEX IF NOT EXISTS idx_workforce_comm_referrer ON workforce_commissions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_workforce_comm_seller ON workforce_commissions(seller_id);
CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(customer_type);

-- ============================================================================
-- 5. SEED DEFAULT RBAC PERMISSIONS & RULES (Idempotent)
-- ============================================================================

-- Insert default role permissions
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

-- Ensure default Super Admin account exists
INSERT INTO users (id, name, email, phone, role, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Super Admin', 'admin@erp.com', '', 'super_admin', 'approved')
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- 6. GRANT PERMISSIONS (Postgres & Supabase Roles)
-- ============================================================================
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
