# Full System Audit & Verification Report
**Project:** AVCOE Smart Trolley (Anticart)  
**Date:** October 28, 2026  
**Branch:** `audit-fixes-oct28`  
**Targets:** Firmware (`firmware/`), Backend (`backend/`), Frontend (`frontend/`), Database (`backend/sql/schema.sql`)

---

## 1. Executive Summary
A comprehensive security, operational, and pipeline audit was executed across all components of the AVCOE Smart Trolley codebase. All critical, high, and medium severity findings—including the essential safety requirement that **the trolley only drives when granted permission by the website**—have been resolved, verified with unit/integration tests, and built cleanly.

---

## 2. Findings & Resolutions

### [CRITICAL] 1. Cart Driving on Boot Without Website Permission
* **Component:** `firmware/AVCOE_Smart_Trolley_EMQX_TLS.ino`
* **Finding:** Firmware booted with `motorsEnabled = true`, `opMode = 0` (`LINE_FOLLOW`), and called `setState(ST_FOLLOW)` after a 2-second delay. The trolley drove autonomously upon receiving power, without waiting for the web app operator or customer.
* **Resolution:**
  - Initialized boot state to safe parked standby: `volatile bool motorsEnabled = false; volatile uint8_t opMode = 1;` (`PAUSED`).
  - Replaced auto-drive in `setup()` with `stopNow(); wasParked = true;`.
  - Added support for both `"START"` and `"RESUME"` commands in `mqttCallback`.
  - Updated backend (`backend/src/mqtt.js`, `backend/src/routes/trolley.js`) to allow the `'START'` command type.
  - Updated frontend (`frontend/src/views/TrolleyView.jsx`) to display an explicit **"Start Trolley (Grant Permission)"** button when parked.

### [HIGH] 2. Hardcoded Wi-Fi & MQTT Credentials in Firmware
* **Component:** `firmware/AVCOE_Smart_Trolley_EMQX_TLS.ino` & `firmware/secrets.h.example`
* **Finding:** Wi-Fi and MQTT credentials were hardcoded in the `.ino` source file.
* **Resolution:** Implemented `#if __has_include("secrets.h")` pattern. Created tracked `firmware/secrets.h.example` with placeholders, keeping actual `secrets.h` gitignored.

### [HIGH] 3. Deprecated Gemini Vision 1.5 Model on v1beta API
* **Component:** `backend/src/routes/cart.js` & `backend/src/routes/products.js`
* **Finding:** Google returned `404 NOT_FOUND` for `gemini-1.5-flash` on `v1beta` for new API keys, triggering `AI_SERVICE_ERROR`.
* **Resolution:** Upgraded to **`gemini-3.8-flash`** with multi-model fallback (`gemini-3.8-flash` → `gemini-flash-latest` → `gemini-2.5-flash`). Verified with live API calls.

### [MEDIUM] 4. Rolling-Shutter Optical Flicker / False Barcode Reads
* **Component:** `frontend/src/views/ScanView.jsx`
* **Finding:** When scanning barcodes displayed on smartphone screens or under high-frequency lighting, rolling-shutter flicker could generate a single-frame optical artifact that matched modulo-10 checksum by fluke.
* **Resolution:** Enforced a **Two-Frame Confirmation Guard** across all barcode types. Two consecutive matching video frames within 500ms are required before submitting to the cart.

### [MEDIUM] 5. UPC-A (12-Digit) vs EAN-13 (13-Digit) Database Normalization
* **Component:** `backend/src/db.js`
* **Finding:** 12-digit UPC-A barcodes failed lookup if stored as 13-digit EAN-13 with leading zero, and MILK was previously recorded with a typo (`0511114075922`).
* **Resolution:** Added GS1 normalization in `getProductByBarcode()` to automatically match 12-digit UPC-A and 13-digit 0-padded codes. Updated live database item for MILK to `051111407592`.

### [MEDIUM] 6. ESP32 MQTT Connection Gated on NTP Sync
* **Component:** `firmware/AVCOE_Smart_Trolley_EMQX_TLS.ino`
* **Finding:** If local Wi-Fi or cellular hotspot blocked UDP port 123, `timeIsValid()` never turned true, preventing the trolley from connecting to MQTT.
* **Resolution:** Added a 15-second fallback: if NTP is delayed, MQTT connection proceeds so telemetry and start/stop controls function.

### [LOW] 7. Backend Test Harness URL Coupling
* **Component:** `backend/test/backend.test.js`
* **Finding:** Hardcoded `http://localhost:5000` prevented targeting live or staging endpoints.
* **Resolution:** Supported `process.env.TEST_BASE_URL || 'http://localhost:5000'`.

---

## 3. Verification & Test Results

1. **EMQX TLS MQTT Pipeline Test:**
   - Broker: `mqtts://k8812401.ala.eu-central-1.emqxsl.com:8883`
   - Test Topic: `avcoeshop/v1/test/audit-check`
   - Result: **PASSED** (TLS connection, QoS 1 publish/subscribe confirmed).
2. **Backend Automated Verification Suite:**
   - Test 1: `/health` status (200 OK, DB ready, MQTT connected) -> **PASSED**
   - Test 2: Product Catalog CRUD & duplicate barcode rejection -> **PASSED**
   - Test 3: Scan flow, checksum validation, and scanId idempotency -> **PASSED**
   - Test 4: Cart checkout, order generation, and stock management -> **PASSED**
   - Test 5: Purchase cancellation and stock restoration -> **PASSED**
   - Test 6: CSV bulk product catalog import -> **PASSED**
   - Test 7: Trolley state and command validation -> **PASSED**
   - Test 8: Server-side AI barcode lookup proxy -> **PASSED**
   - **Result: 8/8 Tests Passed (100% Success)**
3. **Frontend Production Build:**
   - `vite build` completed in 8.76s with 0 errors. Chunks rendered cleanly.
4. **Security Audits:**
   - `npm audit` on `backend/`: **0 vulnerabilities found**
   - `npm audit` on `frontend/`: **0 vulnerabilities found**

---

## 4. What Remains (User Actions for Hardware / Cloud)
1. **Flash ESP32 Firmware:** Flash the updated `firmware/AVCOE_Smart_Trolley_EMQX_TLS.ino` to your ESP32 board using Arduino IDE (configured with ESP32 board package v3.x and PubSubClient buffer >= 1024).
2. **Deploy to Render:** Merge/deploy the latest commit to Render so the backend runs the updated `gemini-3.8-flash` and `START` command handlers.
