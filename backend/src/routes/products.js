import { Router } from 'express';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { db } from '../db.js';

export const productsRouter = Router();

const productSchema = z.object({
  barcode: z.string().trim().min(1, 'Barcode is required'),
  name: z.string().trim().min(1, 'Product name is required'),
  category: z.string().trim().default('General'),
  price: z.coerce.number().min(0, 'Price must be non-negative'),
  gst_percent: z.coerce.number().min(0).max(100).default(0),
  stock: z.union([z.coerce.number().int().min(0), z.null()]).optional().nullable(),
});

// GET /api/products
productsRouter.get('/products', async (req, res, next) => {
  try {
    const { search = '', category = '', page = '1', pageSize = '50' } = req.query;
    const result = await db.getProducts({
      search: String(search),
      category: String(category),
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 50,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id
productsRouter.get('/products/:id', async (req, res, next) => {
  try {
    const product = await db.getProductById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' } });
    }
    res.json(product);
  } catch (err) {
    next(err);
  }
});

// POST /api/products
productsRouter.post('/products', async (req, res, next) => {
  try {
    const validated = productSchema.parse(req.body);
    const product = await db.createProduct(validated);
    res.status(201).json(product);
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    if (err.code === 'DUPLICATE_BARCODE') {
      return res.status(409).json({ error: { code: 'DUPLICATE_BARCODE', message: err.message } });
    }
    next(err);
  }
});

// PUT /api/products/:id
productsRouter.put('/products/:id', async (req, res, next) => {
  try {
    const partialSchema = productSchema.partial();
    const validated = partialSchema.parse(req.body);
    const updated = await db.updateProduct(req.params.id, validated);
    if (!updated) {
      return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' } });
    }
    res.json(updated);
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    if (err.code === 'DUPLICATE_BARCODE') {
      return res.status(409).json({ error: { code: 'DUPLICATE_BARCODE', message: err.message } });
    }
    next(err);
  }
});

// DELETE /api/products/:id
productsRouter.delete('/products/:id', async (req, res, next) => {
  try {
    const success = await db.deleteProduct(req.params.id);
    if (!success) {
      return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' } });
    }
    res.json({ success: true, message: 'Product removed from active catalog' });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/import
productsRouter.post('/products/import', async (req, res, next) => {
  try {
    let rows = [];

    // Support both raw CSV text or JSON array { items: [...] } or { csv: "..." }
    if (typeof req.body === 'string' && req.body.trim().startsWith('barcode')) {
      rows = parse(req.body, { columns: true, skip_empty_lines: true, trim: true });
    } else if (req.body?.csv) {
      rows = parse(req.body.csv, { columns: true, skip_empty_lines: true, trim: true });
    } else if (Array.isArray(req.body?.items)) {
      rows = req.body.items;
    } else if (Array.isArray(req.body)) {
      rows = req.body;
    } else {
      return res.status(400).json({
        error: { code: 'INVALID_IMPORT_PAYLOAD', message: 'Expected CSV string or JSON array with barcode,name,category,price,gst_percent,stock' }
      });
    }

    const results = [];
    let addedCount = 0;
    let failedCount = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      try {
        const validated = productSchema.parse({
          barcode: row.barcode,
          name: row.name,
          category: row.category || 'General',
          price: row.price,
          gst_percent: row.gst_percent || 0,
          stock: row.stock !== undefined && row.stock !== '' ? row.stock : null,
        });

        const created = await db.createProduct(validated);
        results.push({ index, barcode: validated.barcode, status: 'success', id: created.id });
        addedCount += 1;
      } catch (err) {
        failedCount += 1;
        results.push({
          index,
          barcode: row.barcode || `row-${index}`,
          status: 'error',
          error: err.code || (err.issues?.[0]?.message || (err.errors ? err.errors[0].message : err.message)),
        });
      }
    }

    res.json({
      total: rows.length,
      added: addedCount,
      failed: failedCount,
      results,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/ai-lookup (Server-side Gemini AI proxy for barcode metadata)
productsRouter.post('/products/ai-lookup', async (req, res) => {
  const { barcode, hint = '' } = req.body || {};
  if (!barcode) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Barcode is required' } });
  }

  // Import config dynamically to avoid circular references
  const { config } = await import('../config.js');

  if (!config.googleApiKey) {
    return res.json({
      configured: false,
      message: 'GOOGLE_API_KEY is not configured on the server',
      suggestion: null,
    });
  }

  try {
    const prompt = `You are a retail product catalog assistant. Identify or estimate product details for barcode "${barcode}" (additional context: "${hint}").
Respond ONLY with a valid JSON object with keys:
"name": estimated or standard product name in Indian retail (e.g. Amul Milk, Lays Chips),
"category": one of ["Groceries", "Snacks", "Dairy", "Beverages", "Electronics", "Stationery", "General"],
"price": estimated numeric price in INR (e.g. 30),
"gst_percent": standard Indian GST rate (0, 5, 12, 18, or 28).`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.googleApiKey}`;
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    if (!response.ok) {
      console.warn(`[AI LOOKUP] Gemini API returned status ${response.status}`);
      return res.json({ configured: true, suggestion: null });
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.json({ configured: true, suggestion: null });
    }

    const parsed = JSON.parse(rawText);
    return res.json({
      configured: true,
      suggestion: {
        name: parsed.name || '',
        category: parsed.category || 'General',
        price: parseFloat(parsed.price) || 0,
        gst_percent: parseFloat(parsed.gst_percent) || 5,
      },
    });
  } catch (err) {
    console.error('[AI LOOKUP] Error calling Gemini API:', err.message);
    return res.json({ configured: true, suggestion: null });
  }
});
