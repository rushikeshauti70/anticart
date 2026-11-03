import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

function getCaCert() {
  const envCa = process.env.MQTT_CA_CERT;
  if (!envCa) return undefined;
  if (envCa.includes('BEGIN CERTIFICATE')) {
    return envCa;
  }
  if (fs.existsSync(envCa)) {
    return fs.readFileSync(path.resolve(envCa), 'utf8');
  }
  return envCa;
}

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  frontendOrigin: (process.env.FRONTEND_ORIGIN || '*').trim().replace(/\/+$/, ''),
  storeId: process.env.STORE_ID || 'store-01',
  deviceId: process.env.DEVICE_ID || process.env.DEFAULT_DEVICE_ID || 'trolley-01',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  scanner: {
    debounceMs: parseInt(process.env.SCAN_DEBOUNCE_MS || '1500', 10),
    wedgeTimingThresholdMs: parseInt(process.env.WEDGE_TIMING_THRESHOLD_MS || '50', 10),
    allowNegativeStock: process.env.ALLOW_NEGATIVE_STOCK === 'true',
    lowStockThreshold: parseInt(process.env.LOW_STOCK_THRESHOLD || '5', 10),
    offlineQueueMax: parseInt(process.env.OFFLINE_QUEUE_MAX || '500', 10),
    offlineQueueFile: process.env.OFFLINE_QUEUE_FILE || path.resolve(process.cwd(), '.offline_queue.json'),
  },
  excelLogger: {
    flushIntervalSec: parseInt(process.env.EXCEL_FLUSH_INTERVAL_SEC || '5', 10),
    exportsDir: process.env.EXCEL_PATH || path.resolve(process.cwd(), 'exports'),
    rotateRows: parseInt(process.env.EXCEL_ROTATE_ROWS || '10000', 10),
    retentionDays: parseInt(process.env.EXCEL_RETENTION_DAYS || '30', 10),
    sensorChangeThreshold: parseFloat(process.env.SENSOR_CHANGE_THRESHOLD || '2.0'),
    eventWhitelist: (process.env.EVENT_WHITELIST || 'product_added,product_removed,quantity_changed,stock_changed,out_of_stock,low_stock,unknown_barcode,scan_rejected,device_online,device_offline,error')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '',
    jwksUrl: process.env.SUPABASE_JWKS_URL || '',
  },
  googleApiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',
  mqtt: {
    url: process.env.MQTT_URL || (process.env.MQTT_HOST ? `mqtts://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 8883}` : 'mqtts://k8812401.ala.eu-central-1.emqxsl.com:8883'),
    username: process.env.MQTT_USERNAME || 'rushikesh',
    password: process.env.MQTT_PASSWORD || '',
    caCert: getCaCert(),
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'avcoeshop/v1',
    allowedDeviceIds: (process.env.ALLOWED_DEVICE_IDS || 'trolley-01')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
    telemetryStaleMs: parseInt(process.env.TELEMETRY_STALE_MS || '6000', 10),
    telemetryStoreIntervalMs: parseInt(process.env.TELEMETRY_STORE_INTERVAL_MS || '60000', 10),
  }
};
