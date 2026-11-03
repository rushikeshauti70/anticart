import dotenv from 'dotenv';
dotenv.config();

import { db } from '../src/db.js';

export const SAMPLE_CATALOG_PRODUCTS = [
  {
    sku: 'DAIRY-MILK-1L',
    name: 'Organic Whole Milk 1L',
    barcode: '051111407592', // UPC-A
    category: 'Dairy',
    brand: 'Amul',
    description: 'Fresh pasteurized homogenized organic whole cow milk in 1L bottle.',
    image_url: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=300&q=80',
    default_price: 65.00,
    unit: 'btl',
    initial_stock: 15,
  },
  {
    sku: 'CARE-PONDS-100G',
    name: "Pond's Bright Beauty Face Wash 100g",
    barcode: '8901090672646', // EAN-13
    category: 'Personal Care',
    brand: "Pond's",
    description: 'Deep cleansing face wash with vitamin B3+ serum for glowing skin.',
    image_url: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=300&q=80',
    default_price: 125.00,
    unit: 'tube',
    initial_stock: 20,
  },
  {
    sku: 'GROC-MAGGI-70G',
    name: 'Maggi 2-Minute Masala Instant Noodles 70g',
    barcode: '8901030383700', // EAN-13
    category: 'Groceries',
    brand: 'Nestle',
    description: 'Favorite Indian instant noodles enriched with iron and authentic roasted spices.',
    image_url: 'https://images.unsplash.com/photo-1612927601601-6638404737ce?w=300&q=80',
    default_price: 14.00,
    unit: 'pack',
    initial_stock: 50,
  },
  {
    sku: 'SNK-LAYS-50G',
    name: 'Lays Classic Salted Potato Chips 50g',
    barcode: '8901491101837', // EAN-13
    category: 'Snacks',
    brand: "Lay's",
    description: 'Thinly sliced potatoes crisped to perfection and lightly salted.',
    image_url: 'https://images.unsplash.com/photo-1566478989037-eec170784d0b?w=300&q=80',
    default_price: 20.00,
    unit: 'bag',
    initial_stock: 30,
  },
  {
    sku: 'DAIRY-AMUL-GHEE-500ML',
    name: 'Amul Pure Ghee 500ml',
    barcode: '8901725181222', // EAN-13
    category: 'Dairy',
    brand: 'Amul',
    description: 'Traditional aroma and granules made from fresh cow milk fat.',
    image_url: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?w=300&q=80',
    default_price: 310.00,
    unit: 'jar',
    initial_stock: 12,
  },
  {
    sku: 'SNK-GDAY-100G',
    name: 'Britannia Good Day Butter Cookies 100g',
    barcode: '8901063012110', // EAN-13
    category: 'Snacks',
    brand: 'Britannia',
    description: 'Rich butter cookies with delightful smiles on every bite.',
    image_url: 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=300&q=80',
    default_price: 25.00,
    unit: 'pack',
    initial_stock: 40,
  },
  // Unstocked Catalog items (for testing "Not in Inventory" and "Add to Inventory" flow)
  {
    sku: 'BEV-TATA-TEA-250G',
    name: 'Tata Tea Gold Premium Black Tea 250g',
    barcode: '8901052002144',
    category: 'Beverages',
    brand: 'Tata Tea',
    description: 'Fine tea leaves with gently rolled long leaves for superior aroma and taste.',
    image_url: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=300&q=80',
    default_price: 160.00,
    unit: 'box',
    initial_stock: 0, // Unstocked
  },
  {
    sku: 'ELEC-DURACELL-AA4',
    name: 'Duracell Ultra Alkaline AA Batteries (Pack of 4)',
    barcode: '5000394002814',
    category: 'Electronics',
    brand: 'Duracell',
    description: 'Up to 100% more power for high-drain devices with POWERCHECK.',
    image_url: 'https://images.unsplash.com/photo-1619725002198-6a689b72f41d?w=300&q=80',
    default_price: 199.00,
    unit: 'pack',
    initial_stock: 0, // Unstocked
  },
  {
    sku: 'STAT-CLASSMATE-NB',
    name: 'Classmate Long Ruled Notebook 172 Pages',
    barcode: '8901030588235',
    category: 'Stationery',
    brand: 'Classmate',
    description: 'Eco-friendly elemental chlorine-free paper notebook for students.',
    image_url: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=300&q=80',
    default_price: 55.00,
    unit: 'book',
    initial_stock: 0, // Unstocked
  },
];

export async function seedCatalog() {
  console.log('Seeding Master Product Catalog...');
  let createdCount = 0;

  for (const item of SAMPLE_CATALOG_PRODUCTS) {
    try {
      const created = await db.createCatalogProduct({
        sku: item.sku,
        name: item.name,
        barcode: item.barcode,
        category: item.category,
        brand: item.brand,
        description: item.description,
        image_url: item.image_url,
        default_price: item.default_price,
        unit: item.unit,
      });

      // If initial_stock > 0, also stock into store inventory
      if (item.initial_stock > 0) {
        await db.linkCatalogProductToInventory(created.id, {
          price: item.default_price,
          stock: item.initial_stock,
          gst_percent: 5.0,
        });
      }

      console.log(`  + Seeded: ${item.sku.padEnd(22)} | ${item.name} (${item.initial_stock > 0 ? `Stock: ${item.initial_stock}` : 'Not stocked'})`);
      createdCount++;
    } catch (err) {
      if (err.code === 'DUPLICATE_SKU' || err.code === 'DUPLICATE_BARCODE') {
        console.log(`  = Already exists: ${item.sku}`);
      } else {
        console.warn(`  ! Error seeding ${item.sku}:`, err.message);
      }
    }
  }

  console.log(`Master Product Catalog seeding finished. (${createdCount} items processed)`);
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('seed_catalog.js')) {
  seedCatalog().then(() => process.exit(0)).catch((err) => {
    console.error('Seed catalog error:', err);
    process.exit(1);
  });
}
