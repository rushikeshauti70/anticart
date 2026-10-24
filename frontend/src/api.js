// API client and Server-Sent Events stream manager

const API_BASE = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : '';

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(data?.error?.message || `Request failed with status ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || 'UNKNOWN_ERROR';
    error.barcode = data?.error?.barcode;
    throw error;
  }

  return data;
}

export const api = {
  // Health
  getHealth: () => request('/health'),

  // Products
  getProducts: ({ search = '', category = '', page = 1, pageSize = 50 } = {}) => {
    const params = new URLSearchParams({ search, category, page, pageSize });
    return request(`/api/products?${params.toString()}`);
  },
  createProduct: (product) => request('/api/products', { method: 'POST', body: JSON.stringify(product) }),
  updateProduct: (id, product) => request(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(product) }),
  deleteProduct: (id) => request(`/api/products/${id}`, { method: 'DELETE' }),
  importProducts: (body, isCsv = false) => {
    return request('/api/products/import', {
      method: 'POST',
      headers: isCsv ? { 'Content-Type': 'text/csv' } : undefined,
      body: isCsv ? body : JSON.stringify(body),
    });
  },

  // Cart
  getCart: (trolleyId = 'trolley-01') => request(`/api/cart?trolleyId=${trolleyId}`),
  scanBarcode: ({ barcode, scanId, trolleyId = 'trolley-01' }) =>
    request('/api/scan', { method: 'POST', body: JSON.stringify({ barcode, scanId, trolleyId }) }),
  updateCartItemQuantity: ({ productId, quantity, trolleyId = 'trolley-01' }) =>
    request(`/api/cart/items/${productId}`, { method: 'PATCH', body: JSON.stringify({ quantity, trolleyId }) }),
  removeCartItem: ({ productId, trolleyId = 'trolley-01' }) =>
    request(`/api/cart/items/${productId}?trolleyId=${trolleyId}`, { method: 'DELETE' }),
  cancelCart: (trolleyId = 'trolley-01') =>
    request('/api/cart/cancel', { method: 'POST', body: JSON.stringify({ trolleyId }) }),
  checkoutCart: (trolleyId = 'trolley-01') =>
    request('/api/cart/checkout', { method: 'POST', body: JSON.stringify({ trolleyId }) }),

  // Purchases
  getPurchases: ({ page = 1, pageSize = 20 } = {}) =>
    request(`/api/purchases?page=${page}&pageSize=${pageSize}`),
  getPurchaseById: (id) => request(`/api/purchases/${id}`),
  cancelPurchase: (id) => request(`/api/purchases/${id}/cancel`, { method: 'POST' }),

  // Trolley
  getTrolleyState: (deviceId = 'trolley-01') => request(`/api/trolley/${deviceId}/state`),
  getTrolleyEvents: (deviceId = 'trolley-01', { page = 1, pageSize = 20 } = {}) =>
    request(`/api/trolley/${deviceId}/events?page=${page}&pageSize=${pageSize}`),
  sendTrolleyCommand: (deviceId = 'trolley-01', type) =>
    request(`/api/trolley/${deviceId}/command`, { method: 'POST', body: JSON.stringify({ type }) }),
};

// Resilient Server-Sent Events (SSE) subscriber with back-off reconnect
export function subscribeToSse(onEvent, onStatusChange) {
  let eventSource = null;
  let retryCount = 0;
  let retryTimeout = null;
  let isClosedExplicitly = false;

  const retryDelays = [1000, 2000, 5000, 15000];

  function connect() {
    if (isClosedExplicitly) return;

    onStatusChange?.('connecting');
    const streamUrl = `${API_BASE}/api/stream`;

    try {
      eventSource = new EventSource(streamUrl);

      eventSource.onopen = () => {
        retryCount = 0;
        onStatusChange?.('online');
      };

      eventSource.addEventListener('connected', (e) => {
        onStatusChange?.('online');
      });

      eventSource.addEventListener('telemetry', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent?.('telemetry', data);
        } catch (err) {}
      });

      eventSource.addEventListener('status', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent?.('status', data);
        } catch (err) {}
      });

      eventSource.addEventListener('event', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent?.('event', data);
        } catch (err) {}
      });

      eventSource.addEventListener('command-ack', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent?.('command-ack', data);
        } catch (err) {}
      });

      eventSource.addEventListener('cart', (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent?.('cart', data);
        } catch (err) {}
      });

      eventSource.addEventListener('heartbeat', (e) => {
        onEvent?.('heartbeat', {});
      });

      eventSource.onerror = () => {
        if (eventSource) eventSource.close();
        if (isClosedExplicitly) return;

        onStatusChange?.('reconnecting');
        const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
        retryCount += 1;

        retryTimeout = setTimeout(() => {
          connect();
        }, delay);
      };
    } catch (err) {
      onStatusChange?.('offline');
    }
  }

  connect();

  return () => {
    isClosedExplicitly = true;
    if (retryTimeout) clearTimeout(retryTimeout);
    if (eventSource) eventSource.close();
  };
}
