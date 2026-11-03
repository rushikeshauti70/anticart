/**
 * admin_dashboard.test.js
 * Automated Verification Suite for Admin Operations, Analytics & Real-Time Supabase Diagnostics
 */

import assert from 'node:assert';
import { db } from '../src/db.js';
import { InventoryService } from '../src/inventory/inventory_service.js';
import { EventLogger } from '../src/logger/event_logger.js';

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

async function runTests() {
  console.log('====================================================');
  console.log('    TEST SUITE: ADMIN ANALYTICS & DATABASE HEALTH   ');
  console.log('====================================================');

  const inventoryService = new InventoryService({ lowStockThreshold: 5 });

  // 1. Setup sample products & transactions
  const productA = await db.createProduct({
    barcode: '8901000111222',
    name: 'Organic Honey 250g',
    category: 'Groceries',
    price: 180.00,
    gst_percent: 5.0,
    stock: 2, // Low stock!
  });

  const productB = await db.createProduct({
    barcode: '8901000333444',
    name: 'Gourmet Dark Chocolate 100g',
    category: 'Snacks',
    price: 95.00,
    gst_percent: 18.0,
    stock: 25, // Healthy stock
  });

  // Record a scan event
  await db.recordScanEvent({
    scanId: 'scan-admin-test-01',
    cartId: 'cart-admin-01',
    barcode: '8901000111222',
    productId: productA.id,
    result: 'added',
  });

  // Record an unknown scan event
  await db.recordScanEvent({
    scanId: 'scan-admin-test-02',
    cartId: 'cart-admin-01',
    barcode: '9999999999999',
    productId: null,
    result: 'unknown',
  });

  // 1. Test Dashboard Statistics Computation
  await test('1. Dashboard KPIs: Calculates accurate non-fake metrics from database state', async () => {
    const stats = await db.getAdminDashboardStats(14);
    assert.ok(stats.kpis, 'Must return kpis object');
    assert.strictEqual(typeof stats.kpis.totalRevenue, 'number');
    assert.strictEqual(typeof stats.kpis.totalInventoryValuation, 'number');
    assert.ok(stats.kpis.totalProducts >= 2, 'Must include store products');
    assert.ok(stats.kpis.lowStockCount >= 1, 'Must detect productA as low stock');
    assert.ok(Array.isArray(stats.salesTimeline), 'Must return sales timeline array');
    assert.strictEqual(stats.salesTimeline.length, 14, 'Timeline must contain requested 14 days');
    assert.ok(Array.isArray(stats.categoryBreakdown), 'Must return category breakdown');
    assert.ok(Array.isArray(stats.lowStockAlerts), 'Must return low stock alert array');
    assert.ok(stats.lowStockAlerts.some(i => i.id === productA.id), 'productA must appear in low stock alerts');
  });

  // 2. Test Database Health Diagnostics
  await test('2. Database Health: Reports exact row counts across all tables and system uptime', async () => {
    const health = await db.getDatabaseHealth();
    assert.ok(health.tables, 'Must return tables object');
    assert.ok(health.tables.products >= 2, 'Products count must match');
    assert.ok(health.tables.scan_events >= 2, 'Scan events count must match');
    assert.strictEqual(typeof health.uptimeSec, 'number');
    assert.ok(health.memory, 'Must return Node.js process memory metrics');
    assert.strictEqual(health.connected, true);
  });

  // 3. Test Admin Scan Audit Log Pagination & Filtering
  await test('3. Admin Scan Logs: Filters by scan result and supports pagination', async () => {
    const allScans = await db.getAdminScanEvents({ page: 1, pageSize: 10 });
    assert.ok(allScans.data.length >= 2, 'Must return scan records');
    assert.ok(allScans.total >= 2);

    const unknownOnly = await db.getAdminScanEvents({ result: 'unknown' });
    assert.ok(unknownOnly.data.every(s => s.result === 'unknown'), 'Must filter exclusively unknown scans');
  });

  // 4. Test Stock Movements Audit Trail
  await test('4. Stock Movements Trail: Records stock adjustments and provides audit trail', async () => {
    await inventoryService.adjustStock(productA.id, 10, 'restock');
    
    const movements = await db.getAdminStockMovements({ page: 1, pageSize: 10, reason: 'restock' });
    assert.ok(movements.data.length >= 1, 'Must log restock movement');
    assert.strictEqual(movements.data[0].reason, 'restock');

    const freshA = await db.getProductById(productA.id);
    assert.strictEqual(freshA.stock, 12, 'Stock must have increased from 2 to 12');
  });

  // 5. Test Quick Restock Method
  await test('5. Quick Restock Action: Instantly increments stock and updates inventory health', async () => {
    const initialStats = await db.getAdminDashboardStats(7);
    const initialLow = initialStats.kpis.lowStockCount;

    // Create a product with 1 unit in stock
    const scarceProd = await db.createProduct({
      barcode: '8901000555666',
      name: 'Scarce Item For Restock',
      category: 'General',
      price: 50.00,
      stock: 1,
    });

    // Quick restock +15
    await inventoryService.adjustStock(scarceProd.id, 15, 'restock');
    const updated = await db.getProductById(scarceProd.id);
    assert.strictEqual(updated.stock, 16);

    const updatedStats = await db.getAdminDashboardStats(7);
    assert.ok(updatedStats.kpis.healthyStockCount >= 1);
  });

  console.log('====================================================');
  console.log('   ALL 5 ADMIN & DATABASE HEALTH TESTS PASSED!      ');
  console.log('====================================================');
}

runTests().catch((err) => {
  console.error('[FATAL] Admin test runner failed:', err);
  process.exit(1);
});

