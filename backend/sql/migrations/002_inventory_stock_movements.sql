-- =============================================================================
-- Migration 002: Inventory Stock Movements & Scanner System Extensions
-- =============================================================================

-- 1. Extend products table with SKU and Unit of Measurement if not exists
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'pc';

-- Index SKU for rapid catalog lookups
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

-- 2. Create stock_movements table for strict audit trails
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    change INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('sale', 'restock', 'adjustment', 'scan_add', 'scan_remove', 'cancellation')),
    scan_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_scan_id ON stock_movements(scan_id);

-- 3. Row Level Security
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access on stock_movements" ON stock_movements
    FOR ALL TO service_role USING (true) WITH CHECK (true);

