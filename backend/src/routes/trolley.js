import { Router } from 'express';
import { z } from 'zod';
import { mqttManager } from '../mqtt.js';
import { db } from '../db.js';

export const trolleyRouter = Router();

const commandSchema = z.object({
  type: z.enum(['PAUSE', 'RESUME', 'STOP', 'REQUEST_STATUS']),
  timeoutMs: z.coerce.number().min(1000).max(15000).default(5000),
});

// GET /api/trolley/:id/state
trolleyRouter.get('/trolley/:id/state', (req, res) => {
  const deviceId = req.params.id || 'trolley-01';
  const state = mqttManager.getTrolleyState(deviceId);
  res.json(state);
});

// GET /api/trolley/:id/events
trolleyRouter.get('/trolley/:id/events', async (req, res, next) => {
  try {
    const deviceId = req.params.id || 'trolley-01';
    const { page = '1', pageSize = '20' } = req.query;

    const result = await db.getTrolleyEvents({
      deviceId,
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/trolley/:id/command
trolleyRouter.post('/trolley/:id/command', async (req, res, next) => {
  try {
    const deviceId = req.params.id || 'trolley-01';
    const { type, timeoutMs } = commandSchema.parse(req.body);

    const result = await mqttManager.sendCommand(deviceId, type, timeoutMs);
    res.json({
      success: result.status === 'executed',
      ...result,
    });
  } catch (err) {
    if (err.name === 'ZodError') {
      const msg = err.issues?.[0]?.message || err.errors?.[0]?.message || err.message;
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: msg } });
    }
    if (err.code === 'BROKER_NOT_CONNECTED') {
      return res.status(503).json({
        error: {
          code: 'BROKER_NOT_CONNECTED',
          message: 'Server not connected to MQTT broker. Cannot transmit command to trolley.',
        }
      });
    }
    next(err);
  }
});
