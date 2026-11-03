import { Router } from 'express';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { db } from '../db.js';
import { inventory } from '../system.js';
import { sseHub } from '../sse.js';
import { requireAdminOrApiKey } from '../middleware/auth.js';

export const catalogRouter = Router();

const catalogProductSchema = z.object({
  barcode: z.string().trim().optional().nullable(),
  name: z.string().trim().min(1, 'Product name is required'),
  sku: z.string().trim().min(1, 'SKU is required'),
  category: z.string().trim().default('General'),
  brand: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
  image_url: z.string().trim().optional().nullable(),
  default_price: z.coerce.number().min(0, 'Default price must be non-negative'),
  unit: z.string().trim().default('pc'),
  is_active: z.boolean().default(true),
});

// GET /api/catalog (Browse master catalog with live stock status)
catalogRouter.get('/catalog', async (req, res, next) => {
  try {
    const { search = '', category = '', page = '1', pageSize = '50' } = req.query;
    const result = await db.getCatalogProducts({
      search: String(search),
      category: String(category),
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50)),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/catalog/:id
catalogRouter.get('/catalog/:id', async (req, res, next) => {
  try {
    const item = await db.getCatalogProductById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: { code: 'CATALOG_NOT_FOUND', message: 'Catalog product not found' } });
    }
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// POST /api/catalog (Admin create master catalog product)
catalogRouter.post('/catalog', requireAdminOrApiKey, async (req, res, next) => {
  try {
    const validated = catalogProductSchema.parse(req.body);
    const created = await db.createCatalogProduct(validated);
    res.status(201).json(created);
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    if (err.code === 'DUPLICATE_SKU' || err.code === 'DUPLICATE_BARCODE') {
      return res.status(409).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// PUT /api/catalog/:id (Admin edit master catalog product)
catalogRouter.put('/catalog/:id', requireAdminOrApiKey, async (req, res, next) => {
  try {
    const partialSchema = catalogProductSchema.partial();
    const validated = partialSchema.parse(req.body);
    const updated = await db.updateCatalogProduct(req.params.id, validated);
    if (!updated) {
      return res.status(404).json({ error: { code: 'CATALOG_NOT_FOUND', message: 'Catalog product not found' } });
    }
    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    next(err);
  }
});

// DELETE /api/catalog/:id (Admin deactivate catalog product)
catalogRouter.delete('/catalog/:id', requireAdminOrApiKey, async (req, res, next) => {
  try {
    const success = await db.deleteCatalogProduct(req.params.id);
    if (!success) {
      return res.status(404).json({ error: { code: 'CATALOG_NOT_FOUND', message: 'Catalog product not found' } });
    }
    res.json({ success: true, message: 'Catalog product deactivated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/catalog/import (CSV Bulk Import for master catalog)
catalogRouter.post('/catalog/import', requireAdminOrApiKey, async (req, res, next) => {
  try {
    let rows = [];
    if (typeof req.body === 'string' && req.body.trim().startsWith('sku')) {
      rows = parse(req.body, { columns: true, skip_empty_lines: true, trim: true });
    } else if (req.body?.csv) {
      rows = parse(req.body.csv, { columns: true, skip_empty_lines: true, trim: true });
    } else if (Array.isArray(req.body?.items)) {
      rows = req.body.items;
    } else if (Array.isArray(req.body)) {
      rows = req.body;
    } else {
      return res.status(400).json({
        error: { code: 'INVALID_PAYLOAD', message: 'Expected CSV string or JSON array with sku,name,default_price,category' }
      });
    }

    const results = [];
    let addedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const validated = catalogProductSchema.parse({
          sku: row.sku,
          name: row.name,
          barcode: row.barcode || null,
          category: row.category || 'General',
          brand: row.brand || null,
          description: row.description || null,
          image_url: row.image_url || null,
          default_price: row.default_price || row.price || 0,
          unit: row.unit || 'pc',
        });
        const created = await db.createCatalogProduct(validated);
        results.push({ index: i, sku: validated.sku, status: 'success', id: created.id });
        addedCount += 1;
      } catch (err) {
        failedCount += 1;
        results.push({
          index: i,
          sku: row.sku || `row-${i}`,
          status: 'error',
          error: err.code || err.message,
        });
      }
    }

    res.json({ total: rows.length, added: addedCount, failed: failedCount, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/catalog/:id/link-inventory (Add catalog item to inventory with stock)
catalogRouter.post('/catalog/:id/link-inventory', requireAdminOrApiKey, async (req, res, next) => {
  try {
    const { price, stock = 10, gst_percent = 5.0 } = req.body || {};
    const invProduct = await db.linkCatalogProductToInventory(req.params.id, {
      price,
      stock,
      gst_percent,
    });
    res.status(201).json({ success: true, product: invProduct });
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/catalog-add (1-Click Add to Cart directly from Product Catalog with quantity selector)
catalogRouter.post('/cart/catalog-add', async (req, res, next) => {
  try {
    const addSchema = z.object({
      catalogId: z.string().optional(),
      productId: z.string().optional(),
      quantity: z.coerce.number().int().min(1).default(1),
      requestId: z.string().optional(),
      trolleyId: z.string().default('trolley-01'),
      sessionId: z.string().optional(),
    });

    const parsed = addSchema.parse(req.body);
    if (!parsed.catalogId && !parsed.productId) {
      return res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'Either catalogId or productId is required' }
      });
    }

    const result = await inventory.addCatalogItemToCart(parsed);

    if (!result.success) {
      const status = result.out_of_stock ? 409 : 400;
      return res.status(status).json({
        error: {
          code: result.out_of_stock ? 'OUT_OF_STOCK' : 'ADD_FAILED',
          message: result.message,
          product: result.product,
        }
      });
    }

    // Broadcast cart updates over SSE
    sseHub.broadcast('cart', result.cart);

    res.json({
      success: true,
      duplicate: result.duplicate,
      source: 'catalog',
      cart: result.cart,
      item: result.item,
      product: result.product,
      stock_remaining: result.stock_remaining,
    });
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    next(err);
  }
});

