# AVCOE Smart Trolley - Pre-Release Audit & Security Report

**Date**: 2026-10-24  
**Project**: AVCOE Smart Shopping Trolley  
**Target Environments**: Supabase (PostgreSQL), EMQX Cloud (MQTT TLS), Render (Node.js Backend), Vercel (React Frontend)  

---

## 1. Findings by Severity

| ID | Category | Severity | Item Description | Status |
|---|---|---|---|---|
| **SEC-01** | Firmware | **CRITICAL** | Wi-Fi and MQTT credentials were hardcoded in plain text in `.ino` sketches. | **FIXED** |
| **SEC-02** | Credentials | **HIGH** | Google / Gemini API key was transmitted in chat. | **ACTION REQUIRED** |
| **SEC-03** | Credentials | **HIGH** | MQTT password in firmware was a common weak sequence (`12345678`). | **ACTION REQUIRED** |
| **SEC-04** | API Security | **MEDIUM** | Need server-side AI proxy to prevent leaking `GOOGLE_API_KEY` to browser clients. | **FIXED** |
| **SEC-05** | Auth / JWKS | **MEDIUM** | Supabase JWT token verification via JWKS was not yet available for multi-user operator auth. | **FIXED** |
| **NET-01** | MQTT Broker | **MEDIUM** | Broad wildcard topic subscription (`avcoeshop/v1/devices/+/#`). | **FIXED** |
| **NET-02** | MQTT Broker | **MEDIUM** | EMQX Cloud cluster was stopped and refused connection on incorrect credentials. | **ACTION REQUIRED** |
| **REL-01** | Barcode / Cart | **LOW** | Potential frame duplicate scan and scanId idempotency edge cases. | **VERIFIED** |
| **REL-02** | RLS Policies | **LOW** | Row Level Security verification on all Supabase tables. | **VERIFIED** |
| **ENV-01** | Environment | **LOW** | Incomplete `.env.example` placeholder files. | **FIXED** |

---

## 2. Remediations Applied (What Was Fixed)

### 2.1 Credential Sanitization in Firmware
- Removed hardcoded Wi-Fi passwords and MQTT passwords from [`firmware/AVCOE_Smart_Trolley_EMQX_TLS.ino`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/firmware/AVCOE_Smart_Trolley_EMQX_TLS.ino) and [`firmware/avcoe_smart_trolley.ino`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/firmware/avcoe_smart_trolley.ino).
- Fixed the syntax compile error on line 42 (`const char* WIFI_SSID = "android;`).
- Added conditional `#if __has_include("secrets.h")` logic so developers compile with a local uncommitted `secrets.h`.
- Created [`firmware/secrets.h.example`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/firmware/secrets.h.example) with placeholders.
- Added `firmware/secrets.h` to [`.gitignore`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/.gitignore).

### 2.2 Server-Side AI Barcode Proxy (`GOOGLE_API_KEY`)
- Implemented `POST /api/products/ai-lookup` in [`backend/src/routes/products.js`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/backend/src/routes/products.js).
- Calls Google Gemini 1.5 Flash server-side using `process.env.GOOGLE_API_KEY`.
- The Google API key is never exposed to the frontend or committed to git.
- Integrated an "AI Suggest" button into the Add Product modal in [`frontend/src/views/ShopView.jsx`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/frontend/src/views/ShopView.jsx).

### 2.3 JWT Verification via JWKS
- Added [`backend/src/middleware/auth.js`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/backend/src/middleware/auth.js) verifying Bearer tokens against `SUPABASE_JWKS_URL` (`https://booeipyxsuescbsopjyz.supabase.co/auth/v1/.well-known/jwks.json`).
- Permits seamless anonymous kiosk mode while protecting authenticated operator sessions.

### 2.4 Tightened MQTT Subscriptions
- In [`backend/src/mqtt.js`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/backend/src/mqtt.js), replaced the broad `devices/+/#` wildcard with explicit subscriptions:
  - `avcoeshop/v1/devices/+/telemetry`
  - `avcoeshop/v1/devices/+/status`
  - `avcoeshop/v1/devices/+/events`
  - `avcoeshop/v1/devices/+/command-ack`

### 2.5 Standardized Environment Variable Names
- Updated [`backend/.env.example`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/backend/.env.example) to standardize:
  `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS_URL`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_WS_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_URL`, `EMQX_API_URL`, `GOOGLE_API_KEY`.

### 2.6 Automatic Proxy Routing on Vercel
- Added [`frontend/vercel.json`](file:///c:/Users/Rushikesh/OneDrive/Pictures/Desktop/iot/frontend/vercel.json) rewrite proxy so all `/api/...` and `/health` requests automatically forward to the Render backend service.

---

## 3. Owner Actions Required (Security & Configuration)

Before placing the trolley in production:

1. **Rotate the Google / Gemini API Key**:
   - The key shared in chat should be regenerated at [Google AI Studio](https://aistudio.google.com/) or [GCP Console](https://console.cloud.google.com/).
   - In GCP Console, restrict the key:
     - **API Restrictions**: Restrict only to *Generative Language API*.
     - **Application Restrictions**: Set to *IP addresses* (Render's outbound IPs) or leave unrestricted only on server-side environments.
   - Set the rotated key in your **Render** environment variables as `GOOGLE_API_KEY`.

2. **Rotate the Supabase Secret Key**:
   - In the Supabase Dashboard, go to **Project Settings → API Keys**.
   - Rotate the secret key.
   - Update `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) on Render.

3. **Set a Strong MQTT Password in EMQX Cloud**:
   - In [cloud-intl.emqx.com](https://cloud-intl.emqx.com), under **Authentication**, update user `rushikesh` with a 16+ character random password.
   - Update `MQTT_PASSWORD` in your Render environment variables.
   - Update `SECRET_MQTT_PASS` in your local `firmware/secrets.h`.

4. **Verify EMQX Broker is Running**:
   - Confirm deployment `k8812401` status shows **Running** (not Stopped).

---

## 4. Final Go-Live Checklist

- [x] All repository code committed and pushed to `main`.
- [x] Backend deployed and running on Render: `https://avcoe-smart-trolley-backend.onrender.com`.
- [x] Database connected to Supabase PostgreSQL (`provider: supabase, status: ready`).
- [x] Frontend deployed on Vercel: `https://frontend-chi-jet-26.vercel.app`.
- [x] Vercel proxy rewrite active and verified (`/api/products` returns 200).
- [x] Product CRUD and scan-to-cart verified on live production.
- [x] Offline hardware simulation script verified (`backend/scripts/simulate_trolley.js`).
- [x] Top-down animated SVG trolley visualizer operational with Pause/Resume/Stop controls.
- [x] Zero hardcoded secrets remaining in repository code.
- [ ] Owner rotates Google API key and sets `GOOGLE_API_KEY` on Render.
- [ ] Owner updates `MQTT_PASSWORD` in EMQX Cloud and Render.
- [ ] Owner flashes physical ESP32 with `firmware/secrets.h` and places trolley on track.
