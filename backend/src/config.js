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
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '',
  },
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
