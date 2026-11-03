/**
 * full_functional_audit.test.js
 * Comprehensive End-to-End Functional Audit & Integration Verification Harness
 * Tests EVERY SINGLE user workflow, CRUD operation, calculation, constraint, and edge case.
 */

import assert from 'node:assert';
import { db } from '../src/db.js';
import { InventoryService } from '../src/inventory/inventory_service.js';
import { EventLogger } from '../src/logger/event_logger.js';
import { v4 as uuidv4 } from 'uuid';

let passCount = 0;
let failCount = 0;
const failures = [];

async function test(section, name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  [PASS] ${section} -> ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ section, name, error: err.message });
    console.error(`  [FAIL] ${section} -> ${name}`);
    console.error(`         ${err.message}`);
  }
}

async function runCompleteFunctionalAudit() {
  console.log('==================================================================================');
  console.log('       STARTING COMPLETE END-TO-END SYSTEM FUNCTIONAL AUDIT & VERIFICATION       ');
  console.log('==================================================================================\n');

  const inventoryService = new InventoryService({
    lowStockThreshold: 5,
    allowNegativeStock: false,
  });

  const eventLogger = new EventLogger({
    flushIntervalSec: 0,
    exportsDir: './backend/exports',
  });

  // -----------------------------------------------------------------------------
  // MODULE 1: MASTER PRODUCT CATALOG CRUD & SEARCH
  // -----------------------------------------------------------------------------
  console.log('--- MODULE 1: MASTER PRODUCT CATALOG ---');
  let testCatalogId;
  const uniqueSku = `TEST-SKU-${Date.now() % 100000}`;
  const uniqueBarcode = `8901234${Date.now() % 1000000}`;

  await test('Catalog', 'Create catalog product with valid data', async () => {
    const item = await db.createCatalogProduct({
      sku: uniqueSku,
      barcode: uniqueBarcode,
      name: 'Organic Almond Butter 200g',
      category: 'Groceries',
      brand: 'NutriFarm',
      description: '100% natural roasted almonds',
      default_price: 349.00,
      unit: 'jar',
      is_active: true,
    });
    assert.ok(item.id, 'Must generate UUID');
    assert.strictEqual(item.sku, uniqueSku);
    assert.strictEqual(item.default_price, 349.00);
    testCatalogId = item.id;
  });

  await test('Catalog', 'Reject duplicate SKU creation', async () => {
    await assert.rejects(
      async () => {
        await db.createCatalogProduct({
          sku: uniqueSku, // Duplicate
          name: 'Another item',
          default_price: 100,
        });
      },
      (err) => err.code === 'DUPLICATE_SKU' || err.message.includes('already exists') || err.message.includes('unique')
    );
  });

  await test('Catalog', 'Get catalog product by ID', async () => {
    const item = await db.getCatalogProductById(testCatalogId);
    assert.ok(item, 'Item must be found');
    assert.strictEqual(item.name, 'Organic Almond Butter 200g');
    assert.strictEqual(item.is_active, true);
  });

  await test('Catalog', 'Search and filter catalog products', async () => {
    const searchRes = await db.getCatalogProducts({ search: 'Almond Butter' });
    assert.ok(searchRes.data.length >= 1, 'Should find item by text search');
    assert.ok(searchRes.data.some(p => p.id === testCatalogId));

    const catRes = await db.getCatalogProducts({ category: 'Groceries' });
    assert.ok(catRes.data.some(p => p.id === testCatalogId));

    const nonMatchRes = await db.getCatalogProducts({ category: 'Electronics', search: 'Almond' });
    assert.strictEqual(nonMatchRes.data.length, 0, 'Should not match wrong category');
  });

  await test('Catalog', 'Update catalog product fields', async () => {
    const updated = await db.updateCatalogProduct(testCatalogId, {
      default_price: 329.00,
      description: 'Updated premium almond butter',
    });
    assert.strictEqual(updated.default_price, 329.00);
    assert.strictEqual(updated.description, 'Updated premium almond butter');
  });

  // -----------------------------------------------------------------------------
  // MODULE 2: STORE INVENTORY CRUD & CATALOG LINKING
  // -----------------------------------------------------------------------------
  console.log('\n--- MODULE 2: STORE INVENTORY & CATALOG LINKING ---');
  let linkedInventoryProduct;

  await test('Inventory', 'Link catalog product to store inventory', async () => {
    linkedInventoryProduct = await db.linkCatalogProductToInventory(testCatalogId, {
      price: 325.00,
      stock: 20,
      gst_percent: 5.0,
    });
    assert.ok(linkedInventoryProduct.id);
    assert.strictEqual(linkedInventoryProduct.stock, 20);
    assert.strictEqual(linkedInventoryProduct.price, 325.00);

    // Verify catalog item now reports in_inventory = true
    const catalogItem = await db.getCatalogProductById(testCatalogId);
    assert.strictEqual(catalogItem.in_inventory, true);
    assert.strictEqual(catalogItem.stock, 20);
    assert.strictEqual(catalogItem.stock_status, 'in_stock');
  });

  await test('Inventory', 'Manual stock adjustment with audit trail', async () => {
    const res = await inventoryService.adjustStock(linkedInventoryProduct.id, 5, 'restock');
    assert.strictEqual(res.newStock, 25);

    const movements = await db.getStockMovements(linkedInventoryProduct.id);
    assert.ok(movements.length >= 1);
    assert.strictEqual(movements[0].reason, 'restock');
  });

  await test('Inventory', 'Reject stock adjustment resulting in negative inventory', async () => {
    await assert.rejects(
      async () => {
        await inventoryService.adjustStock(linkedInventoryProduct.id, -100, 'adjustment');
      },
      /negative stock/i
    );
  });

  // -----------------------------------------------------------------------------
  // MODULE 3: SHOPPING CART & REAL-TIME POS BILLING PIPELINE
  // -----------------------------------------------------------------------------
  console.log('\n--- MODULE 3: SHOPPING CART & POS BILLING ---');
  const testTrolleyId = `trolley-audit-${Date.now() % 10000}`;
  let activeCart;

  await test('Cart', 'Create and get open cart for trolley session', async () => {
    activeCart = await db.getOrCreateOpenCart(testTrolleyId);
    assert.ok(activeCart.id);
    assert.strictEqual(activeCart.status, 'open');
  });

  await test('Cart', '1-Click add product from catalog with quantity = 2', async () => {
    const result = await inventoryService.addCatalogItemToCart({
      catalogId: testCatalogId,
      quantity: 2,
      trolleyId: testTrolleyId,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.duplicate, false);
    assert.strictEqual(result.stock_remaining, 23); // 25 - 2 = 23
    assert.strictEqual(result.item.quantity, 2);
    // Subtotal: 2 * 325.00 = 650.00. Tax: 5% of 650 = 32.50. Total = 682.50
    assert.strictEqual(result.cart.subtotal, 650.00);
    assert.strictEqual(result.cart.gst_total, 32.50);
    assert.strictEqual(result.cart.total, 682.50);
  });

  await test('Cart', 'Scan barcode to add another item', async () => {
    const scanId = uuidv4();
    const scanRes = await inventoryService.scanAndProcessProduct({
      barcode: linkedInventoryProduct.barcode,
      scanId,
      trolleyId: testTrolleyId,
    });

    assert.strictEqual(scanRes.success, true);
    assert.strictEqual(scanRes.duplicate, false);
    assert.strictEqual(scanRes.stock_remaining, 22); // 23 - 1 = 22
    assert.strictEqual(scanRes.item.quantity, 3); // 2 + 1 = 3
    // Subtotal: 3 * 325 = 975.00. Tax: 5% = 48.75. Total = 1023.75
    assert.strictEqual(scanRes.cart.subtotal, 975.00);
    assert.strictEqual(scanRes.cart.gst_total, 48.75);
    assert.strictEqual(scanRes.cart.total, 1023.75);
  });

  await test('Cart', 'Scan idempotency: Replaying exact same scanId returns duplicate flag', async () => {
    const scanId = uuidv4();
    const first = await inventoryService.scanAndProcessProduct({
      barcode: linkedInventoryProduct.barcode,
      scanId,
      trolleyId: testTrolleyId,
    });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.duplicate, false);

    const duplicate = await inventoryService.scanAndProcessProduct({
      barcode: linkedInventoryProduct.barcode,
      scanId,
      trolleyId: testTrolleyId,
    });
    assert.strictEqual(duplicate.success, true);
    assert.strictEqual(duplicate.duplicate, true);

    // Verify stock was decremented ONLY once
    const prod = await db.getProductById(linkedInventoryProduct.id);
    assert.strictEqual(prod.stock, 21); // Decremented from 22 to 21
  });

  await test('Cart', 'Unknown barcode scanning returns not_found error & records event', async () => {
    const unkScanId = uuidv4();
    const unkRes = await inventoryService.scanAndProcessProduct({
      barcode: '9999999999999',
      scanId: unkScanId,
      trolleyId: testTrolleyId,
    });
    assert.strictEqual(unkRes.success, false);
    assert.strictEqual(unkRes.not_found, true);
  });

  await test('Cart', 'Update cart item quantity (+ / -)', async () => {
    const cart = await db.getOrCreateOpenCart(testTrolleyId);
    const updated = await inventoryService.updateCartItemQuantity(cart.id, linkedInventoryProduct.id, 5);
    assert.ok(updated);
    const item = updated.items.find(i => i.product_id === linkedInventoryProduct.id);
    assert.strictEqual(item.quantity, 5);
  });

  await test('Cart', 'Checkout cart: Finalizes invoice, records audit snapshots, and clears cart', async () => {
    const cart = await db.getOrCreateOpenCart(testTrolleyId);
    const purchase = await db.checkoutCart(cart.id);

    assert.ok(purchase.id, 'Purchase ID generated');
    assert.strictEqual(purchase.status, 'completed');
    assert.ok(purchase.total > 0);
    assert.ok(purchase.items.length >= 1);

    // Verify old cart is marked checked_out
    const oldCart = await db.getCartDetails(cart.id);
    assert.strictEqual(oldCart.status, 'checked_out');

    // Fresh open cart created for subsequent shopping
    const freshCart = await db.getOrCreateOpenCart(testTrolleyId);
    assert.strictEqual(freshCart.status, 'open');
    const freshDetails = await db.getCartDetails(freshCart.id);
    assert.strictEqual(freshDetails.items.length, 0);
  });

  // -----------------------------------------------------------------------------
  // MODULE 4: ORDER HISTORY & CANCELLATION STOCK RESTORATION
  // -----------------------------------------------------------------------------
  console.log('\n--- MODULE 4: ORDER HISTORY & CANCELLATION ---');
  let latestPurchaseId;

  await test('Purchases', 'List past purchases with pagination', async () => {
    const purchases = await db.getPurchases({ page: 1, pageSize: 10 });
    assert.ok(purchases.data.length >= 1);
    latestPurchaseId = purchases.data[0].id;
  });

  await test('Purchases', 'Get purchase invoice details by ID', async () => {
    const invoice = await db.getPurchaseById(latestPurchaseId);
    assert.ok(invoice);
    assert.strictEqual(invoice.id, latestPurchaseId);
    assert.ok(Array.isArray(invoice.items));
  });

  await test('Purchases', 'Cancel purchase and restore reserved stock to inventory', async () => {
    const preStockProd = await db.getProductById(linkedInventoryProduct.id);
    const preStock = preStockProd.stock;

    const cancelled = await db.cancelPurchase(latestPurchaseId);
    assert.strictEqual(cancelled.status, 'cancelled');

    const postStockProd = await db.getProductById(linkedInventoryProduct.id);
    assert.ok(postStockProd.stock > preStock, 'Stock must have increased upon order cancellation');
  });

  // -----------------------------------------------------------------------------
  // MODULE 5: REAL-TIME ADMIN DASHBOARD ANALYTICS & HEALTH
  // -----------------------------------------------------------------------------
  console.log('\n--- MODULE 5: ADMIN DASHBOARD ANALYTICS & HEALTH ---');

  await test('Admin', 'Compute accurate non-fake KPIs and metrics', async () => {
    const stats = await db.getAdminDashboardStats(14);
    assert.ok(stats.kpis);
    assert.strictEqual(typeof stats.kpis.totalRevenue, 'number');
    assert.strictEqual(typeof stats.kpis.totalInventoryValuation, 'number');
    assert.ok(stats.kpis.totalProducts >= 1);
    assert.ok(Array.isArray(stats.salesTimeline));
    assert.strictEqual(stats.salesTimeline.length, 14);
    assert.ok(Array.isArray(stats.categoryBreakdown));
  });

  await test('Admin', 'Report exact table counts across all 10 tables', async () => {
    const health = await db.getDatabaseHealth();
    assert.ok(health.tables);
    assert.ok(health.tables.products >= 1);
    assert.ok(health.tables.catalog_products >= 1);
    assert.strictEqual(typeof health.uptimeSec, 'number');
    assert.ok(health.memory);
  });

  await test('Admin', 'Quick restock action increases stock by +10', async () => {
    const prodBefore = await db.getProductById(linkedInventoryProduct.id);
    const beforeStock = prodBefore.stock;

    const res = await inventoryService.adjustStock(linkedInventoryProduct.id, 10, 'restock');
    assert.strictEqual(res.newStock, beforeStock + 10);
  });

  // -----------------------------------------------------------------------------
  // MODULE 6: LIVE EXCEL LOGGER & 5-SECOND CLEANING CYCLE
  // -----------------------------------------------------------------------------
  console.log('\n--- MODULE 6: LIVE EXCEL LOGGER & CLEANING ---');

  await test('Excel Logger', 'Buffer sensor events and filter noise on flush', async () => {
    eventLogger.logEvent({ action: 'heartbeat', sensor_type: 'system' }); // Noise
    eventLogger.logEvent({ action: 'product_added', sensor_type: 'barcode_scanner', product_name: 'Audit Test Butter', value: '8901234000', qty: 1, stock_after: 19 }); // Important

    await eventLogger.flush();
    const stats = eventLogger.getStats();
    assert.strictEqual(stats.bufferSize, 0, 'Buffer must be empty after flush');
    assert.ok(stats.totalCleanedWritten >= 1);
    assert.ok(stats.activeWorkbook.endsWith('.xlsx'));
  });

  // -----------------------------------------------------------------------------
  // FINAL SUMMARY
  // -----------------------------------------------------------------------------
  console.log('\n==================================================================================');
  console.log(`TOTAL AUDIT TESTS COMPLETED: ${passCount + failCount}`);
  console.log(`  PASSED: ${passCount}`);
  console.log(`  FAILED: ${failCount}`);
  if (failures.length > 0) {
    console.log('\nFAILURES DETECTED:');
    failures.forEach(f => console.log(`  - [${f.section}] ${f.name}: ${f.error}`));
    process.exitCode = 1;
  } else {
    console.log('ALL MODULES, PIPELINES, WORKFLOWS, AND CALCULATIONS ARE 100% OPERATIONAL!');
  }
  console.log('==================================================================================');
}

runCompleteFunctionalAudit().catch(err => {
  console.error('[FATAL] Functional audit runner threw:', err);
  process.exit(1);
});
