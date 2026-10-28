import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { sseHub } from '../sse.js';
import { config } from '../config.js';

export const cartRouter = Router();

const scanSchema = z.object({
  barcode: z.string().trim().min(1, 'Barcode is required'),
  scanId: z.string().uuid('Valid UUID scanId is required'),
  trolleyId: z.string().default('trolley-01'),
});

const quantitySchema = z.object({
  quantity: z.coerce.number().int().min(0, 'Quantity must be non-negative'),
  trolleyId: z.string().default('trolley-01'),
});

// GET /api/cart
cartRouter.get('/cart', async (req, res, next) => {
  try {
    const trolleyId = (req.query.trolleyId || 'trolley-01').toString();
    const openCart = await db.getOrCreateOpenCart(trolleyId);
    const cartDetails = await db.getCartDetails(openCart.id);
    res.json(cartDetails);
  } catch (err) {
    next(err);
  }
});

// POST /api/scan (Core scan flow with scanId idempotency)
cartRouter.post('/scan', async (req, res, next) => {
  try {
    const { barcode, scanId, trolleyId } = scanSchema.parse(req.body);

    const result = await db.scanAndAddToCart({ barcode, scanId, trolleyId });

    // Broadcast cart update to active SSE clients
    sseHub.broadcast('cart', result.cart);

    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: result.duplicate,
      product: result.product,
      cart: result.cart,
    });
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    if (err.code === 'UNKNOWN_BARCODE') {
      return res.status(404).json({
        error: {
          code: 'UNKNOWN_BARCODE',
          message: 'Barcode not in catalog',
          barcode: err.barcode,
        }
      });
    }
    next(err);
  }
});

// PATCH /api/cart/items/:productId
cartRouter.patch('/cart/items/:productId', async (req, res, next) => {
  try {
    const { quantity, trolleyId } = quantitySchema.parse(req.body);
    const openCart = await db.getOrCreateOpenCart(trolleyId);

    const updatedCart = await db.updateCartItemQuantity({
      cartId: openCart.id,
      productId: req.params.productId,
      quantity,
    });

    sseHub.broadcast('cart', updatedCart);
    res.json(updatedCart);
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    next(err);
  }
});

// DELETE /api/cart/items/:productId
cartRouter.delete('/cart/items/:productId', async (req, res, next) => {
  try {
    const trolleyId = (req.query.trolleyId || 'trolley-01').toString();
    const openCart = await db.getOrCreateOpenCart(trolleyId);

    const updatedCart = await db.removeCartItem({
      cartId: openCart.id,
      productId: req.params.productId,
    });

    sseHub.broadcast('cart', updatedCart);
    res.json(updatedCart);
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/cancel
cartRouter.post('/cart/cancel', async (req, res, next) => {
  try {
    const trolleyId = (req.body?.trolleyId || req.query.trolleyId || 'trolley-01').toString();
    const openCart = await db.getOrCreateOpenCart(trolleyId);

    await db.cancelCart(openCart.id);

    // Create a new fresh open cart for this trolley
    const freshCart = await db.getOrCreateOpenCart(trolleyId);
    const freshCartDetails = await db.getCartDetails(freshCart.id);

    sseHub.broadcast('cart', freshCartDetails);
    res.json({ success: true, message: 'Cart cancelled', cart: freshCartDetails });
  } catch (err) {
    next(err);
  }
});

// POST /api/cart/checkout
cartRouter.post('/cart/checkout', async (req, res, next) => {
  try {
    const trolleyId = (req.body?.trolleyId || req.query.trolleyId || 'trolley-01').toString();
    const openCart = await db.getOrCreateOpenCart(trolleyId);

    const purchase = await db.checkoutCart(openCart.id);

    // Fresh empty open cart for subsequent scans
    const newCart = await db.getOrCreateOpenCart(trolleyId);
    const newCartDetails = await db.getCartDetails(newCart.id);

    sseHub.broadcast('cart', newCartDetails);

    res.status(201).json({
      success: true,
      message: 'Checkout completed successfully',
      purchase,
      cart: newCartDetails,
    });
  } catch (err) {
    if (err.code === 'EMPTY_CART') {
      return res.status(400).json({ error: { code: 'EMPTY_CART', message: 'Cart is empty' } });
    }
    next(err);
  }
});

// Helper: EAN-13 / UPC modulo-10 checksum validation
function validateEanUpcChecksum(barcode) {
  if (!barcode || typeof barcode !== 'string') return false;
  const digits = barcode.trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) return false;

  const len = digits.length;
  let sum = 0;
  for (let i = 0; i < len - 1; i++) {
    const digit = parseInt(digits[i], 10);
    const weight = ((len - 1 - i) % 2 === 1) ? 3 : 1;
    sum += digit * weight;
  }
  const calcCheck = (10 - (sum % 10)) % 10;
  return calcCheck === parseInt(digits[len - 1], 10);
}

// In-memory rate limiting map for Gemini Vision requests
const visionRateLimitMap = new Map();

// POST /api/scanner/gemini-vision
// Server-side Gemini 1.5 Flash Vision proxy for damaged/curved/blurry package recognition
cartRouter.post('/scanner/gemini-vision', async (req, res, next) => {
  try {
    const clientId = req.ip || 'default';
    const now = Date.now();
    const lastCall = visionRateLimitMap.get(clientId) || 0;
    if (now - lastCall < 2000) {
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Please wait a moment before capturing another AI frame' }
      });
    }
    visionRateLimitMap.set(clientId, now);

    if (visionRateLimitMap.size > 200) {
      for (const [k, v] of visionRateLimitMap.entries()) {
        if (now - v > 30000) visionRateLimitMap.delete(k);
      }
    }

    const { imageBase64, trolleyId = 'trolley-01', hint = '' } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_IMAGE', message: 'A valid base64 image frame is required' }
      });
    }

    const apiKey = config.googleApiKey;
    if (!apiKey) {
      return res.status(503).json({
        error: { code: 'AI_NOT_CONFIGURED', message: 'Gemini API key is not configured on the backend server' }
      });
    }

    let mimeType = 'image/jpeg';
    let rawBase64 = imageBase64;
    const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      rawBase64 = match[2];
    }

    const prompt = `You are a high-speed retail checkout AI vision assistant.
Analyze this cropped camera image of a retail/grocery product or packaging.
1. Read the exact printed barcode number/digits (EAN-13, UPC, Code 128, QR) if visible, even if slightly curved or worn.
2. If the barcode is damaged or unreadable, identify the exact product name, brand, variant, and estimated package size from packaging text and logos.
Context hint from user: "${hint}".

Respond ONLY with a valid JSON object matching this exact schema:
{
  "identified": true or false,
  "barcode": "digits string or empty string",
  "product_name": "clean product title and brand or empty string",
  "category": "one of [Groceries, Snacks, Dairy, Beverages, Electronics, Stationery, General]",
  "confidence": number between 0.0 and 1.0
}`;

    const candidateModels = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
    let geminiResponse = null;
    let lastErrorText = '';

    for (const modelName of candidateModels) {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8500);

      try {
        const resp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType,
                      data: rawBase64,
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
            }
          })
        });

        if (resp.ok) {
          geminiResponse = resp;
          break;
        } else {
          lastErrorText = await resp.text().catch(() => '');
          console.warn(`[GEMINI VISION] Model ${modelName} returned status ${resp.status}: ${lastErrorText}`);
        }
      } catch (errCall) {
        console.warn(`[GEMINI VISION] Model ${modelName} request error:`, errCall.message);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!geminiResponse) {
      console.warn(`[GEMINI VISION] All candidate models failed. Last error: ${lastErrorText}`);
      return res.status(502).json({
        error: { code: 'AI_SERVICE_ERROR', message: 'Vision service temporarily unavailable. Please retry or enter barcode manually.' }
      });
    }

    const data = await geminiResponse.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.json({
        success: false,
        identified: false,
        message: 'No product or barcode recognized from frame',
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      return res.json({
        success: false,
        identified: false,
        message: 'Could not interpret AI response',
      });
    }

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    const extractedBarcode = (parsed.barcode || '').trim();
    const productName = (parsed.product_name || '').trim();
    const category = parsed.category || 'General';

    let matchedProduct = null;
    let checksumValid = false;

    if (extractedBarcode) {
      checksumValid = validateEanUpcChecksum(extractedBarcode);
      matchedProduct = await db.getProductByBarcode(extractedBarcode);
    }

    if (!matchedProduct && productName) {
      const searchRes = await db.getProducts({ search: productName, pageSize: 3 });
      if (searchRes?.data?.length > 0) {
        matchedProduct = searchRes.data[0];
      }
    }

    return res.json({
      success: true,
      identified: Boolean(parsed.identified && (extractedBarcode || productName)),
      confidence,
      barcode: extractedBarcode || null,
      checksumValid,
      productName: productName || null,
      category,
      matchedProduct,
      suggestion: {
        barcode: extractedBarcode || (matchedProduct ? matchedProduct.barcode : ''),
        name: productName || (matchedProduct ? matchedProduct.name : ''),
        category: matchedProduct ? matchedProduct.category : category,
        price: matchedProduct ? matchedProduct.price : 0,
      },
      requiresConfirmation: confidence < 0.85 || !matchedProduct,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: { code: 'AI_TIMEOUT', message: 'AI vision recognition timed out. Please try again.' } });
    }
    next(err);
  }
});
