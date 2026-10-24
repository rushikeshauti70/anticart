// Simulated ESP32 Trolley Publisher
// Simulates hardware behavior: telemetry, status, LWT, events, and command handling/ACKs.
// Conforms to firmware v3.0.0 contract and tests edge cases (oversized, malformed, wrong device).

import mqtt from 'mqtt';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../src/config.js';

const DEVICE_ID = 'trolley-01';
const TOPIC_PREFIX = config.mqtt.topicPrefix || 'avcoeshop/v1';

const TOPIC_TELEMETRY = `${TOPIC_PREFIX}/devices/${DEVICE_ID}/telemetry`;
const TOPIC_STATUS = `${TOPIC_PREFIX}/devices/${DEVICE_ID}/status`;
const TOPIC_COMMANDS = `${TOPIC_PREFIX}/devices/${DEVICE_ID}/commands`;
const TOPIC_COMMAND_ACK = `${TOPIC_PREFIX}/devices/${DEVICE_ID}/command-ack`;
const TOPIC_EVENTS = `${TOPIC_PREFIX}/devices/${DEVICE_ID}/events`;

const args = process.argv.slice(2);
let customBroker = null;
const brokerIdx = args.indexOf('--broker');
if (brokerIdx !== -1 && args[brokerIdx + 1]) {
  customBroker = args[brokerIdx + 1];
}

class TrolleySimulator {
  constructor(options = {}) {
    this.brokerUrl = options.brokerUrl || customBroker || config.mqtt.url;
    this.client = null;
    this.mode = 'LINE_FOLLOW'; // LINE_FOLLOW, PAUSED, STOPPED
    this.motorsEnabled = true;
    this.obstacle = false;
    this.distanceCm = 85.0;
    this.servoAngle = 90;
    this.uptime = 0;
    this.recentCommandIds = [];
    this.telemetryInterval = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const clientId = `esp32-sim-${DEVICE_ID}-${Math.random().toString(16).substring(2, 6)}`;

      // LWT (offline retained status)
      const lwtPayload = JSON.stringify({
        v: 1,
        deviceId: DEVICE_ID,
        ts: '1970-01-01T00:00:00.000Z',
        type: 'status',
        payload: {
          state: 'offline',
          fw: 'v3.0.0-esp32',
          ip: '0.0.0.0',
          rssi: 0,
          motorsEnabled: false,
        }
      });

      const opts = {
        clientId,
        clean: true,
        will: {
          topic: TOPIC_STATUS,
          payload: lwtPayload,
          qos: 1,
          retain: true,
        },
      };

      if (config.mqtt.username) {
        opts.username = config.mqtt.username;
        opts.password = config.mqtt.password;
      }
      if (config.mqtt.caCert) {
        opts.ca = [config.mqtt.caCert];
        opts.rejectUnauthorized = true;
      }

      console.log(`[SIM] Connecting simulator to ${this.brokerUrl}...`);
      this.client = mqtt.connect(this.brokerUrl, opts);

      this.client.on('connect', () => {
        console.log(`[SIM] Connected to broker as ${clientId}`);

        // Subscribe to commands
        this.client.subscribe(TOPIC_COMMANDS, { qos: 1 }, (err) => {
          if (!err) {
            console.log(`[SIM] Subscribed to ${TOPIC_COMMANDS}`);
          }
        });

        // Publish online status (retained)
        this.publishStatus('online');

        // Publish boot event
        this.publishEvent('DEVICE_BOOT', 'info', 'ESP32 trolley connected to broker');

        resolve();
      });

      this.client.on('message', (topic, message) => {
        if (topic === TOPIC_COMMANDS) {
          this.handleCommand(message);
        }
      });

      this.client.on('error', (err) => {
        console.error('[SIM] Connection error:', err.message);
        // Do not reject here to allow reconnects
      });
    });
  }

  publishStatus(state) {
    const message = {
      v: 1,
      deviceId: DEVICE_ID,
      ts: new Date().toISOString(),
      type: 'status',
      payload: {
        state,
        fw: 'v3.0.0-esp32',
        ip: '192.168.1.142',
        rssi: -58,
        motorsEnabled: this.motorsEnabled,
      }
    };
    this.client.publish(TOPIC_STATUS, JSON.stringify(message), { qos: 1, retain: true });
    console.log(`[SIM] Published status: ${state}`);
  }

  publishEvent(event, severity, messageText) {
    const message = {
      v: 1,
      deviceId: DEVICE_ID,
      ts: new Date().toISOString(),
      type: 'event',
      payload: {
        event,
        severity,
        message: messageText,
      }
    };
    this.client.publish(TOPIC_EVENTS, JSON.stringify(message), { qos: 0, retain: false });
    console.log(`[SIM] Published event: ${event} (${severity}) - ${messageText}`);
  }

  publishTelemetry() {
    this.uptime += 2;

    // Simulate ultrasonic sweep: 90 -> 150 -> 90 -> 30
    const sweepAngles = [90, 150, 90, 30];
    const angleIndex = Math.floor(this.uptime / 2) % sweepAngles.length;
    this.servoAngle = sweepAngles[angleIndex];

    // Simulate occasional obstacle detection
    if (this.uptime % 30 === 10) {
      this.obstacle = true;
      this.distanceCm = 24.5;
      this.publishEvent('OBSTACLE_DETECTED', 'warning', 'Obstacle in path, trolley stopped');
    } else if (this.obstacle && this.uptime % 30 === 18) {
      this.obstacle = false;
      this.distanceCm = 95.0;
    }

    const message = {
      v: 1,
      deviceId: DEVICE_ID,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: {
        mode: this.mode,
        ir: {
          left: this.servoAngle === 150,
          center: true,
          right: this.servoAngle === 30,
        },
        ultrasonic: {
          distance_cm: this.distanceCm,
          servo_angle_deg: this.servoAngle,
          valid: true,
        },
        obstacle: this.obstacle,
        fault: null,
        uptime_s: this.uptime,
        rssi: -60,
      }
    };

    this.client.publish(TOPIC_TELEMETRY, JSON.stringify(message), { qos: 0, retain: false });
    console.log(`[SIM] Telemetry: Mode=${this.mode}, Dist=${this.distanceCm}cm, Servo=${this.servoAngle}deg, Obstacle=${this.obstacle}`);
  }

  handleCommand(messageBuffer) {
    let doc;
    try {
      doc = JSON.parse(messageBuffer.toString('utf8'));
    } catch (e) {
      console.warn('[SIM] Bad command JSON');
      return;
    }

    const src = doc.commandId ? doc : (doc.payload || {});
    const commandId = src.commandId || '';
    const type = src.type || '';
    const expiresAt = src.expiresAtEpoch || 0;

    console.log(`[SIM] Received command ${type} (id: ${commandId})`);

    // Duplicate check
    if (this.recentCommandIds.includes(commandId)) {
      console.log(`[SIM] Duplicate command ${commandId} ignored`);
      return;
    }
    this.recentCommandIds.push(commandId);
    if (this.recentCommandIds.length > 8) this.recentCommandIds.shift();

    // Check expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt > 0 && nowSec > expiresAt) {
      this.publishAck(commandId, 'expired', 'Command arrived past expiresAtEpoch');
      return;
    }

    if (type === 'PAUSE') {
      this.mode = 'PAUSED';
      this.motorsEnabled = false;
      this.publishAck(commandId, 'executed', 'Trolley paused');
      this.publishStatus('online');
      this.publishTelemetry();
    } else if (type === 'RESUME') {
      if (this.obstacle) {
        this.publishAck(commandId, 'rejected', 'Obstacle in front, cannot resume safely');
      } else {
        this.mode = 'LINE_FOLLOW';
        this.motorsEnabled = true;
        this.publishAck(commandId, 'executed', 'Line following resumed');
        this.publishStatus('online');
        this.publishTelemetry();
      }
    } else if (type === 'STOP') {
      this.mode = 'STOPPED';
      this.motorsEnabled = false;
      this.publishAck(commandId, 'executed', 'Emergency STOP executed');
      this.publishStatus('online');
      this.publishTelemetry();
    } else if (type === 'REQUEST_STATUS') {
      this.publishAck(commandId, 'executed', 'Status refreshed on demand');
      this.publishStatus('online');
      this.publishTelemetry();
    } else {
      this.publishAck(commandId, 'rejected', 'Unknown command');
    }
  }

  publishAck(commandId, status, reason) {
    const message = {
      v: 1,
      deviceId: DEVICE_ID,
      ts: new Date().toISOString(),
      type: 'command-ack',
      payload: {
        commandId,
        status,
        reason,
      }
    };
    this.client.publish(TOPIC_COMMAND_ACK, JSON.stringify(message), { qos: 0, retain: false });
    console.log(`[SIM] ACK published for ${commandId}: ${status} (${reason})`);
  }

  startContinuousTelemetry(intervalMs = 2000) {
    this.publishTelemetry();
    this.telemetryInterval = setInterval(() => {
      this.publishTelemetry();
    }, intervalMs);
  }

  stopTelemetry() {
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }

  // --- Edge-Case Test Injections ---
  sendMalformedJson() {
    console.log('[SIM] Injecting malformed JSON...');
    this.client.publish(TOPIC_TELEMETRY, '{ bad json: true, ', { qos: 0 });
  }

  sendDisallowedDeviceId() {
    console.log('[SIM] Injecting message with disallowed deviceId...');
    const message = {
      v: 1,
      deviceId: 'unauthorized-trolley-99',
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { mode: 'LINE_FOLLOW' },
    };
    this.client.publish(`${TOPIC_PREFIX}/devices/unauthorized-trolley-99/telemetry`, JSON.stringify(message));
  }

  sendOversizedPayload() {
    console.log('[SIM] Injecting oversized payload (>1024 bytes)...');
    const filler = 'X'.repeat(2048);
    const message = {
      v: 1,
      deviceId: DEVICE_ID,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { filler },
    };
    this.client.publish(TOPIC_TELEMETRY, JSON.stringify(message));
  }

  disconnect() {
    this.stopTelemetry();
    if (this.client) {
      this.client.end(true);
      console.log('[SIM] Simulator disconnected.');
    }
  }
}

// CLI Execution entry
const sim = new TrolleySimulator();

if (args.includes('--test-cases')) {
  console.log('[SIM] Running automated test scenario...');
  await sim.connect();
  sim.publishTelemetry();

  // Test edge cases
  setTimeout(() => sim.sendMalformedJson(), 1000);
  setTimeout(() => sim.sendDisallowedDeviceId(), 2000);
  setTimeout(() => sim.sendOversizedPayload(), 3000);
  setTimeout(() => {
    console.log('[SIM] Automated edge-case injection complete.');
    sim.disconnect();
    process.exit(0);
  }, 4500);

} else if (args.includes('--stale')) {
  console.log('[SIM] Running stale test: publishing once, then going silent to let backend mark stale (>6s)...');
  await sim.connect();
  sim.publishTelemetry();
  // Do not publish further

} else {
  // Default: start continuous simulation
  console.log('[SIM] Starting continuous trolley simulation (telemetry every 2s). Press Ctrl+C to exit.');
  await sim.connect();
  sim.startContinuousTelemetry(2000);

  process.on('SIGINT', () => {
    sim.disconnect();
    process.exit(0);
  });
}
