import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';

class ProductCache {
  constructor(ttlMs = 60000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  get(barcode) {
    const entry = this.cache.get(barcode);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(barcode);
      return null;
    }
    return entry.value;
  }

  set(barcode, value) {
    this.cache.set(barcode, {
      value,
      expiry: Date.now() + this.ttlMs,
    });
  }

  invalidate(barcode) {
    if (barcode) {
      this.cache.delete(barcode);
    } else {
      this.cache.clear();
    }
  }
}

export const productCache = new ProductCache();

// In-Memory Repository for local dev/testing without Supabase credentials
class MemoryStore {
  constructor() {
    this.products = new Map();
    this.catalogProducts = new Map();
    this.carts = new Map();
    this.cartItems = new Map(); // cart_id:product_id -> item
    this.scanEvents = new Map();
    this.purchases = new Map();
    this.purchaseItems = new Map();
    this.stockMovements = [];
    this.trolleyEvents = [];
    this.trolleyTelemetry = [];
  }

  // --- Master Catalog Products ---
  async getCatalogProducts({ search = '', category = '', page = 1, pageSize = 50 } = {}) {
    let list = Array.from(this.catalogProducts.values()).filter(p => p.is_active !== false);

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.barcode && p.barcode.includes(q)) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.brand && p.brand.toLowerCase().includes(q))
      );
    }

    if (category && category !== 'All') {
      list = list.filter(p => p.category && p.category.toLowerCase() === category.toLowerCase());
    }

    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const enriched = list.map(cp => {
      let invProduct = null;
      for (const p of this.products.values()) {
        if (p.active !== false && (p.catalog_product_id === cp.id || (cp.barcode && p.barcode === cp.barcode) || (cp.sku && p.sku === cp.sku))) {
          invProduct = p;
          break;
        }
      }
      return {
        ...cp,
        inventory_id: invProduct?.id || null,
        stock: invProduct?.stock ?? null,
        stock_qty: invProduct?.stock ?? null,
        inventory_price: invProduct?.price ?? cp.default_price,
        in_inventory: Boolean(invProduct),
        stock_status: !invProduct ? 'not_stocked' : (invProduct.stock === 0 ? 'out_of_stock' : (invProduct.stock <= 5 ? 'low_stock' : 'in_stock')),
      };
    });

    const total = enriched.length;
    const startIndex = (page - 1) * pageSize;
    const paginated = enriched.slice(startIndex, startIndex + pageSize);

    return { data: paginated, total, page, pageSize };
  }

  async getCatalogProductById(id) {
    const cp = this.catalogProducts.get(id);
    if (!cp) return null;
    let invProduct = null;
    for (const p of this.products.values()) {
      if (p.active !== false && (p.catalog_product_id === cp.id || (cp.barcode && p.barcode === cp.barcode) || (cp.sku && p.sku === cp.sku))) {
        invProduct = p;
        break;
      }
    }
    return {
      ...cp,
      inventory_id: invProduct?.id || null,
      stock: invProduct?.stock ?? null,
      stock_qty: invProduct?.stock ?? null,
      inventory_price: invProduct?.price ?? cp.default_price,
      in_inventory: Boolean(invProduct),
      stock_status: !invProduct ? 'not_stocked' : (invProduct.stock === 0 ? 'out_of_stock' : (invProduct.stock <= 5 ? 'low_stock' : 'in_stock')),
    };
  }

  async getCatalogProductBySkuOrBarcode(identifier) {
    if (!identifier) return null;
    for (const cp of this.catalogProducts.values()) {
      if (cp.is_active !== false && (cp.sku === identifier || cp.barcode === identifier)) {
        return this.getCatalogProductById(cp.id);
      }
    }
    return null;
  }

  async createCatalogProduct(data) {
    const id = data.id || 'cat-' + Math.random().toString(36).substring(2, 9);
    const now = new Date().toISOString();
    for (const cp of this.catalogProducts.values()) {
      if (cp.is_active !== false) {
        if (data.sku && cp.sku && cp.sku.toLowerCase() === data.sku.toLowerCase()) {
          const err = new Error(`Catalog product with SKU "${data.sku}" already exists`);
          err.code = 'DUPLICATE_SKU';
          throw err;
        }
        if (data.barcode && cp.barcode === data.barcode) {
          const err = new Error(`Catalog product with barcode "${data.barcode}" already exists`);
          err.code = 'DUPLICATE_BARCODE';
          throw err;
        }
      }
    }
    const item = {
      id,
      barcode: data.barcode || null,
      name: data.name,
      sku: data.sku,
      category: data.category || 'General',
      brand: data.brand || null,
      description: data.description || null,
      image_url: data.image_url || null,
      default_price: parseFloat(data.default_price || data.price || 0),
      unit: data.unit || 'pc',
      is_active: data.is_active !== undefined ? Boolean(data.is_active) : true,
      created_at: now,
      updated_at: now,
    };
    this.catalogProducts.set(id, item);
    return item;
  }

  async updateCatalogProduct(id, updates) {
    const cp = this.catalogProducts.get(id);
    if (!cp) return null;
    const updated = {
      ...cp,
      ...updates,
      default_price: updates.default_price !== undefined ? parseFloat(updates.default_price) : cp.default_price,
      updated_at: new Date().toISOString(),
    };
    this.catalogProducts.set(id, updated);
    return updated;
  }

  async deleteCatalogProduct(id) {
    const cp = this.catalogProducts.get(id);
    if (!cp) return false;
    cp.is_active = false;
    cp.updated_at = new Date().toISOString();
    this.catalogProducts.set(id, cp);
    return true;
  }

  async linkCatalogProductToInventory(catalogId, { price, stock = 10, gst_percent = 5.0 } = {}) {
    const cp = this.catalogProducts.get(catalogId);
    if (!cp) {
      const err = new Error('Catalog product not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    let existing = null;
    for (const p of this.products.values()) {
      if (p.catalog_product_id === catalogId || (cp.barcode && p.barcode === cp.barcode) || (cp.sku && p.sku === cp.sku)) {
        existing = p;
        break;
      }
    }
    if (existing) {
      return existing;
    }
    const invProduct = await this.createProduct({
      barcode: cp.barcode || `AUTO-${cp.sku}-${Date.now() % 10000}`,
      name: cp.name,
      sku: cp.sku,
      unit: cp.unit,
      category: cp.category,
      price: price !== undefined ? parseFloat(price) : cp.default_price,
      gst_percent: parseFloat(gst_percent),
      stock: parseInt(stock, 10),
    });
    invProduct.catalog_product_id = cp.id;
    return invProduct;
  }

  // --- Products ---
  async getProducts({ search = '', category = '', page = 1, pageSize = 50 } = {}) {
    let list = Array.from(this.products.values()).filter(p => p.active !== false);

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.barcode.includes(q));
    }

    if (category && category !== 'All') {
      list = list.filter(p => p.category.toLowerCase() === category.toLowerCase());
    }

    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = list.length;
    const startIndex = (page - 1) * pageSize;
    const paginated = list.slice(startIndex, startIndex + pageSize);

    return { data: paginated, total, page, pageSize };
  }

  async getProductById(id) {
    return this.products.get(id) || null;
  }

  async getProductByBarcode(barcode) {
    for (const p of this.products.values()) {
      if (p.active !== false) {
        if (p.barcode === barcode) return p;
        if (barcode.length === 12 && p.barcode === '0' + barcode) return p;
        if (barcode.length === 13 && barcode.startsWith('0') && p.barcode === barcode.slice(1)) return p;
      }
    }
    return null;
  }

  async createProduct({ barcode, name, category = 'General', price, gst_percent = 0, stock = null }) {
    for (const p of this.products.values()) {
      if (p.barcode === barcode && p.active !== false) {
        const error = new Error(`Product with barcode ${barcode} already exists`);
        error.code = 'DUPLICATE_BARCODE';
        throw error;
      }
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const product = {
      id,
      barcode,
      name,
      category,
      price: parseFloat(price),
      gst_percent: parseFloat(gst_percent),
      stock: stock !== null && stock !== undefined && stock !== '' ? parseInt(stock, 10) : null,
      active: true,
      created_at: now,
      updated_at: now,
    };
    this.products.set(id, product);
    productCache.invalidate(barcode);
    return product;
  }

  async updateProduct(id, updates) {
    const p = this.products.get(id);
    if (!p) return null;

    if (updates.barcode && updates.barcode !== p.barcode) {
      for (const other of this.products.values()) {
        if (other.id !== id && other.barcode === updates.barcode && other.active !== false) {
          const err = new Error(`Barcode ${updates.barcode} already in use`);
          err.code = 'DUPLICATE_BARCODE';
          throw err;
        }
      }
      productCache.invalidate(p.barcode);
      productCache.invalidate(updates.barcode);
    } else {
      productCache.invalidate(p.barcode);
    }

    const updated = {
      ...p,
      ...updates,
      price: updates.price !== undefined ? parseFloat(updates.price) : p.price,
      gst_percent: updates.gst_percent !== undefined ? parseFloat(updates.gst_percent) : p.gst_percent,
      stock: updates.stock !== undefined ? (updates.stock !== null && updates.stock !== '' ? parseInt(updates.stock, 10) : null) : p.stock,
      updated_at: new Date().toISOString(),
    };
    this.products.set(id, updated);
    return updated;
  }

  async deleteProduct(id) {
    const p = this.products.get(id);
    if (!p) return false;

    // Check if in purchase items
    let usedInPurchases = false;
    for (const pi of this.purchaseItems.values()) {
      if (pi.product_id === id) {
        usedInPurchases = true;
        break;
      }
    }

    productCache.invalidate(p.barcode);

    if (usedInPurchases) {
      p.active = false;
      p.updated_at = new Date().toISOString();
      return true;
    } else {
      this.products.delete(id);
      return true;
    }
  }

  // --- Cart ---
  async getOrCreateOpenCart(trolleyId = 'trolley-01') {
    for (const c of this.carts.values()) {
      if (c.trolley_id === trolleyId && c.status === 'open') {
        return c;
      }
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    const cart = {
      id,
      trolley_id: trolleyId,
      status: 'open',
      created_at: now,
      updated_at: now,
    };
    this.carts.set(id, cart);
    return cart;
  }

  async getCartDetails(cartId) {
    const cart = this.carts.get(cartId);
    if (!cart) return null;

    const items = [];
    let subtotal = 0;
    let gst_total = 0;

    for (const [key, item] of this.cartItems.entries()) {
      if (item.cart_id === cartId) {
        const product = this.products.get(item.product_id);
        if (product) {
          const itemSubtotal = parseFloat((product.price * item.quantity).toFixed(2));
          const itemGst = parseFloat(((itemSubtotal * product.gst_percent) / 100).toFixed(2));
          const itemTotal = parseFloat((itemSubtotal + itemGst).toFixed(2));

          subtotal += itemSubtotal;
          gst_total += itemGst;

          items.push({
            id: item.id,
            cart_id: cart.id,
            product_id: product.id,
            barcode: product.barcode,
            name: product.name,
            category: product.category,
            price: product.price,
            gst_percent: product.gst_percent,
            quantity: item.quantity,
            stock: product.stock,
            line_subtotal: itemSubtotal,
            line_gst: itemGst,
            line_total: itemTotal,
          });
        }
      }
    }

    subtotal = parseFloat(subtotal.toFixed(2));
    gst_total = parseFloat(gst_total.toFixed(2));
    const total = parseFloat((subtotal + gst_total).toFixed(2));

    return {
      ...cart,
      items,
      subtotal,
      gst_total,
      total,
      item_count: items.reduce((sum, i) => sum + i.quantity, 0),
    };
  }

  async scanAndAddToCart({ barcode, scanId, trolleyId = 'trolley-01' }) {
    // Check scanId idempotency
    if (this.scanEvents.has(scanId)) {
      const priorEvent = this.scanEvents.get(scanId);
      const cart = await this.getCartDetails(priorEvent.cart_id);
      const product = priorEvent.product_id ? this.products.get(priorEvent.product_id) : null;
      return {
        duplicate: true,
        cart,
        product,
      };
    }

    const cart = await this.getOrCreateOpenCart(trolleyId);
    const product = await this.getProductByBarcode(barcode);

    if (!product) {
      // Record unknown barcode scan event
      this.scanEvents.set(scanId, {
        id: uuidv4(),
        scan_id: scanId,
        cart_id: cart.id,
        barcode,
        product_id: null,
        result: 'unknown',
        created_at: new Date().toISOString(),
      });

      const err = new Error('Barcode not in catalog');
      err.code = 'UNKNOWN_BARCODE';
      err.barcode = barcode;
      throw err;
    }

    // Add or increment item
    const key = `${cart.id}:${product.id}`;
    const existing = this.cartItems.get(key);
    const now = new Date().toISOString();

    if (existing) {
      existing.quantity += 1;
      existing.updated_at = now;
    } else {
      this.cartItems.set(key, {
        id: uuidv4(),
        cart_id: cart.id,
        product_id: product.id,
        quantity: 1,
        created_at: now,
        updated_at: now,
      });
    }

    this.scanEvents.set(scanId, {
      id: uuidv4(),
      scan_id: scanId,
      cart_id: cart.id,
      barcode,
      product_id: product.id,
      result: 'added',
      created_at: now,
    });

    const updatedCart = await this.getCartDetails(cart.id);
    return {
      duplicate: false,
      cart: updatedCart,
      product,
    };
  }

  async updateCartItemQuantity({ cartId, productId, quantity }) {
    const key = `${cartId}:${productId}`;
    const item = this.cartItems.get(key);
    if (!item) return null;

    if (quantity <= 0) {
      this.cartItems.delete(key);
    } else {
      item.quantity = quantity;
      item.updated_at = new Date().toISOString();
    }
    return this.getCartDetails(cartId);
  }

  async removeCartItem({ cartId, productId }) {
    const key = `${cartId}:${productId}`;
    this.cartItems.delete(key);
    return this.getCartDetails(cartId);
  }

  async cancelCart(cartId) {
    const cart = this.carts.get(cartId);
    if (!cart) return false;
    cart.status = 'cancelled';
    cart.updated_at = new Date().toISOString();

    // Remove cart items
    for (const [key, item] of this.cartItems.entries()) {
      if (item.cart_id === cartId) {
        this.cartItems.delete(key);
      }
    }
    return true;
  }

  async checkoutCart(cartId) {
    const cart = await this.getCartDetails(cartId);
    if (!cart || cart.items.length === 0) {
      const err = new Error('Cart is empty or not found');
      err.code = 'EMPTY_CART';
      throw err;
    }

    const purchaseId = uuidv4();
    const now = new Date().toISOString();

    // Snapshot purchase items
    const purchaseItems = [];
    for (const item of cart.items) {
      const pItem = {
        id: uuidv4(),
        purchase_id: purchaseId,
        product_id: item.product_id,
        name: item.name,
        price: item.price,
        gst_percent: item.gst_percent,
        quantity: item.quantity,
        line_subtotal: item.line_subtotal,
        line_gst: item.line_gst,
        line_total: item.line_total,
      };
      this.purchaseItems.set(pItem.id, pItem);
      purchaseItems.push(pItem);

      // Decrement stock if tracked
      const product = this.products.get(item.product_id);
      if (product && product.stock !== null) {
        product.stock = Math.max(0, product.stock - item.quantity);
        product.updated_at = now;
      }
    }

    const purchase = {
      id: purchaseId,
      cart_id: cart.id,
      trolley_id: cart.trolley_id,
      subtotal: cart.subtotal,
      gst_total: cart.gst_total,
      total: cart.total,
      status: 'completed',
      created_at: now,
      cancelled_at: null,
      items: purchaseItems,
    };
    this.purchases.set(purchaseId, purchase);

    // Mark cart checked out and clear cart items
    cart.status = 'checked_out';
    cart.updated_at = now;
    this.carts.set(cart.id, cart);

    for (const [key, item] of this.cartItems.entries()) {
      if (item.cart_id === cartId) {
        this.cartItems.delete(key);
      }
    }

    return purchase;
  }

  // --- Purchases ---
  async getPurchases({ page = 1, pageSize = 20 } = {}) {
    const list = Array.from(this.purchases.values());
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = list.length;
    const startIndex = (page - 1) * pageSize;
    const paginated = list.slice(startIndex, startIndex + pageSize);

    // Attach items
    const enriched = paginated.map(p => {
      const items = Array.from(this.purchaseItems.values()).filter(pi => pi.purchase_id === p.id);
      return { ...p, items };
    });

    return { data: enriched, total, page, pageSize };
  }

  async getPurchaseById(id) {
    const p = this.purchases.get(id);
    if (!p) return null;
    const items = Array.from(this.purchaseItems.values()).filter(pi => pi.purchase_id === p.id);
    return { ...p, items };
  }

  async cancelPurchase(id) {
    const p = this.purchases.get(id);
    if (!p) return null;
    if (p.status === 'cancelled') return p;

    const now = new Date().toISOString();
    p.status = 'cancelled';
    p.cancelled_at = now;

    // Restore stock if tracked
    const items = Array.from(this.purchaseItems.values()).filter(pi => pi.purchase_id === p.id);
    for (const item of items) {
      if (item.product_id) {
        const prod = this.products.get(item.product_id);
        if (prod && prod.stock !== null) {
          prod.stock += item.quantity;
          prod.updated_at = now;
        }
      }
    }

    return { ...p, items };
  }

  // --- Trolley Events & Telemetry ---
  async insertTrolleyEvent({ deviceId, event, severity = 'info', message = '', deviceTs = null }) {
    const record = {
      id: uuidv4(),
      device_id: deviceId,
      event,
      severity,
      message,
      device_ts: deviceTs,
      received_at: new Date().toISOString(),
    };
    this.trolleyEvents.unshift(record);
    if (this.trolleyEvents.length > 500) this.trolleyEvents.pop();
    return record;
  }

  async insertTrolleyTelemetry({ deviceId, payload }) {
    const record = {
      id: uuidv4(),
      device_id: deviceId,
      payload,
      received_at: new Date().toISOString(),
    };
    this.trolleyTelemetry.unshift(record);
    if (this.trolleyTelemetry.length > 500) this.trolleyTelemetry.pop();
    return record;
  }

  async getTrolleyEvents({ deviceId = 'trolley-01', page = 1, pageSize = 20 } = {}) {
    const filtered = this.trolleyEvents.filter(e => e.device_id === deviceId);
    const total = filtered.length;
    const startIndex = (page - 1) * pageSize;
    const paginated = filtered.slice(startIndex, startIndex + pageSize);
    return { data: paginated, total, page, pageSize };
  }

  async checkScanProcessed(scanId) {
    return this.scanEvents.has(scanId);
  }

  async recordScanEvent({ scanId, cartId, barcode, productId, result }) {
    const record = {
      id: uuidv4(),
      scan_id: scanId,
      cart_id: cartId,
      barcode,
      product_id: productId,
      result,
      created_at: new Date().toISOString(),
    };
    this.scanEvents.set(scanId, record);
    return record;
  }

  async updateProductStock(productId, newStock) {
    const p = this.products.get(productId);
    if (!p) return null;
    p.stock = newStock;
    p.updated_at = new Date().toISOString();
    productCache.invalidate(p.barcode);
    return p;
  }

  async recordStockMovement({ productId, change, reason, scanId = null }) {
    const record = {
      id: uuidv4(),
      product_id: productId,
      change,
      reason,
      scan_id: scanId,
      created_at: new Date().toISOString(),
    };
    this.stockMovements.unshift(record);
    return record;
  }

  async getStockMovements(productId) {
    if (productId) {
      return this.stockMovements.filter(m => m.product_id === productId);
    }
    return this.stockMovements;
  }


  // --- Admin Analytics & Monitoring (MemoryStore) ---
  async getAdminDashboardStats(days = 14) {
    const purchases = Array.from(this.purchases.values());
    const completedPurchases = purchases.filter(p => p.status === 'completed');
    const cancelledPurchases = purchases.filter(p => p.status === 'cancelled');

    const totalRevenue = completedPurchases.reduce((acc, p) => acc + (parseFloat(p.total) || 0), 0);
    const netRevenue = completedPurchases.reduce((acc, p) => acc + (parseFloat(p.subtotal) || 0), 0);
    const taxCollected = completedPurchases.reduce((acc, p) => acc + (parseFloat(p.gst_total) || 0), 0);
    const orderCount = completedPurchases.length;
    const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;

    // Daily Sales Timeline (Last 'days' days)
    const timelineMap = new Map();
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = d.toISOString().split('T')[0];
      timelineMap.set(key, { date: key, revenue: 0, orders: 0, gst: 0 });
    }

    for (const p of completedPurchases) {
      const key = (p.created_at || '').split('T')[0];
      if (timelineMap.has(key)) {
        const item = timelineMap.get(key);
        item.revenue = Math.round((item.revenue + (parseFloat(p.total) || 0)) * 100) / 100;
        item.gst = Math.round((item.gst + (parseFloat(p.gst_total) || 0)) * 100) / 100;
        item.orders += 1;
      }
    }
    const salesTimeline = Array.from(timelineMap.values());

    // Category Sales Breakdown
    const catMap = new Map();
    let totalItemsSold = 0;
    for (const item of this.purchaseItems.values()) {
      const prod = this.products.get(item.product_id);
      const cat = prod?.category || 'General';
      const prev = catMap.get(cat) || { category: cat, revenue: 0, units: 0 };
      prev.revenue = Math.round((prev.revenue + (parseFloat(item.line_total) || 0)) * 100) / 100;
      prev.units += item.quantity || 1;
      totalItemsSold += item.quantity || 1;
      catMap.set(cat, prev);
    }
    const categoryBreakdown = Array.from(catMap.values()).map(c => ({
      ...c,
      percentage: totalRevenue > 0 ? Math.round((c.revenue / totalRevenue) * 1000) / 10 : 0
    }));

    // Inventory Intelligence
    const activeProducts = Array.from(this.products.values()).filter(p => p.active !== false);
    let inventoryValuation = 0;
    let outOfStockCount = 0;
    let lowStockCount = 0;
    let healthyStockCount = 0;
    const lowStockItems = [];

    for (const p of activeProducts) {
      const stock = p.stock ?? 0;
      const price = parseFloat(p.price) || 0;
      inventoryValuation += stock * price;
      if (stock === 0) {
        outOfStockCount++;
        lowStockItems.push({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, stock, price, category: p.category, status: 'out_of_stock' });
      } else if (stock <= 5) {
        lowStockCount++;
        lowStockItems.push({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, stock, price, category: p.category, status: 'low_stock' });
      } else {
        healthyStockCount++;
      }
    }

    // Scan Events & Reliability
    const allScans = Array.from(this.scanEvents.values());
    const totalScans = allScans.length;
    const successfulScans = allScans.filter(s => s.result === 'added').length;
    const unknownScans = allScans.filter(s => s.result === 'unknown').length;
    const duplicateScans = allScans.filter(s => s.result === 'duplicate').length;
    const scanReliability = totalScans > 0 ? Math.round(((successfulScans + duplicateScans) / totalScans) * 1000) / 10 : 100;

    // Active Carts
    const activeCarts = Array.from(this.carts.values()).filter(c => c.status === 'open').length;

    // Recent 15 Activity Events
    const recentActivity = [
      ...allScans.slice(0, 10).map(s => ({
        type: 'SCAN',
        title: `Scan ${s.result}`,
        detail: `Barcode: ${s.barcode}`,
        time: s.created_at,
        status: s.result === 'added' ? 'success' : (s.result === 'unknown' ? 'warning' : 'info')
      })),
      ...this.stockMovements.slice(0, 10).map(m => {
        const prod = this.products.get(m.product_id);
        return {
          type: 'STOCK',
          title: `Stock ${m.reason} (${m.change > 0 ? '+' : ''}${m.change})`,
          detail: prod?.name || m.product_id,
          time: m.created_at,
          status: m.change < 0 ? 'info' : 'success'
        };
      })
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 15);

    return {
      kpis: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        netRevenue: Math.round(netRevenue * 100) / 100,
        taxCollected: Math.round(taxCollected * 100) / 100,
        orderCount,
        cancelledCount: cancelledPurchases.length,
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        totalItemsSold,
        activeCarts,
        scanReliability,
        totalScans,
        unknownScans,
        totalInventoryValuation: Math.round(inventoryValuation * 100) / 100,
        totalProducts: activeProducts.length,
        totalCatalogItems: this.catalogProducts.size,
        outOfStockCount,
        lowStockCount,
        healthyStockCount,
      },
      salesTimeline,
      categoryBreakdown,
      lowStockAlerts: lowStockItems.slice(0, 8),
      recentActivity,
    };
  }

  async getDatabaseHealth() {
    return {
      mode: 'in_memory',
      status: 'healthy',
      connected: true,
      timestamp: new Date().toISOString(),
      tables: {
        catalog_products: this.catalogProducts.size,
        products: this.products.size,
        carts: this.carts.size,
        cart_items: this.cartItems.size,
        scan_events: this.scanEvents.size,
        stock_movements: this.stockMovements.length,
        purchases: this.purchases.size,
        purchase_items: this.purchaseItems.size,
        trolley_events: this.trolleyEvents.length,
        trolley_telemetry: this.trolleyTelemetry.length,
      },
      memory: process.memoryUsage(),
      uptimeSec: Math.round(process.uptime()),
    };
  }

  async getAdminScanEvents({ page = 1, pageSize = 25, result = '', search = '' } = {}) {
    let list = Array.from(this.scanEvents.values());
    if (result) {
      list = list.filter(s => s.result === result);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(s => s.barcode?.includes(q) || s.scan_id?.includes(q));
    }
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = list.length;
    const startIndex = (page - 1) * pageSize;
    return { data: list.slice(startIndex, startIndex + pageSize), total, page, pageSize };
  }

  async getAdminStockMovements({ page = 1, pageSize = 25, reason = '', productId = '' } = {}) {
    let list = [...this.stockMovements];
    if (reason) {
      list = list.filter(m => m.reason === reason);
    }
    if (productId) {
      list = list.filter(m => m.product_id === productId);
    }
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const enriched = list.map(m => ({
      ...m,
      product: this.products.get(m.product_id) || null
    }));
    const total = enriched.length;
    const startIndex = (page - 1) * pageSize;
    return { data: enriched.slice(startIndex, startIndex + pageSize), total, page, pageSize };
  }

  async clearCartItems(cartId) {
    for (const [key, item] of this.cartItems.entries()) {
      if (item.cart_id === cartId) {
        this.cartItems.delete(key);
      }
    }
    return this.getCartDetails(cartId);
  }
}

// Supabase Implementation
class SupabaseStore {
  constructor(url, serviceRoleKey) {
    this.supabase = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  // --- Master Catalog (Supabase) ---
  async getCatalogProducts({ search = '', category = '', page = 1, pageSize = 50 } = {}) {
    try {
      let query = this.supabase
        .from('catalog_products')
        .select('*, products(id, stock, price, active)', { count: 'exact' })
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (search) {
        const cleanSearch = String(search).replace(/[,()]/g, ' ').trim();
        if (cleanSearch) {
          query = query.or(`name.ilike.%${cleanSearch}%,sku.ilike.%${cleanSearch}%,barcode.ilike.%${cleanSearch}%`);
        }
      }
      if (category && category !== 'All') {
        query = query.eq('category', category);
      }

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, count, error } = await query.range(from, to);

      if (error) throw error;

      const enriched = (data || []).map(cp => {
        const inv = Array.isArray(cp.products) ? cp.products.find(p => p.active !== false) : cp.products;
        return {
          ...cp,
          inventory_id: inv?.id || null,
          stock_qty: inv?.stock ?? null,
          inventory_price: inv?.price ?? cp.default_price,
          in_inventory: Boolean(inv),
          stock_status: !inv ? 'not_stocked' : (inv.stock === 0 ? 'out_of_stock' : (inv.stock <= 5 ? 'low_stock' : 'in_stock')),
        };
      });

      return { data: enriched, total: count || 0, page, pageSize };
    } catch (err) {
      console.warn('[DB] Supabase getCatalogProducts fallback:', err.message);
      return { data: [], total: 0, page, pageSize };
    }
  }

  async getCatalogProductById(id) {
    try {
      const { data, error } = await this.supabase
        .from('catalog_products')
        .select('*, products(id, stock, price, active)')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const inv = Array.isArray(data.products) ? data.products.find(p => p.active !== false) : data.products;
      return {
        ...data,
        inventory_id: inv?.id || null,
        stock_qty: inv?.stock ?? null,
        inventory_price: inv?.price ?? data.default_price,
        in_inventory: Boolean(inv),
        stock_status: !inv ? 'not_stocked' : (inv.stock === 0 ? 'out_of_stock' : (inv.stock <= 5 ? 'low_stock' : 'in_stock')),
      };
    } catch (err) {
      return null;
    }
  }

  async getCatalogProductBySkuOrBarcode(identifier) {
    try {
      let { data, error } = await this.supabase
        .from('catalog_products')
        .select('*, products(id, stock, price, active)')
        .or(`sku.eq.${identifier},barcode.eq.${identifier}`)
        .eq('is_active', true)
        .maybeSingle();
      if (error || !data) return null;
      const inv = Array.isArray(data.products) ? data.products.find(p => p.active !== false) : data.products;
      return {
        ...data,
        inventory_id: inv?.id || null,
        stock_qty: inv?.stock ?? null,
        inventory_price: inv?.price ?? data.default_price,
        in_inventory: Boolean(inv),
        stock_status: !inv ? 'not_stocked' : (inv.stock === 0 ? 'out_of_stock' : (inv.stock <= 5 ? 'low_stock' : 'in_stock')),
      };
    } catch (err) {
      return null;
    }
  }

  async createCatalogProduct(data) {
    const item = {
      barcode: data.barcode || null,
      name: data.name,
      sku: data.sku,
      category: data.category || 'General',
      brand: data.brand || null,
      description: data.description || null,
      image_url: data.image_url || null,
      default_price: parseFloat(data.default_price || data.price || 0),
      unit: data.unit || 'pc',
      is_active: data.is_active !== undefined ? Boolean(data.is_active) : true,
    };
    const { data: created, error } = await this.supabase
      .from('catalog_products')
      .insert(item)
      .select('*')
      .single();
    if (error) throw error;
    return created;
  }

  async updateCatalogProduct(id, updates) {
    const { data: updated, error } = await this.supabase
      .from('catalog_products')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    return updated;
  }

  async deleteCatalogProduct(id) {
    const { error } = await this.supabase
      .from('catalog_products')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    return true;
  }

  async linkCatalogProductToInventory(catalogId, { price, stock = 10, gst_percent = 5.0 } = {}) {
    const cp = await this.getCatalogProductById(catalogId);
    if (!cp) {
      const err = new Error('Catalog product not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const invProduct = await this.createProduct({
      barcode: cp.barcode || `AUTO-${cp.sku}-${Date.now() % 10000}`,
      name: cp.name,
      sku: cp.sku,
      unit: cp.unit,
      category: cp.category,
      price: price !== undefined ? parseFloat(price) : cp.default_price,
      gst_percent: parseFloat(gst_percent),
      stock: parseInt(stock, 10),
    });
    try {
      await this.supabase.from('products').update({ catalog_product_id: cp.id }).eq('id', invProduct.id);
    } catch (e) {}
    invProduct.catalog_product_id = cp.id;
    return invProduct;
  }




  async getProducts({ search = '', category = '', page = 1, pageSize = 50 } = {}) {
    let query = this.supabase
      .from('products')
      .select('*', { count: 'exact' })
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`name.ilike.%${search}%,barcode.ilike.%${search}%`);
    }
    if (category && category !== 'All') {
      query = query.eq('category', category);
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const { data, count, error } = await query.range(from, to);

    if (error) throw error;
    return { data: data || [], total: count || 0, page, pageSize };
  }

  async getProductById(id) {
    const { data, error } = await this.supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async getProductByBarcode(barcode) {
    const cached = productCache.get(barcode);
    if (cached) return cached;

    let { data, error } = await this.supabase
      .from('products')
      .select('*')
      .eq('barcode', barcode)
      .eq('active', true)
      .maybeSingle();

    if (error) throw error;

    // UPC-A / EAN-13 normalization:
    // If 12-digit UPC-A, also check 13-digit EAN-13 padded with leading 0
    if (!data && barcode.length === 12) {
      const ean13 = '0' + barcode;
      const res = await this.supabase
        .from('products')
        .select('*')
        .eq('barcode', ean13)
        .eq('active', true)
        .maybeSingle();
      if (!res.error && res.data) data = res.data;
    }
    // If 13-digit EAN-13 with leading 0, also check 12-digit UPC-A
    if (!data && barcode.length === 13 && barcode.startsWith('0')) {
      const upcA = barcode.slice(1);
      const res = await this.supabase
        .from('products')
        .select('*')
        .eq('barcode', upcA)
        .eq('active', true)
        .maybeSingle();
      if (!res.error && res.data) data = res.data;
    }

    if (data) productCache.set(barcode, data);
    return data;
  }

  async createProduct({ barcode, name, category = 'General', price, gst_percent = 0, stock = null }) {
    const { data, error } = await this.supabase
      .from('products')
      .insert({
        barcode,
        name,
        category,
        price: parseFloat(price),
        gst_percent: parseFloat(gst_percent),
        stock: stock !== null && stock !== undefined && stock !== '' ? parseInt(stock, 10) : null,
        active: true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        const err = new Error(`Product with barcode ${barcode} already exists`);
        err.code = 'DUPLICATE_BARCODE';
        throw err;
      }
      throw error;
    }
    productCache.invalidate(barcode);
    return data;
  }

  async updateProduct(id, updates) {
    const payload = { ...updates };
    if (payload.price !== undefined) payload.price = parseFloat(payload.price);
    if (payload.gst_percent !== undefined) payload.gst_percent = parseFloat(payload.gst_percent);
    if (payload.stock !== undefined) {
      payload.stock = payload.stock !== null && payload.stock !== '' ? parseInt(payload.stock, 10) : null;
    }

    const { data, error } = await this.supabase
      .from('products')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        const err = new Error(`Barcode already in use`);
        err.code = 'DUPLICATE_BARCODE';
        throw err;
      }
      throw error;
    }
    if (data?.barcode) productCache.invalidate(data.barcode);
    return data;
  }

  async deleteProduct(id) {
    const product = await this.getProductById(id);
    if (!product) return false;

    // Check if used in purchase_items
    const { count, error: countErr } = await this.supabase
      .from('purchase_items')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', id);

    if (countErr) throw countErr;

    productCache.invalidate(product.barcode);

    if (count && count > 0) {
      // Soft-delete
      const { error } = await this.supabase
        .from('products')
        .update({ active: false })
        .eq('id', id);
      if (error) throw error;
      return true;
    } else {
      const { error } = await this.supabase.from('products').delete().eq('id', id);
      if (error) throw error;
      return true;
    }
  }

  async getOrCreateOpenCart(trolleyId = 'trolley-01') {
    const { data, error } = await this.supabase
      .from('carts')
      .select('*')
      .eq('trolley_id', trolleyId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;

    const { data: newCart, error: createErr } = await this.supabase
      .from('carts')
      .insert({ trolley_id: trolleyId, status: 'open' })
      .select()
      .single();

    if (createErr) throw createErr;
    return newCart;
  }

  async getCartDetails(cartId) {
    const { data: cart, error: cartErr } = await this.supabase
      .from('carts')
      .select('*')
      .eq('id', cartId)
      .maybeSingle();

    if (cartErr) throw cartErr;
    if (!cart) return null;

    const { data: items, error: itemsErr } = await this.supabase
      .from('cart_items')
      .select(`
        id,
        cart_id,
        product_id,
        quantity,
        products (
          id,
          barcode,
          name,
          category,
          price,
          gst_percent,
          stock
        )
      `)
      .eq('cart_id', cartId);

    if (itemsErr) throw itemsErr;

    const flattenedItems = [];
    let subtotal = 0;
    let gst_total = 0;

    for (const item of items || []) {
      const p = item.products;
      if (!p) continue;

      const itemSubtotal = parseFloat((p.price * item.quantity).toFixed(2));
      const itemGst = parseFloat(((itemSubtotal * p.gst_percent) / 100).toFixed(2));
      const itemTotal = parseFloat((itemSubtotal + itemGst).toFixed(2));

      subtotal += itemSubtotal;
      gst_total += itemGst;

      flattenedItems.push({
        id: item.id,
        cart_id: item.cart_id,
        product_id: p.id,
        barcode: p.barcode,
        name: p.name,
        category: p.category,
        price: p.price,
        gst_percent: p.gst_percent,
        quantity: item.quantity,
        stock: p.stock,
        line_subtotal: itemSubtotal,
        line_gst: itemGst,
        line_total: itemTotal,
      });
    }

    subtotal = parseFloat(subtotal.toFixed(2));
    gst_total = parseFloat(gst_total.toFixed(2));
    const total = parseFloat((subtotal + gst_total).toFixed(2));

    return {
      ...cart,
      items: flattenedItems,
      subtotal,
      gst_total,
      total,
      item_count: flattenedItems.reduce((acc, i) => acc + i.quantity, 0),
    };
  }

  async scanAndAddToCart({ barcode, scanId, trolleyId = 'trolley-01' }) {
    // Check if scanId exists
    const { data: existingScan } = await this.supabase
      .from('scan_events')
      .select('*')
      .eq('scan_id', scanId)
      .maybeSingle();

    if (existingScan) {
      const cart = await this.getCartDetails(existingScan.cart_id);
      const product = existingScan.product_id ? await this.getProductById(existingScan.product_id) : null;
      return { duplicate: true, cart, product };
    }

    const cart = await this.getOrCreateOpenCart(trolleyId);
    const product = await this.getProductByBarcode(barcode);

    if (!product) {
      await this.supabase.from('scan_events').insert({
        scan_id: scanId,
        cart_id: cart.id,
        barcode,
        product_id: null,
        result: 'unknown',
      });
      const err = new Error('Barcode not in catalog');
      err.code = 'UNKNOWN_BARCODE';
      err.barcode = barcode;
      throw err;
    }

    // Atomic increment or insert on conflict
    const { data: existingItem } = await this.supabase
      .from('cart_items')
      .select('id, quantity')
      .eq('cart_id', cart.id)
      .eq('product_id', product.id)
      .maybeSingle();

    if (existingItem) {
      await this.supabase
        .from('cart_items')
        .update({ quantity: existingItem.quantity + 1, updated_at: new Date().toISOString() })
        .eq('id', existingItem.id);
    } else {
      await this.supabase.from('cart_items').insert({
        cart_id: cart.id,
        product_id: product.id,
        quantity: 1,
      });
    }

    await this.supabase.from('scan_events').insert({
      scan_id: scanId,
      cart_id: cart.id,
      barcode,
      product_id: product.id,
      result: 'added',
    });

    const updatedCart = await this.getCartDetails(cart.id);
    return { duplicate: false, cart: updatedCart, product };
  }

  async updateCartItemQuantity({ cartId, productId, quantity }) {
    if (quantity <= 0) {
      await this.supabase.from('cart_items').delete().eq('cart_id', cartId).eq('product_id', productId);
    } else {
      await this.supabase
        .from('cart_items')
        .update({ quantity, updated_at: new Date().toISOString() })
        .eq('cart_id', cartId)
        .eq('product_id', productId);
    }
    return this.getCartDetails(cartId);
  }

  async removeCartItem({ cartId, productId }) {
    await this.supabase.from('cart_items').delete().eq('cart_id', cartId).eq('product_id', productId);
    return this.getCartDetails(cartId);
  }

  async cancelCart(cartId) {
    const { error } = await this.supabase
      .from('carts')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', cartId);
    if (error) throw error;
    await this.supabase.from('cart_items').delete().eq('cart_id', cartId);
    return true;
  }

  async checkoutCart(cartId) {
    const cart = await this.getCartDetails(cartId);
    if (!cart || cart.items.length === 0) {
      const err = new Error('Cart is empty or not found');
      err.code = 'EMPTY_CART';
      throw err;
    }

    const { data: purchase, error: purchaseErr } = await this.supabase
      .from('purchases')
      .insert({
        cart_id: cart.id,
        trolley_id: cart.trolley_id,
        subtotal: cart.subtotal,
        gst_total: cart.gst_total,
        total: cart.total,
        status: 'completed',
      })
      .select()
      .single();

    if (purchaseErr) throw purchaseErr;

    const itemsToInsert = cart.items.map(item => ({
      purchase_id: purchase.id,
      product_id: item.product_id,
      name: item.name,
      price: item.price,
      gst_percent: item.gst_percent,
      quantity: item.quantity,
      line_subtotal: item.line_subtotal,
      line_gst: item.line_gst,
      line_total: item.line_total,
    }));

    const { error: itemsErr } = await this.supabase.from('purchase_items').insert(itemsToInsert);
    if (itemsErr) throw itemsErr;

    // Decrement stock if tracked
    for (const item of cart.items) {
      if (item.stock !== null && item.stock !== undefined) {
        const newStock = Math.max(0, item.stock - item.quantity);
        await this.supabase.from('products').update({ stock: newStock }).eq('id', item.product_id);
      }
    }

    // Mark cart checked out
    await this.supabase
      .from('carts')
      .update({ status: 'checked_out', updated_at: new Date().toISOString() })
      .eq('id', cartId);

    // Delete cart items
    await this.supabase.from('cart_items').delete().eq('cart_id', cartId);

    return { ...purchase, items: itemsToInsert };
  }

  async getPurchases({ page = 1, pageSize = 20 } = {}) {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: purchases, count, error } = await this.supabase
      .from('purchases')
      .select('*, purchase_items(*)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    const enriched = (purchases || []).map(p => ({
      ...p,
      items: p.purchase_items || [],
    }));

    return { data: enriched, total: count || 0, page, pageSize };
  }

  async getPurchaseById(id) {
    const { data, error } = await this.supabase
      .from('purchases')
      .select('*, purchase_items(*)')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return { ...data, items: data.purchase_items || [] };
  }

  async cancelPurchase(id) {
    const purchase = await this.getPurchaseById(id);
    if (!purchase) return null;
    if (purchase.status === 'cancelled') return purchase;

    const { data: updated, error } = await this.supabase
      .from('purchases')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Restore stock
    for (const item of purchase.items || []) {
      if (item.product_id) {
        const prod = await this.getProductById(item.product_id);
        if (prod && prod.stock !== null) {
          await this.supabase.from('products').update({ stock: prod.stock + item.quantity }).eq('id', item.product_id);
        }
      }
    }

    return { ...updated, items: purchase.items };
  }

  async insertTrolleyEvent({ deviceId, event, severity = 'info', message = '', deviceTs = null }) {
    const { data, error } = await this.supabase
      .from('trolley_events')
      .insert({
        device_id: deviceId,
        event,
        severity,
        message,
        device_ts: deviceTs,
      })
      .select()
      .single();
    if (error) {
      console.error('Failed to insert trolley event:', error.message);
      return null;
    }
    return data;
  }

  async insertTrolleyTelemetry({ deviceId, payload }) {
    const { data, error } = await this.supabase
      .from('trolley_telemetry')
      .insert({
        device_id: deviceId,
        payload,
      })
      .select()
      .single();
    if (error) {
      console.error('Failed to insert trolley telemetry sample:', error.message);
      return null;
    }
    return data;
  }

  async getTrolleyEvents({ deviceId = 'trolley-01', page = 1, pageSize = 20 } = {}) {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, count, error } = await this.supabase
      .from('trolley_events')
      .select('*', { count: 'exact' })
      .eq('device_id', deviceId)
      .order('received_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return { data: data || [], total: count || 0, page, pageSize };
  }

  async checkScanProcessed(scanId) {
    const { data } = await this.supabase
      .from('scan_events')
      .select('id')
      .eq('scan_id', scanId)
      .maybeSingle();
    return Boolean(data);
  }

  async recordScanEvent({ scanId, cartId, barcode, productId, result }) {
    const { data, error } = await this.supabase
      .from('scan_events')
      .insert({
        scan_id: scanId,
        cart_id: cartId,
        barcode,
        product_id: productId,
        result,
      })
      .select()
      .maybeSingle();
    if (error) {
      console.warn('[DB] Error recording scan event:', error.message);
      return null;
    }
    return data;
  }

  async updateProductStock(productId, newStock) {
    const { data, error } = await this.supabase
      .from('products')
      .update({ stock: newStock })
      .eq('id', productId)
      .select()
      .single();
    if (error) throw error;
    if (data?.barcode) productCache.invalidate(data.barcode);
    return data;
  }

  async recordStockMovement({ productId, change, reason, scanId = null }) {
    const { data, error } = await this.supabase
      .from('stock_movements')
      .insert({
        product_id: productId,
        change,
        reason,
        scan_id: scanId,
      })
      .select()
      .maybeSingle();
    if (error) {
      console.warn('[DB] Note on stock_movements:', error.message);
      return null;
    }
    return data;
  }

  async getStockMovements(productId) {
    let query = this.supabase
      .from('stock_movements')
      .select('*')
      .order('created_at', { ascending: false });
    if (productId) {
      query = query.eq('product_id', productId);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }


  // --- Admin Analytics & Monitoring (SupabaseStore) ---
  async getAdminDashboardStats(days = 14) {
    try {
      // 1. Fetch completed purchases
      const { data: purchases } = await this.supabase
        .from('purchases')
        .select('id, subtotal, gst_total, total, status, created_at')
        .order('created_at', { ascending: false })
        .limit(1000);

      const completed = (purchases || []).filter(p => p.status === 'completed');
      const cancelled = (purchases || []).filter(p => p.status === 'cancelled');

      const totalRevenue = completed.reduce((acc, p) => acc + (parseFloat(p.total) || 0), 0);
      const netRevenue = completed.reduce((acc, p) => acc + (parseFloat(p.subtotal) || 0), 0);
      const taxCollected = completed.reduce((acc, p) => acc + (parseFloat(p.gst_total) || 0), 0);
      const orderCount = completed.length;
      const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;

      // 2. Timeline
      const timelineMap = new Map();
      const now = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = d.toISOString().split('T')[0];
        timelineMap.set(key, { date: key, revenue: 0, orders: 0, gst: 0 });
      }

      for (const p of completed) {
        const key = (p.created_at || '').split('T')[0];
        if (timelineMap.has(key)) {
          const item = timelineMap.get(key);
          item.revenue = Math.round((item.revenue + (parseFloat(p.total) || 0)) * 100) / 100;
          item.gst = Math.round((item.gst + (parseFloat(p.gst_total) || 0)) * 100) / 100;
          item.orders += 1;
        }
      }
      const salesTimeline = Array.from(timelineMap.values());

      // 3. Inventory intelligence
      const { data: products } = await this.supabase
        .from('products')
        .select('id, name, barcode, sku, category, price, stock, active')
        .eq('active', true);

      let inventoryValuation = 0;
      let outOfStockCount = 0;
      let lowStockCount = 0;
      let healthyStockCount = 0;
      const lowStockItems = [];

      for (const p of products || []) {
        const stock = p.stock ?? 0;
        const price = parseFloat(p.price) || 0;
        inventoryValuation += stock * price;
        if (stock === 0) {
          outOfStockCount++;
          lowStockItems.push({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, stock, price, category: p.category, status: 'out_of_stock' });
        } else if (stock <= 5) {
          lowStockCount++;
          lowStockItems.push({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, stock, price, category: p.category, status: 'low_stock' });
        } else {
          healthyStockCount++;
        }
      }

      // 4. Category breakdown
      const { data: purchaseItems } = await this.supabase
        .from('purchase_items')
        .select('id, product_id, quantity, line_total')
        .limit(2000);

      const prodMap = new Map((products || []).map(p => [p.id, p]));
      const catMap = new Map();
      let totalItemsSold = 0;

      for (const pi of purchaseItems || []) {
        const prod = prodMap.get(pi.product_id);
        const cat = prod?.category || 'General';
        const prev = catMap.get(cat) || { category: cat, revenue: 0, units: 0 };
        prev.revenue = Math.round((prev.revenue + (parseFloat(pi.line_total) || 0)) * 100) / 100;
        prev.units += pi.quantity || 1;
        totalItemsSold += pi.quantity || 1;
        catMap.set(cat, prev);
      }
      const categoryBreakdown = Array.from(catMap.values()).map(c => ({
        ...c,
        percentage: totalRevenue > 0 ? Math.round((c.revenue / totalRevenue) * 1000) / 10 : 0
      }));

      // 5. Scans
      const { data: scanEvents } = await this.supabase
        .from('scan_events')
        .select('id, scan_id, barcode, result, created_at')
        .order('created_at', { ascending: false })
        .limit(500);

      const totalScans = (scanEvents || []).length;
      const successfulScans = (scanEvents || []).filter(s => s.result === 'added').length;
      const unknownScans = (scanEvents || []).filter(s => s.result === 'unknown').length;
      const duplicateScans = (scanEvents || []).filter(s => s.result === 'duplicate').length;
      const scanReliability = totalScans > 0 ? Math.round(((successfulScans + duplicateScans) / totalScans) * 1000) / 10 : 100;

      // 6. Active carts
      const { count: activeCarts } = await this.supabase
        .from('carts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open');

      const { count: catalogCount } = await this.supabase
        .from('catalog_products')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true);

      // 7. Recent activity
      const recentActivity = (scanEvents || []).slice(0, 15).map(s => ({
        type: 'SCAN',
        title: `Scan ${s.result}`,
        detail: `Barcode: ${s.barcode}`,
        time: s.created_at,
        status: s.result === 'added' ? 'success' : (s.result === 'unknown' ? 'warning' : 'info')
      }));

      return {
        kpis: {
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          netRevenue: Math.round(netRevenue * 100) / 100,
          taxCollected: Math.round(taxCollected * 100) / 100,
          orderCount,
          cancelledCount: cancelled.length,
          avgOrderValue: Math.round(avgOrderValue * 100) / 100,
          totalItemsSold,
          activeCarts: activeCarts || 0,
          scanReliability,
          totalScans,
          unknownScans,
          totalInventoryValuation: Math.round(inventoryValuation * 100) / 100,
          totalProducts: (products || []).length,
          totalCatalogItems: catalogCount || 0,
          outOfStockCount,
          lowStockCount,
          healthyStockCount,
        },
        salesTimeline,
        categoryBreakdown,
        lowStockAlerts: lowStockItems.slice(0, 8),
        recentActivity,
      };
    } catch (err) {
      console.error('[DB] getAdminDashboardStats fallback error:', err.message);
      // Fallback empty response
      return {
        kpis: { totalRevenue: 0, netRevenue: 0, taxCollected: 0, orderCount: 0, cancelledCount: 0, avgOrderValue: 0, totalItemsSold: 0, activeCarts: 0, scanReliability: 100, totalScans: 0, unknownScans: 0, totalInventoryValuation: 0, totalProducts: 0, totalCatalogItems: 0, outOfStockCount: 0, lowStockCount: 0, healthyStockCount: 0 },
        salesTimeline: [],
        categoryBreakdown: [],
        lowStockAlerts: [],
        recentActivity: [],
      };
    }
  }

  async getDatabaseHealth() {
    const tables = ['catalog_products', 'products', 'carts', 'cart_items', 'scan_events', 'stock_movements', 'purchases', 'purchase_items', 'trolley_events', 'trolley_telemetry'];
    const counts = {};
    for (const t of tables) {
      try {
        const { count, error } = await this.supabase.from(t).select('id', { count: 'exact', head: true });
        counts[t] = error ? 0 : (count || 0);
      } catch (e) {
        counts[t] = 0;
      }
    }
    return {
      mode: 'supabase',
      status: 'healthy',
      connected: true,
      timestamp: new Date().toISOString(),
      tables: counts,
      memory: process.memoryUsage(),
      uptimeSec: Math.round(process.uptime()),
    };
  }

  async getAdminScanEvents({ page = 1, pageSize = 25, result = '', search = '' } = {}) {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let query = this.supabase.from('scan_events').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    if (result) query = query.eq('result', result);
    if (search) query = query.ilike('barcode', `%${search}%`);
    const { data, count, error } = await query.range(from, to);
    if (error) throw error;
    return { data: data || [], total: count || 0, page, pageSize };
  }

  async getAdminStockMovements({ page = 1, pageSize = 25, reason = '', productId = '' } = {}) {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let query = this.supabase.from('stock_movements').select('*, products(id, name, barcode, sku, category)', { count: 'exact' }).order('created_at', { ascending: false });
    if (reason) query = query.eq('reason', reason);
    if (productId) query = query.eq('product_id', productId);
    const { data, count, error } = await query.range(from, to);
    if (error) throw error;
    const enriched = (data || []).map(m => ({
      ...m,
      product: m.products || null
    }));
    return { data: enriched, total: count || 0, page, pageSize };
  }

  async clearCartItems(cartId) {
    const { error } = await this.supabase
      .from('cart_items')
      .delete()
      .eq('cart_id', cartId);
    if (error) throw error;
    return this.getCartDetails(cartId);
  }
}

// Instantiate storage based on configuration
const useSupabase = Boolean(config.supabase.url && config.supabase.serviceRoleKey);
export const db = useSupabase
  ? new SupabaseStore(config.supabase.url, config.supabase.serviceRoleKey)
  : new MemoryStore();

console.log(`[DB] Initialized repository: ${useSupabase ? 'Supabase PostgreSQL' : 'In-Memory (fallback store)'}`);
