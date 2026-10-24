import React, { useState, useEffect } from 'react';
import { ShoppingBag, Camera, ShoppingCart, Radio, User, AlertCircle } from 'lucide-react';
import { ShopView } from './views/ShopView';
import { ScanView } from './views/ScanView';
import { CartView } from './views/CartView';
import { TrolleyView } from './views/TrolleyView';
import { AccountView } from './views/AccountView';
import { api, subscribeToSse } from './api';

export function App() {
  const [activeTab, setActiveTab] = useState('shop'); // shop, scan, cart, trolley, account
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // connecting, online, stale, offline, reconnecting
  const [trolleyState, setTrolleyState] = useState(null);
  const [trolleyEvents, setTrolleyEvents] = useState([]);
  const [cart, setCart] = useState({ items: [], subtotal: 0, gst_total: 0, total: 0, item_count: 0 });
  const [bannerAlert, setBannerAlert] = useState(null);

  // Initialize data on mount
  useEffect(() => {
    loadInitialData();

    // Subscribe to SSE realtime stream
    const unsubscribe = subscribeToSse((eventType, data) => {
      if (eventType === 'cart') {
        setCart(data);
      } else if (eventType === 'telemetry') {
        setTrolleyState((prev) => ({
          ...prev,
          connection: data.connection,
          telemetry: data.telemetry,
          lastSeen: data.lastSeen,
        }));
      } else if (eventType === 'status') {
        setTrolleyState((prev) => ({
          ...prev,
          connection: data.connection,
          status: data.status,
          lastSeen: data.lastSeen || prev?.lastSeen,
        }));
      } else if (eventType === 'event') {
        setTrolleyEvents((prev) => [data, ...prev.slice(0, 49)]);
      }
    }, (status) => {
      setConnectionStatus(status);
      if (status === 'offline') {
        setBannerAlert('Server stream disconnected. Attempting to reconnect...');
      } else {
        setBannerAlert(null);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  async function loadInitialData() {
    try {
      // 1. Fetch initial cart
      const cartData = await api.getCart('trolley-01');
      if (cartData) setCart(cartData);

      // 2. Fetch initial trolley state
      const stateData = await api.getTrolleyState('trolley-01');
      if (stateData) setTrolleyState(stateData);

      // 3. Fetch initial events
      const eventsData = await api.getTrolleyEvents('trolley-01', { page: 1, pageSize: 20 });
      if (eventsData?.data) setTrolleyEvents(eventsData.data);
    } catch (err) {
      console.warn('Initial data load warning:', err.message);
    }
  }

  // Derive top connection indicator
  const displayStatus = trolleyState?.connection || connectionStatus;

  return (
    <div className="app-container">
      {/* App Header */}
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary-dark)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="21" r="1"/>
              <circle cx="19" cy="21" r="1"/>
              <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>
            </svg>
            <span>AVCOE Shop</span>
            <span className="brand-badge">trolley-01</span>
          </div>

          <div className="header-actions">
            {/* Connection Status Pill */}
            <div className="connection-pill" title={`Trolley state: ${displayStatus}`}>
              <span className={`pill-dot status-${displayStatus}`} />
              <span style={{ textTransform: 'capitalize' }}>{displayStatus}</span>
            </div>
          </div>
        </div>

        {/* Desktop Top Navigation */}
        <nav className="nav-bar">
          <button
            className={`nav-item ${activeTab === 'shop' ? 'active' : ''}`}
            onClick={() => setActiveTab('shop')}
          >
            <ShoppingBag size={18} />
            <span>Shop</span>
          </button>

          <button
            className={`nav-item ${activeTab === 'scan' ? 'active' : ''}`}
            onClick={() => setActiveTab('scan')}
          >
            <Camera size={18} />
            <span>Scan</span>
          </button>

          <button
            className={`nav-item ${activeTab === 'cart' ? 'active' : ''}`}
            onClick={() => setActiveTab('cart')}
          >
            <ShoppingCart size={18} />
            <span>Cart</span>
            {cart?.item_count > 0 && (
              <span className="nav-item-badge">{cart.item_count}</span>
            )}
          </button>

          <button
            className={`nav-item ${activeTab === 'trolley' ? 'active' : ''}`}
            onClick={() => setActiveTab('trolley')}
          >
            <Radio size={18} />
            <span>Trolley</span>
          </button>

          <button
            className={`nav-item ${activeTab === 'account' ? 'active' : ''}`}
            onClick={() => setActiveTab('account')}
          >
            <User size={18} />
            <span>Account</span>
          </button>
        </nav>
      </header>

      {/* Disconnection Banner */}
      {bannerAlert && (
        <div style={{
          backgroundColor: 'var(--danger-soft)',
          borderBottom: '1px solid var(--danger)',
          color: 'var(--danger)',
          padding: '8px 16px',
          fontSize: '0.82rem',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          justifyContent: 'center',
        }}>
          <AlertCircle size={14} />
          <span>{bannerAlert}</span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="app-main">
        {activeTab === 'shop' && (
          <ShopView
            onSelectBarcodeForScan={(barcode) => {
              setActiveTab('scan');
            }}
          />
        )}

        {activeTab === 'scan' && (
          <ScanView
            onNavigateToCart={() => setActiveTab('cart')}
            onNavigateToShop={() => setActiveTab('shop')}
          />
        )}

        {activeTab === 'cart' && (
          <CartView
            cart={cart}
            onCartUpdated={(updatedCart) => setCart(updatedCart)}
            onNavigateToShop={() => setActiveTab('shop')}
            onNavigateToScan={() => setActiveTab('scan')}
          />
        )}

        {activeTab === 'trolley' && (
          <TrolleyView
            trolleyState={trolleyState}
            events={trolleyEvents}
            onCommandAck={(ack) => {
              setTrolleyEvents((prev) => [{
                event: 'COMMAND_ACK',
                severity: ack.status === 'executed' ? 'info' : 'warning',
                message: `${ack.type || 'Command'}: ${ack.status} (${ack.reason || 'acknowledged'})`,
                received_at: new Date().toISOString(),
              }, ...prev]);
            }}
          />
        )}

        {activeTab === 'account' && (
          <AccountView />
        )}
      </main>
    </div>
  );
}
