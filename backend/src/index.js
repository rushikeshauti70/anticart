import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { sseHub } from './sse.js';
import { mqttManager } from './mqtt.js';
import { healthRouter } from './routes/health.js';
import { productsRouter } from './routes/products.js';
import { cartRouter } from './routes/cart.js';
import { purchasesRouter } from './routes/purchases.js';
import { trolleyRouter } from './routes/trolley.js';
import { optionalJwtAuth } from './middleware/auth.js';

const app = express();

// CORS configuration
const allowedOrigins = [
  config.frontendOrigin,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const cleanOrigin = origin.replace(/\/+$/, '');
    if (allowedOrigins.includes(origin) || allowedOrigins.includes(cleanOrigin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    if (cleanOrigin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
}));

// Body parsing with size limits (supports base64 image frames for AI vision)
app.use(express.json({ limit: '4mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '512kb' }));

// Optional Supabase JWT Auth via JWKS
app.use(optionalJwtAuth);

// Health check endpoint (at root as per section 8)
app.use(healthRouter);

// SSE Stream endpoint
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  res.flushHeaders?.();
  sseHub.addClient(res);
});

// API Routes
app.use('/api', productsRouter);
app.use('/api', cartRouter);
app.use('/api', purchasesRouter);
app.use('/api', trolleyRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.originalUrl}`,
    }
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
    }
  });
});

// Server startup
const server = app.listen(config.port, () => {
  console.log(`[HTTP] AVCOE Smart Trolley Backend running on port ${config.port}`);
  console.log(`[HTTP] Health check available at http://localhost:${config.port}/health`);
  console.log(`[HTTP] SSE stream available at http://localhost:${config.port}/api/stream`);

  // Start MQTT subscriber
  mqttManager.init();
});

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}. Closing server resources...`);
  sseHub.closeAll();
  mqttManager.shutdown();

  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed. Process terminating cleanly.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[SHUTDOWN] Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
