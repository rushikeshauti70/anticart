import dotenv from 'dotenv';
dotenv.config();

import { db } from '../src/db.js';

export const SAMPLE_PRODUCTS = [
  {
    barcode: '051111407592', // UPC-A
    sku: 'DAIRY-MILK-1L',
    name: 'Organic Whole Milk 1L',
    category: 'Dairy',
    price: 65.00,
    gst_percent: 5.0,
    stock: 15,
    unit: 'btl',
  },
  {
    barcode: '8901090672646', // EAN-13
    sku: 'CARE-PONDS-100G',
    name: "Pond's Bright Beauty Face Wash 100g",
    category: 'Personal Care',
    price: 125.00,
    gst_percent: 18.0,
    stock: 20,
    unit: 'tube',
  },
  {
    barcode: '8901030383700', // EAN-13
    sku: 'GROC-MAGGI-70G',
    name: 'Maggi 2-Minute Masala Instant Noodles 70g',
    category: 'Groceries',
    price: 14.00,
    gst_percent: 12.0,
    stock: 50,
    unit: 'pack',
  },
  {
    barcode: '8901491101837', // EAN-13
    sku: 'SNK-LAYS-50G',
    name: 'Lays Classic Salted Potato Chips 50g',
    category: 'Snacks',
    price: 20.00,
    gst_percent: 12.0,
    stock: 30,
    unit: 'bag',
  },
  {
    barcode: '8901725181222', // EAN-13
    sku: 'DAIRY-AMUL-GHEE-500ML',
    name: 'Amul Pure Ghee 500ml',
    category: 'Dairy',
    price: 310.00,
    gst_percent: 5.0,
    stock: 12,
    unit: 'jar',
  },
  {
    barcode: '8901063012110', // EAN-13
    sku: 'SNK-GDAY-100G',
    name: 'Britannia Good Day Butter Cookies 100g',
    category: 'Snacks',
    price: 30.00,
    gst_percent: 12.0,
    stock: 25,
    unit: 'pack',
  },
  {
    barcode: '8901058852331', // EAN-13
    sku: 'GROC-TATASALT-1KG',
    name: 'Tata Salt Vacuum Evaporated 1kg',
    category: 'Groceries',
    price: 28.00,
    gst_percent: 0.0,
    stock: 40,
    unit: 'pouch',
  },
  {
    barcode: '012345678905', // UPC-A
    sku: 'SPEC-CHOCO-LTD',
    name: 'Limited Edition Dark Chocolate 85%',
    category: 'Snacks',
    price: 99.00,
    gst_percent: 18.0,
    stock: 1, // 1 unit remaining for concurrency test
    unit: 'bar',
  },
  {
    barcode: '041570052951', // UPC-A
    sku: 'BEV-SODA-ZERO',
    name: 'Zero Stock Sparkling Soda 330ml',
    category: 'Beverages',
    price: 45.00,
    gst_percent: 28.0,
    stock: 0, // 0 units for out-of-stock test
    unit: 'can',
  },
];

async function seed() {
  console.log('--- Seeding Sample Inventory Products ---');
  let added = 0;
  let updated = 0;

  for (const item of SAMPLE_PRODUCTS) {
    try {
      const existing = await db.getProductByBarcode(item.barcode);
      if (existing) {
        await db.updateProduct(existing.id, {
          name: item.name,
          sku: item.sku,
          price: item.price,
          gst_percent: item.gst_percent,
          stock: item.stock,
          category: item.category,
        });
        console.log(`[UPDATE] ${item.name} (${item.barcode}) - Stock: ${item.stock}`);
        updated++;
      } else {
        await db.createProduct(item);
        console.log(`[INSERT] ${item.name} (${item.barcode}) - Stock: ${item.stock}`);
        added++;
      }
    } catch (err) {
      console.error(`[ERROR] Failed to seed ${item.barcode}:`, err.message);
    }
  }

  console.log(`\nSeed Complete! Added: ${added}, Updated: ${updated}`);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed();
}
