import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';
import { config } from '../config.js';

export class EventLogger extends EventEmitter {
  constructor(options = {}) {
    super();
    this.flushIntervalSec = options.flushIntervalSec ?? config.excelLogger.flushIntervalSec ?? 5;
    this.exportsDir = options.exportsDir || config.excelLogger.exportsDir || path.resolve(process.cwd(), 'exports');
    this.rotateRows = options.rotateRows || config.excelLogger.rotateRows || 10000;
    this.retentionDays = options.retentionDays || config.excelLogger.retentionDays || 30;
    this.sensorChangeThreshold = options.sensorChangeThreshold || config.excelLogger.sensorChangeThreshold || 2.0;
    this.eventWhitelist = new Set(
      (options.eventWhitelist || config.excelLogger.eventWhitelist || [
        'product_added',
        'product_removed',
        'quantity_changed',
        'stock_changed',
        'out_of_stock',
        'low_stock',
        'unknown_barcode',
        'scan_rejected',
        'device_online',
        'device_offline',
        'error',
      ]).map((s) => s.toLowerCase().trim())
    );

    this.maxBufferSize = options.maxBufferSize || 5000;
    this.buffer = [];
    this.isFlushing = false;
    this.flushTimer = null;
    this.lastFlushTime = null;
    this.totalCleanedWritten = 0;
    this.totalAlertsLogged = 0;

    // Ensure exports directory exists
    if (!fs.existsSync(this.exportsDir)) {
      try {
        fs.mkdirSync(this.exportsDir, { recursive: true });
      } catch (e) {
        console.warn('[LOGGER] Could not create exports directory:', e.message);
      }
    }

    // Start background flush worker (non-blocking)
    if (this.flushIntervalSec > 0) {
      this.startFlushWorker();
    }
  }

  /**
   * Log a raw sensor or business event into in-memory bounded buffer
   * Non-blocking: returns instantly
   * @param {object} rawEvent
   */
  logEvent(rawEvent) {
    if (!rawEvent) return;

    const event = {
      event_id: rawEvent.event_id || uuidv4(),
      scan_id: rawEvent.scan_id || null,
      request_id: rawEvent.request_id || null,
      timestamp: rawEvent.timestamp || new Date().toISOString(),
      device_id: rawEvent.device_id || config.deviceId || 'trolley-01',
      sensor_type: rawEvent.sensor_type || 'barcode_scanner',
      action: (rawEvent.action || 'unknown').toLowerCase(),
      value: rawEvent.value ?? rawEvent.barcode ?? '',
      product_id: rawEvent.product_id || null,
      product_name: rawEvent.product_name || rawEvent.name || '',
      qty: rawEvent.qty !== undefined ? Number(rawEvent.qty) : (rawEvent.quantity !== undefined ? Number(rawEvent.quantity) : null),
      stock_after: rawEvent.stock_after !== undefined ? Number(rawEvent.stock_after) : (rawEvent.stock_qty !== undefined ? Number(rawEvent.stock_qty) : null),
      cart_total: rawEvent.cart_total !== undefined ? Number(rawEvent.cart_total) : null,
      status: (rawEvent.status || 'success').toLowerCase(),
      details: rawEvent.details || {},
    };

    if (this.buffer.length >= this.maxBufferSize) {
      // Drop oldest event if bounded capacity exceeded
      this.buffer.shift();
    }

    this.buffer.push(event);
    this.emit('event_buffered', event);
  }

  /**
   * Start 5-second clean-and-flush timer
   */
  startFlushWorker() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(async () => {
      try {
        await this.flush();
      } catch (err) {
        console.warn('[LOGGER][WARN] Periodic flush error:', err.message);
      }
    }, this.flushIntervalSec * 1000);

    // Unref so worker does not prevent Node process exit
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * Stop background flush worker
   */
  stopFlushWorker() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 5-Second Cleaning Algorithm:
   * 1. De-duplicate identical events & debounced repeat barcodes
   * 2. Drop noise (empty reads, malformed scans, heartbeats, status pings)
   * 3. Collapse continuous sensor bursts (keep significant threshold or final value)
   * 4. Enforce whitelist of necessary actions
   * 5. Merge multi-step scan sequence into one single row with final outcome
   * 6. Chronological sort
   *
   * @param {Array<object>} rawEvents
   * @returns {Array<object>} cleanedEvents
   */
  cleanEvents(rawEvents) {
    if (!rawEvents || rawEvents.length === 0) return [];

    // Step 1: Discard pure noise (empty, heartbeat, status_ping, keepalive, debug)
    const nonNoise = rawEvents.filter((e) => {
      if (!e) return false;
      const act = e.action;
      if (act === 'heartbeat' || act === 'status_ping' || act === 'keepalive' || act === 'debug') {
        return false;
      }
      // Drop empty reads without barcode, product, or action details
      if (!e.value && !e.product_id && act === 'scan_rejected' && !e.details?.reason) {
        return false;
      }
      return true;
    });

    // Step 2: Continuous Sensor Burst Collapse (e.g. ultrasonic / weight / temp)
    // If consecutive readings from continuous sensor are within change threshold, collapse to final reading
    const sensorCollapsed = [];
    let lastContinuous = null;

    for (const e of nonNoise) {
      const isContinuous = e.sensor_type === 'ultrasonic' || e.sensor_type === 'weight' || e.sensor_type === 'temperature';
      if (isContinuous && typeof e.value === 'number') {
        if (
          lastContinuous &&
          lastContinuous.sensor_type === e.sensor_type &&
          lastContinuous.device_id === e.device_id &&
          Math.abs(e.value - lastContinuous.value) < this.sensorChangeThreshold
        ) {
          // Update last continuous reading with latest value & timestamp instead of creating new row
          lastContinuous.value = e.value;
          lastContinuous.timestamp = e.timestamp;
          continue;
        }
        lastContinuous = { ...e };
        sensorCollapsed.push(lastContinuous);
      } else {
        lastContinuous = null;
        sensorCollapsed.push(e);
      }
    }

    // Step 3: Merge Related Multi-Step Events (Same scan_id or request_id)
    // Scan events often emit: scan_received -> catalog_lookup -> cart_add -> stock_update.
    // Merge these into 1 single unified row with final outcome!
    const scanGroups = new Map();
    const otherEvents = [];

    for (const e of sensorCollapsed) {
      const key = e.scan_id || e.request_id;
      if (key) {
        if (!scanGroups.has(key)) {
          scanGroups.set(key, []);
        }
        scanGroups.get(key).push(e);
      } else {
        otherEvents.push(e);
      }
    }

    const mergedRows = [];
    for (const [key, group] of scanGroups.entries()) {
      if (group.length === 1) {
        mergedRows.push(group[0]);
        continue;
      }

      // Consolidate into 1 unified row with final outcome
      let primary = group[0];
      let finalAction = primary.action;
      let finalStatus = primary.status;
      let finalStock = primary.stock_after;
      let finalCartTotal = primary.cart_total;
      let finalQty = primary.qty || 1;
      let finalProductName = primary.product_name;

      for (const item of group) {
        if (item.action === 'product_added' || item.action === 'out_of_stock' || item.action === 'unknown_barcode' || item.action === 'scan_rejected') {
          finalAction = item.action;
          finalStatus = item.status;
        }
        if (item.stock_after !== null && item.stock_after !== undefined) {
          finalStock = item.stock_after;
        }
        if (item.cart_total !== null && item.cart_total !== undefined) {
          finalCartTotal = item.cart_total;
        }
        if (item.qty) {
          finalQty = item.qty;
        }
        if (item.product_name) {
          finalProductName = item.product_name;
        }
      }

      mergedRows.push({
        ...primary,
        action: finalAction,
        status: finalStatus,
        product_name: finalProductName,
        qty: finalQty,
        stock_after: finalStock,
        cart_total: finalCartTotal,
      });
    }

    const allCandidateRows = [...otherEvents, ...mergedRows];

    // Step 4: Whitelist Check & Deduplication by (barcode + action) within 1500ms
    const cleaned = [];
    const seenEvents = new Set();
    const recentBarcodeMap = new Map();

    for (const e of allCandidateRows) {
      // Whitelist check
      if (!this.eventWhitelist.has(e.action.toLowerCase())) {
        continue;
      }

      // Check unique event_id
      if (e.event_id && seenEvents.has(e.event_id)) {
        continue;
      }
      seenEvents.add(e.event_id);

      // Check debounce duplicate (same barcode and action within 1500ms)
      if (e.value && typeof e.value === 'string') {
        const barcodeKey = `${e.value}:${e.action}`;
        const eventTime = new Date(e.timestamp).getTime();
        const lastTime = recentBarcodeMap.get(barcodeKey);
        if (lastTime && Math.abs(eventTime - lastTime) < 1500) {
          continue; // Debounced repeat
        }
        recentBarcodeMap.set(barcodeKey, eventTime);
      }

      cleaned.push(e);
    }

    // Step 5: Chronological Sort by timestamp ascending
    cleaned.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return cleaned;
  }

  /**
   * Get active Excel filename based on today's date
   * @param {Date} date
   * @returns {string} filePath
   */
  getActiveWorkbookPath(date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const filename = `activity_${yyyy}-${mm}-${dd}.xlsx`;
    return path.join(this.exportsDir, filename);
  }

  /**
   * Get active CSV fallback filename based on today's date
   * @param {Date} date
   * @returns {string} filePath
   */
  getActiveCsvPath(date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const filename = `activity_${yyyy}-${mm}-${dd}.csv`;
    return path.join(this.exportsDir, filename);
  }

  /**
   * Flush in-memory buffer, clean data, and atomically write/append to Excel
   * Handles file locks (EBUSY / EPERM) by holding data in buffer and retrying without data loss.
   */
  async flush() {
    if (this.isFlushing || this.buffer.length === 0) return;
    this.isFlushing = true;

    // Snapshot buffer to prevent loss of events coming in during flush
    const batchToProcess = [...this.buffer];

    try {
      const cleaned = this.cleanEvents(batchToProcess);

      if (cleaned.length === 0) {
        // Discard processed noise from buffer and return
        this.buffer = this.buffer.slice(batchToProcess.length);
        this.isFlushing = false;
        return;
      }

      const filePath = this.getActiveWorkbookPath();
      await this.writeBatchToExcel(cleaned, filePath);

      // Also append to CSV mirror fallback
      this.writeBatchToCsv(cleaned, this.getActiveCsvPath());

      // Successfully written! Safely remove this batch from buffer
      this.buffer = this.buffer.slice(batchToProcess.length);
      this.lastFlushTime = new Date().toISOString();
      this.totalCleanedWritten += cleaned.length;

      // Clean up exports older than retentionDays
      this.cleanOldExports();

      this.emit('flush_success', { count: cleaned.length, filePath });
    } catch (err) {
      // If file is locked in Excel (EBUSY / EPERM), retain buffer for next cycle retry
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        console.warn(`[LOGGER][LOCK] Excel file is currently open/locked (${err.code}). Buffered ${batchToProcess.length} events for next retry.`);
      } else {
        console.error('[LOGGER][ERROR] Excel flush error:', err.message);
      }
      this.emit('flush_error', err);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Write cleaned events batch to ExcelJS Workbook with Activity, Alerts, and Summary sheets.
   * Uses safe atomic writing (.temp -> rename) to prevent corruption.
   *
   * @param {Array<object>} rows
   * @param {string} targetPath
   */
  async writeBatchToExcel(rows, targetPath) {
    const workbook = new ExcelJS.Workbook();
    let fileExists = fs.existsSync(targetPath);

    if (fileExists) {
      try {
        await workbook.xlsx.readFile(targetPath);
      } catch (readErr) {
        // If file is empty or corrupted, create fresh
        fileExists = false;
      }
    }

    // 1. Activity Sheet
    let activitySheet = workbook.getWorksheet('Activity');
    if (!activitySheet) {
      activitySheet = workbook.addWorksheet('Activity', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      activitySheet.columns = [
        { header: 'Timestamp (UTC)', key: 'timestamp', width: 22 },
        { header: 'Device ID', key: 'device_id', width: 14 },
        { header: 'Sensor', key: 'sensor_type', width: 16 },
        { header: 'Action', key: 'action', width: 18 },
        { header: 'Barcode / Value', key: 'value', width: 18 },
        { header: 'Product Name', key: 'product_name', width: 28 },
        { header: 'Qty', key: 'qty', width: 8 },
        { header: 'Stock After', key: 'stock_after', width: 12 },
        { header: 'Cart Total (₹)', key: 'cart_total', width: 14 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Notes / Details', key: 'notes', width: 30 },
      ];
      this.styleHeaderRow(activitySheet.getRow(1));
    }

    // 2. Alerts Sheet
    let alertsSheet = workbook.getWorksheet('Alerts');
    if (!alertsSheet) {
      alertsSheet = workbook.addWorksheet('Alerts', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      alertsSheet.columns = [
        { header: 'Timestamp (UTC)', key: 'timestamp', width: 22 },
        { header: 'Device ID', key: 'device_id', width: 14 },
        { header: 'Alert Type', key: 'action', width: 18 },
        { header: 'Barcode', key: 'value', width: 18 },
        { header: 'Product Name', key: 'product_name', width: 28 },
        { header: 'Stock After', key: 'stock_after', width: 12 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Message / Details', key: 'notes', width: 35 },
      ];
      this.styleHeaderRow(alertsSheet.getRow(1));
    }

    // Append rows & apply conditional soft coloring
    for (const item of rows) {
      const detailsMsg = item.details?.message || item.details?.reason || (typeof item.details === 'string' ? item.details : '');
      const activityRow = activitySheet.addRow({
        timestamp: item.timestamp,
        device_id: item.device_id,
        sensor_type: item.sensor_type,
        action: item.action,
        value: String(item.value || ''),
        product_name: item.product_name,
        qty: item.qty ?? '',
        stock_after: item.stock_after ?? '',
        cart_total: item.cart_total !== null ? Number(item.cart_total).toFixed(2) : '',
        status: item.status.toUpperCase(),
        notes: detailsMsg,
      });

      this.styleDataRow(activityRow, item.action, item.status);

      // Filter to Alerts sheet if action is warning/error
      const isAlert =
        item.action === 'out_of_stock' ||
        item.action === 'low_stock' ||
        item.action === 'unknown_barcode' ||
        item.action === 'error' ||
        item.status === 'error';

      if (isAlert) {
        this.totalAlertsLogged += 1;
        const alertRow = alertsSheet.addRow({
          timestamp: item.timestamp,
          device_id: item.device_id,
          action: item.action.toUpperCase(),
          value: String(item.value || ''),
          product_name: item.product_name,
          stock_after: item.stock_after ?? '',
          status: item.status.toUpperCase(),
          notes: detailsMsg,
        });
        this.styleDataRow(alertRow, item.action, item.status);
      }
    }

    // Auto-fit column widths with padding
    this.autoFitColumns(activitySheet);
    this.autoFitColumns(alertsSheet);

    // 3. Summary Sheet (Live KPIs)
    let summarySheet = workbook.getWorksheet('Summary');
    if (!summarySheet) {
      summarySheet = workbook.addWorksheet('Summary');
    }
    this.buildSummarySheet(summarySheet, activitySheet, alertsSheet);

    // Write to temporary file, then atomically rename to prevent corruption
    const tempPath = path.join(this.exportsDir, `.temp_${path.basename(targetPath)}`);
    await workbook.xlsx.writeFile(tempPath);

    // Atomic replace
    if (fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
      } catch (delErr) {
        // If locked on Windows, throw to trigger buffer retention
        throw delErr;
      }
    }
    fs.renameSync(tempPath, targetPath);
  }

  /**
   * Append cleaned batch to CSV fallback mirror
   */
  writeBatchToCsv(rows, csvPath) {
    try {
      const exists = fs.existsSync(csvPath);
      let csvContent = '';
      if (!exists) {
        csvContent += 'Timestamp,Device ID,Sensor,Action,Barcode,Product Name,Qty,Stock After,Cart Total,Status,Notes\r\n';
      }
      for (const r of rows) {
        const details = (r.details?.message || r.details?.reason || '').replace(/"/g, '""');
        const pName = (r.product_name || '').replace(/"/g, '""');
        csvContent += `"${r.timestamp}","${r.device_id}","${r.sensor_type}","${r.action}","${r.value || ''}","${pName}","${r.qty ?? ''}","${r.stock_after ?? ''}","${r.cart_total ?? ''}","${r.status}","${details}"\r\n`;
      }
      fs.appendFileSync(csvPath, csvContent, 'utf8');
    } catch (e) {
      console.warn('[LOGGER] CSV fallback mirror warning:', e.message);
    }
  }

  /**
   * Header row styling: Dark slate fill (#1E293B) and white bold font
   */
  styleHeaderRow(row) {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
    row.height = 24;
  }

  /**
   * Data row conditional styling:
   * - Red for out_of_stock or error
   * - Amber for low_stock
   * - Green for product_added
   */
  styleDataRow(row, action, status) {
    let bgColor = null;
    if (action === 'out_of_stock' || action === 'error' || status === 'error') {
      bgColor = 'FFFEE2E2'; // Soft Red
    } else if (action === 'low_stock' || action === 'unknown_barcode') {
      bgColor = 'FFFEF3C7'; // Soft Amber
    } else if (action === 'product_added') {
      bgColor = 'FFDCFCE7'; // Soft Green
    }

    if (bgColor) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: bgColor },
      };
    }

    row.font = { size: 9 };
    row.alignment = { vertical: 'middle' };
  }

  /**
   * Auto-fit columns with safety limits
   */
  autoFitColumns(sheet) {
    sheet.columns.forEach((column) => {
      let maxLen = 0;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const val = cell.value ? String(cell.value) : '';
        if (val.length > maxLen) {
          maxLen = val.length;
        }
      });
      column.width = Math.min(45, Math.max(column.width || 10, maxLen + 3));
    });
  }

  /**
   * Generate Summary KPIs sheet
   */
  buildSummarySheet(summarySheet, activitySheet, alertsSheet) {
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 28 },
      { header: 'Value', key: 'value', width: 22 },
      { header: 'Description', key: 'desc', width: 35 },
    ];
    this.styleHeaderRow(summarySheet.getRow(1));

    const totalRows = Math.max(0, activitySheet.rowCount - 1);
    const alertRows = Math.max(0, alertsSheet.rowCount - 1);

    summarySheet.spliceRows(2, summarySheet.rowCount); // Clear existing
    summarySheet.addRow({
      metric: 'Total Cleaned Actions',
      value: totalRows,
      desc: 'Cleaned operational actions recorded today',
    });
    summarySheet.addRow({
      metric: 'Operational Alerts Count',
      value: alertRows,
      desc: 'Out-of-stock, low-stock, and error events',
    });
    summarySheet.addRow({
      metric: 'Last Clean & Flush Cycle',
      value: new Date().toISOString(),
      desc: 'Timestamp of the latest 5-second clean write',
    });
    summarySheet.addRow({
      metric: 'Flush Interval',
      value: `${this.flushIntervalSec} seconds`,
      desc: 'Non-blocking worker cleaning cycle',
    });
    summarySheet.addRow({
      metric: 'Current Memory Buffer',
      value: `${this.buffer.length} events`,
      desc: 'In-memory queue waiting for next flush',
    });

    for (let i = 2; i <= 6; i++) {
      const row = summarySheet.getRow(i);
      row.font = { size: 10 };
      row.alignment = { vertical: 'middle' };
      if (i % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
    }
  }

  /**
   * Automatically delete export workbooks older than retentionDays (default 30 days)
   */
  cleanOldExports() {
    try {
      const files = fs.readdirSync(this.exportsDir);
      const now = Date.now();
      const maxAgeMs = this.retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith('activity_') && (file.endsWith('.xlsx') || file.endsWith('.csv'))) {
          const fullPath = path.join(this.exportsDir, file);
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath);
            console.log(`[LOGGER] Cleaned up rotated export older than ${this.retentionDays} days: ${file}`);
          }
        }
      }
    } catch (e) {}
  }

  /**
   * Graceful shutdown: flush any remaining buffered events before exiting
   */
  async shutdown() {
    this.stopFlushWorker();
    if (this.buffer.length > 0) {
      console.log(`[LOGGER] Flushing remaining ${this.buffer.length} events during shutdown...`);
      await this.flush();
    }
  }
}

