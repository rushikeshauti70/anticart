import { BarcodeScanner } from './scanner/scanner.js';
import { InventoryService } from './inventory/inventory_service.js';
import { MqttClientService } from './mqtt/mqtt_client.js';
import { EventLogger } from './logger/event_logger.js';
import { config } from './config.js';
import { sseHub } from './sse.js';

// Instantiate core modules
export const scanner = new BarcodeScanner({
  deviceId: config.deviceId,
  debounceMs: config.scanner.debounceMs,
  wedgeTimingThresholdMs: config.scanner.wedgeTimingThresholdMs,
});

export const inventory = new InventoryService({
  storeId: config.storeId,
  allowNegativeStock: config.scanner.allowNegativeStock,
  lowStockThreshold: config.scanner.lowStockThreshold,
});

export const mqttClient = new MqttClientService({
  brokerUrl: config.mqtt.url,
  username: config.mqtt.username,
  password: config.mqtt.password,
  caCert: config.mqtt.caCert,
  deviceId: config.deviceId,
  storeId: config.storeId,
  offlineQueueMax: config.scanner.offlineQueueMax,
  offlineQueueFile: config.scanner.offlineQueueFile,
});

// Guard against unhandled EventEmitter 'error' crashing the process when broker is offline
mqttClient.on('error', (err) => {
  console.warn('[MQTT-CLIENT][WARN] Handled broker connection error:', err.message);
});

// Instantiate Live Excel Event Logger with 5-second non-blocking cleaning
export const eventLogger = new EventLogger({
  flushIntervalSec: config.excelLogger.flushIntervalSec,
  exportsDir: config.excelLogger.exportsDir,
  rotateRows: config.excelLogger.rotateRows,
  retentionDays: config.excelLogger.retentionDays,
  sensorChangeThreshold: config.excelLogger.sensorChangeThreshold,
  eventWhitelist: config.excelLogger.eventWhitelist,
});

// =============================================================================
// Wire Pipeline: Scanner -> Inventory -> MQTT & SSE & Excel Logger
// =============================================================================

// 1. Scanner Events
scanner.on('scan', async (scanEvent) => {
  console.log(`[SCANNER][INFO] Accepted scan #${scanEvent.seq}: ${scanEvent.barcode} (${scanEvent.format}) [scan_id: ${scanEvent.scan_id}]`);

  // Publish raw scan over MQTT immediately
  mqttClient.publishScan(scanEvent);

  try {
    // Process scan through inventory & active cart pipeline
    const result = await inventory.scanAndProcessProduct({
      barcode: scanEvent.barcode,
      scanId: scanEvent.scan_id,
      trolleyId: config.deviceId,
    });

    if (result.success) {
      console.log(`[INVENTORY][INFO] Product "${result.product.name}" added to cart. Remaining stock: ${result.stock_remaining ?? 'N/A'}`);
      sseHub.broadcast('cart', result.cart);
    } else if (result.not_found) {
      console.warn(`[INVENTORY][WARN] Barcode ${scanEvent.barcode} not found in catalog.`);
      sseHub.broadcast('unknown_barcode', {
        barcode: scanEvent.barcode,
        scan_id: scanEvent.scan_id,
      });
    } else if (result.out_of_stock) {
      console.warn(`[INVENTORY][WARN] Product "${result.product.name}" is out of stock.`);
      sseHub.broadcast('out_of_stock', {
        barcode: scanEvent.barcode,
        scan_id: scanEvent.scan_id,
        product: result.product,
      });
    }
  } catch (err) {
    console.error('[INVENTORY][ERROR] Error processing scan event:', err.message);
    eventLogger.logEvent({
      scan_id: scanEvent.scan_id,
      action: 'error',
      status: 'error',
      sensor_type: 'barcode_scanner',
      value: scanEvent.barcode,
      details: { message: err.message },
    });
  }
});

scanner.on('invalid_scan', (err) => {
  console.warn(`[SCANNER][WARN] Rejected scan: "${err.raw}" - Reason: ${err.reason}`);
  eventLogger.logEvent({
    action: 'scan_rejected',
    status: 'rejected',
    sensor_type: 'barcode_scanner',
    value: err.raw,
    details: { reason: err.reason },
  });
});

scanner.on('debounced', (info) => {
  console.log(`[SCANNER][INFO] Debounced repeat scan for ${info.barcode} (${info.timeDiffMs}ms < ${info.debounceThresholdMs}ms)`);
});

// 2. Inventory Alerts & Events -> MQTT & Excel Logger
inventory.on('item_added', (evt) => {
  mqttClient.publishItemAdded(evt.sessionId, evt);
  eventLogger.logEvent({
    scan_id: evt.scan_id,
    request_id: evt.request_id,
    sensor_type: evt.source === 'catalog' ? 'catalog' : 'barcode_scanner',
    action: 'product_added',
    product_id: evt.product_id,
    product_name: evt.name,
    value: evt.barcode,
    qty: evt.qty,
    cart_total: evt.cart_total,
    status: 'success',
    details: { price: evt.price, line_total: evt.line_total, source: evt.source || 'scan' },
  });
});

inventory.on('stock_updated', (evt) => {
  mqttClient.publishStock(evt.productId, evt.stockQty);
  eventLogger.logEvent({
    sensor_type: 'inventory',
    action: 'stock_changed',
    product_id: evt.productId,
    stock_after: evt.stockQty,
    status: 'success',
  });
});

inventory.on('unknown_barcode', (alert) => {
  mqttClient.publishAlert('unknown_barcode', alert);
  eventLogger.logEvent({
    scan_id: alert.scan_id,
    sensor_type: 'barcode_scanner',
    action: 'unknown_barcode',
    value: alert.barcode,
    status: 'rejected',
    details: { message: alert.message },
  });
});

inventory.on('out_of_stock', (alert) => {
  mqttClient.publishAlert('out_of_stock', alert);
  eventLogger.logEvent({
    scan_id: alert.scan_id,
    request_id: alert.request_id,
    sensor_type: alert.source === 'catalog' ? 'catalog' : 'barcode_scanner',
    action: 'out_of_stock',
    product_id: alert.product_id,
    product_name: alert.name,
    value: alert.barcode,
    stock_after: alert.current_stock,
    status: 'rejected',
    details: { message: alert.message },
  });
});

inventory.on('low_stock', (alert) => {
  mqttClient.publishAlert('low_stock', alert);
  eventLogger.logEvent({
    sensor_type: alert.source === 'catalog' ? 'catalog' : 'inventory',
    action: 'low_stock',
    product_id: alert.product_id,
    product_name: alert.name,
    value: alert.barcode,
    stock_after: alert.stock_qty,
    status: 'success',
    details: { threshold: alert.threshold },
  });
});

// 3. MQTT Inbound Subscriptions -> Cache Invalidation & Event Logging
mqttClient.on('connected', () => {
  eventLogger.logEvent({
    sensor_type: 'system',
    action: 'device_online',
    status: 'success',
    details: { message: 'MQTT broker connected' },
  });
});

mqttClient.on('disconnected', () => {
  eventLogger.logEvent({
    sensor_type: 'system',
    action: 'device_offline',
    status: 'error',
    details: { message: 'MQTT broker disconnected' },
  });
});

mqttClient.on('message', ({ topic, data, raw }) => {
  // Invalidate local cache when inventory is updated from another terminal
  if (topic.endsWith('/inventory/update')) {
    const barcode = data?.barcode || (typeof raw === 'string' ? raw.trim() : null);
    if (barcode) {
      console.log(`[MQTT][INFO] Remote inventory update received for ${barcode}. Invalidating local cache.`);
      inventory.cache.invalidate(barcode);
    }
  }
});
