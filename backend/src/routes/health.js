import { Router } from 'express';
import { mqttManager } from '../mqtt.js';
import { config } from '../config.js';

export const healthRouter = Router();

healthRouter.get('/health', (req, res) => {
  const isSupabaseConfigured = Boolean(config.supabase.url && config.supabase.serviceRoleKey);

  res.status(200).json({
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    mqtt: {
      connected: mqttManager.isConnected,
      state: mqttManager.connectionState,
      lastError: mqttManager.lastError,
      stats: mqttManager.stats,
    },
    database: {
      provider: isSupabaseConfigured ? 'supabase' : 'in-memory',
      status: 'ready',
    },
  });
});
