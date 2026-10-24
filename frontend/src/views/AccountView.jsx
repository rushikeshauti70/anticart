import React, { useState, useEffect } from 'react';
import { User, Receipt, RotateCcw, Eye, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../api';

export function AccountView({ onSelectBillToView }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBill, setSelectedBill] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    loadPurchases();
  }, []);

  async function loadPurchases() {
    setLoading(true);
    try {
      const res = await api.getPurchases({ page: 1, pageSize: 50 });
      setPurchases(res.data || []);
    } catch (err) {
      console.error('Failed to load purchases:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelPurchase(id) {
    if (!window.confirm('Are you sure you want to cancel this purchase? Stock will be restored to catalog.')) return;
    try {
      const res = await api.cancelPurchase(id);
      setStatusMessage('Purchase cancelled and stock restored to catalog.');
      loadPurchases();
      setTimeout(() => setStatusMessage(''), 4000);
    } catch (err) {
      alert(err.message || 'Failed to cancel purchase');
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Account & Order History</h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Review completed shopping transactions, past bills, and operator session
        </p>
      </div>

      {statusMessage && (
        <div className="toast-banner toast-success">
          <span>{statusMessage}</span>
          <button className="btn btn-sm" onClick={() => setStatusMessage('')}>Close</button>
        </div>
      )}

      {/* Operator Session Info Card */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' }}>
        <div style={{
          width: '46px',
          height: '46px',
          borderRadius: '50%',
          backgroundColor: 'var(--primary-soft)',
          color: 'var(--primary-dark)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <User size={24} />
        </div>
        <div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>Shop Operator Kiosk</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Terminal Station · Linked to device <code>trolley-01</code>
          </div>
        </div>
      </div>

      {/* Purchase History */}
      <div className="card">
        <h3 className="card-title" style={{ marginBottom: '12px' }}>Past Purchases</h3>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
            Loading purchase history...
          </div>
        ) : purchases.length === 0 ? (
          <div className="empty-state" style={{ margin: '8px 0' }}>
            <Receipt size={36} style={{ margin: '0 auto 10px', color: 'var(--text-light)' }} />
            <div className="empty-state-title">No purchases recorded yet</div>
            <p className="empty-state-text">
              Bills and transaction history will appear here once customers checkout.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="cart-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Date & Time</th>
                  <th>Items</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <code style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                        #{p.id.substring(0, 8).toUpperCase()}
                      </code>
                    </td>
                    <td style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      {new Date(p.created_at).toLocaleDateString()} {new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td>
                      {p.items?.length || 0} line items
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>
                      ₹{Number(p.total).toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        backgroundColor: p.status === 'completed' ? 'var(--success-soft)' : 'var(--danger-soft)',
                        color: p.status === 'completed' ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }}>
                        <button
                          className="btn btn-sm"
                          title="View Bill Details"
                          onClick={() => setSelectedBill(p)}
                        >
                          <Eye size={13} /> View
                        </button>
                        {p.status === 'completed' && (
                          <button
                            className="btn btn-sm"
                            title="Cancel Purchase & Restore Stock"
                            onClick={() => handleCancelPurchase(p.id)}
                          >
                            <RotateCcw size={13} style={{ color: 'var(--danger)' }} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bill Details Modal */}
      {selectedBill && (
        <div className="modal-overlay" onClick={() => setSelectedBill(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h3 className="card-title">Bill #{selectedBill.id.substring(0, 8).toUpperCase()}</h3>
              <button className="btn btn-sm" onClick={() => setSelectedBill(null)}>✕</button>
            </div>

            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '14px' }}>
              <div>Date: {new Date(selectedBill.created_at).toLocaleString()}</div>
              <div>Trolley ID: {selectedBill.trolley_id}</div>
              <div>Status: <strong>{selectedBill.status}</strong></div>
            </div>

            <table className="cart-table" style={{ marginBottom: '14px' }}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ textAlign: 'center' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {selectedBill.items?.map((item, i) => (
                  <tr key={i}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{item.name}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>+{item.gst_percent}% GST</div>
                    </td>
                    <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                    <td style={{ textAlign: 'right' }}>₹{Number(item.price).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>₹{Number(item.line_total).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="summary-box" style={{ marginTop: '0', marginBottom: '16px' }}>
              <div className="summary-row">
                <span>Subtotal</span>
                <span>₹{Number(selectedBill.subtotal).toFixed(2)}</span>
              </div>
              <div className="summary-row">
                <span>GST Total</span>
                <span>₹{Number(selectedBill.gst_total).toFixed(2)}</span>
              </div>
              <div className="summary-row total">
                <span>Grand Total</span>
                <span>₹{Number(selectedBill.total).toFixed(2)}</span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn" onClick={() => setSelectedBill(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
