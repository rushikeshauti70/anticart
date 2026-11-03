-- =============================================================================
-- AVCOE SMART TROLLEY - PRODUCTION SUPABASE DATABASE SCHEMA
-- File: FINAL_SUPABASE_SCHEMA.sql
-- Description: Consolidated, clean, highly optimized, production-ready schema
-- Compatible with: PostgreSQL 15+ / Supabase
-- =============================================================================

-- Enable essential extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. CENTRAL MASTER PRODUCT CATALOG (catalog_products)
-- Global master directory of all registered retail products across store branches
-- =============================================================================
CREATE TABLE IF NOT EXISTS catalog_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barcode TEXT UNIQUE NULL,
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    brand TEXT NULL,
    description TEXT NULL,
    image_url TEXT NULL,
    default_price NUMERIC(10,2) NOT NULL CHECK (default_price >= 0),
    unit TEXT NOT NULL DEFAULT 'pc',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Master Catalog Indexes
CREATE INDEX IF NOT EXISTS idx_catalog_products_barcode ON catalog_products(barcode);
CREATE INDEX IF NOT EXISTS idx_catalog_products_sku ON catalog_products(sku);
CREATE INDEX IF NOT EXISTS idx_catalog_products_name ON catalog_products(name);
CREATE INDEX IF NOT EXISTS idx_catalog_products_category ON catalog_products(category);
CREATE INDEX IF NOT EXISTS idx_catalog_products_brand ON catalog_products(brand);
CREATE INDEX IF NOT EXISTS idx_catalog_products_active ON catalog_products(is_active);

-- =============================================================================
-- 2. STORE INVENTORY (products)
-- Local active inventory items linked to the master catalog
-- =============================================================================
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_product_id UUID NULL REFERENCES catalog_products(id) ON DELETE SET NULL,
    barcode TEXT UNIQUE NOT NULL,
    sku TEXT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    gst_percent NUMERIC(5,2) NOT NULL DEFAULT 0.0 CHECK (gst_percent >= 0 AND gst_percent <= 100),
    stock INTEGER NULL CHECK (stock IS NULL OR stock >= 0),
    unit TEXT NOT NULL DEFAULT 'pc',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Store Inventory Indexes
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_catalog_id ON products(catalog_product_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_stock ON products(stock);

-- =============================================================================
-- 3. STOCK MOVEMENTS AUDIT TRAIL (stock_movements)
-- Immutable ledger recording every stock increment and decrement
-- =============================================================================
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    change INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('sale', 'restock', 'adjustment', 'scan_add', 'scan_remove', 'cancellation')),
    scan_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stock Movement Indexes
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reason ON stock_movements(reason);
CREATE INDEX IF NOT EXISTS idx_stock_movements_scan_id ON stock_movements(scan_id);

-- =============================================================================
-- 4. ACTIVE SHOPPING CARTS (carts)
-- Customer carts tracked per physical trolley or virtual session
-- =============================================================================
CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trolley_id TEXT NOT NULL DEFAULT 'trolley-01',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cart Indexes
CREATE INDEX IF NOT EXISTS idx_carts_trolley_status ON carts(trolley_id, status);
CREATE INDEX IF NOT EXISTS idx_carts_created_at ON carts(created_at DESC);

-- =============================================================================
-- 5. CART LINE ITEMS (cart_items)
-- Products inside an open shopping cart with atomic quantities
-- =============================================================================
CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cart_id, product_id)
);

-- Cart Item Indexes
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items(product_id);

-- =============================================================================
-- 6. SCAN EVENTS AUDIT LOG (scan_events)
-- High-throughput log of all scans with client-generated scanId for idempotency
-- =============================================================================
CREATE TABLE IF NOT EXISTS scan_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID UNIQUE NOT NULL,
    cart_id UUID REFERENCES carts(id) ON DELETE SET NULL,
    barcode TEXT NOT NULL,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    result TEXT NOT NULL CHECK (result IN ('added', 'unknown', 'duplicate', 'rejected', 'out_of_stock')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scan Event Indexes
CREATE INDEX IF NOT EXISTS idx_scan_events_scan_id ON scan_events(scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_created_at ON scan_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_barcode ON scan_events(barcode);
CREATE INDEX IF NOT EXISTS idx_scan_events_result ON scan_events(result);

-- =============================================================================
-- 7. COMPLETED ORDERS & INVOICES (purchases)
-- Immutable transaction header for completed customer checkouts
-- =============================================================================
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID REFERENCES carts(id) ON DELETE SET NULL,
    trolley_id TEXT NOT NULL DEFAULT 'trolley-01',
    subtotal NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
    gst_total NUMERIC(10,2) NOT NULL CHECK (gst_total >= 0),
    total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'upi', 'mock')),
    cancelled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Purchase Indexes
CREATE INDEX IF NOT EXISTS idx_purchases_created_at ON purchases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_trolley_id ON purchases(trolley_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

-- =============================================================================
-- 8. PURCHASE LINE ITEM SNAPSHOTS (purchase_items)
-- Immutable snapshots of purchased items with pricing at transaction time
-- =============================================================================
CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    gst_percent NUMERIC(5,2) NOT NULL DEFAULT 0.0 CHECK (gst_percent >= 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    line_subtotal NUMERIC(10,2) NOT NULL CHECK (line_subtotal >= 0),
    line_gst NUMERIC(10,2) NOT NULL CHECK (line_gst >= 0),
    line_total NUMERIC(10,2) NOT NULL CHECK (line_total >= 0)
);

-- Purchase Items Indexes
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product_id ON purchase_items(product_id);

-- =============================================================================
-- 9. HARDWARE EVENT LOG (trolley_events)
-- Log of hardware events, alerts, and operational signals from ESP32 robots
-- =============================================================================
CREATE TABLE IF NOT EXISTS trolley_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL DEFAULT 'trolley-01',
    event TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    message TEXT NULL,
    device_ts BIGINT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trolley Event Indexes
CREATE INDEX IF NOT EXISTS idx_trolley_events_device_received ON trolley_events(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_trolley_events_severity ON trolley_events(severity);

-- =============================================================================
-- 10. SAMPLED HARDWARE TELEMETRY (trolley_telemetry)
-- Periodic sampled telemetry (battery, RSSI, speed, obstacle distance, weight)
-- =============================================================================
CREATE TABLE IF NOT EXISTS trolley_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL DEFAULT 'trolley-01',
    payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trolley Telemetry Indexes
CREATE INDEX IF NOT EXISTS idx_trolley_telemetry_device_recorded ON trolley_telemetry(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_trolley_telemetry_payload_gin ON trolley_telemetry USING gin(payload);

-- =============================================================================
-- 11. SYSTEM SETTINGS & CONFIGURATION (system_settings)
-- Store-wide configurable thresholds, features, and operational limits
-- =============================================================================
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default system settings
INSERT INTO system_settings (key, value, description)
VALUES 
    ('store_info', '{"name": "AVCOE Smart Retail Store", "branch": "Main Campus", "currency": "INR", "symbol": "₹"}', 'Store identity details'),
    ('pos_rules', '{"default_gst_percent": 5.0, "low_stock_threshold": 5, "allow_negative_stock": false, "debounce_ms": 1500}', 'Point of Sale scanning and stock validation rules'),
    ('excel_logger', '{"flush_interval_sec": 5, "max_buffer_size": 5000, "retention_days": 30}', 'Excel live logging worker configuration')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 12. AUTOMATIC TIMESTAMP UPDATE TRIGGER
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply timestamp triggers
DROP TRIGGER IF EXISTS trg_catalog_products_updated_at ON catalog_products;
CREATE TRIGGER trg_catalog_products_updated_at
    BEFORE UPDATE ON catalog_products
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_carts_updated_at ON carts;
CREATE TRIGGER trg_carts_updated_at
    BEFORE UPDATE ON carts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_cart_items_updated_at ON cart_items;
CREATE TRIGGER trg_cart_items_updated_at
    BEFORE UPDATE ON cart_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON system_settings;
CREATE TRIGGER trg_system_settings_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 13. REAL-TIME ANALYTICS VIEWS
-- Ultra-fast aggregated views for Admin Dashboard without full table scans
-- =============================================================================

-- View 1: Daily Sales & Revenue Statistics
CREATE OR REPLACE VIEW view_daily_sales_stats AS
SELECT
    DATE_TRUNC('day', created_at) AS sale_date,
    COUNT(id) AS total_orders,
    COALESCE(SUM(subtotal), 0) AS gross_subtotal,
    COALESCE(SUM(gst_total), 0) AS total_gst,
    COALESCE(SUM(total), 0) AS gross_revenue,
    ROUND(COALESCE(AVG(total), 0), 2) AS avg_order_value
FROM purchases
WHERE status = 'completed'
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY sale_date DESC;

-- View 2: Sales & Revenue by Product Category
CREATE OR REPLACE VIEW view_category_sales AS
SELECT
    COALESCE(p.category, 'General') AS category,
    COUNT(pi.id) AS lines_sold,
    COALESCE(SUM(pi.quantity), 0) AS units_sold,
    COALESCE(SUM(pi.line_total), 0) AS total_revenue
FROM purchase_items pi
LEFT JOIN products p ON pi.product_id = p.id
JOIN purchases pr ON pi.purchase_id = pr.id
WHERE pr.status = 'completed'
GROUP BY p.category
ORDER BY total_revenue DESC;

-- View 3: Live Store Inventory Health Summary
CREATE OR REPLACE VIEW view_inventory_summary AS
SELECT
    COUNT(id) AS total_skus,
    COALESCE(SUM(stock), 0) AS total_units_in_stock,
    COALESCE(SUM(stock * price), 0) AS total_inventory_valuation,
    COUNT(CASE WHEN stock = 0 THEN 1 END) AS out_of_stock_count,
    COUNT(CASE WHEN stock > 0 AND stock <= 5 THEN 1 END) AS low_stock_count,
    COUNT(CASE WHEN stock > 5 THEN 1 END) AS healthy_stock_count
FROM products
WHERE active = true;

-- View 4: Latest Telemetry per Trolley Device
CREATE OR REPLACE VIEW view_latest_trolley_telemetry AS
SELECT DISTINCT ON (device_id)
    device_id,
    payload,
    recorded_at
FROM trolley_telemetry
ORDER BY device_id, recorded_at DESC;

-- =============================================================================
-- 14. ADMIN DASHBOARD RPC FUNCTION (Single Round-Trip Aggregation)
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_get_admin_dashboard_kpis()
RETURNS JSONB AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'revenue', (
            SELECT jsonb_build_object(
                'total_revenue', COALESCE(SUM(total), 0),
                'net_sales', COALESCE(SUM(subtotal), 0),
                'tax_collected', COALESCE(SUM(gst_total), 0),
                'order_count', COUNT(id),
                'avg_order_value', ROUND(COALESCE(AVG(total), 0), 2)
            )
            FROM purchases WHERE status = 'completed'
        ),
        'inventory', (
            SELECT jsonb_build_object(
                'total_skus', COUNT(id),
                'total_units', COALESCE(SUM(stock), 0),
                'valuation', COALESCE(SUM(stock * price), 0),
                'out_of_stock', COUNT(CASE WHEN stock = 0 THEN 1 END),
                'low_stock', COUNT(CASE WHEN stock > 0 AND stock <= 5 THEN 1 END),
                'healthy_stock', COUNT(CASE WHEN stock > 5 THEN 1 END)
            )
            FROM products WHERE active = true
        ),
        'scans', (
            SELECT jsonb_build_object(
                'total_scans', COUNT(id),
                'successful_scans', COUNT(CASE WHEN result = 'added' THEN 1 END),
                'unknown_scans', COUNT(CASE WHEN result = 'unknown' THEN 1 END),
                'duplicate_scans', COUNT(CASE WHEN result = 'duplicate' THEN 1 END),
                'out_of_stock_scans', COUNT(CASE WHEN result = 'out_of_stock' THEN 1 END)
            )
            FROM scan_events
        ),
        'catalog_count', (SELECT COUNT(id) FROM catalog_products WHERE is_active = true),
        'active_carts', (SELECT COUNT(id) FROM carts WHERE status = 'open')
    ) INTO result;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 15. ROW LEVEL SECURITY (RLS) POLICIES
-- Strict multi-tenant data access control:
-- 1. Backend Service Role has full administrative control
-- 2. Authenticated users & anonymous shoppers have strictly controlled read/write access
-- =============================================================================

-- Enable RLS across all tables
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE trolley_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trolley_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- 1. catalog_products
CREATE POLICY "Public read on active catalog products" ON catalog_products
    FOR SELECT TO anon, authenticated USING (is_active = true);
CREATE POLICY "Service role full access on catalog_products" ON catalog_products
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. products (Store Inventory)
CREATE POLICY "Public read on active products" ON products
    FOR SELECT TO anon, authenticated USING (active = true);
CREATE POLICY "Service role full access on products" ON products
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. stock_movements
CREATE POLICY "Service role full access on stock_movements" ON stock_movements
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Staff read on stock_movements" ON stock_movements
    FOR SELECT TO authenticated USING (true);

-- 4. carts
CREATE POLICY "Public read and write on shopping carts" ON carts
    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on carts" ON carts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. cart_items
CREATE POLICY "Public read and write on cart items" ON cart_items
    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on cart_items" ON cart_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. scan_events
CREATE POLICY "Public insert on scan events" ON scan_events
    FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Service role full access on scan_events" ON scan_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 7. purchases
CREATE POLICY "Public read on completed purchases" ON purchases
    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public insert on completed purchases" ON purchases
    FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Service role full access on purchases" ON purchases
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 8. purchase_items
CREATE POLICY "Public read on purchase items" ON purchase_items
    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public insert on purchase items" ON purchase_items
    FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Service role full access on purchase_items" ON purchase_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 9. trolley_events
CREATE POLICY "Public read on trolley events" ON trolley_events
    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Service role full access on trolley_events" ON trolley_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 10. trolley_telemetry
CREATE POLICY "Public read on trolley telemetry" ON trolley_telemetry
    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Service role full access on trolley_telemetry" ON trolley_telemetry
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 11. system_settings
CREATE POLICY "Public read on system settings" ON system_settings
    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Service role full access on system_settings" ON system_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- 16. PERMISSIONS & SCHEMA GRANTS
-- =============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON catalog_products, products, carts, cart_items, purchases, purchase_items, trolley_events, trolley_telemetry, system_settings TO anon;
GRANT INSERT, UPDATE, DELETE ON carts, cart_items TO anon;
GRANT INSERT ON scan_events, purchases, purchase_items TO anon;
GRANT EXECUTE ON FUNCTION fn_get_admin_dashboard_kpis() TO anon, authenticated, service_role;

-- =============================================================================
-- END OF FINAL_SUPABASE_SCHEMA.sql
-- =============================================================================
