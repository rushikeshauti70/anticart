import { Router } from 'express';
import { db } from '../db.js';

export const purchasesRouter = Router();

// GET /api/purchases
purchasesRouter.get('/purchases', async (req, res, next) => {
  try {
    const { page = '1', pageSize = '20' } = req.query;
    const result = await db.getPurchases({
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/:id
purchasesRouter.get('/purchases/:id', async (req, res, next) => {
  try {
    const purchase = await db.getPurchaseById(req.params.id);
    if (!purchase) {
      return res.status(404).json({ error: { code: 'PURCHASE_NOT_FOUND', message: 'Purchase record not found' } });
    }
    res.json(purchase);
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/:id/cancel
purchasesRouter.post('/purchases/:id/cancel', async (req, res, next) => {
  try {
    const cancelled = await db.cancelPurchase(req.params.id);
    if (!cancelled) {
      return res.status(404).json({ error: { code: 'PURCHASE_NOT_FOUND', message: 'Purchase record not found' } });
    }
    res.json({
      success: true,
      message: 'Purchase cancelled and stock restored',
      purchase: cancelled,
    });
  } catch (err) {
    next(err);
  }
});
