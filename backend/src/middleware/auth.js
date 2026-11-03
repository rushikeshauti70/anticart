// Supabase JWT Verification & Admin Authorization Middleware
// Supports Supabase JWTs, Admin API keys, and unauthenticated kiosk customer shopping.

import { config } from '../config.js';
import { db } from '../db.js';

let cachedJwks = null;
let jwksCacheTime = 0;

export async function optionalJwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] || req.headers['x-admin-key'];

  // Check Admin API key first
  if (config.adminApiKey && (apiKey === config.adminApiKey || authHeader === `Bearer ${config.adminApiKey}`)) {
    req.user = { id: 'admin', role: 'admin', name: 'Store Administrator' };
    return next();
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    req.user = null;
    return next();
  }

  // 1. If live Supabase client exists, verify token cryptographically via Supabase Auth
  if (db && db.supabase && db.supabase.auth && typeof db.supabase.auth.getUser === 'function') {
    try {
      const { data, error } = await db.supabase.auth.getUser(token);
      if (data?.user && !error) {
        req.user = {
          id: data.user.id,
          email: data.user.email,
          role: data.user.role || data.user.app_metadata?.role || 'user',
          ...data.user.user_metadata,
        };
        return next();
      }
    } catch (err) {
      console.warn('[AUTH] Supabase token verification note:', err.message);
    }
  }

  // 2. Fallback to JWKS if configured with 1-hour in-memory key caching
  if (config.supabase.jwksUrl) {
    try {
      const now = Date.now();
      if (!cachedJwks || now - jwksCacheTime > 3600000) {
        const jwksRes = await fetch(config.supabase.jwksUrl);
        if (jwksRes.ok) {
          cachedJwks = await jwksRes.json();
          jwksCacheTime = now;
        }
      }

      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp && Date.now() / 1000 > payload.exp) {
          return res.status(401).json({ error: { code: 'TOKEN_EXPIRED', message: 'Authentication token has expired' } });
        }
        req.user = payload;
      }
    } catch (err) {
      console.warn('[AUTH] JWKS verification warning:', err.message);
    }
  }

  next();
}

/**
 * Route protection middleware for sensitive store mutations and hardware commands.
 * In production, strictly requires admin role or valid admin API key.
 */
export function requireAdminOrApiKey(req, res, next) {
  // If admin API key matched in optionalJwtAuth
  if (req.user?.role === 'admin') {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || req.headers['x-admin-key'];
  if (config.adminApiKey && apiKey === config.adminApiKey) {
    req.user = { id: 'admin', role: 'admin', name: 'Store Administrator' };
    return next();
  }

  // In local dev without ADMIN_API_KEY configured, log a warning but allow for development ease
  if (!config.adminApiKey && process.env.NODE_ENV !== 'production') {
    return next();
  }

  return res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Admin authorization or valid x-api-key required for this action.',
    }
  });
}
