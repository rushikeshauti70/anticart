import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { eventLogger } from '../system.js';

export const reportsRouter = Router();

// GET /api/reports/excel (Download latest cleaned Excel activity log)
reportsRouter.get('/reports/excel', async (req, res, next) => {
  try {
    // Flush any pending events first so download includes the most recent actions
    await eventLogger.flush();

    const filePath = eventLogger.getActiveWorkbookPath();
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: { code: 'REPORT_NOT_FOUND', message: 'No activity logs have been generated today yet.' }
      });
    }

    const filename = path.basename(filePath);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/csv (Download CSV fallback mirror)
reportsRouter.get('/reports/csv', (req, res, next) => {
  try {
    const filePath = eventLogger.getActiveCsvPath();
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        error: { code: 'REPORT_NOT_FOUND', message: 'No CSV activity logs found for today.' }
      });
    }

    const filename = path.basename(filePath);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/stats (Real-time in-memory logging stats)
reportsRouter.get('/reports/stats', (req, res) => {
  res.json({
    buffer_length: eventLogger.buffer.length,
    max_buffer_size: eventLogger.maxBufferSize,
    flush_interval_sec: eventLogger.flushIntervalSec,
    last_flush_time: eventLogger.lastFlushTime,
    total_cleaned_written: eventLogger.totalCleanedWritten,
    total_alerts_logged: eventLogger.totalAlertsLogged,
    active_workbook: path.basename(eventLogger.getActiveWorkbookPath()),
  });
});

// POST /api/reports/flush (Manual flush trigger)
reportsRouter.post('/reports/flush', async (req, res, next) => {
  try {
    await eventLogger.flush();
    res.json({
      success: true,
      message: 'Flushed in-memory buffer to Excel workbook',
      last_flush_time: eventLogger.lastFlushTime,
    });
  } catch (err) {
    next(err);
  }
});
