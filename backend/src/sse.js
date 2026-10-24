// Server-Sent Events (SSE) Manager
// Streams real-time updates for telemetry, status, events, command-ack, and cart changes.

class SseHub {
  constructor() {
    this.clients = new Set();
    this.heartbeatTimer = null;
    this.startHeartbeat();
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.broadcast('heartbeat', { ts: new Date().toISOString() });
    }, 15000);
  }

  addClient(res) {
    this.clients.add(res);

    // Initial greeting / handshake
    res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connected to AVCOE Smart Trolley stream" })}\n\n`);

    reqCloseHandler(res, () => {
      this.clients.delete(res);
    });
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  broadcast(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  closeAll() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) {
      try {
        client.end();
      } catch (err) {
        // ignore on shutdown
      }
    }
    this.clients.clear();
  }
}

function reqCloseHandler(res, callback) {
  res.on('close', callback);
  res.on('finish', callback);
}

export const sseHub = new SseHub();
