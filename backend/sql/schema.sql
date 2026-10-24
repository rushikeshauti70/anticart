-- =============================================================================
-- AVCOE Smart Trolley - Database Schema (Supabase PostgreSQL)
-- Source: docs/KNOWLEDGE_BASE.md Section 7
-- =============================================================================

-- Enable pgcrypto or uuid-ossp for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. PRODUCTS (Master Catalog managed by shop owner)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barcode TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    gst_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (gst_percent >= 0),
    stock INTEGER NULL CHECK (stock IS NULL OR stock >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. CARTS (Active customer shopping carts)
CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trolley_id TEXT NOT NULL DEFAULT 'trolley-01',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. CART_ITEMS (Line items in a cart)
CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cart_id, product_id)
);

-- 4. SCAN_EVENTS (Audit log of scans with client-generated scanId for idempotency)
CREATE TABLE IF NOT EXISTS scan_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID UNIQUE NOT NULL,
    cart_id UUID REFERENCES carts(id) ON DELETE SET NULL,
    barcode TEXT NOT NULL,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    result TEXT NOT NULL CHECK (result IN ('added', 'unknown', 'duplicate')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. PURCHASES (Completed or cancelled checkout orders / bills)
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID REFERENCES carts(id) ON DELETE SET NULL,
    trolley_id TEXT NOT NULL DEFAULT 'trolley-01',
    subtotal NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
    gst_total NUMERIC(10,2) NOT NULL CHECK (gst_total >= 0),
    total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at TIMESTAMPTZ NULL
);

-- 6. PURCHASE_ITEMS (Immutable snapshot of purchased items at time of sale)
CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    gst_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (gst_percent >= 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    line_subtotal NUMERIC(10,2) NOT NULL CHECK (line_subtotal >= 0),
    line_gst NUMERIC(10,2) NOT NULL CHECK (line_gst >= 0),
    line_total NUMERIC(10,2) NOT NULL CHECK (line_total >= 0)
);

-- 7. TROLLEY_EVENTS (Hardware device lifecycle and warning events)
CREATE TABLE IF NOT EXISTS trolley_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    event TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    message TEXT,
    device_ts TIMESTAMPTZ NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. TROLLEY_TELEMETRY (Sampled telemetry history: 30-60s interval or state changes)
CREATE TABLE IF NOT EXISTS trolley_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE INDEX IF NOT EXISTS idx_carts_trolley_status ON carts(trolley_id, status);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items(product_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_scan_id ON scan_events(scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_cart_id ON scan_events(cart_id);

CREATE INDEX IF NOT EXISTS idx_purchases_created_at ON purchases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_trolley_id ON purchases(trolley_id);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);

CREATE INDEX IF NOT EXISTS idx_trolley_events_device_time ON trolley_events(device_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_trolley_telemetry_device_time ON trolley_telemetry(device_id, received_at DESC);

-- =============================================================================
-- AUTOMATIC TIMESTAMP TRIGGER
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- Protect all tables from public anonymous writes. Backend service-role key
-- bypasses RLS automatically.
-- =============================================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE trolley_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trolley_telemetry ENABLE ROW LEVEL SECURITY;

-- Default policies: allow read-only access for anon if needed, or service-role only
CREATE POLICY "Allow service role full access on products" ON products
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on carts" ON carts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on cart_items" ON cart_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on scan_events" ON scan_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on purchases" ON purchases
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on purchase_items" ON purchase_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on trolley_events" ON trolley_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role full access on trolley_telemetry" ON trolley_telemetry
    FOR ALL TO service_role USING (true) WITH CHECK (true);
