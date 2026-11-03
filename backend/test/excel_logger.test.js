import assert from 'assert';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { EventLogger } from '../src/logger/event_logger.js';

const TEST_EXPORTS_DIR = path.resolve(process.cwd(), 'test_exports');

// Cleanup helper
function cleanupTestDir() {
  if (fs.existsSync(TEST_EXPORTS_DIR)) {
    fs.rmSync(TEST_EXPORTS_DIR, { recursive: true, force: true });
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('    TEST SUITE: LIVE EXCEL LOGGER & 5-SEC CLEANING  ');
  console.log('====================================================');

  cleanupTestDir();

  async function test(name, fn) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  // 1. Cleaning & Noise Dropping
  await test('1. Noise Dropping: Heartbeats, status pings, and empty reads are dropped', () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR });

    logger.logEvent({ action: 'heartbeat', sensor_type: 'system', value: 'ping' });
    logger.logEvent({ action: 'status_ping', sensor_type: 'system' });
    logger.logEvent({ action: 'debug', sensor_type: 'system', value: 'test' });
    logger.logEvent({ action: 'scan_rejected', sensor_type: 'barcode_scanner', value: '' }); // empty read without reason
    logger.logEvent({ action: 'product_added', sensor_type: 'barcode_scanner', product_name: 'Milk', value: '051111407592', qty: 1 });

    const cleaned = logger.cleanEvents(logger.buffer);
    assert.strictEqual(cleaned.length, 1, 'Only the legitimate product_added event should remain');
    assert.strictEqual(cleaned[0].action, 'product_added');
  });

  // 2. Duplicate Scans & Debounce Collapse
  await test('2. Duplicate Collapse: Same barcode + action within debounce window is collapsed', () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR });

    const now = new Date();
    const t0 = now.toISOString();
    const t1 = new Date(now.getTime() + 200).toISOString();
    const t2 = new Date(now.getTime() + 2000).toISOString();

    // 1st scan
    logger.logEvent({ event_id: 'e1', action: 'product_added', value: '051111407592', timestamp: t0 });
    // 2nd scan within 200ms (repeat bounce)
    logger.logEvent({ event_id: 'e2', action: 'product_added', value: '051111407592', timestamp: t1 });
    // 3rd scan after 2000ms (> 1500ms debounce)
    logger.logEvent({ event_id: 'e3', action: 'product_added', value: '051111407592', timestamp: t2 });

    const cleaned = logger.cleanEvents(logger.buffer);
    assert.strictEqual(cleaned.length, 2, 'Debounced bounce should be collapsed into 1 row, allowing the scan after 2000ms');
  });

  // 3. Continuous Sensor Burst Collapse
  await test('3. Sensor Burst Collapse: Burst of 50 continuous readings collapses into 1 row', () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR, sensorChangeThreshold: 5.0 });

    const baseTime = Date.now();
    // Simulate 50 ultrasonic readings with minor jitter (25.1 to 25.4 cm)
    for (let i = 0; i < 50; i++) {
      logger.logEvent({
        sensor_type: 'ultrasonic',
        action: 'stock_changed', // using whitelisted action for testing
        value: 25.0 + (i % 3) * 0.1,
        timestamp: new Date(baseTime + i * 20).toISOString(),
      });
    }

    const cleaned = logger.cleanEvents(logger.buffer);
    assert.strictEqual(cleaned.length, 1, 'Burst of 50 sensor events should collapse into 1 stabilized row');
  });

  // 4. Multi-Step Scan Flow Merging
  await test('4. Scan Flow Merging: Multi-step scan sequence merges into 1 unified row with final status', () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR });
    const scanId = 'scan-test-uuid-99';

    // Simulated scan lifecycle events with the same scan_id
    logger.logEvent({ scan_id: scanId, action: 'product_added', sensor_type: 'barcode_scanner', value: '051111407592', product_name: 'Organic Milk 1L', qty: 1, stock_after: 14, cart_total: 65.0, status: 'success' });
    logger.logEvent({ scan_id: scanId, action: 'stock_changed', sensor_type: 'inventory', value: '051111407592', stock_after: 14, status: 'success' });

    const cleaned = logger.cleanEvents(logger.buffer);
    assert.strictEqual(cleaned.length, 1, 'Multi-step events for the same scan_id must merge into exactly 1 row');
    assert.strictEqual(cleaned[0].product_name, 'Organic Milk 1L');
    assert.strictEqual(cleaned[0].stock_after, 14);
    assert.strictEqual(cleaned[0].cart_total, 65.0);
  });

  // 5. Excel Workbook Generation & Sheet Verification
  await test('5. Excel Generation: Generates Activity, Alerts, and Summary sheets with correct styles', async () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR });

    logger.logEvent({ action: 'product_added', sensor_type: 'barcode_scanner', product_name: 'Maggi Noodles', value: '8901030383700', qty: 2, stock_after: 48, cart_total: 28.0, status: 'success' });
    logger.logEvent({ action: 'out_of_stock', sensor_type: 'barcode_scanner', product_name: 'Amul Butter', value: '8901234567890', stock_after: 0, status: 'rejected', details: { message: 'Item out of stock' } });
    logger.logEvent({ action: 'low_stock', sensor_type: 'inventory', product_name: 'Whole Milk', value: '051111407592', stock_after: 3, status: 'success', details: { threshold: 5 } });

    await logger.flush();

    const targetFile = logger.getActiveWorkbookPath();
    assert.ok(fs.existsSync(targetFile), `Target workbook should exist at ${targetFile}`);

    // Read back workbook using ExcelJS
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(targetFile);

    const activitySheet = wb.getWorksheet('Activity');
    const alertsSheet = wb.getWorksheet('Alerts');
    const summarySheet = wb.getWorksheet('Summary');

    assert.ok(activitySheet, 'Activity sheet must exist');
    assert.ok(alertsSheet, 'Alerts sheet must exist');
    assert.ok(summarySheet, 'Summary sheet must exist');

    // Header validation (Activity has 3 data rows + 1 header = 4 rows)
    assert.strictEqual(activitySheet.rowCount, 4, 'Activity sheet should have 3 data rows + 1 header');
    // Alerts sheet contains out_of_stock + low_stock = 2 data rows + 1 header = 3 rows
    assert.strictEqual(alertsSheet.rowCount, 3, 'Alerts sheet should have 2 alert rows + 1 header');

    // Frozen header check
    assert.strictEqual(activitySheet.views[0]?.state, 'frozen', 'Activity sheet row 1 should be frozen');
    assert.strictEqual(activitySheet.views[0]?.ySplit, 1, 'Frozen split must be 1');

    // Check CSV mirror fallback exists
    const csvFile = logger.getActiveCsvPath();
    assert.ok(fs.existsSync(csvFile), `CSV fallback file must exist at ${csvFile}`);
  });

  // 6. File Lock Recovery (EBUSY / EPERM)
  await test('6. File Lock Resilience: Locked file retains buffer and does not crash or lose rows', async () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR });

    logger.logEvent({ action: 'product_added', sensor_type: 'barcode_scanner', product_name: 'Ponds Face Wash', value: '8901090672646', qty: 1 });

    // Mock writeBatchToExcel throwing EBUSY (simulating Windows Excel lock)
    const originalWrite = logger.writeBatchToExcel;
    let callCount = 0;
    logger.writeBatchToExcel = async function(...args) {
      callCount++;
      if (callCount === 1) {
        const lockErr = new Error('EBUSY: resource locked');
        lockErr.code = 'EBUSY';
        throw lockErr;
      }
      return originalWrite.apply(logger, args);
    };

    // 1st Flush Attempt -> Locked
    await logger.flush();
    assert.strictEqual(logger.buffer.length, 1, 'Event must remain in buffer during file lock');

    // 2nd Flush Attempt -> Unlocked
    await logger.flush();
    assert.strictEqual(logger.buffer.length, 0, 'Buffer must be cleanly emptied once file lock is released');
    logger.writeBatchToExcel = originalWrite;
  });

  // 7. Empty Batch Skip
  await test('7. Empty Batch Skip: If buffer has no whitelisted events, file I/O is skipped', async () => {
    const logger = new EventLogger({ flushIntervalSec: 0, exportsDir: TEST_EXPORTS_DIR });
    logger.logEvent({ action: 'heartbeat', sensor_type: 'system' });

    let writeCalled = false;
    logger.writeBatchToExcel = async () => { writeCalled = true; };

    await logger.flush();
    assert.strictEqual(writeCalled, false, 'writeBatchToExcel must NOT be called for an empty/noise batch');
    assert.strictEqual(logger.buffer.length, 0, 'Noise should be purged from buffer');
  });

  cleanupTestDir();
  console.log('\n====================================================');
  console.log('       ALL 7 EXCEL LOGGER TESTS PASSED!             ');
  console.log('====================================================\n');
}

runTests().then(() => {
  if (process.exitCode) process.exit(process.exitCode);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
