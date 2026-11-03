import { Router } from 'express';
import { db } from '../db.js';
import { mqttManager } from '../mqtt.js';
import { eventLogger, inventory } from '../system.js';
import { requireAdminOrApiKey } from '../middleware/auth.js';

export const adminRouter = Router();

// Apply admin protection (allows pass-through in dev if ADMIN_API_KEY is unset)
adminRouter.use(requireAdminOrApiKey);

/**
 * GET /api/admin/dashboard
 * Live aggregated real-time metrics for executive dashboard
 */
adminRouter.get('/admin/dashboard', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days, 10) || 14;
    const stats = await db.getAdminDashboardStats(days);

    // Merge live hardware fleet telemetry
    const fleet = {
      'trolley-01': mqttManager.getTrolleyState('trolley-01'),
    };

    // Excel Logger real-time status
    const loggerStats = typeof eventLogger?.getStats === 'function' ? eventLogger.getStats() : {
      bufferSize: eventLogger?.buffer?.length || 0,
      lastFlushTime: eventLogger?.lastFlushTime || null,
      totalCleanedWritten: eventLogger?.totalCleanedWritten || 0,
    };

    res.json({
      success: true,
      data: {
        ...stats,
        fleet,
        loggerStats,
        serverTime: new Date().toISOString(),
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/database-health
 * Diagnostic metrics: exact row counts across all 10 tables, connection status, memory
 */
adminRouter.get('/admin/database-health', async (req, res, next) => {
  try {
    const health = await db.getDatabaseHealth();
    const loggerStats = typeof eventLogger?.getStats === 'function' ? eventLogger.getStats() : {
      bufferSize: eventLogger?.buffer?.length || 0,
      lastFlushTime: eventLogger?.lastFlushTime || null,
      totalCleanedWritten: eventLogger?.totalCleanedWritten || 0,
    };

    res.json({
      success: true,
      data: {
        ...health,
        logger: loggerStats,
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/scans
 * Searchable, paginated audit log of barcode scans
 */
adminRouter.get('/admin/scans', async (req, res, next) => {
  try {
    const { page = '1', pageSize = '25', result = '', search = '' } = req.query;
    const data = await db.getAdminScanEvents({
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25)),
      result: String(result),
      search: String(search),
    });
    res.json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/movements
 * Searchable, paginated audit log of inventory stock movements
 */
adminRouter.get('/admin/movements', async (req, res, next) => {
  try {
    const { page = '1', pageSize = '25', reason = '', productId = '' } = req.query;
    const data = await db.getAdminStockMovements({
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25)),
      reason: String(reason),
      productId: String(productId),
    });
    res.json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/flush-logs
 * Manually force an immediate clean-and-flush cycle of the Excel logger
 */
adminRouter.post('/admin/flush-logs', async (req, res, next) => {
  try {
    const initialBuffer = eventLogger.buffer.length;
    await eventLogger.flush();
    const finalBuffer = eventLogger.buffer.length;

    res.json({
      success: true,
      message: 'Excel log flush executed successfully',
      flushedCount: initialBuffer - finalBuffer,
      lastFlushTime: eventLogger.lastFlushTime,
      totalCleanedWritten: eventLogger.totalCleanedWritten,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/restock-quick
 * Instant quick restock button from the low-stock dashboard widget
 */
adminRouter.post('/admin/restock-quick', async (req, res, next) => {
  try {
    const { productId, delta = 10 } = req.body;
    if (!productId) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'productId is required' } });
    }

    const result = await inventory.adjustStock(productId, parseInt(delta, 10) || 10, 'restock');
    res.json({
      success: true,
      message: `Restocked ${delta} units successfully`,
      newStock: result.newStock,
      product: result.product,
    });
  } catch (err) {
    next(err);
  }
});

