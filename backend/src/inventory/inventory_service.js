import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db.js';
import { config } from '../config.js';

/**
 * In-memory LRU-like Product Cache with TTL
 */
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
    return entry.data;
  }

  set(barcode, data) {
    this.cache.set(barcode, {
      data,
      expiry: Date.now() + this.ttlMs,
    });
  }

  invalidate(barcode) {
    if (barcode) {
      this.cache.delete(barcode);
      // Invalidate padded/unpadded versions
      if (barcode.length === 12) this.cache.delete('0' + barcode);
      if (barcode.length === 13 && barcode.startsWith('0')) this.cache.delete(barcode.slice(1));
    } else {
      this.cache.clear();
    }
  }
}

export class InventoryService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storeId = options.storeId || config.storeId || 'store-01';
    this.allowNegativeStock = options.allowNegativeStock ?? config.scanner.allowNegativeStock;
    this.lowStockThreshold = options.lowStockThreshold ?? config.scanner.lowStockThreshold;

    this.cache = new ProductCache(60000);

    // Mutual exclusion lock map for atomic concurrent stock updates
    this.productLocks = new Map();
  }

  /**
   * Acquire a mutex lock for a specific product ID during atomic inventory updates
   * @param {string} productId
   * @returns {Promise<Function>} release lock function
   */
  async acquireLock(productId) {
    while (this.productLocks.has(productId)) {
      await this.productLocks.get(productId);
    }
    let resolveLock;
    const lockPromise = new Promise((resolve) => {
      resolveLock = resolve;
    });
    this.productLocks.set(productId, lockPromise);

    return () => {
      this.productLocks.delete(productId);
      resolveLock();
    };
  }

  /**
   * Lookup product in catalog with caching & UPC-A/EAN-13 normalization
   * @param {string} barcode
   * @returns {Promise<object|null>}
   */
  async lookupProduct(barcode) {
    if (!barcode) return null;
    const cleanCode = barcode.trim();

    // Check fast cache
    const cached = this.cache.get(cleanCode);
    if (cached) return cached;

    // Lookup in database
    const product = await db.getProductByBarcode(cleanCode);
    if (product) {
      this.cache.set(cleanCode, product);
    }
    return product;
  }

  /**
   * Core Scan-to-Add Pipeline:
   * 1. Idempotency check with scanId
   * 2. Catalog lookup (with unknown_barcode alert on missing)
   * 3. Stock availability verification (with out_of_stock alert)
   * 4. Atomic stock decrement & stock_movement audit logging
   * 5. Cart line addition / increment
   * 6. Low stock alert notification if threshold reached
   *
   * @param {object} params
   * @param {string} params.barcode
   * @param {string} params.scanId
   * @param {string} [params.trolleyId]
   * @param {string} [params.sessionId]
   * @returns {Promise<object>}
   */
  async scanAndProcessProduct({ barcode, scanId, trolleyId = 'trolley-01', sessionId }) {
    const cleanBarcode = barcode.trim();
    const effectiveSessionId = sessionId || trolleyId;

    // 1. Idempotency check via scanId
    const existingCart = await db.getOrCreateOpenCart(effectiveSessionId);
    if (db.checkScanProcessed && await db.checkScanProcessed(scanId)) {
      const cart = await db.getCartDetails(existingCart.id);
      const product = await this.lookupProduct(cleanBarcode);
      return {
        success: true,
        duplicate: true,
        product,
        cart,
        message: 'Scan already processed (idempotent duplicate)',
      };
    }

    // 2. Product Lookup
    const product = await this.lookupProduct(cleanBarcode);
    if (!product) {
      // Record unknown scan event
      await db.recordScanEvent({
        scanId,
        cartId: existingCart.id,
        barcode: cleanBarcode,
        productId: null,
        result: 'unknown',
      });

      // Emit unknown_barcode alert for MQTT and UI
      const alertPayload = {
        barcode: cleanBarcode,
        scan_id: scanId,
        session_id: effectiveSessionId,
        message: `Product barcode ${cleanBarcode} not found in catalog`,
      };
      this.emit('unknown_barcode', alertPayload);

      return {
        success: false,
        not_found: true,
        barcode: cleanBarcode,
        scan_id: scanId,
        message: 'Product not found in catalog',
      };
    }

    // Acquire lock for this product to prevent concurrency race conditions
    const releaseLock = await this.acquireLock(product.id);
    try {
      // Re-fetch latest product state inside the lock
      const freshProduct = await db.getProductById(product.id);
      const currentStock = freshProduct?.stock ?? null;

      // 3. Stock Availability Check
      if (currentStock !== null && currentStock <= 0 && !this.allowNegativeStock) {
        const outOfStockPayload = {
          product_id: freshProduct.id,
          barcode: freshProduct.barcode,
          name: freshProduct.name,
          current_stock: currentStock,
          scan_id: scanId,
          message: `Product "${freshProduct.name}" (${freshProduct.barcode}) is out of stock`,
        };
        this.emit('out_of_stock', outOfStockPayload);

        return {
          success: false,
          out_of_stock: true,
          product: freshProduct,
          message: `Product "${freshProduct.name}" is out of stock`,
        };
      }

      // 4. Atomic Stock Decrement & Movement Record
      let newStock = currentStock;
      if (currentStock !== null) {
        newStock = currentStock - 1;
        await db.updateProductStock(freshProduct.id, newStock);
        await db.recordStockMovement({
          productId: freshProduct.id,
          change: -1,
          reason: 'scan_add',
          scanId,
        });

        // Invalidate cache with fresh stock
        this.cache.invalidate(freshProduct.barcode);
      }

      // 5. Add / Increment Item in Cart
      const cartResult = await db.scanAndAddToCart({
        barcode: freshProduct.barcode,
        scanId,
        trolleyId: effectiveSessionId,
      });

      const updatedCart = cartResult.cart;
      const cartItem = updatedCart.items.find((i) => i.product_id === freshProduct.id);

      // 6. Check Low Stock Threshold
      if (newStock !== null && newStock <= this.lowStockThreshold) {
        this.emit('low_stock', {
          product_id: freshProduct.id,
          barcode: freshProduct.barcode,
          name: freshProduct.name,
          stock_qty: newStock,
          threshold: this.lowStockThreshold,
        });
      }

      // Emit item_added event for MQTT cart broadcaster
      const itemAddedEvent = {
        scan_id: scanId,
        barcode: freshProduct.barcode,
        product_id: freshProduct.id,
        name: freshProduct.name,
        qty: cartItem ? cartItem.quantity : 1,
        price: freshProduct.price,
        line_total: cartItem ? cartItem.line_total : freshProduct.price,
        cart_total: updatedCart.total,
        timestamp: new Date().toISOString(),
      };
      this.emit('item_added', { sessionId: effectiveSessionId, ...itemAddedEvent });

      if (newStock !== null) {
        this.emit('stock_updated', { productId: freshProduct.id, stockQty: newStock });
      }

      return {
        success: true,
        duplicate: false,
        product: freshProduct,
        cart: updatedCart,
        item: cartItem,
        stock_remaining: newStock,
      };
    } finally {
      releaseLock();
    }
  }

  /**
   * Add a product directly from the Product Catalog to the active cart.
   * Reuses the exact same concurrency mutex lock, atomic stock decrement,
   * audit logging, and MQTT publication as the scan flow.
   */
  async addCatalogItemToCart({ catalogId, productId, quantity = 1, requestId, trolleyId = 'trolley-01', sessionId }) {
    const effectiveSessionId = sessionId || trolleyId;
    const effectiveRequestId = requestId || ('req-' + Math.random().toString(36).substring(2, 10));
    const requestedQty = Math.max(1, parseInt(quantity, 10) || 1);

    // 1. Idempotency check via requestId
    const existingCart = await db.getOrCreateOpenCart(effectiveSessionId);
    if (db.checkScanProcessed && await db.checkScanProcessed(effectiveRequestId)) {
      const cart = await db.getCartDetails(existingCart.id);
      return {
        success: true,
        duplicate: true,
        cart,
        message: 'Catalog add already processed (idempotent duplicate)',
      };
    }

    // 2. Resolve inventory product
    let product = null;
    let catalogItem = null;
    if (catalogId) {
      catalogItem = await db.getCatalogProductById(catalogId);
      if (!catalogItem) {
        const err = new Error('Catalog product not found');
        err.code = 'CATALOG_NOT_FOUND';
        throw err;
      }
      if (catalogItem.is_active === false) {
        const err = new Error(`Catalog product "${catalogItem.name}" is deactivated`);
        err.code = 'PRODUCT_INACTIVE';
        throw err;
      }
      if (catalogItem.inventory_id) {
        product = await db.getProductById(catalogItem.inventory_id);
      } else {
        product = await db.linkCatalogProductToInventory(catalogId, {
          price: catalogItem.default_price,
          stock: 15,
        });
      }
    } else if (productId) {
      product = await db.getProductById(productId);
    }

    if (!product) {
      const err = new Error('Product not found in inventory');
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    // 3. Acquire mutex lock for this product to prevent concurrency race conditions
    const releaseLock = await this.acquireLock(product.id);
    try {
      const freshProduct = await db.getProductById(product.id);
      const currentStock = freshProduct?.stock ?? null;

      // Stock availability check
      if (currentStock !== null && currentStock < requestedQty && !this.allowNegativeStock) {
        const outOfStockPayload = {
          product_id: freshProduct.id,
          barcode: freshProduct.barcode,
          name: freshProduct.name,
          current_stock: currentStock,
          requested_qty: requestedQty,
          request_id: effectiveRequestId,
          source: 'catalog',
          message: `Product "${freshProduct.name}" has insufficient stock (${currentStock} available, ${requestedQty} requested)`,
        };
        this.emit('out_of_stock', outOfStockPayload);
        return {
          success: false,
          out_of_stock: true,
          product: freshProduct,
          message: outOfStockPayload.message,
        };
      }

      // 4. Atomic stock decrement & movement record
      let newStock = currentStock;
      if (currentStock !== null) {
        newStock = currentStock - requestedQty;
        await db.updateProductStock(freshProduct.id, newStock);
        await db.recordStockMovement({
          productId: freshProduct.id,
          change: -requestedQty,
          reason: 'sale',
          scanId: effectiveRequestId,
        });
        this.cache.invalidate(freshProduct.barcode);
      }

      // 5. Add / Increment line item in cart
      let updatedCart;
      for (let i = 0; i < requestedQty; i++) {
        const subScanId = i === 0 ? effectiveRequestId : `${effectiveRequestId}-${i}`;
        const res = await db.scanAndAddToCart({
          barcode: freshProduct.barcode,
          scanId: subScanId,
          trolleyId: effectiveSessionId,
        });
        updatedCart = res.cart;
      }

      const cartItem = updatedCart.items.find((i) => i.product_id === freshProduct.id);

      // 6. Check low stock threshold
      if (newStock !== null && newStock <= this.lowStockThreshold) {
        this.emit('low_stock', {
          product_id: freshProduct.id,
          barcode: freshProduct.barcode,
          name: freshProduct.name,
          stock_qty: newStock,
          threshold: this.lowStockThreshold,
          source: 'catalog',
        });
      }

      // 7. Emit item_added with source = 'catalog'
      const itemAddedEvent = {
        scan_id: effectiveRequestId,
        request_id: effectiveRequestId,
        source: 'catalog',
        barcode: freshProduct.barcode,
        product_id: freshProduct.id,
        name: freshProduct.name,
        qty: cartItem ? cartItem.quantity : requestedQty,
        price: freshProduct.price,
        line_total: cartItem ? cartItem.line_total : freshProduct.price * requestedQty,
        cart_total: updatedCart.total,
        timestamp: new Date().toISOString(),
      };
      this.emit('item_added', { sessionId: effectiveSessionId, ...itemAddedEvent });

      if (newStock !== null) {
        this.emit('stock_updated', { productId: freshProduct.id, stockQty: newStock });
      }

      return {
        success: true,
        duplicate: false,
        source: 'catalog',
        product: freshProduct,
        cart: updatedCart,
        item: cartItem,
        stock_remaining: newStock,
      };
    } finally {
      releaseLock();
    }
  }

  /**
   * Adjust quantity of an item in the cart (+ or -), keeping stock atomic.
   */
  async updateCartItemQuantity(cartId, productId, newQuantity) {
    const releaseLock = await this.acquireLock(productId);
    try {
      const cart = await db.getCartDetails(cartId);
      if (!cart) throw new Error('Cart not found');

      const existingItem = cart.items.find((i) => i.product_id === productId);
      if (!existingItem) throw new Error('Item not found in cart');

      const currentQty = existingItem.quantity;
      const delta = newQuantity - currentQty; // positive if adding, negative if removing

      if (delta === 0) return cart;

      const product = await db.getProductById(productId);
      const currentStock = product?.stock ?? null;

      // Check stock if increasing
      if (delta > 0 && currentStock !== null && currentStock < delta && !this.allowNegativeStock) {
        throw new Error(`Insufficient stock. Only ${currentStock} units available.`);
      }

      // Update product stock
      let updatedStock = currentStock;
      if (currentStock !== null) {
        updatedStock = currentStock - delta;
        await db.updateProductStock(productId, updatedStock);
        await db.recordStockMovement({
          productId,
          change: -delta,
          reason: delta > 0 ? 'scan_add' : 'scan_remove',
          scanId: null,
        });
        this.cache.invalidate(product.barcode);
        this.emit('stock_updated', { productId, stockQty: updatedStock });
      }

      // Update line item
      const updatedCart = await db.updateCartItemQuantity({ cartId, productId, quantity: newQuantity });
      return updatedCart;
    } finally {
      releaseLock();
    }
  }

  /**
   * Remove item from cart and restore its reserved stock.
   */
  async removeCartItem(cartId, productId) {
    return this.updateCartItemQuantity(cartId, productId, 0);
  }

  /**
   * Clear entire cart and restore all reserved inventory.
   */
  async clearCart(cartId) {
    const cart = await db.getCartDetails(cartId);
    if (!cart || !cart.items || cart.items.length === 0) return cart;

    for (const item of cart.items) {
      if (item.stock !== null && item.quantity > 0) {
        const releaseLock = await this.acquireLock(item.product_id);
        try {
          const fresh = await db.getProductById(item.product_id);
          const newStock = (fresh?.stock ?? 0) + item.quantity;
          await db.updateProductStock(item.product_id, newStock);
          await db.recordStockMovement({
            productId: item.product_id,
            change: item.quantity,
            reason: 'cancellation',
          });
          this.cache.invalidate(item.barcode);
          this.emit('stock_updated', { productId: item.product_id, stockQty: newStock });
        } finally {
          releaseLock();
        }
      }
    }

    // Clear items in database
    return await db.clearCartItems(cartId);
  }

  /**
   * Create a new product in the catalog.
   * If autoAddCartId is specified (e.g. from an unknown barcode resolution),
   * automatically adds the newly registered product to that cart!
   */
  async createProduct(productData, { autoAddCartId, autoAddScanId } = {}) {
    const created = await db.createProduct(productData);
    this.cache.invalidate(created.barcode);

    // Record initial stock movement if > 0
    if (created.stock && created.stock > 0) {
      await db.recordStockMovement({
        productId: created.id,
        change: created.stock,
        reason: 'restock',
      });
      this.emit('stock_updated', { productId: created.id, stockQty: created.stock });
    }

    // Auto-add to active cart if requested
    let autoAddResult = null;
    if (autoAddCartId) {
      autoAddResult = await this.scanAndProcessProduct({
        barcode: created.barcode,
        scanId: autoAddScanId || uuidv4(),
        trolleyId: autoAddCartId,
      });
    }

    return {
      product: created,
      autoAddResult,
    };
  }

  /**
   * Manual inventory restock or stock adjustment
   */
  async adjustStock(productId, delta, reason = 'adjustment') {
    const releaseLock = await this.acquireLock(productId);
    try {
      const product = await db.getProductById(productId);
      if (!product) throw new Error('Product not found');

      const currentStock = product.stock ?? 0;
      const newStock = currentStock + delta;
      if (newStock < 0 && !this.allowNegativeStock) {
        throw new Error(`Stock adjustment would result in negative stock (${newStock})`);
      }

      await db.updateProductStock(productId, newStock);
      await db.recordStockMovement({
        productId,
        change: delta,
        reason,
      });

      this.cache.invalidate(product.barcode);
      this.emit('stock_updated', { productId, stockQty: newStock });
      return { product, newStock };
    } finally {
      releaseLock();
    }
  }
}

