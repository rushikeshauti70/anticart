# AVCOE Smart Trolley Web Application

A full-stack IoT web application for the AVCOE Smart Shopping Trolley, supporting browser barcode scanning, automated cart billing with GST calculation, and real-time hardware telemetry monitoring over MQTT and Server-Sent Events (SSE).

---

## 1. Architecture Overview

```
ESP32 Hardware Robot ---WiFi/TLS---> EMQX Cloud Broker ---> Express Backend (MQTT Subscriber)
                                                                 │
                                                       ┌─────────┴─────────┐
                                                       ▼                   ▼
                                                Supabase PostgreSQL   SSE Stream
                                                                           │
                                                                           ▼
                                                                  React + Vite Frontend
```

- **Frontend**: React + Vite single-page application using custom CSS tokens (white, sky blue `#38BDF8`, and yellow `#FACC15`), clean typography, accessible controls, and no emojis or AI decorations.
- **Backend**: Node.js + Express server holding a single persistent MQTT subscriber client with TLS, in-memory state cache, and Server-Sent Events (SSE) hub.
- **Database**: Supabase PostgreSQL with complete Row Level Security (RLS), atomic scan-to-cart operations, immutable purchase item snapshots, and sampled telemetry storage.
- **Broker**: EMQX Cloud TLS broker (`k8812401.ala.eu-central-1.emqxsl.com:8883`) adhering to the frozen ESP32 firmware v3.0.0 contract.

---

## 2. Repository Layout

```
.
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── sql/
│   │   └── schema.sql                # PostgreSQL schema for Supabase
│   ├── scripts/
│   │   └── simulate_trolley.js       # Standalone hardware simulation script
│   ├── src/
│   │   ├── config.js                 # Environment configuration
│   │   ├── db.js                     # Supabase & in-memory database abstraction
│   │   ├── index.js                  # Express application & lifecycle
│   │   ├── mqtt.js                   # MQTT client & envelope validation
│   │   ├── sse.js                    # Server-Sent Events stream manager
│   │   └── routes/
│   │       ├── cart.js               # /api/cart and /api/scan
│   │       ├── health.js             # /health endpoint
│   │       ├── products.js           # /api/products catalog CRUD and CSV import
│   │       ├── purchases.js          # /api/purchases order history
│   │       └── trolley.js            # /api/trolley telemetry and commands
│   └── test/
│       └── backend.test.js           # Automated end-to-end backend tests
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   ├── .env.example
│   └── src/
│       ├── App.jsx                   # Navigation, layout and real-time state
│       ├── api.js                    # REST API and SSE client
│       ├── index.css                 # Theme design tokens and styling
│       ├── main.jsx                  # Entry point
│       ├── components/
│       │   └── TrolleyVisualizer.jsx # Inline top-down animated SVG trolley
│       └── views/
│           ├── AccountView.jsx       # Order history and operator kiosk
│           ├── CartView.jsx          # Shopping cart, totals, and bill printing
│           ├── ScanView.jsx          # Camera barcode scanning & manual entry
│           ├── ShopView.jsx          # Master catalog CRUD and CSV import
│           └── TrolleyView.jsx       # Hardware dashboard and remote controls
├── firmware/                         # ESP32 Arduino sketches (owner-provided)
│   ├── AVCOE_Smart_Trolley_EMQX_TLS.ino
│   └── avcoe_smart_trolley.ino
└── docs/
    ├── KNOWLEDGE_BASE.md             # Source of truth specification
    └── reference/                    # Reference screenshots
```

---

## 3. Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Default / Example |
|---|---|---|
| `PORT` | Local HTTP port for the Express backend | `5000` |
| `FRONTEND_ORIGIN` | Allowed CORS origin (production Vercel URL) | `http://localhost:5173` |
| `SUPABASE_URL` | Supabase Project URL | `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Secret Key (backend only) | `eyJhbGciOi...` |
| `MQTT_URL` | EMQX Broker URL with TLS protocol | `mqtts://k8812401.ala.eu-central-1.emqxsl.com:8883` |
| `MQTT_USERNAME` | EMQX client username | Provided by owner |
| `MQTT_PASSWORD` | EMQX client password | Provided by owner |
| `MQTT_CA_CERT` | Optional PEM certificate or path (DigiCert G2) | Optional |
| `MQTT_TOPIC_PREFIX` | Base topic prefix | `avcoeshop/v1` |
| `ALLOWED_DEVICE_IDS` | Comma-separated allowed trolley IDs | `trolley-01` |
| `TELEMETRY_STALE_MS` | Milliseconds before telemetry is marked stale | `6000` |
| `TELEMETRY_STORE_INTERVAL_MS` | Milliseconds between periodic DB telemetry samples | `60000` |

### Frontend (`frontend/.env`)

| Variable | Description | Default / Example |
|---|---|---|
| `VITE_API_URL` | Backend API URL (leave blank in local dev to use Vite proxy) | `https://your-service.onrender.com` |

---

## 4. Local Run Instructions

### Step 1: Start the Backend

```bash
cd backend
npm install
cp .env.example .env
npm start
```

The backend starts at `http://localhost:5000`.
- Health check: `http://localhost:5000/health`
- Real-time SSE stream: `http://localhost:5000/api/stream`

### Step 2: Run Backend Automated Verification Tests

```bash
cd backend
npm test
```

This validates:
- Health check response (`200 OK`)
- Product catalog CRUD and duplicate barcode rejection
- Scan flow with `scanId` idempotency (duplicate retry protection)
- Cart calculations with exact GST and rounding
- Checkout creation, stock decrement, and purchase cancellation
- Bulk CSV import
- Trolley command validation

### Step 3: Start the Frontend

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173/` in your browser.

### Step 4: Run the Trolley Simulator (Hardware Testing)

To test the application without physical hardware:

```bash
# Continuous simulation publishing telemetry every 2 seconds:
node backend/scripts/simulate_trolley.js

# Or test edge-case message rejection (oversized, malformed, invalid device):
node backend/scripts/simulate_trolley.js --test-cases
```

Alternatively, use the **Test simulation** toggle directly on the **Trolley** page in the browser.

---

## 5. Deployment Instructions

### 1. Supabase (Database)
1. Sign in to [Supabase](https://supabase.com/) and create a new project.
2. Open the **SQL Editor** in the Supabase Dashboard.
3. Open `backend/sql/schema.sql`, paste the contents, and run it. This creates:
   - All 8 tables (`products`, `carts`, `cart_items`, `scan_events`, `purchases`, `purchase_items`, `trolley_events`, `trolley_telemetry`).
   - Indexes, triggers, and Row Level Security policies.
   - The master catalog starts empty.
4. Go to **Project Settings** > **API**. Copy:
   - **Project URL** -> `SUPABASE_URL`
   - **service_role (secret)** key -> `SUPABASE_SERVICE_ROLE_KEY` (never share or expose in frontend).

### 2. EMQX Cloud (MQTT Broker)
1. In your EMQX Cloud console, ensure ACL permissions allow:
   - Device publish on: `avcoeshop/v1/devices/trolley-01/#`
   - Backend subscribe on: `avcoeshop/v1/devices/+/#`
   - Backend publish on: `avcoeshop/v1/devices/+/commands`
2. Create separate users for the ESP32 and for the backend server.

### 3. Render (Backend Deployment)
1. Sign in to [Render](https://render.com/) and select **New Web Service**.
2. Connect your GitHub repository.
3. Configure settings:
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. Under **Environment Variables**, add all variables from `backend/.env.example`.
5. Deploy the service and copy the provided service URL (e.g., `https://avcoe-backend.onrender.com`).

### 4. Vercel (Frontend Deployment)
1. Sign in to [Vercel](https://vercel.com/) and select **Add New Project**.
2. Import your GitHub repository.
3. Configure project settings:
   - **Root Directory**: `frontend`
   - **Framework Preset**: `Vite`
4. Under **Environment Variables**, set:
   - `VITE_API_URL`: Your Render backend URL (e.g. `https://avcoe-backend.onrender.com`).
5. Click **Deploy**. Copy your production Vercel URL (e.g., `https://avcoe-shop.vercel.app`).

### 5. Final Configuration
1. Go back to your Render backend service settings.
2. Update `FRONTEND_ORIGIN` to your Vercel URL (`https://avcoe-shop.vercel.app`).
3. Trigger a backend redeploy to apply the CORS origin.

---

## 6. Troubleshooting Guide

| Issue | Cause | Solution |
|---|---|---|
| `connack timeout` on MQTT | EMQX Cloud cluster paused or missing credentials | Verify broker credentials in `.env`. Ensure cluster is active in EMQX console. |
| Barcode scanner camera does not open | Missing browser permissions or insecure context (HTTP) | Browsers require `https://` (or `localhost`) to access camera. Allow camera permission in browser settings. |
| Camera doesn't detect barcodes | Browser lacks native `BarcodeDetector` | Use manual barcode entry on the Scan screen, or use Chrome/Edge on Android/Desktop. |
| Trolley status shows "Stale" | No telemetry received for > 6 seconds | Trolley Wi-Fi dropped or robot paused. Check status LED on ESP32. |
| Cart does not update on other tabs | SSE connection closed | Ensure backend is running and `/api/stream` is accessible. The client reconnects automatically. |
| Free-tier backend sleep | Render free tier spins down after 15 min of inactivity | Set up an external uptime monitor (e.g., UptimeRobot or Cron-job.org) to ping `/health` every 5 minutes. |
# anticart


---

## 7. Barcode Scanner & POS Auto-Inventory Pipeline

### System Architecture
```
[USB HID Scanner / Web Camera]
           │
           ▼
[Keystroke Wedge Buffer (<50ms filter) + GS1 Modulo-10 Checksum + 1500ms Debounce]
           │
           ├──────────────────────────────┐
           ▼                              ▼
[MQTT TLS Publisher]             [Inventory Service Lock]
- Topic: device/{id}/scan        - Atomic Stock Decrement
- QoS 1, Retained LWT            - Stock Movement Audit Log
- Offline Queue (.offline_queue) - Out-of-Stock / Low-Stock Alerts
                                 - Auto-Add on Catalog Registration
```

### Running the Barcode & Inventory Test Suite
```bash
node backend/test/scanner_system.test.js
```
Runs 15 automated integration tests verifying:
- GS1 Modulo-10 checksums (EAN-13, UPC-A, EAN-8)
- 1500ms debounce deduplication & <50ms keyboard wedge detection
- MQTT offline disk queue (FIFO reconnect flush)
- Atomic stock decrements, concurrent locks, and idempotency
- Real-time inventory movement audit trail

### Interactive Hardware Simulator
```bash
node backend/scripts/simulate_scanner.js
```
Simulates real barcode scanner hardware with interactive options:
- Scan standard demo barcodes (Milk UPC-A, Ponds EAN-13, Maggi, Lays)
- Test burst keystroke timing (15ms hardware wedge vs manual typing)
- Test unknown barcode handling and invalid checksum rejection

### Database Migration
If deploying to Supabase PostgreSQL, execute the migration:
`backend/sql/migrations/002_inventory_stock_movements.sql`


---

## 8. Live Excel Logging with 5-Second Cleaning

### Architecture & Non-Blocking Design
The system records all sensor events (barcode scans, ultrasonic distance, cart additions, inventory movements, hardware status) into a bounded in-memory buffer. A dedicated background worker executes every 5 seconds (configurable via `EXCEL_FLUSH_INTERVAL_SEC`), cleaning the buffer without ever blocking the real-time scanning thread or Express event loop.

```
[Sensors / Scanners / MQTT / Inventory]
                   │
                   ▼ (Non-blocking emit)
       [In-Memory Bounded Buffer (max 5,000)]
                   │
         [Every 5 Seconds Worker]
                   ├─ 1. Drop Noise (heartbeats, empty reads, malformed pings)
                   ├─ 2. Deduplicate (same barcode + action within 1500ms debounce)
                   ├─ 3. Continuous Sensor Burst Collapsing (weight/ultrasonic threshold <5.0)
                   ├─ 4. Multi-Step Scan Flow Merging (merge scan -> lookup -> cart -> stock into 1 row)
                   ├─ 5. Whitelist Filter (keep only necessary operational actions)
                   │
                   ▼
  [Atomic Write to ExcelJS Workbook (.temp rename)]
  ├── "Activity" Sheet: All cleaned sensor actions with frozen styled headers & auto-filters
  ├── "Alerts" Sheet: Filtered warnings (out_of_stock, low_stock, unknown_barcode, error)
  └── "Summary" Sheet: Live operational metrics (total scans, active devices, error rates)
```

### Key Features
- **Multi-Sheet Workbook**: Generates `.xlsx` files with `Activity` (color-coded rows: soft red `#FEE2E2` for out of stock, amber `#FEF3C7` for low stock/alerts, green `#DCFCE7` for additions), `Alerts`, and `Summary` tabs with dark blue `#1E293B` frozen headers.
- **Windows File Lock (`EBUSY` / `EPERM`) Resilience**: If an operator opens the `.xlsx` file in Microsoft Excel during a scheduled flush, the logger catches the lock error, preserves the entire batch in memory, and automatically flushes on the next cycle once the file is unlocked. No data is ever dropped.
- **CSV Mirror Fallback**: Simultaneously maintains an append-only `.csv` log (`exports/activity_YYYY-MM-DD.csv`) as an uncorruptible audit trail.
- **Daily Rotation & 30-Day Retention**: Files automatically rotate daily (`activity_YYYY-MM-DD.xlsx`) or when exceeding 10,000 rows. Files older than 30 days are automatically pruned.
- **REST & Download Endpoints**:
  - `GET /api/reports/excel`: Download the latest styled `.xlsx` file.
  - `GET /api/reports/csv`: Download the CSV fallback log.
  - `GET /api/reports/stats`: Inspect buffer length, total cleaned events written, and last flush timestamp.
  - `POST /api/reports/flush`: Manually trigger an immediate clean-and-flush cycle.

### Running Excel Logger Tests
```bash
node backend/test/excel_logger.test.js
```
Runs 7 tests verifying noise dropping, debounce duplicate collapse, continuous sensor burst collapsing, multi-step scan flow merging, workbook styling, file lock recovery, and empty batch skipping.

---

## 9. Master Product Catalog & 1-Click Cart Addition

### Architecture & Unified Inventory Engine
The Master Product Catalog acts as the global item repository, decoupling store inventory from the central product master. Operators can browse products, search by SKU/barcode/name, filter by category, and add items directly to the shopping cart with 1 click.

```
[Master Product Catalog (catalog_products)]
                   │
     ┌─────────────┴─────────────┐
     ▼                           ▼
[Store Inventory (products)]   [Catalog Browser UI]
     │                           │
     │                           ▼ (1-Click Add with Quantity Stepper)
     └──────────────────────────► [Inventory Service Mutex Lock]
                                 ├─ Validate stock availability
                                 ├─ Atomic stock decrement
                                 ├─ Record stock_movement (audit log)
                                 ├─ Check low_stock threshold (<= 3)
                                 ├─ Idempotent replay protection (requestId)
                                 └─ Publish MQTT event (source: 'catalog')
```

### Key Features
- **Unified Mutex Locking**: Catalog additions reuse the exact same per-product mutex locks and atomic stock decrements as physical barcode scans, eliminating race conditions when multiple users or scanners compete for the last item.
- **1-Click Cart Addition with Quantity Stepper**: Operators can select quantities (+ / -) directly from the Catalog view and add items to cart instantly without manual scanning.
- **Live Stock Status Badges**: Visual indicators for `In stock`, `Low stock` (amber badge), `Out of stock` (red badge), and `Not in inventory` (purple badge).
- **Auto-Linking & On-Demand Inventory Setup**: Unstocked catalog products can be added to store inventory with custom price and initial stock with a single click via `POST /api/catalog/:id/link-inventory`.
- **Idempotency Protection**: Every catalog addition request accepts an optional `requestId` header or body parameter, preventing accidental double-charges if a network retry occurs.
- **MQTT Event Attribution**: Emits `device/{device_id}/cart/item_added` with `source: "catalog"` to clearly distinguish manual UI additions from physical barcode scanner triggers.

### Running Catalog System Integration Tests
```bash
node backend/test/catalog_system.test.js
```
Runs 7 integration tests covering catalog search, category filtering, quantity additions, high-concurrency mutex locking, idempotent duplicate replays, deactivated product protection, and auto-linking unstocked items.

### Seeding Sample Catalog Data
```bash
node backend/scripts/seed_catalog.js
```
Populates the catalog with realistic products across Groceries, Snacks, Dairy, Beverages, and Electronics.
