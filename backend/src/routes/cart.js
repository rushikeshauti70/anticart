import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { sseHub } from '../sse.js';

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
