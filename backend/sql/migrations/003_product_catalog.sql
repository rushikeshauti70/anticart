-- =============================================================================
-- Migration 003: Master Product Catalog & Catalog-Inventory Linking
-- =============================================================================

-- 1. Create master catalog_products table
CREATE TABLE IF NOT EXISTS catalog_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    barcode TEXT UNIQUE NULL,
    name TEXT NOT NULL,
    sku TEXT UNIQUE NOT NULL,
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

-- Indexes for lightning-fast search and filtering
CREATE INDEX IF NOT EXISTS idx_catalog_products_barcode ON catalog_products(barcode);
CREATE INDEX IF NOT EXISTS idx_catalog_products_sku ON catalog_products(sku);
CREATE INDEX IF NOT EXISTS idx_catalog_products_name ON catalog_products(name);
CREATE INDEX IF NOT EXISTS idx_catalog_products_category ON catalog_products(category);
CREATE INDEX IF NOT EXISTS idx_catalog_products_brand ON catalog_products(brand);
CREATE INDEX IF NOT EXISTS idx_catalog_products_active ON catalog_products(is_active);

-- 2. Link inventory products table to master catalog
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_product_id UUID NULL REFERENCES catalog_products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_catalog_id ON products(catalog_product_id);

-- 3. Row Level Security Policies
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access on catalog_products" ON catalog_products
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow public read access on active catalog_products" ON catalog_products
    FOR SELECT TO anon, authenticated USING (is_active = true);

