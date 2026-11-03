import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * Resilient MQTT client featuring:
 * - Exponential backoff reconnect with random jitter
 * - Retained LWT status ('online' / 'offline')
 * - Bounded FIFO offline queue persisted to disk
 * - Auto-resubscription across disconnects
 */
export class MqttClientService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.brokerUrl = options.brokerUrl || 'mqtts://k8812401.ala.eu-central-1.emqxsl.com:8883';
    this.username = options.username || '';
    this.password = options.password || '';
    this.caCert = options.caCert;
    this.deviceId = options.deviceId || 'trolley-01';
    this.storeId = options.storeId || 'store-01';

    this.maxQueueSize = options.offlineQueueMax || 500;
    this.queueFilePath = options.offlineQueueFile || path.resolve(process.cwd(), '.offline_queue.json');

    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.isFlushingQueue = false;

    // Load persisted offline queue
    this.offlineQueue = this.loadQueueFromDisk();

    // Topics
    this.topicStatus = `device/${this.deviceId}/status`;
    this.topicScan = `device/${this.deviceId}/scan`;
    this.topicCmd = `device/${this.deviceId}/cmd`;
    this.topicAlerts = `store/${this.storeId}/alerts`;
    this.topicInventoryUpdate = `store/${this.storeId}/inventory/update`;
  }

  /**
   * Load offline queue from disk file safely.
   * @returns {Array}
   */
  loadQueueFromDisk() {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const raw = fs.readFileSync(this.queueFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.slice(-this.maxQueueSize);
        }
      }
    } catch (e) {
      console.warn('[MQTT] Warning loading persisted offline queue:', e.message);
    }
    return [];
  }

  /**
   * Persist offline queue to disk file.
   */
  persistQueueToDisk() {
    try {
      fs.writeFileSync(this.queueFilePath, JSON.stringify(this.offlineQueue), 'utf8');
    } catch (e) {
      console.error('[MQTT] Error persisting offline queue to disk:', e.message);
    }
  }

  /**
   * Connect to MQTT broker.
   */
  connect() {
    if (this.client) return;

    const clientId = `scanner-${this.deviceId}-${uuidv4().substring(0, 6)}`;
    const lwtPayload = JSON.stringify({
      status: 'offline',
      device_id: this.deviceId,
      timestamp: new Date().toISOString(),
    });

    const mqttOpts = {
      clientId,
      clean: true,
      connectTimeout: 10000,
      keepalive: 45,
      reconnectPeriod: 0, // Manual exponential backoff
      will: {
        topic: this.topicStatus,
        payload: lwtPayload,
        qos: 1,
        retain: true,
      },
    };

    if (this.username) {
      mqttOpts.username = this.username;
      mqttOpts.password = this.password;
    }

    if (this.caCert) {
      mqttOpts.ca = [this.caCert];
      mqttOpts.rejectUnauthorized = true;
    }

    console.log(`[MQTT] Connecting to ${this.brokerUrl} as ${clientId}...`);
    this.client = mqtt.connect(this.brokerUrl, mqttOpts);

    this.client.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log(`[MQTT] Connected to broker successfully. Active topics: ${this.topicStatus}`);

      // Publish Online Status (Retained, QoS 1)
      const onlinePayload = JSON.stringify({
        status: 'online',
        device_id: this.deviceId,
        timestamp: new Date().toISOString(),
      });
      this.client.publish(this.topicStatus, onlinePayload, { qos: 1, retain: true });

      // Resubscribe to required topics
      const subTopics = [this.topicCmd, this.topicInventoryUpdate];
      this.client.subscribe(subTopics, { qos: 1 }, (err) => {
        if (err) console.error('[MQTT] Subscription error:', err.message);
        else console.log(`[MQTT] Subscribed to [${subTopics.join(', ')}]`);
      });

      this.emit('connected');

      // Flush buffered offline queue
      this.flushOfflineQueue();
    });

    this.client.on('message', (topic, payload) => {
      try {
        const text = payload.toString();
        const data = JSON.parse(text);
        this.emit('message', { topic, data });
      } catch (e) {
        this.emit('message', { topic, raw: payload.toString() });
      }
    });

    this.client.on('error', (err) => {
      console.warn('[MQTT] Client error:', err.message);
      this.emit('error', err);
    });

    this.client.on('close', () => {
      if (this.isConnected) {
        console.warn('[MQTT] Broker connection closed.');
      }
      this.isConnected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  /**
   * Exponential backoff reconnect with jitter: 1s -> 2s -> 4s ... max 30s
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;

    const baseDelay = Math.min(30000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)));
    const jitter = Math.floor(Math.random() * 1000);
    const delay = baseDelay + jitter;

    console.log(`[MQTT] Scheduling reconnect attempt #${this.reconnectAttempts} in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.client) {
        this.client.reconnect();
      }
    }, delay);
  }

  /**
   * Publish or queue message if offline.
   * @param {string} topic
   * @param {object|string} payload
   * @param {object} [options]
   * @returns {boolean} true if dispatched or queued
   */
  publishOrQueue(topic, payload, options = { qos: 1, retain: false }) {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);

    if (this.isConnected && this.client) {
      this.client.publish(topic, serialized, options, (err) => {
        if (err) {
          console.warn(`[MQTT] Publish error on ${topic}:`, err.message);
          this.enqueueOffline({ topic, payload: serialized, options });
        }
      });
      return true;
    }

    // Client is offline: buffer into bounded queue
    this.enqueueOffline({ topic, payload: serialized, options });
    return false;
  }

  /**
   * Enqueue item into bounded offline queue.
   * @param {object} item
   */
  enqueueOffline(item) {
    if (this.offlineQueue.length >= this.maxQueueSize) {
      // Drop oldest message to prevent unconstrained memory usage
      this.offlineQueue.shift();
    }
    this.offlineQueue.push(item);
    this.persistQueueToDisk();
  }

  /**
   * Flush bounded offline queue sequentially on reconnect.
   */
  async flushOfflineQueue() {
    if (this.isFlushingQueue || this.offlineQueue.length === 0) return;
    this.isFlushingQueue = true;

    console.log(`[MQTT] Flushing ${this.offlineQueue.length} buffered offline messages...`);
    while (this.isConnected && this.offlineQueue.length > 0) {
      const item = this.offlineQueue.shift();
      try {
        await new Promise((resolve, reject) => {
          this.client.publish(item.topic, item.payload, item.options || { qos: 1 }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (err) {
        console.warn('[MQTT] Error during offline flush:', err.message);
        this.offlineQueue.unshift(item); // Push back onto queue
        break;
      }
    }

    this.persistQueueToDisk();
    this.isFlushingQueue = false;
  }

  // --- Topic-Specific Helper Methods ---

  /**
   * Publish raw scan event: device/{device_id}/scan
   */
  publishScan(scanData) {
    return this.publishOrQueue(this.topicScan, scanData, { qos: 1 });
  }

  /**
   * Publish cart addition: store/{store_id}/cart/{session_id}/item_added
   */
  publishItemAdded(sessionId, itemData) {
    const topic = `store/${this.storeId}/cart/${sessionId}/item_added`;
    return this.publishOrQueue(topic, itemData, { qos: 1 });
  }

  /**
   * Publish updated stock level: store/{store_id}/inventory/{product_id}/stock (retained)
   */
  publishStock(productId, stockQty) {
    const topic = `store/${this.storeId}/inventory/${productId}/stock`;
    const payload = {
      product_id: productId,
      stock_qty: stockQty,
      timestamp: new Date().toISOString(),
    };
    return this.publishOrQueue(topic, payload, { qos: 1, retain: true });
  }

  /**
   * Publish system alert: store/{store_id}/alerts
   */
  publishAlert(alertType, details) {
    const payload = {
      type: alertType,
      device_id: this.deviceId,
      store_id: this.storeId,
      timestamp: new Date().toISOString(),
      ...details,
    };
    return this.publishOrQueue(this.topicAlerts, payload, { qos: 1 });
  }

  /**
   * Graceful shutdown: publish offline status and close.
   */
  async shutdown() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client && this.isConnected) {
      const offlinePayload = JSON.stringify({
        status: 'offline',
        device_id: this.deviceId,
        timestamp: new Date().toISOString(),
      });

      return new Promise((resolve) => {
        this.client.publish(this.topicStatus, offlinePayload, { qos: 1, retain: true }, () => {
          this.client.end(true, () => {
            console.log('[MQTT] Client disconnected cleanly.');
            resolve();
          });
        });
      });
    }
  }
}

