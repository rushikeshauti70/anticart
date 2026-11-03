import { BarcodeScanner } from './scanner/scanner.js';
import { InventoryService } from './inventory/inventory_service.js';
import { MqttClientService } from './mqtt/mqtt_client.js';
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

// =============================================================================
// Wire Pipeline: Scanner -> Inventory -> MQTT & SSE
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
  }
});

scanner.on('invalid_scan', (err) => {
  console.warn(`[SCANNER][WARN] Rejected scan: "${err.raw}" - Reason: ${err.reason}`);
});

scanner.on('debounced', (info) => {
  console.log(`[SCANNER][INFO] Debounced repeat scan for ${info.barcode} (${info.timeDiffMs}ms < ${info.debounceThresholdMs}ms)`);
});

// 2. Inventory Alerts & Events -> MQTT
inventory.on('item_added', (evt) => {
  mqttClient.publishItemAdded(evt.sessionId, evt);
});

inventory.on('stock_updated', (evt) => {
  mqttClient.publishStock(evt.productId, evt.stockQty);
});

inventory.on('unknown_barcode', (alert) => {
  mqttClient.publishAlert('unknown_barcode', alert);
});

inventory.on('out_of_stock', (alert) => {
  mqttClient.publishAlert('out_of_stock', alert);
});

inventory.on('low_stock', (alert) => {
  mqttClient.publishAlert('low_stock', alert);
});

// 3. MQTT Inbound Subscriptions -> Cache Invalidation & Remote Sync
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

