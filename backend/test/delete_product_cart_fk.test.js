import assert from 'node:assert';
import { db } from '../src/db.js';

async function testDeleteProductWithCartFK() {
  console.log('Testing deleteProduct when product has entries in cart_items...');
  const runId = Math.floor(Date.now() % 1000000);
  const testBarcode = `8909${runId}`;
  const trolleyId = `trolley-del-fk-${runId}`;

  // 1. Create a product
  const prod = await db.createProduct({
    barcode: testBarcode,
    name: `Delete FK Test Item ${runId}`,
    category: 'General',
    price: 99.00,
    stock: 5,
  });
  console.log('Created product:', prod.id);

  // 2. Add product to an active cart
  const scanRes = await db.scanAndAddToCart({
    barcode: testBarcode,
    scanId: `scan-del-${runId}`,
    trolleyId,
  });
  console.log('Added to cart:', scanRes.cart.id, 'Cart items:', scanRes.cart.items.length);
  assert.ok(scanRes.cart.items.some(i => i.product_id === prod.id));

  // 3. Delete the product - this previously threw:
  // "violates foreign key constraint cart_items_product_id_fkey on table cart_items"
  const deleted = await db.deleteProduct(prod.id);
  assert.strictEqual(deleted, true, 'Product must be successfully deleted');
  console.log('Successfully deleted product with zero FK errors!');

  // 4. Verify product no longer returned in getProducts
  const products = await db.getProducts({ search: testBarcode });
  assert.strictEqual(products.data.length, 0, 'Deleted product must not appear in inventory listing');

  console.log('TEST PASSED: Product deletion with cart items reference is 100% clean!');
  process.exit(0);
}

testDeleteProductWithCartFK().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
