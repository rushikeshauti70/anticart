# AVCOE Smart Trolley - Project Knowledge Base

Purpose: single reference for Google Antigravity (and any developer) to build, extend and deploy the AVCOE Smart Trolley web application. Read this fully before writing code. Where a section says TO CONFIRM, ask the owner instead of guessing.

---

## 0. How to use this file

1. Treat sections 1-3 as non-negotiable requirements.
2. Treat section 6 (device contract) as frozen. The firmware is already written; the web app adapts to it, not the other way round.
3. Do not invent data. The product catalog starts empty. No sample products, no fake telemetry in production mode.
4. Anything in section 13 (open items) must be resolved with the owner before deployment.

---

## 1. Project summary

A college campus smart shopping trolley.

- A line-following ESP32 trolley drives along a strip, avoids obstacles and reports sensor data over MQTT.
- A browser web application lets the customer scan product barcodes, builds the cart and bill, and shows the trolley's live sensor state in a simple animated view.
- A shop owner can add products (barcode, name, price, GST, category), edit them and delete them.
- A backend maps scanned barcode numbers to products, stores everything, and relays trolley data to the browser.

### Terminology (use these words consistently in code and UI)

| Term | Meaning |
|---|---|
| Catalog | Master list of products the shop sells (barcode, name, price, GST, category). Owner manages it. |
| Cart | Items the current customer has scanned and intends to buy. The owner sometimes calls this "inventory". |
| Bill | Cart items + GST + total, produced at checkout. |
| Trolley | The ESP32 robot, identified by `deviceId` (currently `trolley-01`). |

Note: the original brief said "when a product is purchased it is added to the inventory". Implement it as: scan -> product is added to the Cart -> checkout produces the Bill and a Purchase record. Stock quantity in the Catalog (optional field) decrements on checkout.

---

## 2. Design and UX rules

### 2.1 Tone: must not look AI generated

- No emojis anywhere (UI text, buttons, toasts, README, commit messages).
- No sparkle icons, robot or chatbot mascots, "magic" or "smart assistant" wording, gradient-glow decorations, or marketing filler copy. Remove the floating robot button seen in the earlier prototype.
- No placeholder text like "Zero fake data" or exclamation-heavy messages. Use plain, short, factual labels ("No products yet", "Add product", "Checkout").
- Use a simple line-icon set (for example Lucide) at one consistent stroke width. Icons only where they aid recognition (nav, camera, delete).
- Prefer human, plain microcopy. Errors say what happened and what to do ("Barcode not in catalog. Add it?").
- Avoid generic card-grid-with-glassmorphism look. Use flat surfaces, thin borders, clear spacing, real typography hierarchy.

### 2.2 Theme

Mostly white, with sky blue as the primary accent and yellow as a secondary highlight. Other colours only for status (success, error).

Suggested design tokens (adjust only with owner approval):

```
--bg:            #FFFFFF
--surface:       #F7FAFC
--border:        #E2E8F0
--text:          #0F172A
--text-muted:    #64748B
--primary:       #38BDF8   /* sky blue */
--primary-dark:  #0284C7
--primary-soft:  #E0F2FE
--accent:        #FACC15   /* yellow, used sparingly: warnings, highlights, active trolley line */
--accent-soft:   #FEF9C3
--success:       #16A34A
--danger:        #DC2626
--radius:        10px
```

- Light theme is the default. A dark-mode toggle existed in the prototype; keep it only if it stays clean, otherwise drop it.
- One typeface (system UI stack or Inter). Two weights are enough.
- Mobile-first: the app is used on a phone mounted on the trolley and on a laptop. Bottom navigation on mobile, side or top navigation on desktop.

### 2.3 Reference screens (from the earlier AI Studio prototype)

The owner provided screenshots of the existing prototype at `avcoeprojects.ai.studio`. Keep the information structure; restyle to section 2.2.

1. Shop
   - Header: logo mark, "AVCOE Shop", user chip, theme toggle.
   - Connection banner under header (MQTT state, link to device setup).
   - Search field, "Add Product" button, horizontal category chips: All, Groceries, Snacks, Dairy, Beverages, Electronics, Stationery.
   - Empty state when the catalog has no products, with a single "Add product" button.
   - Remove: "DEMO DATA" badge, floating robot button, "Quick Start Guide" block with emoji.
2. Scan
   - Mode switch: Photo / Barcode (keep Barcode as the primary mode; Photo is optional and can be dropped).
   - Camera viewport, Start Camera, Browse Catalog (manual pick fallback).
   - Status line showing scanner state (Idle, Scanning, Found, Not found).
3. Cart
   - Line items, quantity stepper, remove, subtotal, GST, total, Checkout, Cancel.
4. Trolley
   - "Trolley Telemetry" page, device id, last-update time, animated trolley (see section 4), Mode and Status readout, Test simulation button.
5. Account
   - Basic profile and purchase history.

Bottom navigation order: Shop, Scan, Cart, Trolley, Account.

---

## 3. Functional requirements

### 3.1 Barcode scan to cart (core flow)

1. Customer opens Scan and starts the camera (browser camera, barcode detection; for example the `BarcodeDetector` API with a ZXing-based fallback).
2. A barcode number is decoded.
3. Frontend sends it to the backend (`POST /api/scan`).
4. Backend looks up the barcode in the Catalog.
   - Found: add to the active cart (or increment quantity), return the updated cart.
   - Not found: return `404 UNKNOWN_BARCODE`; UI offers "Add this barcode as a new product".
5. UI updates only the cart area and shows the last scanned product with its price.
6. Prices always come from the database, never from the browser.

Rules:
- Same barcode scanned again within about 1.5 seconds from the same camera frame stream is treated as one scan (debounce). After that, a repeat scan intentionally increments quantity.
- Each scan carries a client-generated `scanId` (UUID) so retries do not double-add.
- Manual entry of a barcode number is also supported (type and submit).

### 3.2 Catalog management

- Add product: barcode (required, unique), name, price, GST percent, category, optional stock.
- Edit product.
- Delete product. If it appears in past purchases, soft-delete (mark inactive) so bills stay valid.
- Bulk add: owner may provide barcode numbers in a list or CSV; the page maps and creates the products (see 10.2 for import format).
- Search by name or barcode, filter by category.

### 3.3 Cart and billing

- Quantity increase/decrease, remove item, clear cart.
- Totals: subtotal = sum(price x qty); GST per product; grand total; all computed server-side, rounded to 2 decimals (store money as integer paise or `numeric(10,2)`).
- Checkout: converts the cart into a Purchase with line items snapshot (name, price, GST at time of sale), decrements stock if tracked, clears cart.
- Cancellation: cancel the whole cart before checkout; cancel a completed purchase only through an explicit, logged action (status becomes `cancelled`, stock restored).
- Bill view: printable page (itemised, total, date, trolley id).

### 3.4 Trolley dashboard

- Live sensor visualisation (section 4), connection status, mode, last-seen time.
- Remote control buttons: Pause, Resume, Stop, Refresh status (these send the commands in section 6.4). Stop must be visually distinct and always enabled when the trolley is online.
- Event log of recent device events (boot, obstacle detected, command results).

### 3.5 Simulation mode

A "Test simulation" toggle that feeds the dashboard with generated telemetry so the UI can be demonstrated without the trolley. It must be clearly labelled as simulation and must never write simulated data to the database.

---

## 4. Animated trolley visualisation

Draw it as an inline SVG, top-down, simple and calm.

Geometry (matches the real hardware):
- Rectangular body with four wheels.
- At the FRONT: a servo-mounted ultrasonic sensor (HC-SR04). The sensor head rotates with the servo.
- Three IR line sensors (left, center, right) mounted at the FRONT underside, pointing at the floor strip. Note: the earlier prototype drew the three dots at the rear; correct this so they sit at the front edge.
- Controller board label in the middle (text: ESP32).

Animations (CSS transform or SVG only; no heavy libraries):
- Servo angle: rotate the ultrasonic head and a fan-shaped beam by `ultrasonic.servo_angle_deg` (90 = straight ahead, 150 = left sweep, 30 = right sweep, per firmware constants). Ease between values (about 250 ms).
- Distance: the beam length scales with `ultrasonic.distance_cm` (0-400 cm mapped to the radar radius). Beam colour: primary when clear, accent yellow in the slow zone (under 70 cm), danger when under 30 cm or `obstacle` is true. If `valid` is false, draw a dashed beam at maximum length.
- IR sensors: three small circles; filled (primary) when that sensor sees the line, hollow when not. Draw the floor strip as a yellow line under the trolley and shift it slightly based on which sensors are active (left only = line is to the left, etc.).
- Obstacle: show an object shape in the beam at the reported distance; short pulse on the body outline.
- Mode chip: LINE_FOLLOW, PAUSED, STOPPED.
- Offline or stale (no telemetry for more than 6 seconds): grey out the drawing and show "Last update 17:27:04". Never show stale data as live.
- Respect `prefers-reduced-motion`.

Readouts under the drawing: Mode, Distance (cm), Servo angle, IR L/C/R, Wi-Fi signal (rssi), Uptime, Fault (if present), Firmware version.

---

## 5. Technology and architecture

Stack (keep it simple):

| Layer | Choice |
|---|---|
| Frontend | React + Vite, plain CSS or Tailwind, deployed on Vercel |
| Backend | Node.js + Express, persistent host (Render or similar), holds the MQTT subscriber |
| Database | Supabase PostgreSQL |
| Broker | EMQX Cloud (serverless/dedicated), already used by the firmware (see section 13, item 1) |
| Browser realtime | Server-Sent Events from backend (one-way is enough for telemetry); commands go through normal REST |

Data flow:

```
ESP32 --WiFi/TLS--> EMQX broker --> Express (MQTT subscriber)
   validate -> cache latest state -> (write events/scans to Supabase)
   --> SSE stream --> React dashboard
Browser (scan/cart/catalog) --REST--> Express --> Supabase
Browser (Pause/Resume/Stop) --REST--> Express --publish--> EMQX --> ESP32
```

Principles:
- The browser never connects to MQTT directly and never holds broker or database secrets.
- The backend keeps the latest telemetry per trolley in memory and only writes to the database when needed (events, status changes, sampled telemetry history).
- One MQTT client, one subscription set, created once; reconnect must not duplicate handlers.
- Use environment variables for everything deployable. Frontend has `VITE_API_URL` only.

Suggested repo layout:

```
/frontend        React + Vite app
/backend         Express server, MQTT subscriber, SQL
  /sql           schema.sql, seed (empty catalog)
/firmware        ESP32 sketch (owner-provided, do not rewrite)
/docs            this file, API and MQTT docs
README.md
```

---

## 6. Device contract (FROZEN - taken from firmware v3.0.0)

Source: `AVCOE SMART TROLLEY - MERGED ESP32 FIRMWARE (v3.0.0)`. The sketch was provided truncated (it stops inside the motor code), but the networking part is complete. The web application must work with this contract without firmware changes.

### 6.1 Connection

- Broker host: `k8812401.ala.eu-central-1.emqxsl.com`, TLS port `8883`.
- Device validates the broker certificate (DigiCert Global Root G2 CA). Backend must also connect with TLS and certificate validation enabled.
- Credentials are supplied through environment variables (`MQTT_USERNAME`, `MQTT_PASSWORD`). They must not be committed or put in documentation (see section 12).
- `deviceId`: `trolley-01`. Topic prefix: `avcoeshop/v1`.
- Client id on device: `esp32-trolley-<deviceId>-<4 hex>`. The backend must use a different client id.
- Keep-alive 15 s. Device only connects once it has valid UTC time via NTP.

### 6.2 Topics

The firmware builds five topics from the prefix and device id (`topicTelemetry`, `topicStatus`, `topicCommandAck`, `topicEvents`, `topicCommands`) in the part of the sketch that was not provided. TO CONFIRM the exact strings. The expected pattern, to be verified, is:

```
avcoeshop/v1/<deviceId>/telemetry      device -> backend   QoS 0, not retained
avcoeshop/v1/<deviceId>/status         device -> backend   QoS 1, retained (also the LWT)
avcoeshop/v1/<deviceId>/events         device -> backend   not retained
avcoeshop/v1/<deviceId>/command-ack    device -> backend   not retained
avcoeshop/v1/<deviceId>/commands       backend -> device   QoS 1
```

The backend subscribes with a wildcard such as `avcoeshop/v1/+/#` filtered by an allow-list (`ALLOWED_DEVICE_IDS`, comma separated, must include `trolley-01`).

### 6.3 Message envelope (all device messages)

```json
{
  "v": 1,
  "deviceId": "trolley-01",
  "ts": "2026-10-24T11:57:04Z",
  "type": "telemetry | status | event | command-ack",
  "payload": { }
}
```

Validate `v === 1`, `deviceId` in allow-list, `type` known, `ts` parseable. Reject anything else and count it (do not crash). Limit accepted payload size to about 1 KB.

### 6.4 Payloads

Telemetry (every 2000 ms while connected):

```json
{
  "mode": "LINE_FOLLOW",
  "ir": { "left": false, "center": true, "right": false },
  "ultrasonic": { "distance_cm": 82.5, "servo_angle_deg": 90, "valid": true },
  "obstacle": false,
  "fault": null,
  "uptime_s": 1234,
  "rssi": -61
}
```

- `mode`: `LINE_FOLLOW`, `PAUSED`, `STOPPED`.
- `distance_cm`: 400 means no echo. `valid` false means the reading is not trustworthy.
- `fault`: null by default. Free-text values (`LINE_LOST`, `PATH_BLOCKED`) are disabled in firmware (`ENABLE_FAULT_REPORTING = false`). The backend must accept null or string.
- Telemetry time `ts` is device UTC time from NTP.

Status (retained, published on connect and after commands):

```json
{ "state": "online", "fw": "v3.0.0-esp32", "ip": "192.168.x.x", "rssi": -61, "motorsEnabled": true }
```

`state: "offline"` is published by the broker as the Last Will when the device disconnects unexpectedly. Its `ts` is `1970-01-01T00:00:00.000Z`; do not treat it as a real time, use server receive time instead.

Event:

```json
{ "event": "OBSTACLE_DETECTED", "severity": "warning", "message": "Obstacle in path, trolley stopped and re-routing" }
```

Known events: `DEVICE_BOOT` (info), `OBSTACLE_DETECTED` (warning). Rate-limit storage of obstacle events (device already limits via queue; server should still deduplicate bursts).

Command (backend -> device), fields at top level (nested `payload` also tolerated by device):

```json
{ "commandId": "uuid", "type": "PAUSE", "expiresAtEpoch": 1790000000 }
```

- `type`: `PAUSE`, `RESUME`, `STOP`, `REQUEST_STATUS`.
- `expiresAtEpoch` in seconds (device tolerates milliseconds). Use a short expiry such as now + 15 s.
- `commandId` must be unique per command; the device ignores repeats (QoS 1 duplicate protection, remembers the last 8).
- Publish with QoS 1.

Command ACK (device -> backend), `payload`:

```json
{ "commandId": "uuid", "status": "executed", "reason": "Trolley paused" }
```

`status`: `accepted`, `executed`, `rejected`, `expired`. `RESUME` is rejected while an obstacle is in front. UI must show the result of each command and a timeout state if no ACK arrives within about 5 seconds.

### 6.5 Staleness and state rules

- Online = status `online` AND last telemetry newer than 6 seconds.
- Stale = status online but telemetry older than 6 seconds.
- Offline = status `offline` or broker connection to device lost.
- Backend connection to the broker down = show "Server not connected to broker", different from "Trolley offline".

### 6.6 Hardware facts used by the UI (from firmware constants)

- Obstacle stop at 30 cm, resume at 40 cm, slow zone below 70 cm.
- Servo: center 90, left sweep 150, right sweep 30 degrees.
- Pins (reference only): motors 25/26 and 27/14, IR 34/35/39, ultrasonic TRIG 23 / ECHO 22, servo 21, LED 2, buzzer 4.
- Firmware runs networking on core 0 and driving on core 1, so the trolley keeps driving if Wi-Fi or MQTT drops. The web app must therefore never assume that "offline" means "stopped".

---

## 7. Database (Supabase PostgreSQL)

Provide one runnable `schema.sql`. Minimum tables:

| Table | Key columns |
|---|---|
| `products` | `id uuid pk`, `barcode text unique not null`, `name`, `category`, `price numeric(10,2) check >= 0`, `gst_percent numeric(5,2) default 0`, `stock int null`, `active bool default true`, `created_at`, `updated_at` |
| `carts` | `id uuid pk`, `trolley_id text`, `status` (`open`, `checked_out`, `cancelled`), `created_at`, `updated_at` |
| `cart_items` | `id`, `cart_id fk`, `product_id fk`, `quantity int check > 0`, unique(`cart_id`,`product_id`) |
| `scan_events` | `id`, `scan_id uuid unique`, `cart_id`, `barcode`, `product_id null`, `result` (`added`, `unknown`, `duplicate`), `created_at` |
| `purchases` | `id`, `cart_id`, `subtotal`, `gst_total`, `total`, `status` (`completed`, `cancelled`), `created_at` |
| `purchase_items` | `purchase_id`, `product_id`, snapshot `name`, `price`, `gst_percent`, `quantity` |
| `trolley_events` | `id`, `device_id`, `event`, `severity`, `message`, `device_ts`, `received_at` |
| `trolley_telemetry` | `id`, `device_id`, `payload jsonb`, `received_at` (sampled, see below) |

Rules:
- Indexes: `products(barcode)` unique, `cart_items(cart_id)`, `scan_events(scan_id)` unique, `trolley_events(device_id, received_at desc)`, `trolley_telemetry(device_id, received_at desc)`.
- Cart add must be atomic (single `insert ... on conflict do update`, or an RPC function) so quantity and totals stay consistent.
- Telemetry history: do not store every 2-second reading. Store one sample per 30 to 60 seconds, plus any reading where `obstacle` or `mode` changes. Delete or aggregate telemetry older than 7 to 30 days. Never auto-delete scans, purchases or events.
- Row Level Security on all tables. The frontend never talks to Supabase with privileged keys. The service-role key stays in the backend environment only. If the frontend later uses Supabase Auth, add per-user policies.

---

## 8. API (backend REST + SSE)

Base: `${VITE_API_URL}`. JSON in and out. Consistent error shape `{ "error": { "code": "...", "message": "..." } }`.

```
GET    /health                         liveness and broker/db connection state
GET    /api/products?search=&category=&page=&pageSize=
POST   /api/products                   create
PUT    /api/products/:id               update
DELETE /api/products/:id               soft delete if used in purchases
POST   /api/products/import            bulk create from list/CSV
GET    /api/cart                       current open cart for the trolley/session
POST   /api/scan                       { barcode, scanId, trolleyId? } -> add to cart
PATCH  /api/cart/items/:productId      { quantity }
DELETE /api/cart/items/:productId
POST   /api/cart/cancel
POST   /api/cart/checkout              returns purchase/bill
GET    /api/purchases?page=            history
POST   /api/purchases/:id/cancel
GET    /api/trolley/:id/state          latest status + telemetry snapshot
GET    /api/trolley/:id/events?page=   recent events (paginated)
POST   /api/trolley/:id/command        { type: PAUSE|RESUME|STOP|REQUEST_STATUS }
GET    /api/stream                     SSE: events `telemetry`, `status`, `event`, `command-ack`, `cart`, `heartbeat`
```

Notes:
- SSE sends a heartbeat every 15 s, supports reconnect with `Last-Event-ID` where practical, and the client reconnects with back-off (1 s, 2 s, 5 s, max 15 s).
- Validate all bodies (for example with zod). Restrict body size. Rate-limit `/api/scan` and `/api/trolley/:id/command`.
- Only these command types are accepted from the browser; the backend builds `commandId` and `expiresAtEpoch` itself.
- CORS: allow only `FRONTEND_ORIGIN`.
- The owner said "I will provide the APIs that you want": see section 13 for which keys and endpoints are needed from the owner.

---

## 9. Environment variables

Backend:

```
PORT=
FRONTEND_ORIGIN=https://<your-vercel-app>.vercel.app
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
MQTT_URL=mqtts://k8812401.ala.eu-central-1.emqxsl.com:8883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_CA_CERT=            (PEM text or a file path; DigiCert Global Root G2)
MQTT_TOPIC_PREFIX=avcoeshop/v1
ALLOWED_DEVICE_IDS=trolley-01
TELEMETRY_STALE_MS=6000
TELEMETRY_STORE_INTERVAL_MS=60000
```

Frontend:

```
VITE_API_URL=https://<your-render-service>.onrender.com
```

Provide `.env.example` files with empty values. Never commit real `.env` files.

---

## 10. Reliability, performance and security rules

### 10.1 Backend
- One MQTT client created at startup; handlers registered once; on reconnect, re-subscribe without adding duplicate listeners. Use `clean: false` or re-subscribe in the `connect` handler, not both in a way that stacks.
- Graceful shutdown on SIGTERM (close SSE streams, end MQTT, close DB).
- Structured logs, no secrets, no full payload dumps at info level.
- Cache product lookups by barcode in memory with a short TTL (for example 60 s) and invalidate on product create/update/delete.
- Bounded memory: cap SSE clients, cap event buffers.
- Free-tier hosts may sleep. A sleeping backend drops the MQTT subscription, so use a plan that stays awake, or an external uptime ping every 5 minutes, and say clearly in the README which was chosen.

### 10.2 Bulk import format (owner supplies barcodes)

CSV with header: `barcode,name,category,price,gst_percent,stock`. Reject rows with duplicate or empty barcodes and return a per-row result list.

### 10.3 Frontend
- Update only the components affected by an SSE message (cart panel, telemetry panel, banner). Do not refetch everything after each scan.
- Paginate catalog, purchases and event history. Keep current sensor values separate from history.
- Show clear states: connecting, online, stale (with last update time), offline, reconnecting.
- Accessible: labels on inputs, focus states, keyboard operable, contrast at least WCAG AA on the white and sky-blue palette (use `--primary-dark` for text on white).

### 10.4 Testing checklist
- Simulated MQTT publisher script (valid telemetry, status online/offline, event, ACK, malformed JSON, wrong deviceId, oversized payload).
- Scan: known barcode adds once; retry with same `scanId` does not double add; unknown barcode returns 404; deliberate second scan increments quantity.
- Totals correct for GST and rounding.
- Backend restart and broker disconnect: UI shows correct states and recovers.
- Both builds pass (`vite build`, backend start). Never state that deployment succeeded unless it was actually verified.

---

## 11. Deployment summary

1. Supabase: create project, run `schema.sql`, copy URL and service-role key into backend env only.
2. EMQX: confirm user has publish/subscribe permission on `avcoeshop/v1/#` (ACL), keep TLS on.
3. Backend on Render: root directory `backend`, build `npm install`, start `npm start`, set env vars from section 9, health check path `/health`.
4. Frontend on Vercel: root directory `frontend`, framework Vite, set `VITE_API_URL` to the Render URL.
5. Set `FRONTEND_ORIGIN` on the backend to the final Vercel URL, redeploy backend.
6. Verify in order: `/health`, product add, scan with simulator, SSE stream, then the real trolley.

Redeploy: push to GitHub main; both hosts rebuild from their configured directories.

---

## 12. Security items the owner must act on

1. The firmware file contains a real Wi-Fi password and real MQTT username and password in plain text, and the file was shared in a chat. Change those credentials now (new broker user, new hotspot password) and keep the new values only in a local, uncommitted `secrets.h` that the sketch includes. Do not put credentials in this knowledge base, the repo, screenshots or the web app.
2. Create separate MQTT users: one for the device, one for the backend, each limited by ACL to the topics it needs.
3. Service-role keys and MQTT passwords exist only in backend environment variables.
4. The Wi-Fi SSID line in the sketch is missing its closing quote (`"android;`). It will not compile until fixed. The sketch was also cut off inside `writeSide()`; send the remainder if the firmware needs review.

---

## 13. Open items (resolve with the owner)

1. Broker conflict: the original brief says HiveMQ Cloud; the firmware already uses EMQX Cloud (`...emqxsl.com`). Plan assumes EMQX because the firmware is working and must not change. Confirm.
2. Exact topic strings (section 6.2) and the `ALLOWED_DEVICE_IDS` value on the previous server. Send the part of the sketch where `topicTelemetry` etc. are built.
3. RFID: the first brief describes RFID scans and `RFID UID`, but this project scans barcodes in the browser and the firmware has no RFID reader. Assumed: barcodes only, no RFID. Confirm.
4. IR sensor position: owner says front; the prototype drew them at the rear. Assumed front.
5. Authentication: the prototype shows a user "Priya". Decide whether login is needed (Supabase Auth) or a single shop-owner role plus anonymous customer carts.
6. Owner-provided inputs still needed: Supabase project URL and keys (to be put in env, not in chat), the barcode list with product names and prices, GST rules, category list, logo (if any), and any previous design images to match.
7. Single trolley or many: currently `trolley-01` only; schema supports more.
8. Whether stock tracking is wanted, or just a catalog with prices.
9. Whether the camera barcode scan runs on the customer's phone, on a screen on the trolley, or both.
10. Hosting plan for the backend (always-on or free with keep-alive) and the expected number of simultaneous users.

---

## 14. Definition of done

- Empty catalog on first run; owner can add a product by barcode and it appears immediately.
- Scanning that barcode adds it to the cart once, shows correct price and total.
- Checkout produces a bill; cancel works before checkout.
- Trolley page shows live animated sensor state from the real ESP32, correct stale/offline handling, and working Pause/Resume/Stop with ACK feedback.
- No emojis, no AI-style mascots or decorations, white with sky-blue and yellow theme.
- No secrets in the repo; README explains setup, env variables, deployment and troubleshooting.
