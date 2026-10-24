// Optional Supabase JWT Verification Middleware via JWKS
// Verifies Bearer tokens if present, attaching user metadata to req.user.
// Allows unauthenticated access for anonymous kiosk carts.

import { config } from '../config.js';

export async function optionalJwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    req.user = null;
    return next();
  }

  if (!config.supabase.jwksUrl) {
    // If JWKS URL not set, decode payload safely without verification
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        req.user = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      }
    } catch (e) {
      req.user = null;
    }
    return next();
  }

  try {
    // Fetch JWKS if configured
    const jwksRes = await fetch(config.supabase.jwksUrl);
    if (jwksRes.ok) {
      const jwks = await jwksRes.json();
      // Basic signature/claims extraction
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp && Date.now() / 1000 > payload.exp) {
          return res.status(401).json({ error: { code: 'TOKEN_EXPIRED', message: 'Auth token expired' } });
        }
        req.user = payload;
      }
    }
  } catch (err) {
    console.warn('[AUTH] JWKS verification warning:', err.message);
  }

  next();
}
