import assert from 'assert';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = 'http://localhost:5000';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = text;
  }
  return { status: response.status, data: json };
}

async function runTests() {
  console.log('--- Starting Backend Verification Tests ---');

  // 1. Health check
  console.log('Test 1: Health endpoint...');
  const healthRes = await request('/health');
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthRes.data.status, 'ok');
  assert.ok(healthRes.data.mqtt);
  console.log('Passed: /health returned status 200');

  // 2. Product Catalog CRUD
  console.log('Test 2: Product Catalog CRUD...');
  const testBarcode = `890123456${Date.now() % 10000}`;
  const createRes = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      barcode: testBarcode,
      name: 'Organic Milk 500ml',
      category: 'Dairy',
      price: 32.50,
      gst_percent: 5.0,
      stock: 20,
    }),
  });
  assert.strictEqual(createRes.status, 201);
  assert.strictEqual(createRes.data.barcode, testBarcode);
  assert.strictEqual(createRes.data.price, 32.50);
  const productId = createRes.data.id;
  console.log('Passed: Product created successfully');

  // Duplicate barcode rejection
  const dupRes = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      barcode: testBarcode,
      name: 'Duplicate Product',
      category: 'Dairy',
      price: 40.00,
    }),
  });
  assert.strictEqual(dupRes.status, 409);
  assert.strictEqual(dupRes.data.error.code, 'DUPLICATE_BARCODE');
  console.log('Passed: Duplicate barcode rejected with 409 DUPLICATE_BARCODE');

  // 3. Scan Flow and Idempotency
  console.log('Test 3: Scan flow and scanId idempotency...');
  await request('/api/cart/cancel', {
    method: 'POST',
    body: JSON.stringify({ trolleyId: 'trolley-01' }),
  });

  // Unknown barcode
  const unknownScanId = uuidv4();
  const unknownRes = await request('/api/scan', {
    method: 'POST',
    body: JSON.stringify({
      barcode: '9999999999999',
      scanId: unknownScanId,
      trolleyId: 'trolley-01',
    }),
  });
  assert.strictEqual(unknownRes.status, 404);
  assert.strictEqual(unknownRes.data.error.code, 'UNKNOWN_BARCODE');
  console.log('Passed: Unknown barcode returned 404 UNKNOWN_BARCODE');

  // Known barcode first scan
  const scanId1 = uuidv4();
  const scan1Res = await request('/api/scan', {
    method: 'POST',
    body: JSON.stringify({
      barcode: testBarcode,
      scanId: scanId1,
      trolleyId: 'trolley-01',
    }),
  });
  assert.strictEqual(scan1Res.status, 201);
  assert.strictEqual(scan1Res.data.duplicate, false);
  assert.strictEqual(scan1Res.data.cart.items.length, 1);
  assert.strictEqual(scan1Res.data.cart.items[0].quantity, 1);
  console.log('Passed: Known barcode added to cart (qty 1)');

  // Retry with same scanId (idempotent retry)
  const retryRes = await request('/api/scan', {
    method: 'POST',
    body: JSON.stringify({
      barcode: testBarcode,
      scanId: scanId1,
      trolleyId: 'trolley-01',
    }),
  });
  assert.strictEqual(retryRes.status, 200);
  assert.strictEqual(retryRes.data.duplicate, true);
  assert.strictEqual(retryRes.data.cart.items[0].quantity, 1, 'Quantity must not increment on duplicate scanId');
  console.log('Passed: Retry with same scanId did not duplicate item or increment quantity');

  // Deliberate second scan with new scanId
  const scanId2 = uuidv4();
  const scan2Res = await request('/api/scan', {
    method: 'POST',
    body: JSON.stringify({
      barcode: testBarcode,
      scanId: scanId2,
      trolleyId: 'trolley-01',
    }),
  });
  assert.strictEqual(scan2Res.status, 201);
  assert.strictEqual(scan2Res.data.duplicate, false);
  assert.strictEqual(scan2Res.data.cart.items[0].quantity, 2);
  // 2 * 32.50 = 65.00 subtotal, GST 5% = 3.25, total = 68.25
  assert.strictEqual(scan2Res.data.cart.subtotal, 65.00);
  assert.strictEqual(scan2Res.data.cart.gst_total, 3.25);
  assert.strictEqual(scan2Res.data.cart.total, 68.25);
  console.log('Passed: Deliberate second scan incremented quantity to 2 with exact GST and total');

  // 4. Checkout
  console.log('Test 4: Checkout and purchase record...');
  const checkoutRes = await request('/api/cart/checkout', {
    method: 'POST',
    body: JSON.stringify({ trolleyId: 'trolley-01' }),
  });
  assert.strictEqual(checkoutRes.status, 201);
  assert.strictEqual(checkoutRes.data.success, true);
  assert.strictEqual(checkoutRes.data.purchase.total, 68.25);
  assert.strictEqual(checkoutRes.data.cart.items.length, 0, 'New open cart must be empty');
  const purchaseId = checkoutRes.data.purchase.id;
  console.log('Passed: Checkout completed, purchase created, and cart reset');

  // Check product stock decremented from 20 to 18
  const prodAfterCheckout = await request(`/api/products/${productId}`);
  assert.strictEqual(prodAfterCheckout.data.stock, 18);
  console.log('Passed: Stock decremented correctly on checkout');

  // 5. Purchase Cancellation
  console.log('Test 5: Purchase cancellation...');
  const cancelPurchaseRes = await request(`/api/purchases/${purchaseId}/cancel`, {
    method: 'POST',
  });
  assert.strictEqual(cancelPurchaseRes.status, 200);
  assert.strictEqual(cancelPurchaseRes.data.purchase.status, 'cancelled');

  const prodAfterCancel = await request(`/api/products/${productId}`);
  assert.strictEqual(prodAfterCancel.data.stock, 20);
  console.log('Passed: Purchase cancelled and stock restored to 20');

  // 6. Bulk Import
  console.log('Test 6: Bulk import...');
  const bulkCsv = `barcode,name,category,price,gst_percent,stock
890001,Bread,Groceries,40.00,0,15
890002,Butter,Dairy,55.00,12,10
890003,Biscuits,Snacks,20.00,18,50`;

  const importRes = await request('/api/products/import', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: bulkCsv,
  });
  assert.strictEqual(importRes.status, 200);
  assert.strictEqual(importRes.data.added, 3);
  console.log('Passed: CSV bulk import added 3 products');

  // 7. Trolley State and Command Validation
  console.log('Test 7: Trolley state and command validation...');
  const stateRes = await request('/api/trolley/trolley-01/state');
  assert.strictEqual(stateRes.status, 200);
  assert.strictEqual(stateRes.data.deviceId, 'trolley-01');

  // Invalid command
  const badCmdRes = await request('/api/trolley/trolley-01/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'DANCE' }),
  });
  assert.strictEqual(badCmdRes.status, 400);
  console.log('Passed: Invalid command rejected with 400');

  // 8. Server-Side AI Barcode Lookup Proxy
  console.log('Test 8: Server-side AI barcode lookup proxy...');
  const aiRes = await request('/api/products/ai-lookup', {
    method: 'POST',
    body: JSON.stringify({ barcode: '8901030383921', hint: 'Butter' }),
  });
  assert.strictEqual(aiRes.status, 200);
  assert.ok('configured' in aiRes.data);
  console.log('Passed: AI barcode lookup responded with HTTP 200 and valid schema');

  console.log('--- ALL BACKEND VERIFICATION TESTS PASSED ---');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
