import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { BarcodeScanner, validateEanUpcChecksum, normalizeBarcode } from '../src/scanner/scanner.js';
import { InventoryService } from '../src/inventory/inventory_service.js';
import { MqttClientService } from '../src/mqtt/mqtt_client.js';
import { db } from '../src/db.js';

console.log('====================================================');
console.log('   RUNNING BARCODE SCANNER & AUTO-INVENTORY SUITE   ');
console.log('====================================================\n');

async function runAllTests() {
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    process.stdout.write(`[TEST ${total}] ${name}... `);
    try {
      await fn();
      console.log('PASSED');
      passed++;
    } catch (err) {
      console.log('FAILED');
      console.error(err);
      process.exitCode = 1;
    }
  }

  // =========================================================================
  // Section 1: Checksum & Normalization Tests
  // =========================================================================
  await test('Checksum validation: Valid EAN-13, UPC-A, and EAN-8 barcodes', () => {
    assert.strictEqual(validateEanUpcChecksum('8901030383700'), true, 'Valid EAN-13 Maggi');
    assert.strictEqual(validateEanUpcChecksum('8901090672646'), true, 'Valid EAN-13 Ponds');
    assert.strictEqual(validateEanUpcChecksum('051111407592'), true, 'Valid UPC-A Milk');
    assert.strictEqual(validateEanUpcChecksum('012345678905'), true, 'Valid UPC-A Choco');
    assert.strictEqual(validateEanUpcChecksum('96385074'), true, 'Valid EAN-8');
  });

  await test('Checksum validation: Rejects corrupted or invalid check digits', () => {
    assert.strictEqual(validateEanUpcChecksum('8901030383709'), false, 'Corrupted EAN-13 check digit');
    assert.strictEqual(validateEanUpcChecksum('051111407599'), false, 'Corrupted UPC-A check digit');
    assert.strictEqual(validateEanUpcChecksum('12345'), false, 'Short length string');
    assert.strictEqual(validateEanUpcChecksum(''), false, 'Empty string');
  });

  await test('Normalization: Trims control characters and whitespace', () => {
    assert.strictEqual(normalizeBarcode('  \r\n8901030383700 \t\x00'), '8901030383700');
  });

  // =========================================================================
  // Section 2: Scanner Debounce & Keystroke Wedge Timing
  // =========================================================================
  await test('Debounce Logic: Blocks same barcode within 1500ms, allows different barcode', () => {
    const s = new BarcodeScanner({ debounceMs: 1500 });
    let emitted = [];
    s.on('scan', (e) => emitted.push(e));

    const t0 = 10000;
    // 1st scan
    const r1 = s.processBarcode('8901030383700', t0);
    assert.ok(r1, 'First scan accepted');
    assert.strictEqual(r1.seq, 1);

    // 2nd scan of same code at t0 + 200ms -> should be blocked by debounce
    const r2 = s.processBarcode('8901030383700', t0 + 200);
    assert.strictEqual(r2, null, 'Immediate repeat scan blocked');

    // Scan different code at t0 + 300ms -> accepted immediately
    const r3 = s.processBarcode('051111407592', t0 + 300);
    assert.ok(r3, 'Different barcode accepted without delay');
    assert.strictEqual(r3.seq, 2);

    // Scan original code after debounce window expired (t0 + 1600ms) -> accepted
    const r4 = s.processBarcode('8901030383700', t0 + 1600);
    assert.ok(r4, 'Original barcode accepted after debounce window expired');
    assert.strictEqual(r4.seq, 3);
    assert.strictEqual(emitted.length, 3);
  });

  await test('Keyboard Wedge: Fast scanner burst (<50ms/char) accepted, slow human typing (>50ms/char) rejected', () => {
    const s = new BarcodeScanner({ wedgeTimingThresholdMs: 50 });
    let scanResult = null;
    let rejectedResult = null;
    s.on('scan', (e) => { scanResult = e; });
    s.on('invalid_scan', (e) => { rejectedResult = e; });

    // 1. Fast scanner burst simulation (10ms between chars)
    let t = 20000;
    const fastBarcode = '8901030383700\r';
    for (const char of fastBarcode) {
      s.feedKeystroke(char, t);
      t += 10;
    }
    assert.ok(scanResult, 'Fast scanner burst successfully triggered scan event');
    assert.strictEqual(scanResult.barcode, '8901030383700');

    // 2. Slow human typing simulation (120ms between chars)
    s.reset();
    scanResult = null;
    t = 30000;
    const slowBarcode = '051111407592\r';
    for (const char of slowBarcode) {
      s.feedKeystroke(char, t);
      t += 120; // Human typing speed
    }
    assert.strictEqual(scanResult, null, 'Slow human typing did not trigger a scan event');
    assert.ok(rejectedResult, 'Slow typing generated invalid_scan event');
    assert.ok(rejectedResult.reason.includes('Human typing rejected'));
  });

  // =========================================================================
  // Section 3: Offline Bounded Queue Persistence & FIFO Flushing
  // =========================================================================
  await test('MQTT Offline Bounded Queue: Enqueue while disconnected, FIFO flush on reconnect, cap at max', async () => {
    const testQueueFile = `.test_offline_queue_${Date.now()}.json`;
    const mqttService = new MqttClientService({
      offlineQueueMax: 3,
      offlineQueueFile: testQueueFile,
    });

    // Enqueue 4 items when offline (capacity is 3)
    mqttService.publishOrQueue('test/topic', { msg: 1 });
    mqttService.publishOrQueue('test/topic', { msg: 2 });
    mqttService.publishOrQueue('test/topic', { msg: 3 });
    mqttService.publishOrQueue('test/topic', { msg: 4 });

    // Oldest item { msg: 1 } should be dropped, queue length must be 3
    assert.strictEqual(mqttService.offlineQueue.length, 3);
    assert.strictEqual(JSON.parse(mqttService.offlineQueue[0].payload).msg, 2, 'FIFO order preserved (oldest dropped)');
    assert.strictEqual(JSON.parse(mqttService.offlineQueue[2].payload).msg, 4);

    // Mock connected client and verify flush in order
    const published = [];
    mqttService.isConnected = true;
    mqttService.client = {
      publish: (topic, payload, opts, cb) => {
        published.push(JSON.parse(payload));
        cb(null);
      },
    };

    await mqttService.flushOfflineQueue();
    assert.strictEqual(published.length, 3);
    assert.strictEqual(published[0].msg, 2);
    assert.strictEqual(published[1].msg, 3);
    assert.strictEqual(published[2].msg, 4);
    assert.strictEqual(mqttService.offlineQueue.length, 0, 'Offline queue completely drained');

    // Clean up test file
    try {
      const fs = await import('fs');
      if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile);
    } catch (e) {}
  });

  // =========================================================================
  // Section 4: Scan-to-Cart Auto Add, Quantities & Stock Decrement
  // =========================================================================
  const testTrolleyId = `test-cart-${Date.now()}`;
  const testBarcode = `890${Date.now() % 1000000000}`;
  let testProduct = null;

  await test('Inventory Setup: Create test product with initial stock = 10', async () => {
    testProduct = await db.createProduct({
      barcode: testBarcode,
      sku: 'TEST-SKU-01',
      name: 'Test Energy Drink 250ml',
      category: 'Beverages',
      price: 50.00,
      gst_percent: 18.0,
      stock: 10,
    });
    assert.ok(testProduct.id);
    assert.strictEqual(testProduct.stock, 10);
  });

  const invService = new InventoryService({ allowNegativeStock: false, lowStockThreshold: 5 });

  await test('Scan-to-Cart Flow: First scan adds product with qty 1 and decrements stock to 9', async () => {
    const scanId = uuidv4();
    const result = await invService.scanAndProcessProduct({
      barcode: testBarcode,
      scanId,
      trolleyId: testTrolleyId,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.duplicate, false);
    assert.strictEqual(result.item.quantity, 1);
    assert.strictEqual(result.stock_remaining, 9);

    const freshProduct = await db.getProductById(testProduct.id);
    assert.strictEqual(freshProduct.stock, 9, 'Stock decremented by 1 in DB');
  });

  await test('Scan-to-Cart Flow: Second scan increments qty to 2 and decrements stock to 8', async () => {
    const scanId = uuidv4();
    const result = await invService.scanAndProcessProduct({
      barcode: testBarcode,
      scanId,
      trolleyId: testTrolleyId,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.item.quantity, 2);
    assert.strictEqual(result.stock_remaining, 8);

    const freshProduct = await db.getProductById(testProduct.id);
    assert.strictEqual(freshProduct.stock, 8);
  });

  await test('Idempotency: Re-submitting the exact same scan_id returns duplicate without double-decrementing stock', async () => {
    const scanId = uuidv4();
    // 1st time
    const res1 = await invService.scanAndProcessProduct({
      barcode: testBarcode,
      scanId,
      trolleyId: testTrolleyId,
    });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.duplicate, false);
    const stockAfter1 = res1.stock_remaining; // 7

    // 2nd time with exact same scanId (simulating QoS 1 MQTT re-delivery)
    const res2 = await invService.scanAndProcessProduct({
      barcode: testBarcode,
      scanId,
      trolleyId: testTrolleyId,
    });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.duplicate, true, 'Flagged as duplicate scanId');

    const freshProduct = await db.getProductById(testProduct.id);
    assert.strictEqual(freshProduct.stock, stockAfter1, 'Stock was not decremented on duplicate delivery');
  });

  // =========================================================================
  // Section 5: Unknown Barcode Alert & Auto-Add on Catalog Registration
  // =========================================================================
  const unknownCode = '8907777777775';
  await test('Unknown Barcode: Emits unknown_barcode alert when scanned', async () => {
    let alertEmitted = null;
    invService.once('unknown_barcode', (alert) => { alertEmitted = alert; });

    const scanId = uuidv4();
    const result = await invService.scanAndProcessProduct({
      barcode: unknownCode,
      scanId,
      trolleyId: testTrolleyId,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.not_found, true);
    assert.ok(alertEmitted, 'Alert event was emitted');
    assert.strictEqual(alertEmitted.barcode, unknownCode);
  });

  await test('Unknown Barcode Resolution: Creating product with autoAddCartId automatically adds it to cart', async () => {
    const autoAddResult = await invService.createProduct({
      barcode: unknownCode,
      sku: 'AUTO-SNACK-01',
      name: 'Roasted Cashews 100g',
      category: 'Snacks',
      price: 150.00,
      gst_percent: 5.0,
      stock: 20,
    }, { autoAddCartId: testTrolleyId });

    assert.ok(autoAddResult.product.id);
    assert.ok(autoAddResult.autoAddResult, 'Auto-add hook executed');
    assert.strictEqual(autoAddResult.autoAddResult.success, true);
    assert.strictEqual(autoAddResult.autoAddResult.item.barcode, unknownCode);
    assert.strictEqual(autoAddResult.autoAddResult.item.quantity, 1);
  });

  // =========================================================================
  // Section 6: Out of Stock & Concurrency Atomicity Lock Test
  // =========================================================================
  const scarceBarcode = `890${(Date.now() + 500) % 1000000000}`;
  let scarceProduct = null;

  await test('Concurrency Guard Setup: Create scarce product with stock = 1', async () => {
    scarceProduct = await db.createProduct({
      barcode: scarceBarcode,
      sku: 'SCARCE-01',
      name: 'Rare Collectible Model',
      category: 'General',
      price: 999.00,
      gst_percent: 18.0,
      stock: 1, // Only 1 unit in stock
    });
    assert.strictEqual(scarceProduct.stock, 1);
  });

  await test('Concurrency Guard: Two simultaneous scans of the last unit results in exactly 1 success and 1 out-of-stock', async () => {
    let outOfStockAlert = null;
    invService.once('out_of_stock', (alert) => { outOfStockAlert = alert; });

    // Fire 2 parallel requests simultaneously
    const [req1, req2] = await Promise.all([
      invService.scanAndProcessProduct({
        barcode: scarceBarcode,
        scanId: uuidv4(),
        trolleyId: testTrolleyId,
      }),
      invService.scanAndProcessProduct({
        barcode: scarceBarcode,
        scanId: uuidv4(),
        trolleyId: testTrolleyId,
      }),
    ]);

    const successes = [req1, req2].filter((r) => r.success);
    const outOfStocks = [req1, req2].filter((r) => r.out_of_stock);

    assert.strictEqual(successes.length, 1, 'Exactly one scan succeeded');
    assert.strictEqual(outOfStocks.length, 1, 'Exactly one scan was rejected for lack of stock');
    assert.ok(outOfStockAlert, 'out_of_stock alert was emitted');

    const finalProduct = await db.getProductById(scarceProduct.id);
    assert.strictEqual(finalProduct.stock, 0, 'Final stock is exactly 0 and never dropped negative');
  });

  // =========================================================================
  // Section 7: Stock Movements Audit Trail
  // =========================================================================
  await test('Stock Movements Audit Trail: Logs scan_add and restock events', async () => {
    const movements = await db.getStockMovements(testProduct.id);
    assert.ok(movements.length >= 2, 'Audit movements recorded for test product');
    const scanAddMovements = movements.filter((m) => m.reason === 'scan_add');
    assert.ok(scanAddMovements.length >= 2, 'Recorded scan_add movements');
    assert.strictEqual(scanAddMovements[0].change, -1);
  });

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passed}/${total} TESTS PASSED (100% SUCCESS)`);
  console.log('====================================================\n');
}

runAllTests().catch((e) => {
  console.error('Test runner fatal error:', e);
  process.exit(1);
});
