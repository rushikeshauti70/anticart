import mqtt from 'mqtt';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { db } from './db.js';
import { sseHub } from './sse.js';

class MqttManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionState = 'disconnected'; // 'connecting', 'connected', 'disconnected', 'error'
    this.lastError = null;

    // In-memory state cache for trolleys
    this.trolleys = new Map();

    // Pending commands map: commandId -> { deviceId, type, resolve, reject, timer }
    this.pendingCommands = new Map();

    // Stats
    this.stats = {
      messagesReceived: 0,
      messagesRejected: 0,
      commandsPublished: 0,
      acksReceived: 0,
    };

    // Staleness check interval
    this.stalenessTimer = null;
  }

  init() {
    if (!config.mqtt.url) {
      console.log('[MQTT] No broker URL configured, MQTT client disabled.');
      return;
    }

    const clientId = `avcoe-server-${uuidv4().substring(0, 8)}`;
    const options = {
      clientId,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 5000,
      keepalive: 30,
    };

    if (config.mqtt.username) {
      options.username = config.mqtt.username;
      options.password = config.mqtt.password;
    }

    if (config.mqtt.caCert) {
      options.ca = [config.mqtt.caCert];
      options.rejectUnauthorized = true;
    }

    console.log(`[MQTT] Connecting to ${config.mqtt.url} as ${clientId}...`);
    this.connectionState = 'connecting';

    try {
      this.client = mqtt.connect(config.mqtt.url, options);

      // Register listeners ONCE
      this.client.on('connect', () => {
        this.isConnected = true;
        this.connectionState = 'connected';
        this.lastError = null;
        console.log('[MQTT] Connected to EMQX broker successfully.');

        // Subscribe to all device subtopics
        const subPattern = `${config.mqtt.topicPrefix}/devices/+/#`;
        this.client.subscribe(subPattern, { qos: 1 }, (err) => {
          if (err) {
            console.error(`[MQTT] Subscription failed to ${subPattern}:`, err.message);
          } else {
            console.log(`[MQTT] Subscribed to pattern: ${subPattern}`);
          }
        });
      });

      this.client.on('reconnect', () => {
        console.log('[MQTT] Reconnecting to broker...');
        this.connectionState = 'connecting';
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        this.connectionState = 'disconnected';
        console.log('[MQTT] Broker connection went offline.');
      });

      this.client.on('error', (err) => {
        this.lastError = err.message;
        this.connectionState = 'error';
        console.error('[MQTT] Connection error:', err.message);
      });

      this.client.on('message', (topic, payloadBuffer) => {
        this.handleIncomingMessage(topic, payloadBuffer);
      });

      // Start background timer to detect stale telemetry
      this.stalenessTimer = setInterval(() => {
        this.checkStaleness();
      }, 1000);

    } catch (err) {
      this.connectionState = 'error';
      this.lastError = err.message;
      console.error('[MQTT] Initialization error:', err.message);
    }
  }

  handleIncomingMessage(topic, payloadBuffer) {
    this.stats.messagesReceived += 1;

    // 1. Check size limit (~1024 bytes)
    if (payloadBuffer.length > 1024) {
      console.warn(`[MQTT] Rejected oversized message on ${topic} (${payloadBuffer.length} bytes)`);
      this.stats.messagesRejected += 1;
      return;
    }

    // 2. Parse JSON
    let envelope;
    try {
      envelope = JSON.parse(payloadBuffer.toString('utf8'));
    } catch (err) {
      console.warn(`[MQTT] Rejected malformed JSON on ${topic}:`, err.message);
      this.stats.messagesRejected += 1;
      return;
    }

    // 3. Envelope validation
    if (envelope.v !== 1) {
      console.warn(`[MQTT] Rejected envelope with invalid version v=${envelope.v}`);
      this.stats.messagesRejected += 1;
      return;
    }

    const { deviceId, type, ts, payload } = envelope;

    if (!deviceId || !config.mqtt.allowedDeviceIds.includes(deviceId)) {
      console.warn(`[MQTT] Rejected unknown or disallowed deviceId: "${deviceId}"`);
      this.stats.messagesRejected += 1;
      return;
    }

    const knownTypes = ['telemetry', 'status', 'event', 'command-ack'];
    if (!knownTypes.includes(type)) {
      console.warn(`[MQTT] Rejected unknown message type: "${type}"`);
      this.stats.messagesRejected += 1;
      return;
    }

    // Process parsed message
    this.processValidatedMessage(deviceId, type, ts, payload || {});
  }

  processValidatedMessage(deviceId, type, ts, payload) {
    const now = Date.now();
    let state = this.getOrCreateTrolleyState(deviceId);

    if (type === 'status') {
      const isLwt = ts === '1970-01-01T00:00:00.000Z' || payload.state === 'offline';
      state.status = {
        state: isLwt ? 'offline' : (payload.state || 'online'),
        fw: payload.fw || state.status.fw,
        ip: payload.ip || state.status.ip,
        rssi: payload.rssi !== undefined ? payload.rssi : state.status.rssi,
        motorsEnabled: payload.motorsEnabled !== undefined ? payload.motorsEnabled : state.status.motorsEnabled,
        ts: isLwt ? new Date().toISOString() : ts,
      };

      if (!isLwt) {
        state.lastSeenEpoch = now;
        state.connection = 'online';
      } else {
        state.connection = 'offline';
      }

      sseHub.broadcast('status', {
        deviceId,
        connection: state.connection,
        status: state.status,
      });

    } else if (type === 'telemetry') {
      const prevObstacle = state.telemetry?.obstacle;
      const prevMode = state.telemetry?.mode;

      state.lastSeenEpoch = now;
      state.connection = 'online';
      state.telemetry = {
        ...payload,
        ts,
      };

      // Broadcast to SSE clients
      sseHub.broadcast('telemetry', {
        deviceId,
        connection: state.connection,
        telemetry: state.telemetry,
        lastSeen: new Date(now).toISOString(),
      });

      // Sampled persistence: save if mode or obstacle changed, or interval elapsed
      const shouldStore =
        prevObstacle !== payload.obstacle ||
        prevMode !== payload.mode ||
        (now - state.lastStoredEpoch >= config.mqtt.telemetryStoreIntervalMs);

      if (shouldStore) {
        state.lastStoredEpoch = now;
        db.insertTrolleyTelemetry({ deviceId, payload: state.telemetry }).catch(err => {
          console.error('[MQTT] Error storing telemetry sample:', err.message);
        });
      }

    } else if (type === 'event') {
      const eventData = {
        deviceId,
        event: payload.event || 'UNKNOWN',
        severity: payload.severity || 'info',
        message: payload.message || '',
        deviceTs: ts,
      };

      db.insertTrolleyEvent(eventData).catch(err => {
        console.error('[MQTT] Error storing trolley event:', err.message);
      });

      sseHub.broadcast('event', eventData);

    } else if (type === 'command-ack') {
      this.stats.acksReceived += 1;
      const commandId = payload.commandId;
      const ackData = {
        deviceId,
        commandId,
        status: payload.status, // 'executed' | 'rejected' | 'expired'
        reason: payload.reason || '',
        ts,
      };

      // Settle pending command promise if awaiting
      if (this.pendingCommands.has(commandId)) {
        const pending = this.pendingCommands.get(commandId);
        clearTimeout(pending.timer);
        this.pendingCommands.delete(commandId);
        pending.resolve(ackData);
      }

      sseHub.broadcast('command-ack', ackData);
    }
  }

  getOrCreateTrolleyState(deviceId) {
    if (!this.trolleys.has(deviceId)) {
      this.trolleys.set(deviceId, {
        deviceId,
        connection: 'offline', // 'online' | 'stale' | 'offline'
        lastSeenEpoch: 0,
        lastStoredEpoch: 0,
        telemetry: null,
        status: {
          state: 'offline',
          fw: 'v3.0.0-esp32',
          ip: null,
          rssi: null,
          motorsEnabled: false,
        },
      });
    }
    return this.trolleys.get(deviceId);
  }

  checkStaleness() {
    const now = Date.now();
    for (const [deviceId, state] of this.trolleys.entries()) {
      if (state.connection === 'online') {
        const elapsed = now - state.lastSeenEpoch;
        if (elapsed > config.mqtt.telemetryStaleMs) {
          state.connection = 'stale';
          sseHub.broadcast('status', {
            deviceId,
            connection: 'stale',
            status: state.status,
            lastSeen: new Date(state.lastSeenEpoch).toISOString(),
            staleDurationMs: elapsed,
          });
        }
      }
    }
  }

  getTrolleyState(deviceId = 'trolley-01') {
    const state = this.getOrCreateTrolleyState(deviceId);
    const now = Date.now();
    let currentConnection = state.connection;
    if (currentConnection === 'online' && (now - state.lastSeenEpoch > config.mqtt.telemetryStaleMs)) {
      currentConnection = 'stale';
    }

    return {
      deviceId,
      connection: currentConnection,
      brokerConnection: this.connectionState,
      lastSeen: state.lastSeenEpoch ? new Date(state.lastSeenEpoch).toISOString() : null,
      status: state.status,
      telemetry: state.telemetry,
    };
  }

  async sendCommand(deviceId, commandType, timeoutMs = 5000) {
    const allowedCommands = ['PAUSE', 'RESUME', 'STOP', 'REQUEST_STATUS'];
    if (!allowedCommands.includes(commandType)) {
      const err = new Error(`Invalid command type: ${commandType}`);
      err.code = 'INVALID_COMMAND';
      throw err;
    }

    if (!this.isConnected || !this.client) {
      const err = new Error('Server not connected to MQTT broker');
      err.code = 'BROKER_NOT_CONNECTED';
      throw err;
    }

    const commandId = uuidv4();
    const nowEpoch = Math.floor(Date.now() / 1000);
    const expiresAtEpoch = nowEpoch + 15; // 15 second expiry

    // Payload adheres to section 6.4: commandId/type/expiresAtEpoch at top level
    const commandMessage = {
      commandId,
      type: commandType,
      expiresAtEpoch,
    };

    const topic = `${config.mqtt.topicPrefix}/devices/${deviceId}/commands`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommands.has(commandId)) {
          this.pendingCommands.delete(commandId);
          resolve({
            commandId,
            status: 'timeout',
            reason: 'No ACK received from trolley within 5 seconds',
          });
        }
      }, timeoutMs);

      this.pendingCommands.set(commandId, {
        deviceId,
        type: commandType,
        resolve,
        reject,
        timer,
      });

      this.client.publish(topic, JSON.stringify(commandMessage), { qos: 1 }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingCommands.delete(commandId);
          reject(err);
        } else {
          this.stats.commandsPublished += 1;
          console.log(`[MQTT] Published ${commandType} command to ${topic} (id: ${commandId})`);
        }
      });
    });
  }

  shutdown() {
    if (this.stalenessTimer) clearInterval(this.stalenessTimer);
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingCommands.clear();

    if (this.client) {
      this.client.end(true, () => {
        console.log('[MQTT] Client disconnected gracefully.');
      });
    }
  }
}

export const mqttManager = new MqttManager();
