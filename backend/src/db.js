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
    this.carts = new Map();
    this.cartItems = new Map(); // cart_id:product_id -> item
    this.scanEvents = new Map();
    this.purchases = new Map();
    this.purchaseItems = new Map();
    this.trolleyEvents = [];
    this.trolleyTelemetry = [];
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
}

// Supabase Implementation
class SupabaseStore {
  constructor(url, serviceRoleKey) {
    this.supabase = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
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
}

// Instantiate storage based on configuration
const useSupabase = Boolean(config.supabase.url && config.supabase.serviceRoleKey);
export const db = useSupabase
  ? new SupabaseStore(config.supabase.url, config.supabase.serviceRoleKey)
  : new MemoryStore();

console.log(`[DB] Initialized repository: ${useSupabase ? 'Supabase PostgreSQL' : 'In-Memory (fallback store)'}`);
